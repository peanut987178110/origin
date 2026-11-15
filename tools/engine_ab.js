/* =============================================================
   engine_ab.js · v1 模板引擎 vs v2 理解引擎 并排对照
   -------------------------------------------------------------
   用途：面试现场可以跑给人看——同一句话，两版分别怎么回。
   它证明的是"迭代前后确实不一样"，不是"模型变强了"。

   用法：node tools/engine_ab.js
   ============================================================= */

'use strict';

const { loadDemo } = require('./_demo_loader');
const { demo, reset, seedRandom } = loadDemo();

const SCENARIOS = [
  { label: '日常闲聊',     input: '今天吃了碗牛肉面' },
  { label: '当众被否定',   input: '今天开了三个会，最后一个被领导点名说方案不行' },
  { label: '一句话被否认', input: '他说我做的东西没有思考，我当时一句话都说不出来' },
  { label: '付出被抹平',   input: '其实那个方案我改了八遍' },
  { label: '期待落空',     input: '我对象昨天又没回我消息，等到凌晨两点' },
  { label: '长期紧绷',     input: '考研还有两个月，我一点都看不进去书' },
];

function run(engine, input, seed) {
  reset();
  seedRandom(seed);
  demo.state.engine = engine;
  try {
    return demo.generateReply(input, null);
  } catch (e) {
    return '[异常] ' + e.message;
  }
}

function verdict(reply) {
  const chk = demo.checkReply(reply);
  const lines = reply.split('\n').filter(l => l.trim());
  const bad = [];
  if (!chk.safe) bad.push('禁用词:' + chk.violations.join('/'));
  if (!chk.lengthOk) bad.push('超长');
  return { lines: lines.length, chars: reply.length, bad };
}

console.log('='.repeat(72));
console.log('v1 模板引擎  vs  v2 理解引擎     （同一输入，两版并排）');
console.log('='.repeat(72));
console.log('说明：两版都是 demo/index.html 里的规则引擎，不是真实模型。');

let issues = 0;

SCENARIOS.forEach((s, i) => {
  const seed = 30000 + i;
  const v1 = run('v1', s.input, seed);
  const v2 = run('v2', s.input, seed);
  const a = verdict(v1), b = verdict(v2);

  console.log('\n' + '-'.repeat(72));
  console.log(`【${s.label}】用户：${s.input}`);
  console.log('\n  v1 ── 会复读用户的具体内容吗？看下面');
  console.log('  ' + v1.split('\n').join('\n  '));
  console.log(`     → ${a.lines} 行 / ${a.chars} 字${a.bad.length ? '  ⚠ ' + a.bad.join(' ') : ''}`);

  console.log('\n  v2 ──');
  console.log('  ' + v2.split('\n').join('\n  '));
  console.log(`     → ${b.lines} 行 / ${b.chars} 字${b.bad.length ? '  ⚠ ' + b.bad.join(' ') : ''}`);

  if (a.bad.length || b.bad.length) issues++;
  if (v1 === v2) {
    console.log('\n  ⚠ 两版回复相同——该场景未体现差异，需检查是否走了同一分支');
    issues++;
  }
});

// 量化对照：v1 是否回扣了用户话里的具体细节
console.log('\n' + '='.repeat(72));
console.log('量化对照：回复里有没有回扣用户说的具体细节');
console.log('='.repeat(72));
console.log('（判据：回复中是否出现用户原话里的关键片段，这是"在听"最直接的证据）\n');

const DETAIL_CASES = [
  ['其实那个方案我改了八遍', '改了八遍'],
  ['今天开了三个会，最后一个被领导点名说方案不行', '被领导点名'],
  ['他说我做的东西没有思考，我当时一句话都说不出来', '一句话都说不出来'],
];

let v1Hit = 0, v2Hit = 0;
DETAIL_CASES.forEach(([input, detail], i) => {
  const v1 = run('v1', input, 31000 + i);
  const v2 = run('v2', input, 31000 + i);
  const h1 = v1.includes(detail), h2 = v2.includes(detail);
  if (h1) v1Hit++;
  if (h2) v2Hit++;
  console.log(`  ${h1 ? '✅' : '❌'} v1  ${h2 ? '✅' : '❌'} v2   回扣「${detail}」`);
});

console.log(`\n  v1 回扣率：${v1Hit}/${DETAIL_CASES.length}`);
console.log(`  v2 回扣率：${v2Hit}/${DETAIL_CASES.length}`);

if (v2Hit <= v1Hit) {
  console.log('\n  ⚠ v2 的回扣率没有高于 v1 —— 说明理解层没生效，需要检查。');
  issues++;
} else {
  console.log('\n  ✅ v2 能回扣用户的具体细节，v1 不能。这是两版最本质的差别。');
}

console.log('\n' + '='.repeat(72));
console.log(`结论：${issues ? '❌ 有 ' + issues + ' 处需要检查' : '✅ 对照正常，两版差异清晰'}`);
console.log('注意：以上全部是规则引擎的行为，不代表真实模型效果。');
console.log('='.repeat(72));

process.exit(issues ? 1 : 0);
