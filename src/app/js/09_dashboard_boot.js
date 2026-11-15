/* 09_dashboard_boot.js · PM dashboard (PRD §16 Demo step 8) + boot
   Two clearly separated blocks:
     · THIS PHONE  — real events from this device, computed with the PRD §9.1 definitions
     · SYNTHETIC   — a seeded fake cohort, watermarked, only to show how the readout & A/B test work */
Views.dashboard = { render(el) {
  const me = LIFE.computeMetrics([{ events: S.events, asOf: now() }]);
  /* this person has written messages here even before the event log knew about it (the log starts after a
     reset) — the message count is what the user can see on their own screen */
  if (S.chat && S.chat.messages && S.chat.messages.some(m => m.who === 'me') && me.counts.firstMsg === 0) { me.counts.firstMsg = 1; me.rates.install_to_first_message = 1; }
  const syn = LIFE.syntheticCohort(400, 7);
  const sm = LIFE.computeMetrics(syn);
  const A = syn.filter(u => u.variant === 'A_character_first'), B = syn.filter(u => u.variant === 'B_intro_first');
  const fa = A.filter(u => u.events.some(e => e.name === 'first_message_sent')).length, fb = B.filter(u => u.events.some(e => e.name === 'first_message_sent')).length;
  const z = LIFE.zTest(fa, A.length, fb, B.length);
  const reply = S.engineStats.filter(x => x.kind === 'reply').slice(-20);
  const avg = k => { const v = reply.map(r => r[k]).filter(x => typeof x === 'number'); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; };
  const tps = reply.filter(r => r.genTokens && r.genMs).map(r => r.genTokens / (r.genMs / 1000));
  const nav_ = S.perf.slice(-30).map(p => p.ms).sort((a, b) => a - b);
  const p95 = nav_.length ? nav_[Math.min(nav_.length - 1, Math.floor(nav_.length * 0.95))] : null;
  const K = [['install_to_first_message', tt('Install → first message', '安装→首条消息')], ['first_conversation_completion', tt('First chat ≥5 msgs', '首次对话≥5条')], ['d1', 'D1'], ['d7', 'D7'],
    ['effective_share', tt('Effective-interaction users', '有效陪伴用户占比')], ['proactive_ctr', tt('Check-in CTR', '主动消息点击率')], ['memory_confirm_rate', tt('Memory confirm rate', '记忆确认率')], ['helpful_rate', tt('Helpful rate', '有帮助率')], ['paywall_conversion', tt('Paywall → purchase', '付费页→购买')]];
  const grid = m => '<div class="kpi">' + K.map(([k, l]) => '<div class="card"><div class="n">' + pct(m.rates[k]) + '</div><div class="l">' + esc(l) + '</div><div class="t">' + tt('target ', '目标 ') + pct(LIFE.TARGETS[k]) + '</div></div>').join('') + '</div>';
  el.innerHTML = topBar(tt('Product dashboard', '产品数据看板')) + '<div class="body">' +
    '<div class="sec">' + tt('This phone — real local events', '这台手机——真实本地埋点') + '</div>' +
    '<div class="tiny" style="margin-bottom:8px">' + tt('One user (you). Rates are per this device only — useful to check the definitions, not a result.', '只有一个用户（你）。比率只代表这台设备——用来核对口径，不是结果。') + '</div>' + grid(me) +
    '<div class="card" style="margin-top:8px"><div class="tiny">' + tt('Events logged: ', '埋点数：') + S.events.length + ' · ' + tt('conversations: ', '对话：') + S.convs.length + ' · ' + tt('effective: ', '有效：') + S.convs.filter(c => c.effective).length + ' · ' + tt('north star (≥3 effective in a week): ', '北极星（一周≥3次有效）：') + (me.counts.northStar ? '✓' : '—') + '</div></div>' +
    '<div class="sec">' + tt('On-device AI performance', '本机 AI 性能') + '</div><div class="card"><div class="kpi">' +
      '<div class="card"><div class="n">' + (avg('firstMs') == null ? '—' : avg('firstMs') + 'ms') + '</div><div class="l">' + tt('first text (avg)', '首字时间（均值）') + '</div><div class="t">PRD P95 ≤ 2000ms</div></div>' +
      '<div class="card"><div class="n">' + (avg('totalMs') == null ? '—' : avg('totalMs') + 'ms') + '</div><div class="l">' + tt('full reply (avg)', '完整回复（均值）') + '</div><div class="t">PRD P95 ≤ 6000ms</div></div>' +
      '<div class="card"><div class="n">' + (tps.length ? (tps.reduce((a, b) => a + b, 0) / tps.length).toFixed(1) : '—') + '</div><div class="l">tokens/s</div></div>' +
      '<div class="card"><div class="n">' + (p95 == null ? '—' : p95 + 'ms') + '</div><div class="l">' + tt('page switch P95', '页面切换 P95') + '</div></div></div>' +
      '<div class="tiny" style="margin-top:8px">' + esc(Engine.status.model || '') + ' · ' + tt('replies measured: ', '已测回复：') + reply.length + '</div></div>' +
    '<div class="sec">' + tt('Experiments (your assignment)', '实验（你的分组）') + '</div><div class="card">' + Object.entries(LIFE.EXPERIMENTS).map(([id, e]) =>
      '<div class="row" style="display:block"><div class="k">' + esc(id) + '</div><div class="tiny">' + tt('metric: ', '指标：') + esc(e.metric) + ' · ' + tt('stop: ', '停止：') + esc(e.stop) + '</div>' +
      '<div style="margin-top:6px">' + seg(e.variants.map(v => [id + '|' + v, v]), id + '|' + VAR[id], 'd.var') + '</div></div>').join('') + '</div>' +
    '<div class="sec">' + tt('Demo cohort', '演示样本') + ' <span class="wm">SYNTHETIC — NOT REAL USERS</span></div>' +
    '<div class="tiny" style="margin-bottom:8px">' + tt('400 seeded fake users whose behaviour comes from made-up probabilities. Shows how the readout works. Never quote these numbers.', '400 个用固定随机种子生成的假用户，行为来自虚构的概率，只用于演示看板和 A/B 怎么读。不能引用这些数字。') + '</div>' + grid(sm) +
    '<div class="card" style="margin-top:8px"><b>onboarding_order_v1 · first_message_rate</b><div class="tiny" style="margin-top:4px">A ' + fa + '/' + A.length + ' = ' + pct(fa / A.length) + ' · B ' + fb + '/' + B.length + ' = ' + pct(fb / B.length) +
      ' · Δ ' + (z.diff * 100).toFixed(1) + 'pt · z=' + z.z.toFixed(2) + ' · p=' + z.p.toFixed(3) + ' → ' + (z.p < 0.05 ? tt('significant at 5%', '5% 水平显著') : tt('not significant — keep running', '不显著——继续跑')) + '</div></div>' +
    '<div class="sec">' + tt('Demo controls', '演示控制') + '</div><div class="stack">' +
      '<button class="btn ghost" data-act="d.nextDay">⏭ ' + tt('Simulate next day (deliver due check-ins)', '模拟到第二天（投递到期的主动消息）') + '</button>' +
      '<button class="btn ghost" data-act="d.testNotif">🔔 ' + tt('Send a test notification in 5 s', '5 秒后发一条测试通知') + '</button>' +
      '<button class="btn ghost" data-act="d.events">' + tt('Show event log', '查看埋点日志') + '</button>' +
      '<div class="tiny">' + tt('Clock offset: ', '时钟偏移：') + Math.round((S.clockOffset || 0) / 3600000) + 'h</div></div></div>';
} };
Actions['d.var'] = a => { const [id, v] = a.split('|'); S.exp.overrides[id] = v; refreshVariants(); save(); track('experiment_override', { experiment_id: id, variant_id: v }); rerender(); };
Actions['d.nextDay'] = () => {
  const c = S.convs.find(x => x.id === S.convId); if (c) endConv(c, 'next_day');
  S.clockOffset = (S.clockOffset || 0) + LIFE.DAY;
  // the play calendar does not go along with a demo jump (see playNow in 10_play.js)
  if (typeof playState === 'function') { const _p = playState(); _p.clockHold = (_p.clockHold || 0) + LIFE.DAY; }
  planProactive();                                 // things that became due "today" get planned now…
  // …then jump to the planned slot (e.g. 19:00) so the demo doesn't wait for the evening
  const next = S.inbox.filter(p => p.status === 'planned').sort((a, b) => a.plannedAt - b.plannedAt)[0];
  if (next && now() < next.plannedAt && next.plannedAt - now() < LIFE.DAY) S.clockOffset += next.plannedAt - now() + 1000;
  deliverDue();
  const got = S.inbox.filter(p => p.status === 'delivered' && !p.outcome).length;
  save(); toast(got ? tt('A check-in arrived — see Home', '收到一条主动消息——去首页看看') : tt('No check-in: ', '没有主动消息：') + (S.lastPlanReason || ''));
  go('home', { reset: true });
};
Actions['d.testNotif'] = () => { if (!BR) { toast(tt('Notifications need the Android app.', '通知需要安卓 App。')); return; } try { BR.scheduleAt(S.character.name, tt('This is a test check-in from Orbit.', '这是一条来自 Orbit 的测试通知。'), Date.now() + 5000); toast(tt('Scheduled — lock the screen or go home.', '已安排——可以锁屏或回到桌面。')); } catch (e) {} };
Actions['d.events'] = () => openSheet('<h2>' + tt('Event log', '埋点日志') + ' (' + S.events.length + ')</h2><div class="tiny" style="margin-top:8px;white-space:pre-wrap;font-family:monospace">' +
  esc(S.events.slice(-60).reverse().map(e => new Date(e.ts).toISOString().slice(5, 19) + ' ' + e.name + ' ' + JSON.stringify(e.props)).join('\n')) + '</div>');

/* ---------------- boot ---------------- */
(function boot() {
  S = load();
  refreshVariants();
  refreshVoiceLang();
  if (!S.user.timezone) S.user.timezone = deviceTz();
  Engine.onStatus(st => {
    if (st.state === 'ready') warmEngine();
    if (nav.stack[nav.stack.length - 1] === 'chat') updateReady();
    const ob = $('#obEngine'); if (ob) ob.textContent = engineLine();
  });
  Engine.prepare();                                // copy/load the on-device model in the background — never awaited
  track('app_open', { opened_from_notification: !!(BR && (() => { try { return BR.lastNotificationOpened(); } catch (e) { return false; } })()) });
  if (S.user.onboarded && S.character) {
    if (Engine.status.state === 'ready') warmEngine();
    deliverDue();
    go('home', { reset: true });
  } else go('welcome', { reset: true });
  setInterval(() => { if (S.user.onboarded) deliverDue(); }, 60000);
  scheduleDueCheck(65000, deliverDue);               // the first check, on the minute grid (see scheduleDueCheck)
  window.__orbitResumed = () => { if (!S.user.onboarded) return; deliverDue(); const c = S.convs.find(x => x.id === S.convId); if (c && !c.ended && now() - c.lastAt > 30 * 60000) endConv(c, 'idle'); };
  window.Orbit = { get state() { return S; }, get busy() { return !!BUSY; }, get screen() { return nav.stack[nav.stack.length - 1]; },
    setVariants(o) { Object.assign(S.exp.overrides, o || {}); refreshVariants(); save(); return Object.assign({}, VAR); },
    go, back, get nav() { return nav; }, send, Actions, Engine, MIND, MEM, LIFE, VERSION, save };   // save() exposed so tests can seed state
})();
