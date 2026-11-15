/* =========================================================================
   server.js · 潮汐 v5 服务端代理
   -------------------------------------------------------------------------
   这个服务做的事，就是"下载即用"背后公司都在做的事：
     1. 静默注册     App 首次启动用安装 ID 换 token，用户无感
     2. 按设备限额   免费 30 轮/天、Plus 300 轮/天；到额度走软上限，不切断
     3. 服务端拼提示词  客户端只发"用户这句话"，人格、安全规则、记忆都在这里拼
                       → 别人截获接口也没法把潮汐当免费通用大模型用
     4. 危机二次拦截  客户端已经拦过一次，服务端再拦一次（客户端可能被改）
     5. 记忆抽取+检索 异步抽取，检索后放进提示词（RAG 的 R 和 A）
     6. 埋点         所有事件写 events 表，供 analytics/ 下的 SQL 算漏斗与留存
     7. A/B 分组     nudge_v1：是否开启晚间主动关怀

   Key 只从环境变量读取（TIDE_UPSTREAM_KEY），永远不进代码、不进日志、不发给客户端。
   没配 Key 时，服务端进入 MOCK 模式：回复明确标注 [mock]，用于本地联调和测试，
   绝不能当成模型效果。

   运行：
     set TIDE_UPSTREAM_KEY=sk-...        （可选，不设就是 mock）
     node --experimental-sqlite server/server.js
   ========================================================================= */
'use strict';
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');
const Core = require('../shared/tide_core.js');
const { open, makeStore } = require('./db.js');

const CFG = {
  port: Number(process.env.TIDE_PORT || 8787),
  dbFile: process.env.TIDE_DB || path.join(__dirname, 'tide.db'),
  /* 默认上游：DeepSeek 官方文档（2026-11-10 查阅）写的是 base_url = https://api.deepseek.com、
     模型名 deepseek-flash（当时由 DeepSeek-V4.1-Flash-1017 提供服务）；旧名 deepseek-chat 已不在文档里。
     模型名会变：上线前以官网为准，用环境变量覆盖，不要改代码。
     注意：本项目没有用真实 Key 调通过这个默认值（开发全程用 mock 与本机 Ollama）。 */
  upstreamBase: (process.env.TIDE_UPSTREAM_BASE || 'https://api.deepseek.com').replace(/\/+$/, ''),
  upstreamKey: process.env.TIDE_UPSTREAM_KEY || '',
  model: process.env.TIDE_MODEL || 'deepseek-flash',
  maxInput: 2000,          // 单条用户消息最多 2000 字符（防止被当成长文本处理网关）
  maxHistory: 12,          // 客户端最多带 12 条历史
  registerPerIpPerHour: 20 // 同一 IP 每小时最多注册 20 台设备（挡批量注册机）
};
const MOCK = !CFG.upstreamKey;

/* ---------------- 小工具 ---------------- */
function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > (limit || 64 * 1024)) { reject(Object.assign(new Error('payload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(Object.assign(new Error('invalid json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function send(res, status, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  }, extra || {}));
  res.end(body);
}
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

/* 注册限流：内存计数即可（单实例原型）；多实例部署要换成 Redis。 */
const regBucket = new Map();
function allowRegister(ip) {
  const hour = Math.floor(Date.now() / 3600000);
  const key = ip + '|' + hour;
  const n = (regBucket.get(key) || 0) + 1;
  regBucket.set(key, n);
  if (regBucket.size > 5000) for (const k of regBucket.keys()) if (!k.endsWith('|' + hour)) regBucket.delete(k);
  return n <= CFG.registerPerIpPerHour;
}

/* ---------------- 上游模型 ----------------
   测试可以用 setUpstream() 换成假的上游（比如让它对抽取请求返回一段 JSON），
   这样"自动抽取记忆 → 第二天问起"这条链路不花钱也能端到端验证。 */
let upstreamOverride = null;
function setUpstream(fn) { upstreamOverride = fn; }
function upstream(messages, maxTokens, temperature) {
  if (upstreamOverride) return Promise.resolve(upstreamOverride(messages, maxTokens, temperature));
  if (MOCK) {
    const last = [...messages].reverse().find(m => m.role === 'user');
    const t = String(last && last.content || '').slice(0, 40);
    return Promise.resolve({ text: '[mock] I hear you: "' + t + '". Tell me more?', tokensIn: 0, tokensOut: 0 });
  }
  const body = JSON.stringify({ model: CFG.model, messages, max_tokens: maxTokens || 300, temperature: temperature ?? 0.8, stream: false });
  const u = new URL(CFG.upstreamBase + '/chat/completions');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname, method: 'POST', timeout: 30000,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CFG.upstreamKey, 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('upstream ' + res.statusCode));
        try {
          const o = JSON.parse(raw);
          const text = (o.choices && o.choices[0] && o.choices[0].message && o.choices[0].message.content) || '';
          resolve({ text, tokensIn: (o.usage && o.usage.prompt_tokens) || 0, tokensOut: (o.usage && o.usage.completion_tokens) || 0 });
        } catch (e) { reject(new Error('upstream parse')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
    req.write(body); req.end();
  });
}


/* ---------------- 记忆抽取（异步，不阻塞回复） ----------------
   每 4 轮抽一次。只有 Plus 自动抽取；免费用户的记忆来自 App 里的手动记忆本。 */
const turnsSinceExtract = new Map();
function maybeExtract(store, dev, history, userText, lang) {
  const plan = Core.PLANS[dev.plan] || Core.PLANS.free;
  if (!plan.autoMemory) return;
  const n = (turnsSinceExtract.get(dev.device_id) || 0) + 1;
  turnsSinceExtract.set(dev.device_id, n);
  if (n < 4) return;
  turnsSinceExtract.set(dev.device_id, 0);
  const convo = history.concat([{ role: 'user', content: userText }]).slice(-10)
    .map(m => (m.role === 'user' ? 'User' : 'Companion') + ': ' + String(m.content).slice(0, 400)).join('\n');
  const prompt = Core.EXTRACT_PROMPT[lang].replace('{{today}}', new Date().toISOString().slice(0, 10)).replace('{{conversation}}', convo);
  upstream([{ role: 'user', content: prompt }], 300, 0.1).then(r => {
    const mems = Core.parseMemories(r.text);
    let added = 0;
    for (const m of mems) if (store.addMemory(dev.device_id, m, 'auto')) added++;
    if (added) store.track(dev.device_id, 'memory_extracted', { added });
  }).catch(() => store.track(dev.device_id, 'memory_extract_failed', {}));
}

/* ---------------- 路由 ---------------- */
function makeServer(store) {
  async function handle(req, res) {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;

    if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true, version: Core.VERSION, mock: MOCK });

    /* 1. 静默注册 */
    if (req.method === 'POST' && p === '/v1/register') {
      if (!allowRegister(clientIp(req))) return send(res, 429, { error: 'too_many_registrations' });
      const b = await readJson(req);
      const country = /^[A-Z]{2}$/.test(String(b.country || '').toUpperCase()) ? String(b.country).toUpperCase() : null;
      const lang = b.lang === 'zh' ? 'zh' : 'en';
      const { deviceId, token } = store.register(country, lang);
      const nudge = store.variant(deviceId, 'nudge_v1', ['control', 'nudge']);
      store.track(deviceId, 'signup', { country, lang, nudge_v1: nudge });
      return send(res, 200, { token, deviceId, plan: 'free', experiments: { nudge_v1: nudge } });
    }

    /* 以下都需要 token */
    const auth = String(req.headers.authorization || '');
    const dev = store.deviceByToken(auth.startsWith('Bearer ') ? auth.slice(7) : '');
    if (!dev) return send(res, 401, { error: 'unauthorized' });

    /* 2. 资料：语言、国家、角色、昵称、年龄确认 */
    if (req.method === 'POST' && p === '/v1/profile') {
      const b = await readJson(req);
      const persona = b.persona && Core.PERSONAS[b.persona] ? b.persona : undefined;
      store.updateProfile(dev.device_id, {
        lang: b.lang === 'zh' || b.lang === 'en' ? b.lang : undefined,
        country: /^[A-Z]{2}$/.test(String(b.country || '')) ? b.country : undefined,
        persona, nickname: b.nickname !== undefined ? String(b.nickname).slice(0, 30) : undefined,
        age_ok: b.age_ok === undefined ? undefined : !!b.age_ok
      });
      if (b.age_ok) store.track(dev.device_id, 'age_confirmed', {});
      if (persona) store.track(dev.device_id, 'persona_selected', { persona, source: b.source || 'settings' });
      return send(res, 200, { ok: true });
    }

    /* 3. 对话 */
    if (req.method === 'POST' && p === '/v1/chat') {
      const t0 = Date.now();
      const b = await readJson(req);
      const text = String(b.text || '').trim();
      if (!text) return send(res, 400, { error: 'empty' });
      if (text.length > CFG.maxInput) return send(res, 413, { error: 'too_long', max: CFG.maxInput });
      if (!dev.age_ok) return send(res, 403, { error: 'age_gate' });

      const lang = b.lang === 'zh' || b.lang === 'en' ? b.lang : Core.detectLang(text, dev.lang || 'en');
      const persona = Core.PERSONAS[b.persona] ? b.persona : (dev.persona || 'tide');
      const plan = Core.PLANS[dev.plan] || Core.PLANS.free;
      if (!plan.personas.includes(persona)) return send(res, 402, { error: 'persona_locked' });

      /* 危机：服务端再拦一次，不调用模型、不计额度 */
      if (Core.isCrisis(text)) {
        store.track(dev.device_id, 'crisis_routed', { lang, layer: 'server' });
        return send(res, 200, { reply: Core.crisisReply(text, lang, dev.country), crisis: true, remaining: plan.daily - store.usedToday(dev.device_id) });
      }

      /* 软上限：到额度时，不调用模型，返回角色的收尾语 + softCap 标记 */
      const used = store.usedToday(dev.device_id);
      if (used >= plan.daily) {
        store.track(dev.device_id, 'paywall_view', { trigger: 'soft_cap', used });
        return send(res, 200, { reply: Core.SOFT_CAP_REPLY[lang], softCap: true, remaining: 0 });
      }

      /* 历史：只接受 role ∈ {user, assistant}，丢掉客户端塞来的 system 消息 */
      const history = (Array.isArray(b.history) ? b.history : []).slice(-CFG.maxHistory)
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map(m => ({ role: m.role, content: m.content.slice(0, CFG.maxInput) }));

      /* 记忆陷阱：问"你还记得 X 吗"而 X 哪儿都没有 → 不调模型，直接承认（不计额度） */
      const allMem = store.memories(dev.device_id);
      const recentUser = history.filter(m => m.role === 'user').map(m => m.content).join('\n');
      const miss = Core.recallMiss(text, allMem.map(m => m.content), recentUser, lang);
      if (miss) {
        store.track(dev.device_id, 'recall_miss', { lang });
        return send(res, 200, { reply: miss, remaining: plan.daily - used, recalled: 0, mock: MOCK });
      }

      /* RAG：检索相关记忆 + 今天/昨天到期的后续事件 */
      const recall = Core.retrieve(allMem, text + ' ' + history.slice(-2).map(m => m.content).join(' '), 5);
      const due = Core.dueFollowups(allMem);
      const sys = Core.buildSystemPrompt({
        persona, lang, nickname: dev.nickname,
        memories: recall.map(m => m.content),
        followups: due.map(m => m.content)
      });

      /* 生成：清洗 → 太敷衍就带提示重生成（最多两次），见 Core.generateReply */
      let r;
      try {
        const messages = [{ role: 'system', content: sys }].concat(history, [{ role: 'user', content: text }]);
        r = await Core.generateReply((msgs, temp) => upstream(msgs, 300, temp), messages, lang);
      } catch (e) {
        store.track(dev.device_id, 'chat_error', { reason: String(e.message).slice(0, 40) });
        return send(res, 502, { error: 'upstream_unavailable', fallback: 'local' });
      }
      const reply = r.text || (lang === 'zh' ? '刚才走神了，你能再说一遍吗？' : 'Sorry, I drifted for a second. Could you say that again?');

      store.countTurn(dev.device_id);
      for (const m of due) store.markFollowed(dev.device_id, m.id);
      store.track(dev.device_id, 'message_sent', {
        persona, lang, len: text.length, turn: used + 1, recalled: recall.length, followups: due.length,
        ms: Date.now() - t0, tin: r.tokensIn, tout: r.tokensOut, retries: r.retries
      });
      maybeExtract(store, dev, history, text, lang);
      return send(res, 200, { reply, remaining: plan.daily - used - 1, recalled: recall.length, mock: MOCK });
    }

    /* 4. 记忆：列出 / 手动添加 / 删除 */
    if (p === '/v1/memory' && req.method === 'GET') return send(res, 200, { memories: store.memories(dev.device_id) });
    if (p === '/v1/memory' && req.method === 'POST') {
      const b = await readJson(req);
      const content = String(b.content || '').trim().slice(0, 120);
      if (content.length < 2) return send(res, 400, { error: 'empty' });
      const due = /^\d{4}-\d{2}-\d{2}$/.test(String(b.due)) ? b.due : null;
      const ok = store.addMemory(dev.device_id, { type: 'status', content, importance: 4, due }, 'manual');
      if (ok) store.track(dev.device_id, 'memory_added', { source: 'manual' });
      return send(res, ok ? 200 : 409, { ok });
    }
    const md = p.match(/^\/v1\/memory\/(\d+)$/);
    if (md && req.method === 'DELETE') {
      const ok = store.deleteMemory(dev.device_id, Number(md[1]));
      if (ok) store.track(dev.device_id, 'memory_deleted', {});
      return send(res, ok ? 200 : 404, { ok });
    }

    /* 5. 主动关怀：App 进入后台时来问"今晚要不要排一条提醒"。
          只有 nudge 组、只有存在到期事件时才返回；control 组永远返回空——这就是 A/B。 */
    if (req.method === 'GET' && p === '/v1/nudge') {
      const v = store.variant(dev.device_id, 'nudge_v1', ['control', 'nudge']);
      if (v !== 'nudge') return send(res, 200, { nudge: null, variant: v });
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const pick = Core.dueFollowups(store.memories(dev.device_id), tomorrow)[0];
      if (!pick) return send(res, 200, { nudge: null, variant: v });
      const lang = dev.lang === 'zh' ? 'zh' : 'en';
      const n = Core.careNudge(pick, dev.persona || 'tide', lang);
      store.track(dev.device_id, 'nudge_scheduled', { memory: pick.id });
      return send(res, 200, { nudge: Object.assign({ memoryId: pick.id }, n), variant: v });
    }

    /* 6. 埋点：客户端事件（onboarding_step、paywall_click、nudge_opened…） */
    if (req.method === 'POST' && p === '/v1/events') {
      const b = await readJson(req);
      const list = Array.isArray(b.events) ? b.events.slice(0, 50) : [];
      // crisis_routed 必须在白名单里：危机多数在客户端就被拦下（离线也要拦），
      // 漏掉它，SB 243 要求的年度"转介次数"就会少算。subscribe 不在这里——订阅只能由服务端自己记录，不能由客户端伪造。
      const ALLOWED = /^(app_open|onboarding_step|onboarding_done|persona_browse|return_visit|paywall_view|paywall_click|nudge_opened|nudge_dismissed|offline_fallback|ai_notice_shown|care_opened|session_end|crisis_routed)$/;
      let n = 0;
      for (const e of list) {
        if (!e || !ALLOWED.test(String(e.name))) continue;
        const ts = e.ts && !isNaN(Date.parse(e.ts)) ? new Date(e.ts).toISOString() : undefined;
        store.track(dev.device_id, e.name, e.props && typeof e.props === 'object' ? e.props : null, ts);
        n++;
      }
      return send(res, 200, { accepted: n });
    }

    /* 7. 订阅：原型只做"模拟购买"，真实上架要接 Google Play Billing 并在服务端验票。 */
    if (req.method === 'POST' && p === '/v1/subscribe') {
      if (process.env.TIDE_ALLOW_FAKE_BILLING !== '1') return send(res, 501, { error: 'billing_not_configured' });
      store.setPlan(dev.device_id, 'plus');
      store.track(dev.device_id, 'subscribe', { plan: 'plus', fake: true });
      return send(res, 200, { plan: 'plus' });
    }

    /* 8. 删除账号与全部数据（隐私：用户可随时清空） */
    if (req.method === 'DELETE' && p === '/v1/me') {
      store.deleteDevice(dev.device_id);
      return send(res, 200, { deleted: true });
    }

    return send(res, 404, { error: 'not_found' });
  }

  return http.createServer((req, res) => {
    handle(req, res).catch(e => {
      const status = e.status || 500;
      if (status === 500) console.error('[tide] ' + req.method + ' ' + req.url + ' -> ' + e.message);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'internal' : e.message });
    });
  });
}

if (require.main === module) {
  const store = makeStore(open(CFG.dbFile));
  makeServer(store).listen(CFG.port, () => {
    console.log('[tide] server v' + Core.VERSION + ' on :' + CFG.port + (MOCK ? '  (MOCK: no TIDE_UPSTREAM_KEY set)' : '  upstream ' + CFG.upstreamBase));
  });
}

module.exports = { makeServer, setUpstream, CFG, MOCK };
