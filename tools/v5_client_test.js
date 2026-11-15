/* =========================================================================
   v5_client_test.js · 用真实构建产物（assets/index.html）+ 真实服务端（mock 上游）
   跑完整的用户路径，验证页面逻辑和服务端的配合。
   -------------------------------------------------------------------------
   页面跑在 Node vm 里，DOM 用最小桩；AndroidTide 桥用 Node 的 http 直连服务端，
   行为和 TideApi.kt 一致（token 存在桥里、不回传页面）。
   运行：node --experimental-sqlite tools/v5_client_test.js
   ========================================================================= */
'use strict';
delete process.env.TIDE_UPSTREAM_KEY;
process.env.TIDE_ALLOW_FAKE_BILLING = '1';
const fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');
const ROOT = path.resolve(__dirname, '..');
const { open, makeStore } = require('../server/db.js');
const { makeServer } = require('../server/server.js');
const Core = require('../shared/tide_core.js');

let pass = 0, fail = 0; const failures = [];
const ok = (c, n, d) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; failures.push(n); console.log('  ❌ ' + n + (d ? '  :: ' + d : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms) { const t = Date.now(); while (Date.now() - t < (ms || 3000)) { if (fn()) return true; await sleep(20); } return false; }

/* ---------------- 最小 DOM ---------------- */
function makeDom(html) {
  const els = {};
  const mk = id => {
    const e = { id, value: '', textContent: '', innerHTML: '', disabled: false, style: {}, dataset: {}, children: [], scrollTop: 0, scrollHeight: 0,
      classList: { s: new Set(), add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); }, contains(c) { return this.s.has(c); },
        toggle(c, on) { (on === undefined ? !this.s.has(c) : on) ? this.s.add(c) : this.s.delete(c); } },
      appendChild(c) { c.parentNode = e; e.children.push(c); return c; },
      insertBefore(c, ref) { c.parentNode = e; const i = e.children.indexOf(ref); if (i < 0) e.children.push(c); else e.children.splice(i, 0, c); return c; } };
    Object.defineProperty(e, 'className', { get() { return [...e.classList.s].join(' '); }, set(v) { e.classList.s = new Set(String(v).split(/\s+/).filter(Boolean)); } });
    return e;
  };
  for (const m of html.matchAll(/id="([^"]+)"/g)) els[m[1]] = mk(m[1]);
  const i18nEls = [...html.matchAll(/<[^>]+data-i18n="([^"]+)"[^>]*>/g)].map(m => { const e = mk(''); e.dataset.i18n = m[1]; return e; });
  const screens = [...html.matchAll(/<section class="screen[^"]*" id="([^"]+)"/g)].map(m => els[m[1]]);
  screens[0].classList.add('on');
  return {
    els, screens,
    document: {
      getElementById: id => els[id] || (els[id] = mk(id)),
      createElement: () => mk(''),
      querySelectorAll: sel => sel === '.screen' ? screens : sel === '[data-i18n]' ? i18nEls : [],
      addEventListener: () => {}, documentElement: {}, hidden: false
    }
  };
}

/* ---------------- 模拟 Android 桥（与 TideApi.kt 同语义） ---------------- */
function makeBridge(port, win) {
  let token = null;
  const post = (method, p, body, tok) => new Promise(res => {
    const data = body || null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, tok ? { Authorization: 'Bearer ' + tok } : {}, data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
      r => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => res([r.statusCode, Buffer.concat(c).toString('utf8')])); });
    req.on('error', () => res([0, '{"error":"network"}']));
    if (data) req.write(data); req.end();
  });
  const bridge = {
    calls: [], nudges: [], down: false,
    country: () => 'US', systemLang: () => 'en', hasToken: () => !!token, serverHost: () => '127.0.0.1',
    register(lang, id) { post('POST', '/v1/register', JSON.stringify({ country: 'US', lang })).then(([s, t]) => {
      let o = {}; try { o = JSON.parse(t); } catch (e) {}
      if (s === 200) { token = o.token; delete o.token; }
      bridge.lastRegisterBody = JSON.stringify(o);
      win.__tideApi(id, s, JSON.stringify(o)); }); },
    call(method, p, body, id) {
      bridge.calls.push(method + ' ' + p);
      if (bridge.down) { setTimeout(() => win.__tideApi(id, 0, '{"error":"network"}'), 5); return; }
      post(method, p, body || null, token).then(([s, t]) => { if (s === 401) token = null; win.__tideApi(id, s, t); });
    },
    scheduleNudge(title, body, hour) { bridge.nudges.push({ title, body, hour }); },
    cancelNudge() {}, notificationsAllowed: () => true, requestNotifications() { win.__tideNotifResult(true); }, lastNudgeOpened: () => false,
    _token: () => token
  };
  return bridge;
}

(async () => {
  /* 先构建，确保测的是 APK 里真正那份页面 */
  require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build_app.js')], { stdio: 'ignore' });
  const html = fs.readFileSync(path.join(ROOT, 'android/app/src/main/assets/index.html'), 'utf8');

  console.log('── 0. 构建产物');
  ok(!html.includes('/*__TIDE_CORE__*/') && !html.includes('/*__TIDE_APP__*/'), '占位符已被内联替换');
  ok(html.includes('TideCore') && html.includes('TideApp'), '共享核心与页面逻辑都进了包');
  ok(!/sk-[A-Za-z0-9]{16,}/.test(html), '包里没有任何形似 API Key 的字符串');

  const store = makeStore(open(':memory:'));
  const server = makeServer(store);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const dom = makeDom(html);
  const store_ = {};
  const win = {
    localStorage: { getItem: k => (k in store_ ? store_[k] : null), setItem: (k, v) => { store_[k] = String(v); }, removeItem: k => { delete store_[k]; } },
    navigator: { language: 'en-US' }, document: dom.document, setInterval: () => 0, setTimeout, clearTimeout,
    confirm: () => true, alert: () => {}, location: { reload: () => {} }, console
  };
  win.window = win; win.self = win;
  const bridge = makeBridge(port, win);
  win.AndroidTide = bridge;
  // 离线兜底：模拟手机内置模型（真机上是 llama.cpp）
  win.AndroidLocal = { run(body, id) { const m = JSON.parse(body).messages; setTimeout(() => win.__tideResult(id, true, '[on-device] ' + m[m.length - 1].content.slice(0, 20)), 10); } };
  vm.createContext(win);
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(m[1], win);
  const E = dom.els;
  const on = id => E[id].classList.contains('on');
  const msgs = () => E.msgs.children.map(c => (c.children[1] || {}).textContent || c.textContent || '');

  console.log('── 1. 首次打开：年龄与 AI 身份');
  ok(on('s-gate'), '首屏是年龄 / AI 身份确认');
  const gateText = dom.document.querySelectorAll('[data-i18n]').find(e => e.dataset.i18n === 'gateAi').textContent;
  ok(/AI companion, not a human/.test(gateText), '首屏明确告知“这是 AI，不是真人”', gateText);
  win.TideApp.underAge();
  ok(E.btnAge.disabled && /only for adults/.test(E.gateMsg.textContent), '选“未满 18 岁”被拦下');
  E.btnAge.disabled = false;
  win.confirmAge();
  ok(await until(() => on('s-onboard')), '确认 18+ 后进入新手引导（静默注册，无表单）');
  ok(!!bridge._token() && !/token/.test(bridge.lastRegisterBody || ''), 'token 留在原生桥，没有回传页面');

  console.log('── 2. 新手引导：一个问题 → 推荐角色');
  ok(E.onbChoices.innerHTML.split('class="choice"').length - 1 === Core.ONBOARD.length, '展示 ' + Core.ONBOARD.length + ' 个选项');
  win.TideApp.pick('restless');
  ok(on('s-match') && /Mira/.test(E.matchName.textContent), '“睡不着”推荐 Mira（温柔）', E.matchName.textContent);
  await win.startWithMatch();
  ok(on('s-chat'), '进入聊天页（共 2 步）');
  ok(msgs()[0] === Core.ONBOARD[0].opener.en, '角色开场白直接接住用户刚选的回答');
  ok(E.aiNotice.style.display === 'block' && /AI, not a human/.test(E.aiNotice.textContent), '聊天开始时显示 AI 身份提示');
  ok(store.db.prepare("SELECT persona FROM devices").get().persona === 'man', '角色选择同步到服务端');

  console.log('── 3. 对话走服务端');
  E.inp.value = 'long day honestly';
  await win.sendMsg();
  ok(/\[mock\]/.test(msgs().slice(-1)[0]), '回复来自服务端（mock 标记）', msgs().slice(-1)[0]);
  ok(bridge.calls.includes('POST /v1/chat'), '请求走 /v1/chat');
  const sent = store.db.prepare("SELECT props FROM events WHERE name='message_sent'").get();
  ok(sent && JSON.parse(sent.props).persona === 'man', '服务端记录 message_sent，带角色');

  console.log('── 4. 危机：客户端先拦，不发服务端');
  const before = bridge.calls.filter(c => c === 'POST /v1/chat').length;
  E.inp.value = 'i want to end my life';
  await win.sendMsg();
  ok(/988/.test(msgs().slice(-1)[0]), '固定话术 + 美国 988');
  ok(bridge.calls.filter(c => c === 'POST /v1/chat').length === before, '危机消息没有发给服务端');
  win.TideApp._flush(); await sleep(150);
  ok(store.db.prepare("SELECT COUNT(*) n FROM events WHERE name='crisis_routed'").get().n === 1, '危机转介事件已上报（SB 243 年报口径）');

  console.log('── 5. 被问“你是 AI 吗”');
  E.inp.value = 'are you a real human?';
  await win.sendMsg();
  ok(/I'm an AI/.test(msgs().slice(-1)[0]), '如实回答是 AI');

  console.log('── 6. 软上限 → 付费墙');
  const dev = store.db.prepare('SELECT device_id FROM devices').get().device_id;
  store.db.prepare('INSERT OR REPLACE INTO usage (device_id, day, turns) VALUES (?, ?, ?)').run(dev, new Date().toISOString().slice(0, 10), Core.PLANS.free.daily);
  E.inp.value = 'one more thing';
  await win.sendMsg();
  ok(msgs().slice(-1)[0] === Core.SOFT_CAP_REPLY.en, '到额度：角色先道晚安，不切断');
  ok(await until(() => E.sheet.classList.contains('on') && /Tide Plus/.test(E.sheetBody.innerHTML), 2000), '随后弹出付费墙');
  await win.TideApp.subscribe();
  ok(store.device(dev).plan === 'plus', '模拟订阅后服务端套餐变为 Plus');
  win.closeSheet();

  console.log('── 7. 记忆本：增删走服务端');
  win.openSheet('memory');
  await until(() => /memInp/.test(E.sheetBody.innerHTML));
  E.memInp.value = 'Has a job interview on Friday'; E.memDue.value = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  await win.TideApp.addMem();
  ok(store.memories(dev).length === 1, '手动记忆写入服务端');
  await until(() => /job interview/.test(E.sheetBody.innerHTML));
  ok(/job interview/.test(E.sheetBody.innerHTML), '记忆本里能看到这条');

  console.log('── 8. 晚间关怀只在实验组 + 用户打开时排程');
  // 关怀开关默认关闭：此时切后台不应排任何提醒
  await win.TideApp._scheduleNudge();
  ok(bridge.nudges.length === 0, '开关关闭时不排提醒（默认关闭）');
  win.TideApp.toggleCare();
  ok(win.TideApp._state().care === true, '用户打开晚间关怀');
  // 把这台设备分别放进 control / nudge 组，验证服务端和页面的配合
  store.db.prepare("UPDATE experiments SET variant = 'control' WHERE device_id = ?").run(dev);
  await win.TideApp._scheduleNudge();
  ok(bridge.nudges.length === 0, 'control 组：即使开关打开、有到期事件，也不排提醒');
  store.db.prepare("UPDATE experiments SET variant = 'nudge' WHERE device_id = ?").run(dev);
  await win.TideApp._scheduleNudge();
  ok(bridge.nudges.length === 1 && /job interview/.test(bridge.nudges[0].body), 'nudge 组：按用户说过的具体事件排一条提醒', JSON.stringify(bridge.nudges));
  ok(bridge.nudges[0] && bridge.nudges[0].hour >= 18 && bridge.nudges[0].hour <= 23, '提醒排在晚间时段');
  ok(bridge.nudges[0] && !/miss you|missed you|where have you/i.test(bridge.nudges[0].body), '提醒文案不让人愧疚');

  console.log('── 9. 断网 → 离线模型兜底');
  bridge.down = true;
  E.inp.value = 'still awake';
  await win.sendMsg();
  ok(/\[on-device\]/.test(msgs().slice(-1)[0]), '服务端连不上时，用手机内置模型回复', msgs().slice(-1)[0]);
  ok(/on-device/.test(E.chatStatus.textContent), '顶部状态切到“离线模式”', E.chatStatus.textContent);
  ok(msgs().some(t => /No connection/.test(t)), '明确提示“没有网络，回复会简单一些”');
  bridge.down = false;
  E.inp.value = 'i want to kill myself';
  bridge.down = true;
  await win.sendMsg();
  ok(/988/.test(msgs().slice(-1)[0]), '断网时危机拦截依然有效');
  bridge.down = false;

  console.log('── 10. 中文');
  win.TideApp.setLang('zh');
  ok(dom.document.querySelectorAll('[data-i18n]').find(e => e.dataset.i18n === 'gateAi').textContent.startsWith('潮汐是 AI'), '切换中文后文案更新');
  E.inp.value = '我不想活了';
  await win.sendMsg();
  ok(/AI/.test(msgs().slice(-1)[0]) && /988/.test(msgs().slice(-1)[0]), '中文危机表达同样拦截（设备地区为 US，给 988）');

  console.log('── 10b. 客户端不能伪造订阅事件');
  win.TideApp._track('subscribe', { plan: 'plus' }); win.TideApp._flush(); await sleep(150);
  const fakeSubs = store.db.prepare("SELECT COUNT(*) n FROM events WHERE name='subscribe' AND json_extract(props,'$.fake') IS NULL").get().n;
  ok(fakeSubs === 0, '客户端上报的 subscribe 被服务端丢弃（转化率不会被刷）');

  console.log('── 10c. 角色发现：每张卡带“TA 会怎么开口”');
  win.TideApp.setLang('en');
  win.TideApp.showAllPersonas();
  const cards = E.matchAll.innerHTML;
  ok(Object.values(Core.PERSONAS).every(p => cards.includes(p.sample.en.replace(/'/g, '&#39;'))), '6 张角色卡都展示了示例台词');
  await sleep(50); win.TideApp._flush(); await sleep(150);
  ok(store.db.prepare("SELECT COUNT(*) n FROM events WHERE name='persona_browse'").get().n >= 1, '埋点 persona_browse（算"看了全部角色的人占比"）');

  console.log('── 10d. 角色活感：深夜状态与白天不同');
  const lateLine = Core.lifeStatus('man', 'en', new Date(), 1);
  ok(Core.PERSONAS.man.late.en.includes(lateLine), '凌晨 1 点显示"也还醒着"类状态', lateLine);
  ok(Core.PERSONAS.man.life.en.includes(Core.lifeStatus('man', 'en', new Date(), 21)), '晚上 9 点显示日常状态');

  console.log('── 10e. 回访承接：隔 3 天再打开');
  await win.TideApp.addMemFromTest('Job interview at the design studio');
  const nBefore = msgs().length;
  win.localStorage.setItem('tide5.lastSeen', JSON.stringify(Date.now() - 3 * 86400000));
  await win.TideApp._welcomeBack();
  const greet = msgs().slice(-1)[0] || '';
  ok(msgs().length === nBefore + 1, '角色主动说了一句');
  ok(/few days/.test(greet) && /design studio/.test(greet), '引用了用户说过的具体事', greet);
  ok(!/miss(ed)? you|where were you|took you so long/i.test(greet), '没有让人愧疚的话术');
  win.TideApp._flush(); await sleep(150);
  const rv = store.db.prepare("SELECT props FROM events WHERE name='return_visit' ORDER BY id DESC LIMIT 1").get();
  ok(rv && JSON.parse(rv.props).gap_days === 3 && JSON.parse(rv.props).with_memory === true, '埋点 return_visit 带间隔天数');
  const n2 = msgs().length;
  await win.TideApp._welcomeBack();
  ok(msgs().length === n2, '同一天再打开不会重复欢迎');

  console.log('── 10f. 关于潮汐：行业数据带来源');
  const Market = require('../shared/market_data.js');
  await win.TideApp.openSheet('about');
  const about = E.sheetBody.innerHTML;
  const shown = Market.facts.filter(f => f.level === 'A' || f.level === 'B');
  ok(shown.length > 0 && shown.every(f => about.includes(f.source.replace(/&/g, '&amp;').replace(/'/g, '&#39;'))), 'A/B 级数据全部展示且带来源', shown.length + ' 条');
  ok(Market.facts.filter(f => f.level === 'C').every(f => !about.includes(f.en.replace(/'/g, '&#39;'))), 'C 级数据不在 App 里展示');
  ok(/not Tide data/.test(about), '注明"不是潮汐自己的数据"');
  win.TideApp.closeSheet();

  console.log('── 11. 删除账号');
  await win.TideApp.deleteAll();
  ok(!store.device(dev), '服务端设备与数据已删除');

  server.close();
  console.log('\n' + '='.repeat(60));
  console.log(fail ? '❌ 失败 ' + fail + ' 项（通过 ' + pass + ' 项）\n  · ' + failures.join('\n  · ') : '✅ 全部通过：' + pass + ' 项');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
