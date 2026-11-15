/* =========================================================================
   app.js · 潮汐 v5 页面逻辑
   -------------------------------------------------------------------------
   构建时由 tools/build_app.js 内联进 index.html（和 shared/tide_core.js 一起）。
   依赖：window.TideCore（共享核心），window.AndroidTide（服务端桥，v5 新增），
         window.AndroidLocal（离线小模型，可选），window.AndroidVoice（系统语音，可选）。

   对话路由（优先级从高到低）：
     1. 危机词表命中        → 本地固定话术 + 当地热线，不发服务端、不调模型
     2. 服务端可用          → /v1/chat（服务端拼提示词、检索记忆、计额度）
     3. 服务端不可用/断网   → 手机内置离线小模型兜底，并上报 offline_fallback
     4. 都不可用            → 明确告诉用户现在连不上，不假装回答
   ========================================================================= */
'use strict';
(function () {
const C = window.TideCore;
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };

/* ---------------- 文案（中英） ---------------- */
const T = {
  en: {
    gateTitle: 'Tide', gateSub: 'A quiet place to talk in the evening.',
    gateAi: 'Tide is an AI companion, not a human. It is not therapy and does not give medical advice. If you are in crisis, contact local emergency services.',
    gateMinor: 'Tide is for adults. AI companions may not be suitable for minors.',
    gateYes: 'I am 18 or older — continue', gateNo: 'I am under 18',
    gateUnder: 'Sorry, Tide is only for adults. If you need someone to talk to, please reach out to a trusted adult or a helpline.',
    onbTitle: 'What kind of night is it?', onbSub: 'Pick the closest one. You can change companions anytime.',
    matchGo: 'Start talking', matchOther: 'Choose someone else',
    placeholder: 'Say anything…', online: 'online', offline: 'offline mode · on-device model',
    remaining: n => n + ' free messages left today',
    aiNotice: C.AI_NOTICE.en,
    connecting: 'Connecting…', serverDown: 'Can\'t reach Tide right now, and the offline model isn\'t available on this device. Please try again in a moment.',
    offlineNote: 'No connection — replying with the on-device model. Replies may be simpler.',
    settings: 'Settings', memory: 'What I remember', memEmpty: 'Nothing yet. Things you choose to share can be saved here.',
    memAdd: 'Add something to remember', memAddBtn: 'Save', memDel: 'Forget',
    memNote: 'Free plan: you add memories yourself. Plus: I also pick up important things from our chats. You can delete anything.',
    lang: 'Language', persona: 'Companion', nickname: 'What should I call you?',
    care: 'Evening check-ins', careDesc: 'If you mention something with a date (an interview, a move), I may check in that evening. At most once a day.',
    careOn: 'On', careOff: 'Off', careBlocked: 'Notifications are turned off for Tide in system settings.',
    clear: 'Clear this chat', deleteAll: 'Delete my account and all data', deleteConfirm: 'This deletes your memories and history on the server. Continue?',
    deleted: 'Deleted. Starting fresh.',
    plusTitle: 'Tide Plus', plusSub: 'Keep the conversation going.',
    planFree: 'Free', planPlus: 'Plus', perMonth: '/ month', perYear: '/ year',
    planFreeList: ['30 messages a day', 'Unlimited on-device replies', 'Memory you add yourself'],
    planPlusList: ['300 messages a day', 'I remember what matters automatically', 'Evening check-ins about your plans'],
    subscribe: 'Start Plus', later: 'Not now', subDone: 'Plus is on. Thank you.',
    subNotReady: 'Purchases aren\'t available in this test build.',
    done: 'Done', aiQuestion: 'Yes — I\'m an AI. I can\'t replace people in your life, but I\'m glad to keep you company.',
    about: 'About Tide', aboutWhy: 'Why Tide exists',
    aboutWhyText: 'Many people have something on their mind at night and no one awake to tell. Tide is a quiet place for that. It is not therapy, and it is not a replacement for the people in your life.',
    aboutMarket: 'Industry context', aboutMarketNote: 'Public figures from third-party sources, not Tide data. Each one lists its source and date.',
    aboutSource: 'Source', aboutChecked: 'checked'
  },
  zh: {
    gateTitle: '潮汐', gateSub: '一个晚上可以说说话的地方。',
    gateAi: '潮汐是 AI 陪伴，不是真人。它不是心理治疗，也不提供医疗建议。如果你处在危机中，请联系当地急救。',
    gateMinor: '潮汐仅面向成年人。AI 陪伴可能不适合未成年人。',
    gateYes: '我已年满 18 岁，继续', gateNo: '我未满 18 岁',
    gateUnder: '抱歉，潮汐只面向成年人。如果你需要倾诉，请找一位信任的大人，或拨打心理援助热线。',
    onbTitle: '今晚是个什么样的晚上？', onbSub: '选最接近的一个。陪伴者之后随时能换。',
    matchGo: '开始聊天', matchOther: '换一个陪伴者',
    placeholder: '说点什么…', online: '在线', offline: '离线模式 · 手机内置模型',
    remaining: n => '今天还剩 ' + n + ' 条免费消息',
    aiNotice: C.AI_NOTICE.zh,
    connecting: '连接中…', serverDown: '现在连不上潮汐，这台手机也没有离线模型。稍后再试一下。',
    offlineNote: '没有网络，正在用手机内置模型回复，回答会简单一些。',
    settings: '设置', memory: '我记得的事', memEmpty: '还没有。你愿意让我记住的事，可以存在这里。',
    memAdd: '添加一件想让我记住的事', memAddBtn: '保存', memDel: '忘掉',
    memNote: '免费版：记忆由你自己添加。Plus：我也会从聊天里记下重要的事。任何一条都能删除。',
    lang: '语言', persona: '陪伴者', nickname: '想让我怎么称呼你？',
    care: '晚间关怀', careDesc: '如果你提到有日期的事（面试、搬家），我可能会在那天晚上问一句。一天最多一次。',
    careOn: '开', careOff: '关', careBlocked: '系统设置里关闭了潮汐的通知。',
    clear: '清空本次对话', deleteAll: '删除账号和全部数据', deleteConfirm: '这会删除服务端上的记忆和记录。继续吗？',
    deleted: '已删除，重新开始。',
    plusTitle: '潮汐 Plus', plusSub: '让对话继续下去。',
    planFree: '免费', planPlus: 'Plus', perMonth: '/ 月', perYear: '/ 年',
    planFreeList: ['每天 30 条消息', '离线回复不限', '记忆由你手动添加'],
    planPlusList: ['每天 300 条消息', '自动记住重要的事', '针对你的安排做晚间关怀'],
    subscribe: '开通 Plus', later: '以后再说', subDone: 'Plus 已开通，谢谢你。',
    subNotReady: '这个测试版还不能购买。',
    done: '完成', aiQuestion: '是的，我是 AI。我替代不了你身边的人，但很愿意陪你待一会儿。',
    about: '关于潮汐', aboutWhy: '为什么做潮汐',
    aboutWhyText: '很多人晚上心里有话，身边却没有醒着的人可以说。潮汐想做那个安静的地方——它不是心理治疗，也替代不了你身边的人。',
    aboutMarket: '行业背景', aboutMarketNote: '以下是第三方公开数据，不是潮汐自己的数据。每一条都写了来源和日期。',
    aboutSource: '来源', aboutChecked: '核对于'
  }
};

/* ---------------- 状态 ---------------- */
const K = { lang: 'tide5.lang', age: 'tide5.age', persona: 'tide5.persona', chat: 'tide5.chat', nick: 'tide5.nick',
  plan: 'tide5.plan', exp: 'tide5.exp', notice: 'tide5.notice', care: 'tide5.care', localMem: 'tide5.localMem', onb: 'tide5.onb',
  lastSeen: 'tide5.lastSeen' };
const S = {
  lang: load(K.lang, null) || (window.AndroidTide ? window.AndroidTide.systemLang() : (navigator.language || 'en').startsWith('zh') ? 'zh' : 'en'),
  persona: load(K.persona, null),
  history: load(K.chat, []),
  nick: load(K.nick, ''),
  plan: load(K.plan, 'free'),
  exp: load(K.exp, {}),
  care: load(K.care, false),
  remaining: null,
  online: null,
  busy: false,
  matched: null
};
const L = () => T[S.lang];
const country = () => (window.AndroidTide ? window.AndroidTide.country() : 'US');
const P = id => C.PERSONAS[id] || C.PERSONAS.tide;

function i18n() {
  document.documentElement.lang = S.lang;
  document.querySelectorAll('[data-i18n]').forEach(e => { const v = L()[e.dataset.i18n]; if (typeof v === 'string') e.textContent = v; });
  const inp = $('inp'); if (inp) inp.placeholder = L().placeholder;
}
function setLang(l) { S.lang = l === 'zh' ? 'zh' : 'en'; save(K.lang, S.lang); i18n(); api('POST', '/v1/profile', { lang: S.lang }); }
function go(id) { document.querySelectorAll('.screen').forEach(s => s.classList.remove('on')); $(id).classList.add('on'); }

/* ---------------- 服务端桥 ---------------- */
let seq = 0; const pending = {};
window.__tideApi = function (id, status, body) {
  const cb = pending[id]; if (!cb) return; delete pending[id];
  let j = null; try { j = JSON.parse(body); } catch (e) {}
  cb(status, j || {});
};
function api(method, path, body) {
  return new Promise(resolve => {
    if (!window.AndroidTide) return resolve({ status: 0, body: { error: 'no_bridge' } });
    const id = 'a' + (++seq);
    pending[id] = (status, j) => resolve({ status, body: j });
    try { window.AndroidTide.call(method, path, body ? JSON.stringify(body) : '', id); }
    catch (e) { delete pending[id]; resolve({ status: 0, body: { error: 'bridge' } }); }
    setTimeout(() => { if (pending[id]) { delete pending[id]; resolve({ status: 0, body: { error: 'timeout' } }); } }, 45000);
  });
}
function register() {
  return new Promise(resolve => {
    if (!window.AndroidTide) return resolve(false);
    if (window.AndroidTide.hasToken()) return resolve(true);
    const id = 'r' + (++seq);
    pending[id] = (status, j) => {
      if (status === 200) { S.exp = j.experiments || {}; save(K.exp, S.exp); S.plan = j.plan || 'free'; save(K.plan, S.plan); }
      resolve(status === 200);
    };
    window.AndroidTide.register(S.lang, id);
  });
}

/* 埋点：先攒在内存里，攒够或页面切后台时一次发出 */
const evq = [];
function track(name, props) { evq.push({ name, props: props || {}, ts: new Date().toISOString() }); if (evq.length >= 10) flush(); }
function flush() { if (!evq.length) return; const batch = evq.splice(0, evq.length); api('POST', '/v1/events', { events: batch }); }
document.addEventListener('visibilitychange', () => { if (document.hidden) { flush(); maybeScheduleNudge(); } });

/* ---------------- 1. 年龄与 AI 身份 ---------------- */
async function confirmAge() {
  $('btnAge').disabled = true;
  save(K.age, true);
  const ok = await register();
  S.online = ok;
  if (ok) await api('POST', '/v1/profile', { age_ok: true, lang: S.lang, country: country() });
  track('onboarding_step', { step: 'age' });
  if (S.persona && S.history.length) return bootChat();
  renderOnboard(); go('s-onboard');
}
function underAge() { $('gateMsg').textContent = L().gateUnder; $('btnAge').disabled = true; }

/* ---------------- 2. 新手引导 ---------------- */
function renderOnboard() {
  $('onbChoices').innerHTML = C.ONBOARD.map(o =>
    '<div class="choice" onclick="TideApp.pick(\'' + o.id + '\')">' + esc(o.label[S.lang]) + '</div>').join('');
  track('onboarding_step', { step: 'question_shown' });
}
function pick(choiceId) {
  const o = C.ONBOARD.find(x => x.id === choiceId); if (!o) return;
  S.matched = o;
  const p = P(o.persona);
  $('matchAva').textContent = p.emoji;
  $('matchName').textContent = p.name[S.lang] + ' · ' + p.tag[S.lang];
  $('matchDesc').textContent = p.desc[S.lang] + '\n\n“' + p.sample[S.lang] + '”';
  $('matchAll').innerHTML = '';
  track('onboarding_step', { step: 'choice', choice: choiceId, persona: o.persona });
  go('s-match');
}
/* 角色发现：每张卡 = 名字 + 性格标签 + 一句话介绍 + TA 会怎么开口（sample）。
   "TA 会怎么开口"比任何形容词都直观——用户是凭语气选人的，不是凭标签。 */
function personaCard(p, onclick) {
  return '<div class="choice' + (p.id === S.persona ? ' on' : '') + '" onclick="' + onclick + '">' + p.emoji + ' ' + esc(p.name[S.lang]) +
    ' <span class="tag">' + esc(p.tag[S.lang]) + '</span>' +
    '<div class="hint" style="margin-top:4px">' + esc(p.desc[S.lang]) + '</div>' +
    '<div class="hint" style="margin-top:6px;color:var(--txt);font-style:italic">“' + esc(p.sample[S.lang]) + '”</div></div>';
}
function showAllPersonas() {
  $('matchAll').innerHTML = Object.values(C.PERSONAS).map(p => personaCard(p, 'TideApp.choose(\'' + p.id + '\')')).join('');
  track('persona_browse', { from: 'onboarding', matched: S.matched && S.matched.persona });
}
async function choose(pid) { await setPersona(pid, 'onboarding_other'); startChat(null); }
async function startWithMatch() { await setPersona(S.matched.persona, 'onboarding'); startChat(S.matched.opener[S.lang]); }
/* 必须等服务端确认后再进聊天：否则用户手快发出第一句时，服务端还没收到角色，第一条回复会用错角色。
   每条 /v1/chat 也带 persona 字段，这里只是让服务端记录与埋点保持一致。 */
function setPersona(pid, source) {
  S.persona = pid; save(K.persona, pid);
  return api('POST', '/v1/profile', { persona: pid, source });
}
function startChat(opener) {
  save(K.onb, true);
  track('onboarding_done', { persona: S.persona });
  if (!S.history.length) {
    const first = opener || C.ONBOARD.find(o => o.persona === S.persona)?.opener[S.lang] || L().placeholder;
    S.history.push({ role: 'assistant', content: first });
    save(K.chat, S.history);
  }
  bootChat();
}

/* ---------------- 3. 聊天 ---------------- */
function bootChat() {
  const p = P(S.persona);
  $('chatAva').textContent = p.emoji;
  $('chatName').textContent = p.name[S.lang];
  i18n(); go('s-chat');
  renderHistory(); updateStatus(); showAiNotice();
  if (window.AndroidTide && window.AndroidTide.lastNudgeOpened()) track('nudge_opened', {});
  track('app_open', { persona: S.persona });
  welcomeBack();
}

/* 回访承接：隔 ≥2 天再来，角色先开口（引用一件对方说过的具体事，没有就只问近况）。
   lastSeen 用"本地自然日"算，晚上 11 点来、第二天凌晨 1 点再来不算隔天。 */
const dayNo = t => Math.floor((t - new Date(t).getTimezoneOffset() * 60000) / 86400000);
async function welcomeBack() {
  const now = Date.now();
  const last = load(K.lastSeen, 0);
  save(K.lastSeen, now);
  if (!last || !S.history.length) return;
  const gap = dayNo(now) - dayNo(last);
  if (gap < 2) return;
  let mem = null;
  const r = await api('GET', '/v1/memory');
  if (r.status === 200 && Array.isArray(r.body.memories)) mem = r.body.memories.find(m => (m.importance || 3) >= 3) || null;
  else { const local = load(K.localMem, []); if (local.length) mem = { content: local[local.length - 1] }; }
  const text = C.returnGreeting(S.persona, S.lang, gap, mem);
  if (!text) return;
  bubble('ai', text);
  S.history.push({ role: 'assistant', content: text }); save(K.chat, S.history);
  track('return_visit', { gap_days: gap, with_memory: !!mem, persona: S.persona });
}
function renderHistory() {
  $('msgs').innerHTML = '';
  S.history.forEach(m => bubble(m.role === 'user' ? 'me' : 'ai', m.content, m.kind));
}
function bubble(who, text, kind) {
  const row = document.createElement('div'); row.className = 'msg' + (who === 'me' ? ' me' : '');
  const av = document.createElement('div'); av.className = 'av'; av.textContent = who === 'me' ? '🙂' : P(S.persona).emoji;
  const b = document.createElement('div'); b.className = 'bub' + (kind ? ' ' + kind : ''); b.textContent = text;
  row.appendChild(av); row.appendChild(b); $('msgs').appendChild(row);
  b._row = row;   // 离线提示要插在这一行之前（b.parentNode 在部分 WebView 版本里取不到 row 的引用）
  $('msgs').scrollTop = $('msgs').scrollHeight;
  return b;
}
function sys(text) { const d = document.createElement('div'); d.className = 'sys'; d.textContent = text; $('msgs').appendChild(d); $('msgs').scrollTop = $('msgs').scrollHeight; }
function updateStatus() {
  const p = P(S.persona);
  const life = C.lifeStatus(S.persona, S.lang, new Date(), new Date().getHours());
  let st = (S.online === false ? L().offline : life);
  if (S.online !== false && S.plan === 'free' && S.remaining != null && S.remaining <= 10) st += ' · ' + L().remaining(S.remaining);
  $('chatStatus').textContent = st;
  $('chatName').textContent = p.name[S.lang];
}
/* 纽约 §1700：每次开始互动时提示一次，连续使用每 3 小时再提示 */
function showAiNotice() {
  const last = load(K.notice, 0);
  if (!C.needsAiNotice(last, Date.now())) { $('aiNotice').style.display = 'none'; return; }
  $('aiNotice').textContent = L().aiNotice; $('aiNotice').style.display = 'block';
  save(K.notice, Date.now()); track('ai_notice_shown', {});
}
setInterval(() => { if ($('s-chat').classList.contains('on')) showAiNotice(); }, 10 * 60 * 1000);

function autoGrow(t) { t.style.height = 'auto'; t.style.height = Math.min(120, t.scrollHeight) + 'px'; }

async function sendMsg() {
  if (S.busy) return;
  const inp = $('inp'); const text = (inp.value || '').trim();
  if (!text) return;
  inp.value = ''; autoGrow(inp);
  bubble('me', text);
  const history = S.history.slice(-12);
  S.history.push({ role: 'user', content: text }); save(K.chat, S.history);

  /* 1. 危机：本地先拦（离线也必须拦得住） */
  if (C.isCrisis(text)) {
    const r = C.crisisReply(text, C.detectLang(text, S.lang), country());
    bubble('ai', r, 'crisis');
    S.history.push({ role: 'assistant', content: r, kind: 'crisis' }); save(K.chat, S.history);
    track('crisis_routed', { layer: 'client' }); flush();
    return;
  }
  /* 被问"你是 AI 吗"：如实回答，不交给模型临场发挥 */
  if (/(are you (an? )?(ai|bot|robot|human|real))|(你是(不是)?(ai|AI|机器人|真人))/i.test(text)) {
    bubble('ai', L().aiQuestion);
    S.history.push({ role: 'assistant', content: L().aiQuestion }); save(K.chat, S.history);
    return;
  }

  S.busy = true; $('sendBtn').disabled = true;
  const b = bubble('ai', ''); b.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';

  /* 2. 服务端 */
  let reply = null, kind = null;
  const r = await api('POST', '/v1/chat', { text, history, persona: S.persona, lang: C.detectLang(text, S.lang) });
  if (r.status === 200 && r.body.reply) {
    S.online = true;
    reply = r.body.reply;
    if (r.body.crisis) kind = 'crisis';
    if (typeof r.body.remaining === 'number') S.remaining = r.body.remaining;
    if (r.body.softCap) { setTimeout(() => openSheet('plus', 'soft_cap'), 900); }
  } else if (r.status === 401) {
    if (window.AndroidTide && !window.AndroidTide.hasToken()) { await register(); }
  } else if (r.status === 403 && r.body.error === 'age_gate') {
    await api('POST', '/v1/profile', { age_ok: true });
  }

  /* 3. 离线兜底 */
  if (!reply && window.AndroidLocal) {
    S.online = false; updateStatus();
    // 提示插在回复气泡之前（气泡已经先建好了），否则提示会出现在回复下面，看起来像是"最后一条"
    const note = document.createElement('div'); note.className = 'sys'; note.textContent = L().offlineNote;
    $('msgs').insertBefore(note, b._row);
    track('offline_fallback', { status: r.status });
    reply = await localReply(text, history);
  }

  S.busy = false; $('sendBtn').disabled = false;
  if (!reply) { b.textContent = L().serverDown; b.classList.add('err'); S.history.pop(); save(K.chat, S.history); return; }
  b.textContent = reply; if (kind) b.classList.add(kind);
  S.history.push({ role: 'assistant', content: reply, kind }); save(K.chat, S.history);
  if (S.history.length > 80) { S.history = S.history.slice(-80); save(K.chat, S.history); }
  updateStatus(); speak(reply);
}

/* 离线：提示词在本地拼，记忆只用本机手动记忆本（服务端记忆此时拿不到） */
function localReply(text, history) {
  const mems = load(K.localMem, []);
  const lang = C.detectLang(text, S.lang);
  /* 记忆陷阱：离线时同样不让小模型编造（离线小模型比云端更爱编） */
  const miss = C.recallMiss(text, mems, history.filter(m => m.role === 'user').map(m => m.content).join(' '), lang);
  if (miss) return Promise.resolve(miss);
  return new Promise(resolve => {
    const sysPrompt = C.buildSystemPrompt({ persona: S.persona, lang, nickname: S.nick,
      memories: C.retrieve(mems.map(c => ({ content: c, importance: 4 })), text, 3).map(m => m.content) });
    const id = 'l' + (++seq);
    window.__tideResult = window.__tideResult || function (rid, ok, payload) { const cb = pending[rid]; if (cb) { delete pending[rid]; cb(ok, payload); } };
    pending[id] = (ok, payload) => resolve(ok ? C.cleanReply(String(payload || '').replace(/<\|im_end\|>[\s\S]*$/, '')) || null : null);
    const messages = [{ role: 'system', content: sysPrompt }].concat(history.slice(-4), [{ role: 'user', content: text }]);
    try { window.AndroidLocal.run(JSON.stringify({ messages }), id); } catch (e) { delete pending[id]; resolve(null); }
    setTimeout(() => { if (pending[id]) { delete pending[id]; resolve(null); } }, 180000);
  });
}

function speak(text) {
  if (!window.AndroidVoice || !load('tide5.voice', false)) return;
  const p = P(S.persona);
  try { window.AndroidVoice.speak(text, p.rate, p.pitch); } catch (e) {}
}
function toggleMic() {
  const btn = $('micBtn');
  if (!window.AndroidVoice) return sys('Voice input is not available here.');
  if (btn.classList.contains('rec')) { btn.classList.remove('rec'); try { window.AndroidVoice.stopListening(); } catch (e) {} return; }
  btn.classList.add('rec'); try { window.AndroidVoice.startListening(); } catch (e) { btn.classList.remove('rec'); }
}
window.__tideSpeech = t => { if (t) { $('inp').value = t; sendMsg(); } };
window.__tideSpeechEnd = () => $('micBtn').classList.remove('rec');
window.__tideSpeechError = m => { $('micBtn').classList.remove('rec'); if (m) sys(m); };
window.__tideMicGranted = () => {};

/* ---------------- 抽屉：设置 / 记忆 / 付费墙 ---------------- */
async function openSheet(kind, trigger) {
  const body = $('sheetBody');
  if (kind === 'settings') body.innerHTML = settingsHtml();
  if (kind === 'memory') { body.innerHTML = '<h2>' + esc(L().memory) + '</h2><div class="hint">' + esc(L().connecting) + '</div>'; renderMemory(); }
  if (kind === 'plus') { body.innerHTML = plusHtml(); track('paywall_view', { trigger: trigger || 'settings' }); }
  if (kind === 'about') body.innerHTML = aboutHtml();
  $('sheet').classList.add('on');
}
function closeSheet() { $('sheet').classList.remove('on'); updateStatus(); }

function settingsHtml() {
  const l = L();
  return '<h2>' + esc(l.settings) + '</h2>' +
    '<div class="divider"></div><div class="switch"><span>' + esc(l.lang) + '</span><span>' +
      '<button class="btn ghost sm" style="width:auto" onclick="TideApp.setLang(\'en\');TideApp.openSheet(\'settings\')">English</button> ' +
      '<button class="btn ghost sm" style="width:auto" onclick="TideApp.setLang(\'zh\');TideApp.openSheet(\'settings\')">中文</button></span></div>' +
    '<div class="divider"></div><div class="hint">' + esc(l.persona) + '</div>' +
      Object.values(C.PERSONAS).map(p => personaCard(p, 'TideApp.switchPersona(\'' + p.id + '\')')).join('') +
    '<div class="divider"></div><div class="hint">' + esc(l.nickname) + '</div>' +
      '<input id="nickInp" value="' + esc(S.nick) + '" maxlength="30" onchange="TideApp.setNick(this.value)">' +
    '<div class="divider"></div><div class="switch"><span>' + esc(l.care) + '</span>' +
      '<button class="btn ghost sm" style="width:auto" onclick="TideApp.toggleCare()">' + esc(S.care ? l.careOn : l.careOff) + '</button></div>' +
      '<div class="hint">' + esc(l.careDesc) + '</div><div class="hint" id="careHint"></div>' +
    '<div class="divider"></div>' +
      (S.plan === 'free' ? '<button class="btn" onclick="TideApp.openSheet(\'plus\',\'settings\')">' + esc(l.plusTitle) + '</button>' : '<div class="hint">✓ ' + esc(l.plusTitle) + '</div>') +
      '<button class="btn ghost sm" style="margin-top:10px" onclick="TideApp.openSheet(\'about\')">' + esc(l.about) + '</button>' +
      '<button class="btn ghost sm" style="margin-top:8px" onclick="TideApp.clearChat()">' + esc(l.clear) + '</button>' +
      '<button class="btn ghost sm" style="margin-top:8px;color:#f5a3a3" onclick="TideApp.deleteAll()">' + esc(l.deleteAll) + '</button>' +
    '<button class="btn" style="margin-top:16px" onclick="TideApp.closeSheet()">' + esc(l.done) + '</button>';
}
function switchPersona(pid) { if (pid === S.persona) return closeSheet(); setPersona(pid, 'settings'); S.history.push({ role: 'assistant', content: C.ONBOARD.find(o => o.persona === pid)?.opener[S.lang] || '…' }); save(K.chat, S.history); closeSheet(); bootChat(); }
function setNick(v) { S.nick = String(v || '').trim().slice(0, 30); save(K.nick, S.nick); api('POST', '/v1/profile', { nickname: S.nick }); }
function clearChat() { S.history = []; save(K.chat, []); closeSheet(); startChat(null); }
async function deleteAll() {
  if (!confirm(L().deleteConfirm)) return;
  await api('DELETE', '/v1/me');
  Object.values(K).forEach(k => localStorage.removeItem(k));
  alert(L().deleted); location.reload();
}

/* 晚间关怀：只有用户打开、且服务端判定为 nudge 组并且有到期事件时，才会真的排通知 */
function toggleCare() {
  if (!S.care && window.AndroidTide && !window.AndroidTide.notificationsAllowed()) {
    window.__tideNotifResult = ok => { if (ok) { S.care = true; save(K.care, true); } else $('careHint').textContent = L().careBlocked; openSheet('settings'); };
    window.AndroidTide.requestNotifications(); return;
  }
  S.care = !S.care; save(K.care, S.care);
  if (!S.care && window.AndroidTide) { window.AndroidTide.cancelNudge(); track('nudge_dismissed', { action: 'disable' }); }
  openSheet('settings');
}
async function maybeScheduleNudge() {
  if (!S.care || !window.AndroidTide) return;
  const r = await api('GET', '/v1/nudge');
  if (r.status === 200 && r.body.nudge) window.AndroidTide.scheduleNudge(r.body.nudge.title, r.body.nudge.body, 20);
}

/* 记忆本：服务端为准；离线时显示本机手动记忆 */
async function renderMemory() {
  const l = L();
  const r = await api('GET', '/v1/memory');
  const server = r.status === 200 ? (r.body.memories || []) : null;
  const local = load(K.localMem, []);
  const rows = server
    ? server.map(m => '<div class="mem"><div>' + esc(m.content) + (m.due ? ' <span class="tag">' + esc(m.due) + '</span>' : '') +
        (m.source === 'auto' ? ' <span class="tag">auto</span>' : '') + '</div>' +
        '<button class="btn ghost sm" style="width:auto" onclick="TideApp.delMem(' + m.id + ')">' + esc(l.memDel) + '</button></div>').join('')
    : local.map((c, i) => '<div class="mem"><div>' + esc(c) + '</div><button class="btn ghost sm" style="width:auto" onclick="TideApp.delLocalMem(' + i + ')">' + esc(l.memDel) + '</button></div>').join('');
  $('sheetBody').innerHTML = '<h2>' + esc(l.memory) + '</h2><div class="hint">' + esc(l.memNote) + '</div>' +
    '<div style="margin-top:12px">' + (rows || '<div class="hint">' + esc(l.memEmpty) + '</div>') + '</div>' +
    '<div class="divider"></div><div class="hint">' + esc(l.memAdd) + '</div>' +
    '<input id="memInp" maxlength="120" style="margin-top:6px"><input id="memDue" type="date" style="margin-top:8px">' +
    '<button class="btn sm" style="margin-top:8px" onclick="TideApp.addMem()">' + esc(l.memAddBtn) + '</button>' +
    '<button class="btn" style="margin-top:16px" onclick="TideApp.closeSheet()">' + esc(l.done) + '</button>';
}
async function addMem() {
  const c = String($('memInp').value || '').trim(); if (c.length < 2) return;
  const due = $('memDue').value || null;
  const local = load(K.localMem, []); if (!local.includes(c)) { local.push(c); save(K.localMem, local.slice(-30)); }
  await api('POST', '/v1/memory', { content: c, due });
  renderMemory();
}
async function delMem(id) { await api('DELETE', '/v1/memory/' + id); renderMemory(); }
function delLocalMem(i) { const local = load(K.localMem, []); local.splice(i, 1); save(K.localMem, local); renderMemory(); }

/* 关于潮汐：产品为什么存在 + 行业背景数据。
   数据只来自 shared/market_data.js（与 docs/29 同一份），只展示 A/B 级、且必须带来源和日期。
   不展示潮汐自己的任何"用户数"——我们还没有。 */
function aboutHtml() {
  const l = L();
  const M = window.TideMarket || { facts: [] };
  const facts = M.facts.filter(f => f.level === 'A' || f.level === 'B');
  return '<h2>' + esc(l.about) + '</h2>' +
    '<div class="hint" style="color:var(--txt)"><b>' + esc(l.aboutWhy) + '</b></div><div class="sub">' + esc(l.aboutWhyText) + '</div>' +
    '<div class="divider"></div><div class="hint" style="color:var(--txt)"><b>' + esc(l.aboutMarket) + '</b></div><div class="hint">' + esc(l.aboutMarketNote) + '</div>' +
    facts.map(f => '<div class="mem" style="display:block"><div>' + esc(f[S.lang] || f.en) + '</div>' +
      '<div class="tag" style="margin-top:4px">' + esc(l.aboutSource) + ': ' + esc(f.source) + ' · ' + esc(f.date) + ' · ' + esc(l.aboutChecked) + ' ' + esc(M.checked) + '</div></div>').join('') +
    '<button class="btn" style="margin-top:16px" onclick="TideApp.closeSheet()">' + esc(l.done) + '</button>';
}

/* 付费墙：软上限触发时出现，不切断当前对话 */
function plusHtml() {
  const l = L();
  const li = a => a.map(x => '<div class="hint">· ' + esc(x) + '</div>').join('');
  return '<h2>' + esc(l.plusTitle) + '</h2><div class="sub">' + esc(l.plusSub) + '</div>' +
    '<div class="plan"><b>' + esc(l.planFree) + '</b>' + li(l.planFreeList) + '</div>' +
    '<div class="plan best"><b>' + esc(l.planPlus) + '</b> — $7.99 ' + esc(l.perMonth) + ' · $59.99 ' + esc(l.perYear) + li(l.planPlusList) + '</div>' +
    '<button class="btn" style="margin-top:14px" onclick="TideApp.subscribe()">' + esc(l.subscribe) + '</button>' +
    '<button class="btn ghost sm" style="margin-top:8px" onclick="TideApp.closeSheet()">' + esc(l.later) + '</button><div class="hint" id="subMsg"></div>';
}
async function subscribe() {
  track('paywall_click', {});
  const r = await api('POST', '/v1/subscribe', {});
  if (r.status === 200) { S.plan = 'plus'; save(K.plan, 'plus'); $('subMsg').textContent = L().subDone; S.remaining = null; }
  else $('subMsg').textContent = L().subNotReady;
}

/* 返回键 */
window.__tideBack = function () {
  if ($('sheet').classList.contains('on')) { closeSheet(); return 'handled'; }
  if ($('s-match').classList.contains('on')) { go('s-onboard'); return 'handled'; }
  flush(); return 'exit';
};
window.__tideResumed = () => { if ($('s-chat').classList.contains('on')) showAiNotice(); };

/* ---------------- 启动 ---------------- */
function boot() {
  i18n();
  if (load(K.age, false) && S.persona && load(K.onb, false)) {
    register().then(ok => { S.online = ok; bootChat(); });
    return;
  }
  if (load(K.age, false)) { register().then(ok => { S.online = ok; }); renderOnboard(); go('s-onboard'); return; }
  go('s-gate');
}

window.TideApp = { setLang, confirmAge, underAge, pick, choose, showAllPersonas, startWithMatch, sendMsg, toggleMic, autoGrow,
  openSheet, closeSheet, switchPersona, setNick, toggleCare, clearChat, deleteAll, addMem, delMem, delLocalMem, subscribe,
  _state: () => S, _track: track, _flush: flush, _scheduleNudge: maybeScheduleNudge, _welcomeBack: welcomeBack,
  addMemFromTest: c => api('POST', '/v1/memory', { content: c }) };
/* 页面里 onclick 直接调用的全局函数 */
Object.assign(window, { setLang, confirmAge, underAge, startWithMatch, showAllPersonas, sendMsg, toggleMic, autoGrow, openSheet, closeSheet });
boot();
})();
