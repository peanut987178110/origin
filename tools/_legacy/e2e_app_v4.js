/* =============================================================
   e2e_app.js · 产品端到端测试（真实页面代码）
   -------------------------------------------------------------
   跑的是 src/app/index.html 里的真实脚本（DOM 桩），覆盖用户完整路径：
     ① 注册 / 登录 / 错误处理
     ② 12 个角色、6 个分组，选角色 → 换头像 → 调声音
     ③ 服务商预设（DeepSeek 等 9 家）、地址校验、API Key 保存与打码
     ④ 与「OpenAI 兼容」服务对话：本地起一个模拟 DeepSeek 的 SSE 服务，
        验证 Authorization 头、流式拼接、错误翻译（401/402/429/404）
     ⑤ 真实模型对话：本机 Ollama 的 /v1 接口（同一套协议），测 3 个角色
     ⑥ 危机硬规则、记忆抽取、账号与 Key 隔离
   用法：node tools/e2e_app.js
         （第 ⑤ 部分需要 Ollama 在跑；没跑则跳过并标注）
   ============================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'src', 'app', 'index.html'), 'utf8');
const OLLAMA = process.env.TIDE_OLLAMA || 'http://10.10.1.52:11434';
const OLLAMA_MODEL = process.env.TIDE_MODEL || 'qwen2.5:3b';

let pass = 0, fail = 0, skip = 0; const failures = [];
const ok = (c, n, d) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; failures.push(n + (d ? ' :: ' + d : '')); console.log('  ❌ ' + n + (d ? '\n     ' + d : '')); } };
const wait = (cond, ms = 60000) => new Promise((res, rej) => { const t0 = Date.now(); const iv = setInterval(() => {
  if (cond()) { clearInterval(iv); res(); } else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('超时')); } }, 50); });

/* ---------------- DOM 桩 ---------------- */
function makeEl(id) {
  const e = { id, value: '', textContent: '', innerHTML: '', disabled: false, children: [], dataset: {}, style: {},
    scrollTop: 0, scrollHeight: 0, parentNode: null,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); },
      toggle(c, on) { (on === undefined ? !this._s.has(c) : on) ? this._s.add(c) : this._s.delete(c); } },
    appendChild(c) { c.parentNode = e; e.children.push(c); return c; },
    remove() { if (e.parentNode) e.parentNode.children = e.parentNode.children.filter(x => x !== e); e.parentNode = null; } };
  Object.defineProperty(e, 'className', { get() { return [...e.classList._s].join(' '); },
    set(v) { e.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); } });
  return e;
}
const els = {};
const byId = id => els[id] || (els[id] = makeEl(id));
for (const m of html.matchAll(/id="([^"]+)"/g)) byId(m[1]);
const screens = [...html.matchAll(/<section class="screen[^"]*" id="([^"]+)"/g)].map(m => m[1]);
byId('s-auth').classList.add('on');
/* renderModelForm 用 innerHTML 生成输入框：解析出带 id 的 input/select 并给出默认值 */
function hydrate(htmlStr) {
  for (const m of htmlStr.matchAll(/<(input|select|datalist|div)\s[^>]*id="([^"]+)"[^>]*>/g)) {
    const e = byId(m[2]); const v = m[0].match(/\svalue="([^"]*)"/);
    e.value = v ? v[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"') : '';
    if (m[1] === 'select') { const sel = htmlStr.match(new RegExp('<option value="([^"]+)" selected')); if (sel) e.value = sel[1]; }
  }
}
['setupForm', 'sheetModelForm'].forEach(id => {
  const e = byId(id); let h = '';
  Object.defineProperty(e, 'innerHTML', { get() { return h; }, set(v) { h = v; hydrate(v); } });
});

const store = {}, sess = {};
const mkStorage = o => ({ getItem: k => (k in o ? o[k] : null), setItem: (k, v) => { o[k] = String(v); }, removeItem: k => { delete o[k]; } });
global.localStorage = mkStorage(store);
global.sessionStorage = mkStorage(sess);
global.document = { getElementById: byId, createElement: () => makeEl(''),
  querySelectorAll: sel => sel === '.screen' ? screens.map(byId) : [] };
global.window = global;

const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).pop();
vm.runInThisContext(code, { filename: 'src/app/index.html' });
const T = window.TIDE;
const screenOn = () => screens.find(id => byId(id).classList.contains('on'));

/* ---------------- 模拟一个 DeepSeek（OpenAI 兼容 SSE） ---------------- */
let lastReq = null; let mode = 'ok';
const mock = http.createServer((req, res) => {
  let body = ''; req.on('data', d => body += d);
  req.on('end', () => {
    lastReq = { url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null };
    if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] })); }
    const err = { e401: [401, 'Authentication Fails, invalid api key'], e402: [402, 'Insufficient Balance'],
                  e429: [429, 'Rate limit reached'], e404: [404, 'Model Not Exist'] }[mode];
    if (err) { res.writeHead(err[0], { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: err[1] } })); }
    if (lastReq.body && lastReq.body.stream === false) {
      const isMem = /长期记住/.test(JSON.stringify(lastReq.body.messages));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { content: isMem ? '1. 养了一只猫叫橘子\n2. 在杭州做运营' : '在的，今天怎么样？' } }] }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const parts = [{ role: 'assistant' }, { content: null, reasoning_content: '想一下' }, { content: '当着那么多人' }, { content: '被这么说，' }, { content: '换谁都下不来台。' }];
    for (const d of parts) res.write('data: ' + JSON.stringify({ choices: [{ delta: d }] }) + '\n\n');
    res.write('data: [DONE]\n\n'); res.end();
  });
});

async function main() {
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const MOCK = 'http://127.0.0.1:' + mock.address().port + '/v1';
  console.log('='.repeat(64));
  console.log('端到端测试 · 真实页面代码');
  console.log('='.repeat(64));

  console.log('\n── ① 注册 / 登录');
  setAuthTab('login'); byId('authUser').value = 'xiaolu'; byId('authPass').value = '1234'; doAuth();
  ok(/没有这个账号/.test(byId('authErr').textContent), '未注册账号登录被拒');
  setAuthTab('reg');
  byId('authUser').value = 'x'; doAuth(); ok(/至少 2/.test(byId('authErr').textContent), '用户名过短被拒');
  byId('authUser').value = 'a|b'; doAuth(); ok(/不能包含/.test(byId('authErr').textContent), '用户名含分隔符被拒');
  byId('authUser').value = 'xiaolu'; byId('authPass').value = '12'; doAuth(); ok(/至少 4/.test(byId('authErr').textContent), '密码过短被拒');
  byId('authPass').value = '1234'; byId('authNick').value = '小鹿'; doAuth();
  ok(screenOn() === 's-persona', '注册后进入选角色');
  ok(!/1234/.test(store['tide.users']), '密码不以明文存储');
  ok(T.state().nickname === '小鹿', '注册时填的称呼被保存');

  console.log('\n── ② 角色');
  ok(Object.keys(T.PERSONAS).length === 12, '共 12 个角色', Object.keys(T.PERSONAS).length);
  ok(T.PERSONA_GROUPS.length === 6, '6 个人群分组');
  T.PERSONA_GROUPS.forEach(g => ok(Object.values(T.PERSONAS).filter(p => p.group === g.id).length === 2, `「${g.name}」下有 2 个角色`));
  const names = Object.values(T.PERSONAS).map(p => p.name);
  ok(new Set(names).size === 12, '角色名不重复');
  ok(Object.values(T.PERSONAS).every(p => p.style.length > 40 && p.desc && p.emoji && p.tag), '每个角色都有性格描述、简介、头像、标签');
  ok(Object.values(T.PERSONAS).every(p => p.rate >= 0.6 && p.rate <= 1.5 && p.pitch >= 0.6 && p.pitch <= 1.6), '每个角色有合法的默认语速音调');
  const prompts = Object.keys(T.PERSONAS).map(id => T.buildSystemPrompt(id, { summary: '' }, ''));
  ok(new Set(prompts).size === 12, '12 个角色的提示词互不相同');
  ok(prompts.every(p => /永远不要只回/.test(p) && /不做任何医学或心理诊断/.test(p)), '每个角色都带安全与"不敷衍"底线');
  ok(Object.keys(T.PERSONAS).every(id => T.greeting(T.PERSONAS[id], 23).length > 4), '每个角色有专属开场白');
  ok(new Set(Object.keys(T.PERSONAS).map(id => T.greeting(T.PERSONAS[id], 15))).size === 12, '开场白各不相同');
  setGroup('alone'); ok(/奶奶/.test(byId('personaList').innerHTML) && !/阿岸/.test(byId('personaList').innerHTML), '切换分组只显示该组角色');
  chooseP('nainai'); pickPersona();
  ok(T.state().persona === 'nainai' && T.state().avatar === '🧶', '选「奶奶」，头像随角色');
  ok(T.state().rate === 0.8, '语速随角色默认值（奶奶说话慢）');
  ok(screenOn() === 's-custom', '进入头像/声音页');
  chooseAva('🦊'); ok(T.state().avatar === '🦊', '可以换成别的头像');
  byId('voiceRate').value = '9'; byId('voicePitch').value = '0.1'; onVoiceChange('voice');
  ok(T.state().rate === 1.5 && T.state().pitch === 0.6, '越界语速音调被夹回');
  saveCustom(); ok(screenOn() === 's-setup', '首次进入「连接大模型」页');

  console.log('\n── ③ 服务商与校验');
  ok(Object.keys(T.PROVIDERS).length === 9, '9 个服务商预设');
  ['deepseek', 'qwen', 'kimi', 'zhipu', 'doubao', 'siliconflow', 'openai'].forEach(k =>
    ok(/^https:\/\//.test(T.PROVIDERS[k].base) && T.validateBase(T.PROVIDERS[k].base).ok, `${T.PROVIDERS[k].name} 预设地址合法（https）`));
  ok(byId('setupForm_prov').value === 'deepseek', '默认服务商是 DeepSeek');
  ok(byId('setupForm_base').value === 'https://api.deepseek.com/v1', '默认地址自动填好');
  ok(!T.validateBase('http://8.8.8.8/v1').ok, '公网 http 被拒');
  ok(!T.validateBase('http://localhost:11434/v1').ok, 'localhost 被拒');
  ok(T.validateBase('http://192.168.1.8:11434/v1').ok, '局域网 http 放行');
  ok(!T.validateBase('https://api.deepseek.com/v1/chat/completions').ok, '误填完整路径时给出提示');
  ok(/API Key 不对/.test(T.friendlyError('HTTP 401 invalid api key')), '401 → 中文提示');
  ok(/余额不足/.test(T.friendlyError('HTTP 402 Insufficient Balance')), '402 → 中文提示');
  ok(/限流/.test(T.friendlyError('HTTP 429 Rate limit')), '429 → 中文提示');
  ok(/模型名不对/.test(T.friendlyError('HTTP 404 Model Not Exist')), '404 → 中文提示');
  ok(T.parseSseLine('data: {"choices":[{"delta":{"content":null,"reasoning_content":"x"}}]}') === null, '推理模型的思考片段不显示成 null');
  ok(T.cleanReply('<think>嗯</think>你好') === '你好', '去掉 <think> 段');

  byId('setupForm_key').value = ''; testModel('setupForm', true);
  ok(/请填写 API Key/.test(byId('setupForm_msg').innerHTML), '没填 Key 不让测试');
  byId('setupForm_key').value = 'sk a'; testModel('setupForm', true);
  ok(/格式不对/.test(byId('setupForm_msg').innerHTML), 'Key 格式不对被拒');

  console.log('\n── ④ 与「OpenAI 兼容」服务对话（模拟 DeepSeek）');
  byId('setupForm_prov').value = 'custom'; onProviderChange('setupForm', true);
  byId('setupForm_base').value = MOCK.replace('127.0.0.1', '192.168.0.1'); // 先验证 Key 保存流程
  byId('setupForm_base').value = MOCK;
  // 127.0.0.1 在手机上不可用，页面会拒绝；测试里直接放行这一个地址
  const realValidate = T.validateBase;
  window.validateBase = (b) => b.startsWith(MOCK) ? { ok: true, base: MOCK } : realValidate(b);
  byId('setupForm_model').value = 'deepseek-chat';
  byId('setupForm_key').value = 'sk-test-abcdef123456';
  testModel('setupForm', true);
  await wait(() => /成功|出错|不对/.test(byId('setupForm_msg').innerHTML));
  ok(/连接成功/.test(byId('setupForm_msg').innerHTML), '连接测试成功', byId('setupForm_msg').innerHTML.replace(/<[^>]+>/g, ''));
  ok(lastReq.auth === 'Bearer sk-test-abcdef123456', '请求带上了 Authorization: Bearer <Key>');
  ok(lastReq.url === '/v1/chat/completions', '请求路径是 /chat/completions');
  ok(byId('startBtn').disabled === false, '测试成功后「开始聊天」可点');
  ok(T.KeyVault.has(T.keySlot('xiaolu', 'custom')), 'Key 已保存');
  ok(T.KeyVault.hint(T.keySlot('xiaolu', 'custom')) === 'sk-t****3456', 'Key 只显示打码', T.KeyVault.hint(T.keySlot('xiaolu', 'custom')));
  ok(!JSON.stringify(store).includes('sk-test-abcdef123456'), 'Key 没有写进长期存储（localStorage）');
  ok(byId('setupForm_key').value === '', '保存后输入框清空，不在界面上残留明文');

  loadModels('setupForm');
  await wait(() => /获取到|出错/.test(byId('setupForm_msg').innerHTML));
  ok(/获取到 2 个模型/.test(byId('setupForm_msg').innerHTML), '获取模型列表');

  finishSetup();
  ok(screenOn() === 's-chat', '进入聊天');
  ok(byId('chatName').textContent === '奶奶' && byId('chatAva').textContent === '🦊', '聊天页显示所选角色与头像');
  ok(/小鹿/.test(byId('msgs').children.map(c => c.children.map(x => x.textContent).join('')).join('')), '开场白叫了用户的称呼');

  byId('inp').value = '今天被领导当众说方案不行';
  sendMsg(); await wait(() => !byId('sendBtn').disabled);
  const h = T.history(); const last = h[h.length - 1];
  ok(last.role === 'assistant' && last.content === '当着那么多人被这么说，换谁都下不来台。', '流式分片正确拼接', last.content);
  ok(lastReq.body.stream === true && lastReq.body.model === 'deepseek-chat', '请求体：stream=true，模型正确');
  ok(lastReq.body.messages[0].role === 'system' && /奶奶/.test(lastReq.body.messages[0].content), 'system 提示词是所选角色');
  ok(/小鹿/.test(lastReq.body.messages[0].content), '提示词里带上用户称呼');

  for (const [m, re] of [['e401', /API Key 不对/], ['e402', /余额不足/], ['e429', /限流/], ['e404', /模型名不对/]]) {
    mode = m; const n = T.history().length;
    byId('inp').value = '在吗'; sendMsg(); await wait(() => !byId('sendBtn').disabled);
    const bubbles = byId('msgs').children; const lastB = bubbles[bubbles.length - 1].children[1];
    ok(re.test(lastB.textContent), `服务商返回 ${m.slice(1)} → 用户看到中文提示`, lastB.textContent);
    ok(T.history().length === n + 1, `${m.slice(1)} 时不把错误存成 AI 回复`);
  }
  mode = 'ok';

  for (let i = 0; i < 4; i++) { byId('inp').value = '我家猫叫橘子 ' + i; sendMsg(); await wait(() => !byId('sendBtn').disabled); }
  await wait(() => T.mem().facts.length > 0, 5000).catch(() => {});
  ok(T.mem().facts.length === 2 && /橘子/.test(T.mem().summary), '每 4 轮自动抽取长期记忆', JSON.stringify(T.mem()));
  ok(/橘子/.test(T.buildSystemPrompt('nainai', T.mem(), '')), '记忆写进下一轮提示词');

  console.log('\n── ⑤ 危机硬规则');
  ok(T.isCrisis('活着没意思') && T.isCrisis('想睡一个很长很长的觉'), '明确 / 隐晦表达都命中');
  ok(!T.isCrisis('我手机不在了') && !T.isCrisis('今天好累'), '日常表达不误报');
  const before = lastReq;
  byId('inp').value = '活着没意思'; sendMsg();
  const cr = T.history()[T.history().length - 1].content;
  ok(/12356/.test(cr) && /活着没意思/.test(cr), '给热线并引用原话');
  ok(lastReq === before, '危机分支不调用模型');

  console.log('\n── ⑥ 真实模型（本机 Ollama /v1，同一套 OpenAI 兼容协议）');
  let ollamaUp = false;
  try { const r = await fetch(OLLAMA + '/api/tags', { signal: AbortSignal.timeout(3000) }); ollamaUp = r.ok; } catch (e) {}
  if (!ollamaUp) { skip++; console.log('  ⏭  Ollama 未运行，跳过（不计失败）'); }
  else {
    window.validateBase = realValidate;
    const users = JSON.parse(store['tide.users']);
    for (const [pid, input] of [['an', '今天又被领导当众骂了，烦死了'], ['xiaoyu', '考研还有两个月，我一点都学不进去'], ['nainai', '一个人在外地，过年也回不去']]) {
      T.setState({ persona: pid, provider: 'ollama', base: OLLAMA + '/v1', model: OLLAMA_MODEL });
      T.setHistory([]);
      byId('inp').value = input; sendMsg(); await wait(() => !byId('sendBtn').disabled, 120000);
      const r = T.history()[T.history().length - 1];
      console.log(`     【${T.PERSONAS[pid].name}】用户：${input}\n       回复：${(r && r.content || '').replace(/\n/g, ' ')}`);
      ok(r && r.role === 'assistant' && r.content.length >= 8, `${T.PERSONAS[pid].name}：真实模型有实质回复`);
      ok(r && !/你已经很棒|我建议你|你应该|加油！/.test(r.content), `${T.PERSONAS[pid].name}：无禁用表达`, r && r.content);
    }
  }

  console.log('\n── ⑦ 账号与 Key 隔离');
  logout(); ok(screenOn() === 's-auth', '退出回到登录页');
  setAuthTab('reg'); byId('authUser').value = 'another'; byId('authPass').value = 'abcd'; doAuth();
  ok(T.history().length === 0, '新账号看不到别人的对话');
  ok(!T.KeyVault.has(T.keySlot('another', 'custom')), '新账号看不到别人的 API Key');
  logout(); setAuthTab('login'); byId('authUser').value = 'xiaolu'; byId('authPass').value = 'wrong'; doAuth();
  ok(/密码不对/.test(byId('authErr').textContent), '错误密码被拒');
  byId('authPass').value = '1234'; doAuth();
  ok(screenOn() === 's-chat' && T.history().length > 0, '重新登录直接进聊天，历史还在');

  mock.close();
  console.log('\n' + '='.repeat(64));
  if (fail) { console.log(`❌ 失败 ${fail} 项（通过 ${pass}，跳过 ${skip}）`); failures.forEach(f => console.log('  · ' + f)); process.exit(1); }
  console.log(`✅ 全部通过：${pass} 项` + (skip ? `（跳过 ${skip} 组：Ollama 未运行）` : '（含真实模型）'));
  process.exit(0);
}
main().catch(e => { console.error('运行失败：' + e.stack); process.exit(1); });
