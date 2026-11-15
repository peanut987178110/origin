/* =============================================================
   _demo_loader.js · 测试专用加载器（不是产品代码）
   -------------------------------------------------------------
   目的：让 Node 测试直接运行 demo/index.html 里那一份**真实的**引擎代码，
        而不是在测试里重写一遍逻辑。
        测试重写一遍逻辑 = 测的是测试，不是产品。

   做法：
     1. 从 index.html 抠出最后一个 <script> 块
     2. 注入最小 DOM 桩（document / window），因为渲染函数会碰 DOM
     3. 用可复现的伪随机替换 Math.random —— 引擎里有大量随机选池，
        不固定种子的话同一句话每次结果不同，断言没法写
     4. 返回引擎内部函数与 state，供各测试文件调用

   用法：
     const { demo, reset, sayTurn } = require('./_demo_loader');
   ============================================================= */

'use strict';

const fs = require('fs');
const path = require('path');

const DEMO_HTML = path.resolve(__dirname, '..', 'demo', 'index.html');

// ---- 可复现的伪随机（线性同余） ----
let _seed = 20261101;
function seedRandom(s) { _seed = (s >>> 0) || 1; }
function random() {
  _seed = (_seed * 1664525 + 1013904223) >>> 0;
  return _seed / 4294967296;
}

// ---- 最小 DOM 桩 ----
function makeElement() {
  return {
    innerHTML: '',
    textContent: '',
    className: '',
    value: '',
    style: {},
    children: [],
    scrollTop: 0,
    scrollHeight: 0,
    appendChild(c) { this.children.push(c); return c; },
    removeChild() {},
    setAttribute() {},
    addEventListener() {},
  };
}

function loadDemo() {
  if (!fs.existsSync(DEMO_HTML)) {
    throw new Error('找不到 demo/index.html：' + DEMO_HTML);
  }
  const html = fs.readFileSync(DEMO_HTML, 'utf8');

  // 取最后一个 <script> 块（页面里只有一个业务脚本块）
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (!blocks.length) throw new Error('index.html 里没有 <script> 块');
  const code = blocks[blocks.length - 1];

  // DOM 桩
  const els = Object.create(null);
  const documentStub = {
    getElementById(id) {
      if (!els[id]) els[id] = makeElement();
      return els[id];
    },
    createElement() { return makeElement(); },
    addEventListener() {},
  };
  const windowStub = {};

  Math.random = random;

  // new Function 里 const 声明在函数作用域内，所以要在末尾显式 return
  const factory = new Function(
    'document', 'window',
    code + '\n;return {' + [
      'state', 'classify', 'detectEmotion', 'detectIntent', 'analyze',
      'pickPhrase', 'coresOf', 'contextHint', 'retrieveMemory', 'topicOf',
      'v1Reply', 'v2Reply', 'v3Reply', 'generateReply', 'crisisReply',
      'extractMemory', 'checkReply', 'readFrame', 'attributePain',
      'tighten', 'grams', 'redundant', 'pick',
      'usableCore', 'mirrorLine', 'topicBucket', 'nightGreeting',
      'MEM_THRESHOLD', 'CRISIS', 'ILLEGAL', 'MEDICAL', 'DECISION',
      'FORBIDDEN', 'MINI_ACK', 'PAINNAME', 'WHO_MAP', 'EVENT_MAP', 'EMOTIONS',
    ].join(',') + '};'
  );

  const demo = factory(documentStub, windowStub);

  // ---- 状态复位：每个用例前回到初始态，避免用例之间互相污染 ----
  const INITIAL_MEMORY = {
    id: 'm1', type: 'person', content: '养了一只猫，名字叫橘子', entities: ['橘子'],
    keywords: ['养猫', '橘子', '猫咪', '宠物'],
    emotion: 'joy', importance: 3, time: '上周', quote: '我家那只猫，叫橘子',
  };

  function reset() {
    const s = demo.state;
    s.turn = 0;
    s.memories = [Object.assign({}, INITIAL_MEMORY)];
    s.hits = 0;
    s.blocks = 0;
    s.cost = 0;
    s.log = [];
    s.used = [];
    s.engine = 'v3';
    s.asked = [];
    s.pendingAsk = null;
    s.crossCooldown = 0;
    s.lastDiag = null;
    s.lastPain = null;
    els.msgs && (els.msgs.innerHTML = '');
  }

  /* 模拟 send() 的一轮收尾：生成回复 → 写会话脉络。
     finishTurn 里做的就是这件事，这里保持一致，否则跨轮测试和真实行为不符。 */
  function sayTurn(text) {
    const s = demo.state;
    const reply = demo.generateReply(text, null);
    const emo = demo.detectEmotion(text);
    const f = demo.analyze(text);
    s.log.push({
      text: text.slice(0, 30),
      emotion: emo.primary,
      intensity: emo.intensity,
      topic: demo.topicOf(text),
      people: f.people,
      events: f.events,
    });
    if (s.log.length > 12) s.log.shift();
    s.turn++;
    return { reply, emo, f };
  }

  return { demo, reset, sayTurn, seedRandom, DEMO_HTML, code };
}

module.exports = { loadDemo, seedRandom, DEMO_HTML };
