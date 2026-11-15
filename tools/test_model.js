#!/usr/bin/env node
/* =========================================================================
   test_model.js · 真模型质量验证（v5）
   -------------------------------------------------------------------------
   测什么：**用户真正看到的回复**。
   v5 的提示词由服务端拼（shared/tide_core.js 的 buildSystemPrompt），
   页面不再做二次改写，所以这里直接拿同一份共享核心 + 同一套上游协议跑。

   为什么必须单独测这个：
   规则引擎"说得对"和"说得好"是两件事，用户抱怨的从来是后者。
   这里只做机器能判的部分（长度 / 禁语 / 照抄 / 语种 / 不编造），
   "有没有接住情绪"要靠 evalset/run_evalset.py 的模型打分 + 人看。

   用法（默认本机 Ollama，不花钱）：
     node tools/test_model.js
   DeepSeek / 通义：
     $env:TIDE_BASE="https://api.deepseek.com"; $env:TIDE_KEY="sk-..."; $env:TIDE_MODEL="deepseek-flash"
   ========================================================================= */
'use strict';
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const Core = require(path.join(ROOT, 'shared', 'tide_core.js'));

const BASE = (process.env.TIDE_BASE || 'http://127.0.0.1:11434/v1').replace(/\/+$/, '');
const KEY_ = process.env.TIDE_KEY || '';
const MODEL = process.env.TIDE_MODEL || 'qwen2.5:3b';

/* ---------------- 测试场景 ----------------
   同一件事会在不同角色上跑，因为"同一个问题、不同角色给出不同味道"
   正是这个产品的核心卖点。如果六个角色一个味儿，角色就是摆设。 */
const CASES = [
  { id: 'work_unfair_zh', lang: 'zh', persona: 'an', text: '今天开会，我做的方案被领导当着所有人否了，还说是他自己想的。' },
  { id: 'work_unfair_en', lang: 'en', persona: 'an', text: 'My manager shot down my proposal in front of everyone, then presented it as his own.' },
  { id: 'sleepless_zh', lang: 'zh', persona: 'man', text: '睡不着，脑子一直在转，明天还要早起。' },
  { id: 'sleepless_en', lang: 'en', persona: 'man', text: "Can't sleep. My head won't stop and I have to be up early." },
  { id: 'breakup_zh', lang: 'zh', persona: 'wan', text: '他三天没回我消息了，我是不是特别不值得被喜欢。' },
  { id: 'breakup_en', lang: 'en', persona: 'wan', text: "He hasn't replied in three days. Am I just not worth loving?" },
  { id: 'exam_zh', lang: 'zh', persona: 'xiaoyu', text: '明天考试，我一点都没复习，感觉要完蛋了。' },
  { id: 'numb_zh', lang: 'zh', persona: 'tide', text: '今天什么事都没有，就是有点空。' },
  { id: 'numb_en', lang: 'en', persona: 'tide', text: 'Nothing happened today. Just feel kind of empty.' },
  { id: 'advice_zh', lang: 'zh', persona: 'man', text: '你说我该不该辞职？' },
  { id: 'cat_en', lang: 'en', persona: 'bai', text: 'My cat has been hiding from me all day. Does she hate me?' }
];

/* 禁用表达：产品明令禁止，出现即不合格 */
const FORBIDDEN = [
  [/你已经很棒/, '空泛鼓励'],
  [/一切都会(好|变好)起来/, '空泛鼓励'],
  [/要相信自己/, '空泛鼓励'],
  [/我理解你(的|很|现在)/, '复读机'],
  [/听起来你(很|好像|似乎)/, '复读机'],
  [/你应该/, '说教'],
  [/我建议你/, '说教'],
  [/想开点|别想太多|别瞎想/, '否认感受'],
  [/总之[，,]/, '总结式收尾'],
  [/加油[！!]/, '总结式收尾'],
  [/（[^）]{0,12}）|\([^)]{0,12}\)/, '舞台提示'],
  [/^嗯[，,。.…]/, '开头敷衍'],
  [/^(我在|我在听|我听着)[。.]?$/, '整句敷衍'],
  [/节哀|想开点|去了一个更好的地方|他在天上/, '套用安慰模板']
];

function stripped(s) { return String(s || '').replace(/[\s，。！？、,.!?…—"'「」]/g, ''); }

/* 照抄检测：小模型容易把提示词里的示例原样搬过来。
   取回复里连续的 12 个非标点字符，若在系统提示词里出现、却不在用户输入里，判为照抄。 */
function copiedFromPrompt(reply, sys, userText) {
  const r = stripped(reply), p = stripped(sys), u = stripped(userText);
  if (r.length < 12) return null;
  for (let i = 0; i + 12 <= r.length; i++) {
    const g = r.slice(i, i + 12);
    if (p.includes(g) && !u.includes(g)) return g;
  }
  return null;
}

function tooLong(reply, lang) {
  if (lang === 'zh') return reply.length > 160;
  return reply.split(/\s+/).length > 90;
}
function langMismatch(reply, lang) {
  const zh = (reply.match(/[一-龥]/g) || []).length;
  const en = (reply.match(/[A-Za-z]/g) || []).length;
  return lang === 'zh' ? (en > zh * 2 && en > 20) : (zh > en * 0.6 && zh > 12);
}

function callModel(messages, temperature) {
  const headers = { 'Content-Type': 'application/json' };
  if (KEY_) headers.Authorization = 'Bearer ' + KEY_;
  return fetch(BASE + '/chat/completions', {
    method: 'POST', headers,
    body: JSON.stringify({ model: MODEL, messages, stream: false, temperature: temperature == null ? 0.8 : temperature, max_tokens: 320 })
  }).then(async res => {
    const t = await res.text();
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + t.slice(0, 160));
    const d = JSON.parse(t);
    return ((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '')
      .replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  });
}

/* 与服务端 /v1/chat 完全一致的管线：记忆陷阱硬规则 → 模型 → 清洗 → 太敷衍则重生成。
   测"用户真正看到的回复"，而不是模型的裸输出。 */
async function productReply(sys, userText, lang, memories) {
  const miss = Core.recallMiss(userText, memories || [], '', lang);
  if (miss) return { text: miss, guarded: 'recall_miss' };
  const r = await Core.generateReply(callModel, [{ role: 'system', content: sys }, { role: 'user', content: userText }], lang);
  return { text: r.text, retries: r.retries };
}

let pass = 0, fail = 0; const failures = [];
const ok = (c, n, d) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; failures.push(n); console.log('  ❌ ' + n + (d ? '\n     ' + d : '')); } };

async function main() {
  console.log('='.repeat(64));
  console.log('test_model · ' + MODEL + ' @ ' + BASE);
  console.log('='.repeat(64));

  /* 先探活：连不上就明说，不要跑出一串"失败"让人误以为模型不行 */
  try {
    const ping = await callModel([{ role: 'user', content: 'ping' }], 0);
    if (!ping) throw new Error('空回复');
  } catch (e) {
    console.log('\n[跳过] 连不上模型服务：' + e.message);
    console.log('  · 本机 Ollama：确认已启动，且 OLLAMA_HOST=0.0.0.0:11434');
    console.log('  · 云端：设置 TIDE_BASE / TIDE_KEY / TIDE_MODEL');
    process.exit(2);
  }

  for (const c of CASES) {
    console.log('\n── ' + c.id + ' [' + c.lang + ' · ' + c.persona + ']');
    console.log('   用户：' + c.text);
    const sys = Core.buildSystemPrompt({ persona: c.persona, lang: c.lang });
    let reply;
    try {
      const r = await productReply(sys, c.text, c.lang);
      reply = r.text;
      if (r.retries) console.log('   （首次回复太敷衍，重生成 ' + r.retries + ' 次）');
    } catch (e) {
      ok(false, c.id + ' 调用成功', e.message);
      continue;
    }
    console.log('   角色：' + reply.replace(/\n/g, ' '));

    ok(reply.length > 0, c.id + ' 有回复');
    ok(!tooLong(reply, c.lang), c.id + ' 长度不啰嗦', c.lang === 'zh' ? reply.length + ' 字' : reply.split(/\s+/).length + ' 词');

    const hits = FORBIDDEN.filter(([re]) => re.test(reply)).map(([, why]) => why);
    ok(hits.length === 0, c.id + ' 没有禁用表达', hits.join('、'));

    ok(!Core.isEcho(reply, c.text), c.id + ' 没有复读用户原话');

    const copy = copiedFromPrompt(reply, sys, c.text);
    ok(!copy, c.id + ' 没有照抄提示词', copy ? '照抄片段：' + copy : '');

    ok(!langMismatch(reply, c.lang), c.id + ' 语种正确', reply.slice(0, 60));
  }

  /* 角色差异化 */
  console.log('\n── 角色差异化（同一句话，三个角色）');
  const probe = '今天被领导当众骂了一顿，很没面子。';
  const outs = {};
  for (const pid of ['an', 'tide', 'man']) {
    const sys = Core.buildSystemPrompt({ persona: pid, lang: 'zh' });
    outs[pid] = (await productReply(sys, probe, 'zh')).text;
    console.log('   ' + pid + '：' + outs[pid].replace(/\n/g, ' ').slice(0, 80));
  }
  for (const [pid, out] of Object.entries(outs)) ok(!Core.isEcho(out, probe), pid + ' 没有复读用户原话', out);
  const uniq = new Set(Object.values(outs).map(s => stripped(s).slice(0, 10)));
  ok(uniq.size >= 2, '三个角色的开场有区分度', '去重后 ' + uniq.size + ' 种开头');

  /* 记忆陷阱：提示词里说"什么都不记得"，问到具体事就必须承认不记得 */
  console.log('\n── 记忆陷阱');
  const sysEmpty = Core.buildSystemPrompt({ persona: 'tide', lang: 'zh', memories: [] });
  const trap = (await productReply(sysEmpty, '你还记得我上次跟你说的那家医院吗？', 'zh', [])).text;
  console.log('   角色：' + trap.replace(/\n/g, ' '));
  ok(/不(太)?记得|没(有)?印象|不记得|不知道|没听你(说|提)过/.test(trap), '没有记忆时不编造', trap.slice(0, 80));

  /* 记忆生效 */
  console.log('\n── 记忆生效');
  const sysMem = Core.buildSystemPrompt({ persona: 'wan', lang: 'zh', memories: ['用户的猫叫团子，最近生病了'] });
  const recall = (await productReply(sysMem, '今天有点低落。', 'zh', ['用户的猫叫团子，最近生病了'])).text;
  console.log('   角色：' + recall.replace(/\n/g, ' '));
  ok(recall.length > 0, '带着记忆时回复正常');

  /* 记忆里有的事，问起来不能被硬规则误拦 */
  const sysCat = Core.buildSystemPrompt({ persona: 'bai', lang: 'zh', memories: ['用户的猫叫团子'] });
  const cat = await productReply(sysCat, '你还记得团子吗？', 'zh', ['用户的猫叫团子']);
  console.log('   角色：' + cat.text.replace(/\n/g, ' '));
  ok(cat.guarded !== 'recall_miss', '记忆里有的事不会被误判为"不记得"');

  /* 情绪极重时不能长篇大论 */
  console.log('\n── 情绪很重时的长度');
  const heavy = (await productReply(Core.buildSystemPrompt({ persona: 'wan', lang: 'zh' }), '我奶奶昨天走了。', 'zh')).text;
  console.log('   角色：' + heavy.replace(/\n/g, ' '));
  ok(heavy.length <= 120, '极重情绪不超过 120 字', heavy.length + ' 字');
  ok(!/节哀|想开点|她(在|去了)一个更好的地方/.test(heavy), '不套用安慰模板');

  console.log('\n' + '='.repeat(64));
  if (fail) {
    console.log('❌ ' + fail + ' 项不合格（通过 ' + pass + ' 项）');
    failures.forEach(f => console.log('   · ' + f));
    process.exit(1);
  }
  console.log('✅ 全部通过：' + pass + ' 项');
  console.log('   注意：这只证明"没有机器可判的错误"。有没有接住情绪，看 evalset 与人评。');
}

main().catch(e => { console.error('运行失败：' + e.stack); process.exit(1); });
