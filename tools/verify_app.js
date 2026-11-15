#!/usr/bin/env node
/* =========================================================================
   verify_app.js · 静态架构校验（v5）
   -------------------------------------------------------------------------
   回答一个问题：**代码结构是否还符合 v5 的设计**。
   这里不测效果（效果由 server_test / care_flow_test / v5_client_test 测），
   只做"便宜的、能在 1 秒内跑完的"结构守卫，防止某次改动悄悄把架构改坏：
     · 密码 / API Key 有没有混进代码
     · 危机拦截是不是还在调模型之前
     · 提示词是不是只在服务端 / 共享核心里
     · 构建产物是不是最新的
   用法：node tools/verify_app.js
   ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let ok = 0, bad = 0; const fail = [];
const check = (c, n, d) => { if (c) { ok++; } else { bad++; fail.push(n + (d ? ' :: ' + d : '')); } };
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = p => fs.existsSync(path.join(ROOT, p));
const stripXml = s => s.replace(/<!--[\s\S]*?-->/g, '');
const stripJs = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/* ---------------- 1. 共享核心 ---------------- */
const core = stripJs(read('shared/tide_core.js'));
const C = require(path.join(ROOT, 'shared', 'tide_core.js'));

check(C.VERSION && /^5\./.test(C.VERSION), '共享核心版本为 5.x', C.VERSION);
check(Object.keys(C.PERSONAS).length === 6, '首发 6 个角色', Object.keys(C.PERSONAS).length);
check(Object.values(C.PERSONAS).every(p => p.name.zh && p.name.en && p.style.zh && p.style.en && p.life.zh.length >= 3),
  '每个角色都有中英双语人格 + 活感台词');
check(Object.values(C.PERSONAS).every(p => p.rate > 0.5 && p.rate < 2 && p.pitch > 0.5 && p.pitch < 2), '语速音调在可用区间');
check(C.ONBOARD.length >= 5 && C.ONBOARD.every(o => C.PERSONAS[o.persona] && o.opener.zh && o.opener.en),
  '新手引导：每个选项都能落到一个存在的角色，且开场白双语');
check(C.CRISIS_WORDS.zh.length >= 10 && C.CRISIS_WORDS.en.length >= 10, '危机词表中英各 ≥10 条');
check(['US', 'CA', 'GB', 'AU', 'CN', 'DEFAULT'].every(k => C.HOTLINES[k]), '主要地区热线齐备（含 DEFAULT 兜底）');
check(/^\d{4}-\d{2}-\d{2}$/.test(C.HOTLINES_VERIFIED), '热线带核验日期', C.HOTLINES_VERIFIED);
check(C.isCrisis('不想活了') && C.isCrisis('I want to die') && !C.isCrisis('今天吃了拉面'),
  '危机判定：中英命中、正常语句不误报');
check(/12356/.test(C.crisisReply('不想活了', 'zh', 'CN')), '中文危机回复带国内热线');
check(/988/.test(C.crisisReply('I want to die', 'en', 'US')), '英文危机回复带 988');
check(/findahelpline/.test(C.crisisReply('I want to die', 'en', 'ZZ')), '未知地区兜底到 findahelpline');
check(/你是 AI/.test(C.buildSystemPrompt({ persona: 'tide', lang: 'zh' })), '中文提示词声明 AI 身份');
check(/You are an AI/.test(C.buildSystemPrompt({ persona: 'tide', lang: 'en' })), '英文提示词声明 AI 身份');
check(/never invent|绝不编造/i.test(C.buildSystemPrompt({ persona: 'tide', lang: 'en' })), '提示词含"不编造记忆"约束');
check(/我建议你/.test(C.RULES.zh) && /I suggest you/.test(C.RULES.en), '禁止话术同时写在两套规则里');
check(C.parseMemories('```json\n{"memories":[{"type":"event","content":"周五面试","importance":4,"due":"2026-11-13"}]}\n```').length === 1,
  '记忆解析能容忍 ``` 包裹');
check(C.parseMemories('模型胡说一通').length === 0, '记忆解析失败时返回空而不是半截文本');
check(C.parseMemories('{"memories":[{"type":"x","content":"面试","importance":99}]}')[0].importance === 5, '重要度夹在 1–5');
const mem = [
  { content: '我的猫叫团子', importance: 4, created_at: new Date().toISOString() },
  { content: '周五有个面试', importance: 3, created_at: new Date().toISOString() }
];
check(C.retrieve(mem, '团子今天不吃饭', 3).some(m => /团子/.test(m.content)), '检索：说到猫能召回猫的记忆');
check(C.retrieve(mem, '完全无关的话', 3).some(m => /团子/.test(m.content)), '检索：高重要度记忆无关键词也带上');
check(C.detectLang('我今天很累') === 'zh' && C.detectLang('I am tired') === 'en', '语种判定');
check(C.lifeStatus('tide', 'en', '2026-11-10') === C.lifeStatus('tide', 'en', '2026-11-10'), '活感台词同一天稳定');
check(C.lifeStatus('tide', 'en', '2026-11-10') !== C.lifeStatus('tide', 'en', '2026-11-11') ||
  C.PERSONAS.tide.life.en.length === 1, '活感台词随日期变化');
check(C.PLANS.free.daily === 30 && C.PLANS.plus.daily === 300, '额度：免费 30 / Plus 300');
check(C.PLANS.free.autoMemory === false && C.PLANS.plus.autoMemory === true, '自动记忆是 Plus 权益');
check(C.needsAiNotice(0, Date.now()) && !C.needsAiNotice(Date.now(), Date.now()), 'AI 身份提示：首次必现，3 小时内不重复');
check(C.careNudge({ content: '周五面试' }, 'tide', 'en').body.includes('周五面试'), '关怀文案必须引用原话');
check(C.careNudge({ content: '' }, 'tide', 'en') === null, '没有具体的事就不发关怀');

/* ---------------- 2. 页面（v6 Orbit：本地优先，无网络） ---------------- */
const html = read('src/app/index.html');
const jsDir = path.join(ROOT, 'src', 'app', 'js');
const appRaw = fs.readdirSync(jsDir).filter(f => /^\d\d_.*\.js$/.test(f)).sort().map(f => fs.readFileSync(path.join(jsDir, f), 'utf8')).join('\n');
const app = stripJs(appRaw);
const chatCore = stripJs(read('src/app/js/05_chat_core.js'));

check(html.includes('/*__ORBIT_JS__*/'), '页面保留构建占位符 ORBIT_JS');
check(!/PERSONAS\s*=\s*\{/.test(html + app), '人格定义只在 shared/orbit_personas.js');
check(/AndroidOrbitAI/.test(app), '页面通过本机模型桥生成回复');
check(!/AndroidTide|AndroidLlm|apiKey|\/v1\/chat['"]/.test(app), '页面没有任何服务端 / 厂商 Key 路径（下载即用）');
check(/engine === ?'ollama'|get\('engine'\) === 'ollama'/.test(app) && !/fetch\(/.test(app.replace(/async function ollama[\s\S]*?\n  \}\n/, '')), '唯一的 fetch 是桌面开发用的 Ollama（?engine=ollama），安卓包里不会走到');
check(chatCore.indexOf('MIND.checkSafety(text)') > 0 && chatCore.indexOf('MIND.checkSafety(text)') < chatCore.indexOf('generateReply({'), '危机规则在调用模型之前');
check(/m\.risk|umsg\.risk/.test(chatCore), '危机消息不进入后续对话上下文');
check(/isAiQuestion/.test(chatCore), '被问"你是 AI 吗"由规则如实回答');
check(/guardReply/.test(chatCore) && /RETRY_HINT/.test(chatCore), '每条回复都过输出守卫，必要时重生成一次');
check(/memAsk/.test(app) && /confirmMemory/.test(app), '记忆先征得同意再保存');
check(!/sk-[A-Za-z0-9]{16,}/.test(appRaw), '页面没有硬编码密钥');
check(/__orbitBack/.test(app) && /window\.Orbit\s*=/.test(app), '返回键钩子 + 测试入口');
check(/visibilitychange/.test(app) && /save\(true\)/.test(app), '切后台时立即落盘');
check(/track\('app_open'/.test(app) && /experiment_id/.test(app), '埋点带 experiment_id / variant_id');
check(/function measure/.test(app), '每次页面切换都计时');

/* ---------------- 3. 构建产物 ---------------- */
check(exists('android/app/src/main/assets/index.html'), '构建产物存在');
if (exists('android/app/src/main/assets/index.html')) {
  const built = read('android/app/src/main/assets/index.html');
  const expected = require(path.join(ROOT, 'tools', 'build_app.js')).assemble().out;
  check(built === expected, '构建产物与源码逐字节一致（否则运行 node tools/build_app.js）');
  check(!built.includes('/*__ORBIT_JS__*/'), '构建产物已内联，无残留占位符');
}

/* ---------------- 4. Android 工程 ---------------- */
const must = [
  'app/src/main/AndroidManifest.xml',
  'app/src/main/java/com/tide/app/MainActivity.kt',
  'app/src/main/java/com/tide/app/OrbitEngine.kt',
  'app/src/main/java/com/tide/app/OrbitBridge.kt',
  'app/src/main/cpp/orbit.cpp',
  'app/src/main/assets/models/orbit-qwen2.5-1.5b-instruct-q4_k_m.gguf',
  'app/src/main/java/com/tide/app/KeyStore.kt',
  'app/src/main/java/com/tide/app/VoiceBridge.kt',
  'app/src/main/java/com/tide/app/CareNotifier.kt',
  'app/src/test/java/com/tide/app/LlmClientTest.kt'
];
must.forEach(f => check(exists(path.join('android', f)), 'android 存在 ' + f));
['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'].forEach(d =>
  check(exists(path.join('android', `app/src/main/res/mipmap-${d}/ic_launcher.png`)), '图标 ' + d));

const mf = stripXml(read('android/app/src/main/AndroidManifest.xml'));
check(/android\.permission\.INTERNET/.test(mf), '声明 INTERNET');
check(/RECORD_AUDIO/.test(mf), '声明 RECORD_AUDIO');
check(/POST_NOTIFICATIONS/.test(mf), '声明 POST_NOTIFICATIONS（晚间关怀）');
check(!/ACCESS_FINE_LOCATION|READ_CONTACTS|READ_SMS|CALL_LOG|CAMERA/.test(mf), '未申请无关敏感权限（不使用定位）');
check(/allowBackup="false"/.test(mf), '禁止云备份');
check(/<manifest[^>]*>[\s\S]*<queries>[\s\S]*<application/.test(mf), '<queries> 是 <manifest> 的直接子元素');
check((mf.match(/<queries>/g) || []).length === 1, '<queries> 只出现一次');

const eng = read('android/app/src/main/java/com/tide/app/OrbitEngine.kt');
check(/fun prepare/.test(eng) && /loader\.execute/.test(eng), '模型在后台准备，不阻塞页面');
check(/fun warm/.test(eng) && /prefillOnly|true, object : ChunkSink/.test(eng), '选好角色后预填 KV 缓存');
check(/asimddp/.test(eng) && /3L \* 1024/.test(eng), '旧 CPU / 内存不足时明确提示，不崩溃');
check(/cores \/ 2/.test(eng), '推理线程不占满所有核心（给界面留余量）');
const cpp = read('android/app/src/main/cpp/orbit.cpp');
check(/llama_kv_self_seq_rm/.test(cpp) && /common/.test(cpp), 'KV 缓存前缀复用');
check(/utf8_complete_prefix/.test(cpp) && /onChunk/.test(cpp), '流式输出且不切断多字节字符');
check(/g_stop/.test(cpp), '支持停止生成');
const cm = read('android/app/src/main/cpp/CMakeLists.txt');
check(/CMAKE_BUILD_TYPE Release/.test(cm) && /dotprod/.test(cm) && /GGML_AVX2 ON/.test(cm), '推理引擎始终按 Release + SIMD 编译');

const ks = read('android/app/src/main/java/com/tide/app/KeyStore.kt');
check(/EncryptedSharedPreferences/.test(ks) && /MasterKeys/.test(ks), '加密存储类保留（未来云端模式用）');

const main = read('android/app/src/main/java/com/tide/app/MainActivity.kt');
check(/WebViewAssetLoader/.test(main), '用 WebViewAssetLoader 加载本地页面');
check(/__orbitBack/.test(main), '返回键委托页面');
check(/AndroidOrbitAI[\s\S]*AndroidOrbit"[\s\S]*AndroidVoice/.test(main), '注册三个 JS 桥（模型 / 设备 / 语音）');
check(!/addJavascriptInterface\((api|llm|localEngine)/.test(main), '外壳不注册任何联网桥');
check(/FLAG_DEBUGGABLE/.test(main), 'WebView 调试只在 debug 包打开');

const gradle = read('android/app/build.gradle.kts');
check(/versionName = "6\.\d+\.\d+"/.test(gradle), '版本号 6.x');
check(/security-crypto/.test(gradle), '依赖 security-crypto');
check(/testImplementation\("junit/.test(gradle) && /testImplementation\("org\.json/.test(gradle), '单测依赖 junit + org.json');
check(/abiFilters/.test(gradle) && /arm64-v8a/.test(gradle), '只打需要的 ABI');

/* ---------------- 5. 服务端 ---------------- */
const srvRaw = read('server/server.js');
const srv = stripJs(srvRaw);
check(/process\.env\.TIDE_UPSTREAM_KEY/.test(srv), '上游 Key 只从环境变量读');
check(!/sk-[A-Za-z0-9]{16,}/.test(srvRaw), '服务端源码里没有硬编码密钥');
check(/Core\.isCrisis\(text\)/.test(srv), '服务端二次危机拦截');
check(srv.indexOf('Core.isCrisis(text)') < srv.indexOf('Core.generateReply('), '服务端危机拦截在调用模型之前');
check(/Core\.buildSystemPrompt/.test(srv), '提示词由服务端拼装');
check(/Core\.recallMiss\(/.test(srv), '记忆陷阱硬规则在服务端');
check(/Core\.generateReply\(/.test(srv), '敷衍回复重生成在服务端');
check(/Core\.retrieve\(/.test(srv), 'RAG：检索记忆');
check(/Core\.dueFollowups\(/.test(srv), 'RAG：到期的追问');
check(/Bearer /.test(srv) && /deviceByToken/.test(srv), '接口鉴权');
check(/maxInput/.test(srv) && /maxHistory/.test(srv), '输入与历史长度受限（防止被当通用网关）');
check(/allowRegister/.test(srv), '注册限流');
check(/ALLOWED\s*=\s*\//.test(srv), '客户端埋点白名单存在');
check(!/ALLOWED\s*=\s*\/[\s\S]{0,300}subscribe/.test(srv), 'subscribe 不在客户端可上报白名单里');
check(/store\.variant\(/.test(srv), 'A/B 分组');

const db = stripJs(read('server/db.js'));
['devices', 'usage', 'events', 'memories', 'experiments'].forEach(t =>
  check(new RegExp('CREATE TABLE IF NOT EXISTS ' + t).test(db), '数据表 ' + t));
check(/token_hash/.test(db), '只存 token 哈希');
check(/ON DELETE CASCADE/.test(db), '删号级联');
check(/WHERE token_hash = \?/.test(db), '按哈希查设备');

/* ---------------- 6. 分析 ---------------- */
const q = read('analytics/queries.sql');
['funnel', 'retention', 'ab_nudge'].forEach(n =>
  check(new RegExp('-- name: ' + n).test(q), 'SQL：' + n));
check(exists('analytics/report.js'), '分析报表脚本存在');

/* ---------------- 7. 文档 ---------------- */
[
  'docs/08_PRD_潮汐Tide_v1.0.md',
  'docs/12_合规与危机干预SOP.md',
  'docs/13_数据埋点与指标字典.md',
  'docs/16_产品定位_第三空间.md',
  'docs/19_角色设计_人群与性格.md'
].forEach(d => check(exists(d), '文档存在 ' + d));

/* ---------------- 8. 不变量：没有假数据 ---------------- */
const MK = require(path.join(ROOT, 'shared', 'market_data.js'));
const doc29 = exists('docs/29_市场数据手册.md') ? read('docs/29_市场数据手册.md') : '';
check(/^\d{4}-\d{2}-\d{2}$/.test(MK.checked), '市场数据带核对日期', MK.checked);
check(MK.facts.length >= 6, '市场数据至少 6 条', MK.facts.length);
check(MK.facts.every(f => f.id && f.zh && f.en && f.source && /^https:\/\//.test(f.url) && /^\d{4}(-\d{2}){0,2}$/.test(f.date) && /^[ABC]$/.test(f.level)),
  '每条市场数据都有中英文、来源、https 链接、日期、等级');
check(new Set(MK.facts.map(f => f.id)).size === MK.facts.length, '市场数据 id 不重复');
check(MK.facts.every(f => doc29.includes('`' + f.id + '`')), 'App 里的每条市场数据都在 docs/29 里有同一个 id',
  MK.facts.filter(f => !doc29.includes('`' + f.id + '`')).map(f => f.id).join(','));
check(MK.facts.filter(f => f.level !== 'C').length >= 6, 'A/B 级数据至少 6 条（App 只展示 A/B）');

const docsAll = [];
for (const dir of ['docs', 'prompts', 'workflow']) {
  if (!exists(dir)) continue;
  for (const f of fs.readdirSync(path.join(ROOT, dir))) {
    if (f.endsWith('.md')) docsAll.push(read(path.join(dir, f)));
  }
}
const joined = docsAll.join('\n');
check(!/留存率.{0,6}(提升了?|涨到|达到)\s*\d{2}%/.test(joined), '文档里没有"留存涨到 X%"这类无出处说法');
check(!/转化率.{0,8}(提升了?|涨到|达到)\s*\d{2}%/.test(joined), '文档里没有"转化率涨到 X%"这类无出处说法');

/* ---------------- 输出 ---------------- */
console.log('='.repeat(60));
console.log('verify_app · v6 静态架构校验');
console.log('='.repeat(60));
if (bad) {
  console.log('❌ 失败 ' + bad + ' 项（通过 ' + ok + ' 项）');
  fail.forEach(f => console.log('   · ' + f));
  process.exit(1);
}
console.log('✅ 全部通过：' + ok + ' 项');
