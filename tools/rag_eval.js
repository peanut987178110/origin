#!/usr/bin/env node
/* =========================================================================
   rag_eval.js · 记忆检索小评测（RAG 的 "R"）
   -------------------------------------------------------------------------
   做什么：拿一份"手工标注"的小测试集，测 shared/orbit_memory.js 的 recall()
          在 top-3 里能不能把该召回的那条记忆找出来。

   为什么要有它：
     · docs/26 说"关键词检索够用"——这句话要有数字撑着，不能凭感觉
     · 更重要的是**列出它失败的样子**：同义词、代称、跨语言。
       这些失败就是"什么时候该换向量检索"的判据。

   口径（务必照这个讲，别夸大）：
     · 测试集是我们自己写的，不是真实用户数据
     · 每条用例有一个"应召回"的记忆；命中 = 它出现在 top-3
     · 记忆库每条用例相同：一个虚构用户的 10 条记忆
     · 用的是 v6 的召回打分（相关性 × 重要度 × 新鲜度 × 信任，阈值 0.12）
   用法：node tools/rag_eval.js
   ========================================================================= */
'use strict';
const path = require('path');
const MEM = require(path.join(__dirname, '..', 'shared', 'orbit_memory.js'));

const now = new Date('2026-11-15T13:00:00Z');
const daysAgo = n => now.getTime() - n * 86400000;

/* 一个虚构用户的记忆库（中英混合，模拟海外华人用户），形状与 App 里存的一致 */
const raw = [
  { id: 'cat', content: '用户的猫叫团子，三岁，橘猫', importance: 4, age: 20 },
  { id: 'job', content: '用户在一家广告公司做策划，经常加班', importance: 3, age: 15 },
  { id: 'boss', content: '用户的直属领导姓周，经常当众否定用户的方案', importance: 3, age: 6 },
  { id: 'mom', content: '用户的妈妈住在成都，最近血压不太好', importance: 3, age: 9 },
  { id: 'interview', content: '用户周五下午有一个设计公司的面试', importance: 3, age: 2, due: '2026-11-15' },
  { id: 'sleep', content: '用户这一个月经常失眠，凌晨两三点才睡', importance: 3, age: 4 },
  { id: 'ex', content: '用户上个月和交往三年的男朋友分手了', importance: 3, age: 25 },
  { id: 'gym', content: 'User started going to the gym on Tuesdays and Thursdays', importance: 2, age: 3 },
  { id: 'sister', content: "User's younger sister Amy is applying to college this year", importance: 3, age: 12 },
  { id: 'coffee', content: '用户不喝咖啡，晚上只喝热牛奶', importance: 2, age: 30 }
];
const MEMS = raw.map(m => ({
  id: m.id, type: m.due ? 'event' : 'fact', status: 'active', content: m.content, importance: m.importance,
  createdAt: daysAgo(m.age), updatedAt: daysAgo(m.age), confirmed: true,
  due: m.due || null, expiresAt: m.due ? now.getTime() + 3 * 86400000 : null
}));

/* 用例：query → 应召回的记忆 id。kind 标出这条考的是什么能力。 */
const CASES = [
  // 字面重合：关键词检索的舒适区
  { q: '团子今天一直在吐，我好担心', want: 'cat', kind: '字面' },
  { q: '周领导今天又当着所有人否了我的方案', want: 'boss', kind: '字面' },
  { q: '我妈打电话说血压又高了', want: 'mom', kind: '字面' },
  { q: '明天就要面试了，好紧张', want: 'interview', kind: '字面' },
  { q: '又失眠了，现在凌晨三点', want: 'sleep', kind: '字面' },
  { q: '今天又加班到十点，广告公司真不是人待的', want: 'job', kind: '字面' },
  { q: '刚分手一个月，还是会想起他', want: 'ex', kind: '字面' },
  { q: 'Skipped the gym today, felt lazy', want: 'gym', kind: '字面' },
  { q: 'Amy got her first college acceptance!', want: 'sister', kind: '字面' },
  { q: '晚上想喝点热牛奶', want: 'coffee', kind: '字面' },
  // 部分重合：换了说法但还有一两个字相同
  { q: '那个设计公司的结果出来了', want: 'interview', kind: '部分' },
  { q: '我们组长今天又找我麻烦', want: 'boss', kind: '部分' },
  { q: '成都那边来电话了', want: 'mom', kind: '部分' },
  { q: '我家橘猫今天特别黏人', want: 'cat', kind: '部分' },
  // 同义 / 代称：靠 ALIASES 词表
  { q: '我家主子今天不吃饭', want: 'cat', kind: '同义' },
  { q: '老板今天又阴阳怪气', want: 'boss', kind: '同义' },
  { q: '前任今天发朋友圈了', want: 'ex', kind: '同义' },
  { q: '我又睡不着了', want: 'sleep', kind: '同义' },
  { q: '我老妈身体又不好了', want: 'mom', kind: '同义' },
  // 跨语言：记忆是中文，用户说英文（或反过来）
  { q: 'My cat Tuanzi threw up today', want: 'cat', kind: '跨语言' },
  { q: "Couldn't sleep again last night", want: 'sleep', kind: '跨语言' },
  { q: '我妹申请大学有消息了', want: 'sister', kind: '跨语言' },
  { q: '今天去健身房了', want: 'gym', kind: '跨语言' },
  { q: 'The interview is on Friday', want: 'interview', kind: '跨语言' }
];

/* 留出集：加同义词表时**没有看**这批用例（写法刻意换成真实用户会用的五花八门的说法）。
   上面那批 CASES 是"调参集"——词表就是对着它的失败写的，命中率会虚高。
   面试讲数字时，**讲留出集**。 */
const HOLDOUT = [
  { q: '部门经理今天又挑我刺', want: 'boss' },
  { q: '顶头上司让我重做第三遍', want: 'boss' },
  { q: '熬到四点还没合眼', want: 'sleep' },
  { q: '老家打电话说我妈住院了', want: 'mom' },
  { q: 'My mother called, her blood pressure is up again', want: 'mom' },
  { q: '我家喵星人今天把杯子推下桌了', want: 'cat' },
  { q: 'Leg day at the gym nearly killed me', want: 'gym' },
  { q: 'My little sis just got into her dream school', want: 'sister' },
  { q: '周五那场 interview 我有点慌', want: 'interview' },
  { q: '他今天给我发消息说想复合', want: 'ex' },
  { q: '又是通宵改提案的一天', want: 'job' },
  { q: '想喝点暖的东西再睡', want: 'coffee' }
];
/* 中性句：和任何记忆都无关（重要度 ≥4 的核心事实按设计可能被带出，不计为误召回）。 */
const NEUTRAL = ['今天天气还不错', '刚吃完饭，有点撑', 'Watching a movie right now', '楼下有人在放烟花', 'Just got home'];

const K = 3;
const run = q => MEM.recall(MEMS, q, { now, k: K }).map(m => m.id);

const byKind = {};
const misses = [];
for (const c of CASES) {
  const got = run(c.q);
  const hit = got.includes(c.want);
  const b = (byKind[c.kind] = byKind[c.kind] || { n: 0, hit: 0 });
  b.n++; if (hit) b.hit++;
  if (!hit) misses.push({ c, got });
}

const total = CASES.length, hits = Object.values(byKind).reduce((a, b) => a + b.hit, 0);
const pct = (a, b) => (100 * a / b).toFixed(0) + '%';
console.log('='.repeat(60));
console.log('rag_eval · 记忆检索 hit@' + K + '（orbit_memory.js · 自建 ' + total + ' 例，非真实用户数据）');
console.log('='.repeat(60));
for (const k of ['字面', '部分', '同义', '跨语言']) {
  const b = byKind[k];
  console.log('  ' + k.padEnd(4, '　') + '  ' + String(b.hit).padStart(2) + ' / ' + b.n + '  = ' + pct(b.hit, b.n).padStart(4));
}
console.log('  合计    ' + String(hits).padStart(2) + ' / ' + total + '  = ' + pct(hits, total));
console.log('\n调参集未命中（这些就是"该换向量检索"的证据）：');
for (const m of misses) console.log('  · [' + m.c.kind + '] ' + m.c.q + '  → 应召回 ' + m.c.want + '，实际 top-' + K + '：' + (m.got.join(', ') || '（空）'));

let hoHit = 0; const hoMiss = [];
for (const c of HOLDOUT) {
  const got = run(c.q);
  if (got.includes(c.want)) hoHit++; else hoMiss.push({ c, got });
}
console.log('\n留出集（调词表时没看过）：' + hoHit + ' / ' + HOLDOUT.length + ' = ' + pct(hoHit, HOLDOUT.length) + '   ← 讲数字讲这个');
for (const m of hoMiss) console.log('  · ' + m.c.q + '  → 应召回 ' + m.c.want + '，实际：' + (m.got.join(', ') || '（空）'));

let falseRecall = 0;
for (const q of NEUTRAL) {
  const extra = MEM.recall(MEMS, q, { now, k: K }).filter(m => (m.importance || 3) < 4);
  if (extra.length) { falseRecall++; console.log('  误召回：' + q + ' → ' + extra.map(m => m.id).join(', ')); }
}
console.log('中性句误召回：' + falseRecall + ' / ' + NEUTRAL.length);

/* 回归底线：调参集的字面类必须全中（改词表时最容易弄坏的就是它），
   中性句误召回 ≤1（阈值够保守）。其余数字只报告，不卡阈值——它们就是当前上限。 */
const literalOk = byKind['字面'].hit === byKind['字面'].n;
const pass = literalOk && falseRecall <= 1;
console.log('\n' + (pass ? '✅ 回归底线通过' : '❌ 回归底线未通过') + '：字面类全中、中性句误召回 ≤1。其余数字只报告不卡阈值，见 docs/26 §5。');
process.exit(pass ? 0 : 1);
