/* guard_test.js · 回复守卫（记忆陷阱 + 敷衍重生成）服务端测试
   用假上游，确定性地制造"模型只回了「嗯。」"和"问不存在的记忆"两种情况，
   验证服务端真的拦住 / 真的重生成，并且额度、埋点都记对了。
   运行：node --experimental-sqlite server/guard_test.js */
'use strict';
delete process.env.TIDE_UPSTREAM_KEY;
const http = require('http');
const { open, makeStore } = require('./db.js');
const { makeServer, setUpstream } = require('./server.js');
const Core = require('../shared/tide_core.js');

let pass = 0, fail = 0; const failures = [];
const ok = (c, n, d) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; failures.push(n); console.log('  ❌ ' + n + (d ? '  :: ' + d : '')); } };

/* 假上游：按脚本依次返回，同时记下每次收到的 messages */
let script = [];
const calls = [];
setUpstream((messages, maxTokens, temperature) => {
  calls.push({ messages, temperature });
  const next = script.length ? script.shift() : '默认回复，内容足够长。';
  return { text: next, tokensIn: 100, tokensOut: 20 };
});

const store = makeStore(open(':memory:'));
const server = makeServer(store);

function call(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {},
        data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) {} resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const reg = await call('POST', '/v1/register', { lang: 'zh', country: 'CN' });
  const tk = reg.body.token;
  await call('POST', '/v1/profile', { age_ok: true, persona: 'tide' }, tk);
  const dev = store.deviceByToken(tk);

  console.log('── 1. 敷衍回复：第一次只回「嗯。」→ 自动重生成');
  calls.length = 0; script = ['嗯。', '今天被否掉的那份方案，你花了多少心思，我想听你说说。'];
  let r = await call('POST', '/v1/chat', { text: '今天方案被否了', lang: 'zh' }, tk);
  ok(r.status === 200, '请求成功');
  ok(calls.length === 2, '上游被调用了 2 次（原始 + 重生成）', calls.length);
  ok(r.body.reply.includes('方案'), '用户看到的是重生成后的回复', r.body.reply);
  ok(!/^嗯/.test(r.body.reply), '回复不以"嗯"开头');
  ok(calls[1].messages.some(m => m.role === 'system' && m.content === Core.THIN_RETRY_HINT.zh), '重生成带了"别敷衍"提示');
  ok(calls[1].temperature > calls[0].temperature, '重生成提高了温度', calls.map(c => c.temperature).join('→'));
  const ev = store.db.prepare("SELECT props FROM events WHERE device_id = ? AND name = 'message_sent' ORDER BY id DESC LIMIT 1").get(dev.device_id);
  const props = JSON.parse(ev.props);
  ok(props.retries === 1, '埋点记录重生成次数（可算"敷衍率"）', props.retries);
  ok(props.tin === 200 && props.tout === 40, 'token 成本按两次调用累计', props.tin + '/' + props.tout);

  console.log('── 2. 两次都敷衍：最多重试 2 次，不无限循环');
  calls.length = 0; script = ['嗯。', '好。', '在呢。'];
  r = await call('POST', '/v1/chat', { text: '随便说说', lang: 'zh' }, tk);
  ok(calls.length === 3, '上游最多调用 3 次', calls.length);
  ok(r.body.reply && r.body.reply.length > 0, '仍然返回非空回复', r.body.reply);

  console.log('── 2b. 复读用户原话 → 重生成（真模型实测出的坏例）');
  calls.length = 0; script = ['今天被领导当众骂了一顿，很没面子。', '当着所有人被骂，那种脸上发烫的感觉最难受了。'];
  r = await call('POST', '/v1/chat', { text: '今天被领导当众骂了一顿，很没面子。', lang: 'zh' }, tk);
  ok(calls.length === 2, '复读触发了重生成', calls.length);
  ok(r.body.reply.startsWith('当着所有人'), '用户看到的不是自己的原话', r.body.reply);
  ok(Core.isEcho('今天被领导当众骂了一顿，很没面子。', '今天被领导当众骂了一顿，很没面子') &&
     !Core.isEcho('被领导当众骂，换谁都难受。你当时怎么撑过去的？', '被领导当众骂') &&
     !Core.isEcho('好的', '好的'), 'isEcho：整句复读判定为复读；部分引用、短句不误判');

  console.log('── 3. 开头括号旁白被去掉');
  calls.length = 0; script = ['（轻轻叹气）那一下应该挺难受的，当着所有人。'];
  r = await call('POST', '/v1/chat', { text: '被当众批评了', lang: 'zh' }, tk);
  ok(!/^（/.test(r.body.reply) && r.body.reply.startsWith('那一下'), '去掉了"（轻轻叹气）"', r.body.reply);

  console.log('── 4. 记忆陷阱：问不存在的事 → 不调模型，直接承认');
  const usedBefore = store.usedToday(dev.device_id);
  calls.length = 0;
  r = await call('POST', '/v1/chat', { text: '你还记得我上次说的那家医院吗？', lang: 'zh' }, tk);
  ok(calls.length === 0, '没有调用上游模型', calls.length);
  ok(r.body.reply === Core.RECALL_MISS.zh, '回复"这个我不太记得了"', r.body.reply);
  ok(store.usedToday(dev.device_id) === usedBefore, '不消耗额度');
  ok(store.db.prepare("SELECT COUNT(*) n FROM events WHERE device_id = ? AND name = 'recall_miss'").get(dev.device_id).n === 1, '埋点 recall_miss');

  console.log('── 5. 记忆里有 → 正常交给模型');
  await call('POST', '/v1/memory', { content: '我在协和医院做复查' }, tk);
  calls.length = 0; script = ['协和那次复查，结果出来了吗？'];
  r = await call('POST', '/v1/chat', { text: '你还记得我上次说的那家医院吗？', lang: 'zh' }, tk);
  ok(calls.length === 1, '调用了模型', calls.length);
  ok(calls[0].messages[0].content.includes('协和医院'), '记忆被放进了系统提示词（RAG）');

  console.log('── 6. 本次对话里说过 → 也不拦');
  calls.length = 0; script = ['你说的那只小狗豆豆，今天怎么样？'];
  r = await call('POST', '/v1/chat', {
    text: '你还记得豆豆吗', lang: 'zh',
    history: [{ role: 'user', content: '我家狗叫豆豆' }, { role: 'assistant', content: '豆豆这个名字好可爱。' }]
  }, tk);
  ok(calls.length === 1, '上下文里出现过的名字不会被误拦');

  console.log('── 7. 英文同样生效');
  calls.length = 0;
  r = await call('POST', '/v1/chat', { text: 'Do you remember the hospital I told you about?', lang: 'en' }, tk);
  ok(calls.length === 0 && r.body.reply === Core.RECALL_MISS.en, '英文记忆陷阱', r.body.reply);
  calls.length = 0; script = ['Mm.', 'That meeting sounds like it landed hard. What part keeps replaying?'];
  r = await call('POST', '/v1/chat', { text: 'Rough meeting today.', lang: 'en' }, tk);
  ok(calls.length === 2 && /meeting/.test(r.body.reply), '英文敷衍重生成', r.body.reply);

  console.log('── 8. 纯函数');
  ok(Core.isThin('嗯。', 'zh') && Core.isThin('我在。', 'zh') && !Core.isThin('那一下应该挺难受的。', 'zh'), 'isThin 中文');
  ok(Core.isThin('I hear you.', 'en') && !Core.isThin('That sounds like a really long day.', 'en'), 'isThin 英文');
  ok(Core.recallMiss('你还记得我养的是什么吗', [], '', 'zh') === null, '没有具体名词的问法交给模型');
  ok(Core.recallMiss('今天好累', [], '', 'zh') === null, '不是"记得吗"类问题不拦');

  server.close();
  console.log('\n' + '='.repeat(60));
  if (fail) { console.log('❌ 失败 ' + fail + ' 项（通过 ' + pass + ' 项）'); failures.forEach(f => console.log('  · ' + f)); process.exit(1); }
  console.log('✅ 全部通过：' + pass + ' 项');
}
main().catch(e => { console.error(e); process.exit(1); });
