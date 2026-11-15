/* =========================================================================
   report.js · 跑 queries.sql，输出漏斗 / 留存 / A/B / 安全 / 成本报告
   -------------------------------------------------------------------------
   用法：
     node --experimental-sqlite analytics/report.js                 读 server/tide.db（真实数据）
     node --experimental-sqlite analytics/report.js path/to/x.db    读指定库
     node --experimental-sqlite analytics/report.js --selftest      用合成数据验证 SQL 算得对不对

   --selftest 生成的是"答案已知"的合成数据，用来证明 SQL 没写错。
   它的数字绝不能写进简历或报告——报告头会打上 SYNTHETIC 水印。
   ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const { open, makeStore } = require('../server/db.js');

/* 美元 / 百万 token。来源：DeepSeek 官方价格页（api-docs.deepseek.com/quick_start/pricing，2026-11-10 查阅），
   deepseek-flash 的**高峰价、缓存未命中**——取最贵的一档做保守估算。
   高峰时段是 UTC 周一至周五 01:00–04:00、06:00–10:00；美国东部晚 9 点 ≈ UTC 02:00，正好落在高峰。
   价格会变，改这里时同步改 docs/07 的 v5 成本一节。 */
const PRICE = { inPerM: 0.30, outPerM: 1.20, currency: '$' };

function loadQueries() {
  const sql = fs.readFileSync(path.join(__dirname, 'queries.sql'), 'utf8');
  const out = {};
  for (const block of sql.split(/^-- name: /m).slice(1)) {
    const name = block.split('\n')[0].trim();
    out[name] = block.split('\n').slice(1).filter(l => !/^\s*--/.test(l)).join('\n').trim().replace(/;\s*$/, '');
  }
  return out;
}

function run(db) {
  const Q = loadQueries();
  const r = {};
  for (const k of Object.keys(Q)) r[k] = db.prepare(Q[k]).all();
  return r;
}

const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '—');

function render(r, synthetic) {
  const L = [];
  if (synthetic) L.push('⚠️  SYNTHETIC DATA — 仅用于验证 SQL 口径，数字不代表任何真实用户', '');
  L.push('== 新手漏斗 ==');
  const top = (r.funnel[0] || {}).devices || 0;
  let prev = top;
  for (const s of r.funnel) { L.push('  ' + s.step.padEnd(18) + String(s.devices).padStart(6) + '   占注册 ' + pct(s.devices, top).padStart(6) + '   较上一步 ' + pct(s.devices, prev)); prev = s.devices; }
  L.push('', '== 留存（只算注册已满 n 天的设备） ==');
  for (const x of r.retention) L.push('  D' + x.day_n + '  ' + String(x.retained).padStart(4) + ' / ' + String(x.eligible).padEnd(4) + ' = ' + pct(x.retained, x.eligible));
  L.push('', '== A/B：nudge_v1 晚间主动关怀 ==');
  for (const x of r.ab_nudge) L.push('  ' + x.variant.padEnd(8) + ' D7 ' + pct(x.retained_d7, x.eligible_d7).padStart(6) + ' (' + x.retained_d7 + '/' + x.eligible_d7 + ')   关闭通知 ' + x.disabled_notifications);
  const a = r.ab_nudge.find(x => x.variant === 'control'), b = r.ab_nudge.find(x => x.variant === 'nudge');
  if (a && b && a.eligible_d7 && b.eligible_d7) {
    const p1 = a.retained_d7 / a.eligible_d7, p2 = b.retained_d7 / b.eligible_d7;
    const pp = (a.retained_d7 + b.retained_d7) / (a.eligible_d7 + b.eligible_d7);
    const se = Math.sqrt(pp * (1 - pp) * (1 / a.eligible_d7 + 1 / b.eligible_d7));
    const z = se ? (p2 - p1) / se : 0;
    L.push('  差值 ' + ((p2 - p1) * 100).toFixed(1) + 'pt   z=' + z.toFixed(2) + (Math.abs(z) >= 1.96 ? '（p<0.05）' : '（不显著，样本不够或差异太小）'));
  }
  L.push('', '== 新手引导选项 ==');
  for (const x of r.onboarding_choice) L.push('  ' + String(x.choice).padEnd(10) + ' 选择 ' + String(x.picked).padStart(4) + '   激活 ' + pct(x.activated, x.picked));
  L.push('', '== 分群：按首选角色 ==');
  for (const x of r.segments) L.push('  ' + String(x.persona).padEnd(8) + ' 设备 ' + String(x.devices).padStart(4) + '   激活 ' + pct(x.activated, x.devices).padStart(6) + '   D1 ' + pct(x.d1_retained, x.d1_eligible));
  L.push('', '== 分群：近 7 天活跃天数 ==');
  for (const x of r.usage_tier) L.push('  ' + String(x.tier).padEnd(16) + ' 设备 ' + String(x.devices).padStart(4) + '   人均轮次 ' + x.turns_per_device);
  L.push('', '== 周 cohort（设备数） ==');
  L.push('  cohort      size   w0   w1   w2   w3');
  for (const x of r.cohort_weekly) L.push('  ' + x.cohort.padEnd(10) + String(x.size).padStart(5) + [x.w0, x.w1, x.w2, x.w3].map(v => String(v).padStart(5)).join(''));
  const rl = r.recall_loop[0] || {};
  L.push('', '== 召回链路 ==');
  L.push('  关怀排程 ' + rl.nudges_scheduled + ' → 被点开 ' + rl.nudges_opened + '（' + pct(rl.nudges_opened, rl.nudges_scheduled) + '）   回访 ' + rl.return_visits + '，其中带记忆承接 ' + pct(rl.return_with_memory, rl.return_visits));
  const rq = r.reply_quality[0] || {};
  L.push('', '== 回复质量（机器可算） ==');
  L.push('  轮次 ' + rq.turns + '   触发重生成 ' + rq.retried_turns + '（' + rq.retry_rate_pct + '%）   记忆陷阱拦截 ' + rq.recall_guard);
  L.push('', '== 安全：危机转介次数 ==');
  if (!r.safety.length) L.push('  0');
  for (const x of r.safety) L.push('  ' + String(x.layer).padEnd(8) + ' ' + x.crisis_referrals);
  L.push('', '== 成本 ==');
  for (const x of r.cost.slice(-7)) {
    const yuan = (x.tokens_in * PRICE.inPerM + x.tokens_out * PRICE.outPerM) / 1e6;
    L.push('  ' + x.day + '  轮次 ' + String(x.turns).padStart(5) + '   ' + PRICE.currency + yuan.toFixed(4) + '   平均 ' + x.avg_ms + 'ms');
  }
  return L.join('\n');
}

/* ---------------- 合成数据：每个设备的命运事先写死，所以答案已知 ---------------- */
function seed(store) {
  const day = n => new Date(Date.UTC(2026, 9, 1 + n, 21, 0, 0)).toISOString();   // 2026-10-01 起，晚 9 点
  const plan = [];
  // 40 台设备，注册日 0..19（每天 2 台），这样 D7 有 12 天的 cohort 满足条件
  for (let i = 0; i < 40; i++) plan.push({ i, d0: Math.floor(i / 2) });
  const expect = { signup: 0, age: 0, persona: 0, first: 0, act: 0, pay: 0, sub: 0, d1e: 0, d1r: 0, d7e: 0, d7r: 0,
    seg: {}, tiers: {}, retried: 0, turns: 0, nudgeSched: 0, nudgeOpen: 0, returns: 0, returnsMem: 0, recallGuard: 0 };
  const activeDays = {};   // device → Set(日序号) + 轮次，用来手算 usage_tier
  const origTrack = store.track;
  let lastDay = 0;         // 全库最后一条事件落在第几天 = SQL 里的 asof
  store.track = (id, name, props, ts) => {
    lastDay = Math.max(lastDay, Math.round((Date.parse(ts) - Date.UTC(2026, 9, 1, 21)) / 86400000));
    if (name === 'message_sent') {
      expect.turns++;
      if (props && props.retries) expect.retried++;
      const a = (activeDays[id] = activeDays[id] || { days: new Set(), turns: [] });
      const n = Math.round((Date.parse(ts) - Date.UTC(2026, 9, 1, 21)) / 86400000);
      a.days.add(n); a.turns.push(n);
    }
    return origTrack(id, name, props, ts);
  };
  for (const p of plan) {
    const id = 's' + String(p.i).padStart(3, '0');
    store.db.prepare("INSERT INTO devices (device_id, token_hash, created_at, plan, age_ok) VALUES (?, ?, ?, 'free', 1)").run(id, 'h' + id, day(p.d0));
    store.db.prepare("INSERT INTO experiments (device_id, exp, variant, assigned_at) VALUES (?, 'nudge_v1', ?, ?)").run(id, p.i % 2 ? 'nudge' : 'control', day(p.d0));
    store.track(id, 'signup', {}, day(p.d0)); expect.signup++;
    if (p.i % 10 === 9) { (expect.seg['(none)'] = expect.seg['(none)'] || { devices: 0, act: 0 }).devices++; continue; } // 10% 卡在年龄确认
    store.track(id, 'age_confirmed', {}, day(p.d0)); expect.age++;
    const choice = ['restless', 'work', 'heart', 'quiet'][p.i % 4];
    const persona = { restless: 'man', work: 'an', heart: 'wan', quiet: 'tide' }[choice];
    store.track(id, 'persona_selected', { persona, source: 'onboarding' }, day(p.d0)); expect.persona++;
    store.track(id, 'onboarding_step', { step: 'choice', choice }, day(p.d0));
    const msgs = p.i % 3 === 0 ? 1 : 4;                                              // 1/3 只发 1 条
    for (let k = 0; k < msgs; k++) store.track(id, 'message_sent', { tin: 900, tout: 60, ms: 1200, retries: k === 0 && p.i % 6 === 1 ? 1 : 0 }, day(p.d0));
    const sg = (expect.seg[persona] = expect.seg[persona] || { devices: 0, act: 0 });
    sg.devices++; if (msgs >= 3) sg.act++;
    if (p.i % 4 === 3) { store.track(id, 'nudge_scheduled', {}, day(p.d0 + 1)); expect.nudgeSched++; }
    if (p.i % 8 === 3) { store.track(id, 'nudge_opened', {}, day(p.d0 + 2)); expect.nudgeOpen++; }
    if (p.i % 5 === 2) { store.track(id, 'return_visit', { gap_days: 3, with_memory: p.i % 10 === 2 }, day(p.d0 + 3)); expect.returns++; if (p.i % 10 === 2) expect.returnsMem++; }
    if (p.i === 7) { store.track(id, 'recall_miss', {}, day(p.d0)); expect.recallGuard++; }
    // 重度用户：i=4、i=8 在最后一周每晚都来（让 usage_tier 三层都有人）。
    // 选这两个是因为它们的 D1/D7 日都不落在第 20–26 天，不会污染上面的留存答案。
    if (p.i === 4 || p.i === 8) for (let k = 20; k <= 26; k++) store.track(id, 'message_sent', {}, day(k));
    if (p.i === 34) for (const k of [21, 23, 25]) store.track(id, 'message_sent', {}, day(k));
    expect.first++; if (msgs >= 3) expect.act++;
    if (p.i % 5 === 0) { store.track(id, 'paywall_view', {}, day(p.d0)); expect.pay++; }
    if (p.i % 20 === 0) { store.track(id, 'subscribe', {}, day(p.d0)); expect.sub++; }
    // D1：偶数号回来
    if (p.i % 2 === 0) store.track(id, 'message_sent', {}, day(p.d0 + 1));
    // D7：nudge 组（奇数）中 i%4==1 的回来；control 组（偶数）中 i%8==0 的回来
    const backD7 = (p.i % 2 === 1 && p.i % 4 === 1) || (p.i % 2 === 0 && p.i % 8 === 0);
    if (backD7) store.track(id, 'message_sent', {}, day(p.d0 + 7));
    if (p.i % 2 === 1 && p.i % 7 === 0) store.track(id, 'nudge_dismissed', { action: 'disable' }, day(p.d0 + 2));
  }
  store.track('s000', 'crisis_routed', { layer: 'client' }, day(21));
  // 期望留存，按同样的口径手算。
  // 截至日 = 全库最后一条事件的日期（SQL 的口径），不是一个写死的常数。
  // 这里踩过两次坑，都是自检抓出来的，错的都是测试、不是 SQL：
  //   ① 第一版写死 21；② 第二版用"最晚一次 D7 回访"推算，后来加了重度用户的事件，截至日变了。
  // 所以现在直接记录"每一条写入的事件里最晚的那天"，和 SQL 的 MAX(ts) 同一个定义。
  const asof = lastDay;
  for (const p of plan) {
    const blocked = p.i % 10 === 9;
    if (asof - p.d0 >= 1) { expect.d1e++; if (!blocked && p.i % 2 === 0) expect.d1r++; }
    if (asof - p.d0 >= 7) { expect.d7e++; if (!blocked && ((p.i % 2 === 1 && p.i % 4 === 1) || (p.i % 2 === 0 && p.i % 8 === 0))) expect.d7r++; }
  }
  // 行为分群：近 7 天 = [asof-6, asof] 里有对话的天数
  for (const a of Object.values(activeDays)) {
    const n = [...a.days].filter(x => x >= asof - 6 && x <= asof).length;
    if (!n) continue;
    const tier = n >= 6 ? '3_heavy(6-7d)' : n >= 3 ? '2_medium(3-5d)' : '1_light(1-2d)';
    expect.tiers[tier] = (expect.tiers[tier] || 0) + 1;
  }
  store.track = origTrack;
  return expect;
}

function selftest() {
  const store = makeStore(open(':memory:'));
  const E = seed(store);
  const r = run(store.db);
  const f = Object.fromEntries(r.funnel.map(x => [x.step, x.devices]));
  const d = Object.fromEntries(r.retention.map(x => [x.day_n, x]));
  const seg = Object.fromEntries(r.segments.map(x => [x.persona, x]));
  const tier = Object.fromEntries(r.usage_tier.map(x => [x.tier, x.devices]));
  const rl = r.recall_loop[0], rq = r.reply_quality[0];
  const checks = [
    ['漏斗·注册', f.signup, E.signup], ['漏斗·确认 18+', f.age_confirmed, E.age], ['漏斗·选角色', f.persona_selected, E.persona],
    ['漏斗·首条消息', f.first_message, E.first], ['漏斗·激活(≥3条)', f.activated_3msg, E.act],
    ['漏斗·付费墙', f.paywall_view, E.pay], ['漏斗·订阅', f.subscribe, E.sub],
    ['D1 分母', d[1].eligible, E.d1e], ['D1 留存', d[1].retained, E.d1r],
    ['D7 分母', d[7].eligible, E.d7e], ['D7 留存', d[7].retained, E.d7r],
    ['安全·转介', (r.safety[0] || {}).crisis_referrals, 1],
    ...Object.entries(E.seg).map(([k, v]) => ['分群·' + k + ' 设备数', (seg[k] || {}).devices, v.devices]),
    ...Object.entries(E.seg).map(([k, v]) => ['分群·' + k + ' 激活数', (seg[k] || {}).activated, v.act]),
    ...['1_light(1-2d)', '2_medium(3-5d)', '3_heavy(6-7d)'].map(k => ['活跃分层·' + k, tier[k], E.tiers[k]]),
    ['周 cohort·人数合计', r.cohort_weekly.reduce((a, x) => a + x.size, 0), E.signup],
    ['周 cohort·第 0 周活跃合计', r.cohort_weekly.reduce((a, x) => a + x.w0, 0), E.first],
    ['召回·关怀排程', rl.nudges_scheduled, E.nudgeSched], ['召回·关怀打开', rl.nudges_opened, E.nudgeOpen],
    ['召回·回访', rl.return_visits, E.returns], ['召回·带记忆回访', rl.return_with_memory, E.returnsMem],
    ['质量·总轮次', rq.turns, E.turns], ['质量·重生成轮次', rq.retried_turns, E.retried], ['质量·记忆陷阱拦截', rq.recall_guard, E.recallGuard]
  ];
  let bad = 0;
  for (const [n, got, want] of checks) { const ok = got === want; if (!ok) bad++; console.log('  ' + (ok ? '✅' : '❌') + ' ' + n + '  得 ' + got + '  应 ' + want); }
  const ab = Object.fromEntries(r.ab_nudge.map(x => [x.variant, x]));
  const abOk = ab.nudge && ab.control && ab.nudge.retained_d7 > ab.control.retained_d7;
  console.log('  ' + (abOk ? '✅' : '❌') + ' A/B 方向：nudge 组 D7 应高于 control（合成数据刻意这样设）');
  if (!abOk) bad++;
  console.log('\n' + render(r, true));
  console.log('\n' + (bad ? '❌ SQL 口径校验失败 ' + bad + ' 项' : '✅ SQL 口径校验全部通过：' + (checks.length + 1) + ' 项'));
  return bad;
}

if (require.main === module) {
  if (process.argv.includes('--selftest')) process.exit(selftest() ? 1 : 0);
  const file = process.argv[2] || path.join(__dirname, '..', 'server', 'tide.db');
  if (!fs.existsSync(file)) { console.log('找不到数据库：' + file + '\n先启动服务端并让真实用户使用，或用 --selftest 验证 SQL。'); process.exit(1); }
  const store = makeStore(open(file));
  console.log(render(run(store.db), false));
}

module.exports = { run, render, seed, selftest };
