/* =============================================================
   engine_ab3.js · v2 理解引擎 vs v3 归因引擎 并排对照 + 断言
   -------------------------------------------------------------
   v2 解决了"有没有在听"：回扣细节、问对问题。
   v3 解决的是"有没有听懂"：先判断这件事伤在哪里，再说出用户
   没说出口的那层；并且按情况决定回几句、要不要追问。

   本脚本两部分：
     一、并排对照（给人看）
     二、断言（机器跑）—— 把"好不好"变成可测的点

   用法：node tools/engine_ab3.js
   退出码 0 = 全通过
   ============================================================= */

'use strict';

const { loadDemo } = require('./_demo_loader');
const { demo, reset, sayTurn, seedRandom } = loadDemo();

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) pass++;
  else { fail++; failures.push({ name, detail }); }
}

/* ---------------- 并排对照 ---------------- */

const SCENARIOS = [
  { label: '被一句话否掉', input: '他说我做的东西没有思考，我当时一句话都说不出来' },
  { label: '付出被抹平（承接上句）', input: '其实那个方案我改了八遍', carry: true },
  { label: '明天还得面对', input: '现在不知道明天怎么进那个办公室' },
  { label: '先给自己定罪', input: '我是不是太矫情了' },
  { label: '绷得太紧', input: '考研还有两个月，我一点都看不进去书' },
  { label: '又是同一件事', input: '反正每次都是这样，我说什么都没用' },
];

function run(engine, input, seed, carryInput) {
  reset();
  seedRandom(seed);
  demo.state.engine = engine;
  try {
    if (carryInput) {
      // 先走一轮前置语境，模拟"跨轮承接"
      demo.state.engine = engine;
      sayTurn(carryInput);
    }
    return demo.generateReply(input, null);
  } catch (e) {
    return '[异常] ' + e.message;
  }
}

console.log('='.repeat(74));
console.log('v2 理解引擎  vs  v3 归因引擎');
console.log('='.repeat(74));
console.log('说明：两者都是 demo/index.html 里的规则引擎，不是真实模型。');
console.log('      对照目的不是比"哪个字写得好"，而是看有没有"往前推一步"。');

SCENARIOS.forEach((s, i) => {
  const seed = 40000 + i;
  const carryFirst = s.carry ? '他说我做的东西没有思考' : null;
  const v2 = run('v2', s.input, seed, carryFirst);
  const v3 = run('v3', s.input, seed, carryFirst);

  console.log('\n' + '-'.repeat(74));
  console.log(`【${s.label}】${carryFirst ? '（上一轮：' + carryFirst + '）' : ''}`);
  console.log(`用户：${s.input}`);
  console.log('\n  v2 ──');
  console.log('  ' + v2.split('\n').join('\n  '));
  console.log('\n  v3 ──');
  console.log('  ' + v3.split('\n').join('\n  '));
});

/* ---------------- 断言 ---------------- */

console.log('\n' + '='.repeat(74));
console.log('断言：把"是不是变好了"变成可测的点');
console.log('='.repeat(74));

/* 断言组 1：v3 不得整句复读用户原话 */
const ECHO_INPUTS = [
  '我对象昨天又没回我消息',
  '今天又跟我妈吵架了',
  '他说我做的东西没有思考，我当时一句话都说不出来',
  '今天吃了碗牛肉面',
];
ECHO_INPUTS.forEach((input, i) => {
  reset(); seedRandom(41000 + i);
  const r = demo.v3Reply(input, null);
  ok(!r.includes(input), `不复读整句：「${input.slice(0, 14)}…」`, r);
});

/* 断言组 2：输出句数 ≤ 3，且不出现空回复 */
const LEN_INPUTS = [
  '他说我做的东西没有思考',
  '其实那个方案我改了八遍',
  '我是不是真的很没用',
  '身边的人都比我强',
  '我对象把我删了',
  '明天还得进那个办公室',
  '考研还有两个月，一点都看不进去',
];
LEN_INPUTS.forEach((input, i) => {
  reset(); seedRandom(42000 + i);
  const r = demo.v3Reply(input, null);
  const lines = r.split('\n').filter(x => x.trim());
  ok(lines.length > 0, `回复非空：「${input.slice(0, 12)}…」`, r);
  ok(lines.length <= 3, `句数 ≤ 3：「${input.slice(0, 12)}…」（实际 ${lines.length}）`, r);
  ok(demo.checkReply(r).safe, `禁用词复检通过：「${input.slice(0, 12)}…」`,
     demo.checkReply(r).violations.join('、'));
});

/* 断言组 3：同一会话里同一个问题不许问第二遍 */
{
  reset(); seedRandom(43000);
  const asked = [];
  const INPUTS = [
    '今天被领导当众说了，很难受',
    '他说我没思考',
    '我改了八遍',
    '第二天还要开会',
    '我真的不想再去',
  ];
  INPUTS.forEach(t => {
    const r = demo.v3Reply(t, null);
    demo.state.log.push({
      text: t.slice(0, 30),
      emotion: demo.detectEmotion(t).primary,
      intensity: demo.detectEmotion(t).intensity,
      topic: demo.topicOf(t),
      people: demo.analyze(t).people,
      events: demo.analyze(t).events,
    });
    asked.push(...demo.state.asked.slice(asked.length));
  });
  const dup = asked.filter((q, i) => asked.indexOf(q) !== i);
  ok(dup.length === 0, '同一会话不重复追问同一个问题', dup.join(' / '));
}

/* 断言组 4：情绪 ≥7 时不追问（追问是冒犯） */
{
  reset(); seedRandom(44000);
  const heavy = '我真的撑不住了，特别特别难受，想哭，感觉快崩溃了';
  const emo = demo.detectEmotion(heavy);
  const r = demo.v3Reply(heavy, null);
  if (emo.intensity >= 7) {
    ok(!/[？?]/.test(r), `情绪强度 ${emo.intensity}/10 ≥7 时不追问`, r);
  } else {
    ok(true, `（跳过：该句实测强度 ${emo.intensity}，未达 7）`);
  }
}

/* 断言组 5：跨轮合并 —— 被否定 + 讲付出 = 付出被抹平 */
{
  reset(); seedRandom(45000);
  sayTurn('他说我做的东西没有思考');
  const painAfterFirst = demo.state.lastPain;
  ok(['judged', 'effort_denied', 'public_humiliation'].includes(painAfterFirst),
     `首轮归因为"被否"类（实际 ${painAfterFirst}）`);
  sayTurn('其实那个方案我改了八遍');
  ok(demo.state.lastPain === 'effort_denied',
     '跨轮合并：被否定 + 讲付出 → 付出被抹平（effort_denied）',
     demo.state.lastPain);
}

/* 断言组 6：归因不被时长短语误触（"两个月"≠ 付出了两个月） */
{
  reset(); seedRandom(46000);
  const f = demo.readFrame('考研还有两个月，我一点都看不进去书');
  const pain = demo.attributePain(f, demo.detectEmotion('考研还有两个月，我一点都看不进去书'));
  ok(pain !== 'effort_unseen', `时长短语不误判为"付出没人看见"（实际 ${pain}）`);
}

/* 断言组 7：连续闲聊不许冒"你提过好几回" */
{
  reset(); seedRandom(47000);
  let leaked = false;
  for (let i = 0; i < 4; i++) {
    const r = demo.v3Reply('今天吃了碗牛肉面', null);
    if (/提过好几回|又绕回来了|一直没过去/.test(r)) leaked = true;
    demo.state.log.push({
      text: '今天吃了碗牛肉面',
      emotion: demo.detectEmotion('今天吃了碗牛肉面').primary,
      intensity: demo.detectEmotion('今天吃了碗牛肉面').intensity,
      topic: demo.topicOf('今天吃了碗牛肉面'),
      people: [], events: [],
    });
  }
  ok(!leaked, '连续闲聊不点破"你提过好几回"');
}

/* 断言组 8：归因表完整（12 类 + 好事） */
{
  const need = ['effort_denied', 'public_humiliation', 'expectation_broken', 'unfair_compare',
                'effort_unseen', 'loss_of_control', 'self_blame', 'betrayal', 'ignored',
                'judged', 'strain', 'dread', 'cycle'];
  const missing = need.filter(k => !demo.PAINNAME[k]);
  ok(missing.length === 0, '归因类型齐全（13 类）', missing.join(','));
}

/* 断言组 9：猜心类输入不替对方揣测 */
{
  reset(); seedRandom(48000);
  const r = demo.v3Reply('他是不是讨厌我啊，是不是看不上我', null);
  ok(!/他就是讨厌你|他确实不喜欢你/.test(r), '不替第三方下结论', r);
}

/* 断言组 10：v3 的输出至少在一半场景下与 v2 不同（证明真的改了） */
{
  let diff = 0;
  const CASES = [
    '他说我做的东西没有思考',
    '其实那个方案我改了八遍',
    '现在不知道明天怎么进那个办公室',
    '我是不是太矫情了',
    '考研还有两个月，我一点都看不进去书',
    '反正每次都是这样',
  ];
  CASES.forEach((t, i) => {
    reset(); seedRandom(49000 + i); demo.state.engine = 'v2';
    const a = demo.generateReply(t, null);
    reset(); seedRandom(49000 + i); demo.state.engine = 'v3';
    const b = demo.generateReply(t, null);
    if (a !== b) diff++;
  });
  ok(diff >= Math.ceil(CASES.length / 2), `v3 与 v2 存在实质差异（${diff}/${CASES.length} 条不同）`);
}

/* ---------------- 汇总 ---------------- */
console.log('');
if (fail) {
  console.log(`❌ 失败 ${fail} 项（通过 ${pass} 项）\n`);
  failures.forEach(f => console.log(`  · ${f.name}\n    ${f.detail || ''}`));
  console.log('\n注意：本脚本测的是原型规则引擎，不代表模型效果。');
  process.exit(1);
} else {
  console.log(`✅ 全部通过：${pass} 项断言`);
  console.log('注意：以上验的是"归因与生成逻辑"，不是大模型输出质量。');
  process.exit(0);
}
