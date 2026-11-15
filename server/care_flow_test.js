/* care_flow_test.js · 主动关怀全链路（假上游，不花钱）
   用户说"周五面试" → 第 4 轮触发自动抽取 → 记忆带 due 日期入库
   → 到期那天：事件进入系统提示词的"可以自然问起的事" → 问过一次标记已跟进
   → 前一晚：nudge 组排出一条基于这件事的提醒；control 组不排
   运行：node --experimental-sqlite server/care_flow_test.js */
'use strict';
delete process.env.TIDE_UPSTREAM_KEY;
process.env.TIDE_ALLOW_FAKE_BILLING = '1';
const http = require('http');
const { open, makeStore } = require('./db.js');
const { makeServer, setUpstream } = require('./server.js');
const Core = require('../shared/tide_core.js');

let pass = 0, fail = 0; const failures = [];
const ok = (c, n, d) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; failures.push(n); console.log('  ❌ ' + n + (d ? '  :: ' + d : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const prompts = [];   // 记下每次发给上游的系统提示词，用来检查记忆有没有被放进去
let extractCalls = 0;
setUpstream(messages => {
  const sys = messages.find(m => m.role === 'system');
  const user = messages[messages.length - 1].content;
  if (/memory extractor|记忆抽取器/.test(user)) {
    extractCalls++;
    // 模拟模型：包一层 ```json，外加一句废话——这是真实模型常见的输出形态
    return { text: 'Sure!\n```json\n{"memories":[{"type":"event","content":"Has a job interview at a design studio","importance":4,"due":"' + tomorrow + '"},' +
      '{"type":"person","content":"Has a cat named Biscuit","importance":5,"due":null}]}\n```', tokensIn: 50, tokensOut: 40 };
  }
  prompts.push(sys ? sys.content : '');
  return { text: 'ok: ' + user.slice(0, 20), tokensIn: 10, tokensOut: 5 };
});

const store = makeStore(open(':memory:'));
const server = makeServer(store);
function call(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {},
        data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }, res => {
      const c = []; res.on('data', d => c.push(d));
      res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString('utf8')); } catch (e) {} resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  /* 找一台 nudge 组、一台 control 组的设备 */
  const devs = {};
  for (let i = 0; i < 40 && !(devs.nudge && devs.control); i++) {
    const r = await call('POST', '/v1/register', { country: 'US', lang: 'en' });
    const v = r.body.experiments.nudge_v1;
    if (!devs[v]) devs[v] = r.body;
  }
  for (const v of ['nudge', 'control']) {
    await call('POST', '/v1/profile', { age_ok: true, persona: 'tide' }, devs[v].token);
    await call('POST', '/v1/subscribe', {}, devs[v].token);        // 自动记忆只对 Plus 开放
  }

  console.log('── 1. 免费用户不触发自动抽取');
  const free = await call('POST', '/v1/register', { country: 'US', lang: 'en' });
  await call('POST', '/v1/profile', { age_ok: true }, free.body.token);
  for (let i = 0; i < 5; i++) await call('POST', '/v1/chat', { text: 'chatting ' + i, lang: 'en' }, free.body.token);
  await sleep(50);
  ok(extractCalls === 0, '免费用户聊 5 轮，没有调用记忆抽取');

  console.log('── 2. Plus 用户第 4 轮触发抽取');
  const T = devs.nudge.token, D = devs.nudge.deviceId;
  const lines = ['I have an interview tomorrow at a design studio', 'kind of nervous', 'my cat Biscuit keeps me company', 'anyway thanks'];
  for (const t of lines) await call('POST', '/v1/chat', { text: t, lang: 'en' }, T);
  await sleep(80);
  ok(extractCalls === 1, '第 4 轮触发一次抽取', 'calls=' + extractCalls);
  const mems = store.memories(D);
  ok(mems.length === 2, '模型输出外面包了 ```json 和废话，仍正确解析出 2 条', JSON.stringify(mems.map(m => m.content)));
  const ev = mems.find(m => m.type === 'event');
  ok(ev && ev.due === tomorrow && ev.source === 'auto', '面试事件带 due 日期、来源标记为 auto');

  console.log('── 3. 检索：相关记忆进入提示词，无关的不进');
  prompts.length = 0;
  await call('POST', '/v1/chat', { text: 'how is Biscuit doing', lang: 'en' }, T);
  ok(/Biscuit/.test(prompts[0]), '问到猫 → "Has a cat named Biscuit" 进入系统提示词');
  ok(/never invent/.test(prompts[0]), '提示词里同时带"只引用这些，绝不编造"的约束');

  console.log('── 4. 到期当天：事件作为"可以自然问起的事"出现一次');
  // 把时钟拨到"明天"：直接把 due 改成今天，等价于第二天打开
  const today = new Date().toISOString().slice(0, 10);
  store.db.prepare('UPDATE memories SET due = ? WHERE id = ?').run(today, ev.id);
  prompts.length = 0;
  await call('POST', '/v1/chat', { text: 'hey', lang: 'en' }, T);
  ok(/Things you may naturally ask about[\s\S]*job interview/.test(prompts[0]), '到期事件出现在"可以自然问起的事"');
  ok(store.memories(D).find(m => m.id === ev.id).followed_up === 1, '问过一次后标记为已跟进');
  prompts.length = 0;
  await call('POST', '/v1/chat', { text: 'hey again', lang: 'en' }, T);
  ok(!/Things you may naturally ask about/.test(prompts[0]), '同一件事不会每轮都追问');

  console.log('── 5. 前一晚的提醒：nudge 组有，control 组没有');
  for (const v of ['nudge', 'control']) {
    await call('POST', '/v1/memory', { content: 'Moving to a new apartment', due: tomorrow }, devs[v].token);
  }
  const n1 = await call('GET', '/v1/nudge', undefined, devs.nudge.token);
  const n2 = await call('GET', '/v1/nudge', undefined, devs.control.token);
  ok(n1.body.nudge && /Moving to a new apartment/.test(n1.body.nudge.body), 'nudge 组：提醒内容来自用户说过的具体事件', JSON.stringify(n1.body.nudge));
  ok(n2.body.nudge === null, 'control 组：没有提醒');
  ok(!/miss you|missed you|where have you/i.test(n1.body.nudge.body), '提醒不让人愧疚');
  const noEvent = await call('POST', '/v1/register', { country: 'US', lang: 'en' });
  let empty = null;
  if (noEvent.body.experiments.nudge_v1 === 'nudge') empty = await call('GET', '/v1/nudge', undefined, noEvent.body.token);
  ok(!empty || empty.body.nudge === null, '没有到期事件时，nudge 组也不发泛泛的"回来看看"');

  console.log('── 6. 删除记忆后不再被提起');
  await call('DELETE', '/v1/memory/' + ev.id, undefined, T);
  store.db.prepare('UPDATE memories SET followed_up = 0').run();
  prompts.length = 0;
  await call('POST', '/v1/chat', { text: 'interview went fine', lang: 'en' }, T);
  ok(!/design studio/.test(prompts[0]), '用户删掉的记忆不再进入提示词');

  console.log('── 7. 埋点');
  const names = store.db.prepare('SELECT name, COUNT(*) n FROM events WHERE device_id = ? GROUP BY name').all(D)
    .reduce((o, r) => (o[r.name] = r.n, o), {});
  ok(names.memory_extracted === 2, '记录 memory_extracted', JSON.stringify({names,extractCalls}));
  ok(names.nudge_scheduled === 1, '记录 nudge_scheduled');
  ok(names.memory_deleted === 1, '记录 memory_deleted');

  server.close();
  console.log('\n' + '='.repeat(60));
  console.log(fail ? '❌ 失败 ' + fail + ' 项（通过 ' + pass + ' 项）\n  · ' + failures.join('\n  · ') : '✅ 全部通过：' + pass + ' 项');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
