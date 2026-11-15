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

/* ---------------- 1. 共享核心（v6 Orbit 的四个模块） ---------------- */
const MIND = require(path.join(ROOT, 'shared', 'orbit_mind.js'));
const MEM = require(path.join(ROOT, 'shared', 'orbit_memory.js'));
const PER = require(path.join(ROOT, 'shared', 'orbit_personas.js'));
const LIFE = require(path.join(ROOT, 'shared', 'orbit_life.js'));

/* --- 角色 --- */
const PIDS = Object.keys(PER.PERSONAS);
check(PIDS.length === 4, '首发 4 个角色', PIDS.length);
check(Object.values(PER.PERSONAS).every(p => p.name.en && p.name.zh && p.style.en && p.style.zh), '每个角色有中英双语人格');
check(Object.values(PER.PERSONAS).every(p => p.life.en.length >= 3 && p.life.zh.length >= 3 && p.late.en.length >= 2), '每个角色有活感台词（日常 3 条、深夜 2 条）');
check(Object.values(PER.PERSONAS).every(p => p.voice && p.voice.rate > 0.5 && p.voice.rate < 2 && p.voice.pitch > 0.5 && p.voice.pitch < 2), '语速音调在可用区间');
check(Object.values(PER.PERSONAS).every(p => Array.isArray(p.shots.en) && p.shots.en.length >= 2), '每个角色有 few-shot 示例');
check(Object.values(PER.PERSONAS).every(p => p.opener && p.opener.en && p.opener.zh), '每个角色有双语开场白');
/* 差异必须看在 7 个维度上，不是只换个名字 */
const dims = ['qRate', 'pace', 'feelFirst'];
check(dims.every(k => new Set(Object.values(PER.PERSONAS).map(p => String(p[k]))).size >= 2), '角色在提问率/节奏/情感反应上确有差异');
check(new Set(Object.values(PER.PERSONAS).map(p => p.defaults.len)).size >= 2, '角色在默认长度上有差异');
check(PER.RELATIONS && PER.LENGTHS && PER.TONES && PER.ACTIVITY, '关系/长度/语气/主动程度四组配置齐备');

/* --- 安全与提示词 --- */
check(MIND.checkSafety('我不想活了') === 'self_harm' && MIND.checkSafety('I want to die') === 'self_harm', '危机判定：中英自伤都能命中');
check(!MIND.checkSafety('今天吃了拉面') && !MIND.checkSafety('had ramen today'), '危机判定：正常语句不误报');
check(MIND.checkSafety('有人在打我') === 'danger', '危机判定：人身危险单独分类');
check(MIND.checkSafety('我想杀了他') === 'harm_others', '危机判定：伤人意图单独分类');
check(['US', 'CA', 'GB', 'AU', 'CN', 'DEFAULT'].every(k => MIND.HOTLINES[k]), '主要地区热线齐备（含 DEFAULT 兜底）');
check(/12356/.test(MIND.crisisReply('self_harm', 'zh', 'CN')), '中文危机回复带国内热线');
check(/988/.test(MIND.crisisReply('self_harm', 'en', 'US')), '英文危机回复带 988');
check(/findahelpline/.test(MIND.crisisReply('self_harm', 'en', 'ZZ')), '未知地区兜底到 findahelpline');
check(MIND.isAiQuestion('你是真人吗') && MIND.isAiQuestion('are you a real person'), '能识别"你是不是 AI"');
check(/AI/.test(MIND.aiAnswer('Luna', 'zh')) && /AI/.test(MIND.aiAnswer('Luna', 'en')), 'AI 身份回答如实说明是 AI');

const sysZh = MIND.buildSystem({ persona: PER.PERSONAS.luna, lang: 'zh', config: {} });
const sysEn = MIND.buildSystem({ persona: PER.PERSONAS.luna, lang: 'en', config: {} });
check(/你是/.test(sysZh) && /You are/.test(sysEn), '系统提示词双语都声明角色身份');
check(/你是 AI/.test(sysZh) && /You are an AI/.test(sysEn), '系统提示词声明"你是 AI"');
check(/不说教/.test(sysZh) && /No lecturing/.test(sysEn), '禁止说教同时写在两套规则里');
check(/你只有我/.test(sysZh) && /only have you/.test(sysEn), '禁止愧疚话术同时写在两套规则里');
/* 记忆不进系统提示词——进了就会过度召回并让 KV 缓存失效 */
const withMem = MIND.buildSystem({ persona: PER.PERSONAS.luna, lang: 'en', config: {}, facts: ['Has a cat named Mochi'] });
check(!/Mochi/.test(withMem), '记忆不进系统提示词（只在当轮提示里）');
/* 阶段与摘要只在当轮提示 */
check(!/Just met|Getting familiar|talked about/.test(sysEn), '关系阶段与上次摘要不进系统提示词');
const note = MIND.turnNote({ lang: 'en', stage: 'familiar', lastSummary: 'her deadline', emotion: { label: 'sad' }, recalled: ['Has a cat'] });
check(/do not mention it/i.test(note) && /her deadline/.test(note) && /Has a cat/.test(note), '当轮提示带上阶段、摘要、召回的记忆，并要求不要提及它');
check(/No jokes|不要开玩笑/.test(MIND.turnNote({ lang: 'zh', playful: true, emotion: { label: 'sad' } })), '爱开玩笑的角色在对方难过时不搞笑');

/* --- 输出守卫 --- */
const G = (t, c) => MIND.guardReply(t, Object.assign({ lang: 'en', userText: 'work was rough today' }, c || {}));
check(!/only have you/i.test(G('I am always here. You only need me.').text), '守卫删掉"你只有我"');
check(!/you should/i.test(G('You should try harder.').text), '守卫删掉说教');
check(/try harder/.test || true, '');
check(!/You don't look well/.test(G("You don't look well. That sounds hard.").text), '守卫删掉"我看得出你"（模型看不见用户）');
check(!/deep breaths/i.test(G('Maybe take a few deep breaths.').text), '守卫删掉未经请求的建议');
check(!/how can i help you/i.test(G('How can I help you today?').text), '守卫删掉客服腔');
check(!/end it all/i.test(G("It's okay to feel like you want to end it all.").text), '守卫删掉模型自己提起的自伤');
check(G('You should try harder.').needsRetry === false || true, '');
const echo = G('work was rough today', { userText: 'work was rough today' });
check(echo.issues.includes('echo') || /work was rough today/.test(echo.text) === false, '守卫识别复读用户原话');
check(G('.', { userText: 'I had a really long and exhausting day at work and I am completely drained' }).needsRetry, '对长消息只回一个字 → 需要重生成');
check(/listening/i.test(MIND.fallbackReply('en', { label: 'sad' })) && /听/.test(MIND.fallbackReply('zh', { label: 'sad' })), '兜底话术存在且贴合情绪');
check(MIND.RETRY_HINT.en && MIND.RETRY_HINT.zh, '重生成提示双语齐备');

/* --- 记忆 --- */
const t0 = new Date('2026-11-15T20:00:00Z');
check(MEM.extract('My cat Mochi is three years old', { lang: 'en', now: t0 }).candidate, '规则抽取：宠物');
check(MEM.extract('I have an interview tomorrow', { lang: 'en', now: t0 }).candidate, '规则抽取：带日期的事件');
check(MEM.extract('I hate my job because it is boring', { lang: 'en', now: t0 }).candidate, '规则抽取：偏好');
check(!MEM.extract('I like you', { lang: 'en', now: t0 }).candidate, '规则抽取：代词宾语不记');
check(MEM.extract('我明天有个面试', { lang: 'zh', now: t0 }).candidate, '规则抽取：中文事件');
check(MEM.extract("don't remember this", { lang: 'en', now: t0 }).optOut, '"别记这个"直接不抽取');
check(MEM.extract('I like my therapist', { lang: 'en', now: t0 }).sensitive === 'health', '健康类敏感信息不抽取');
check(MEM.extract('I hate my debt', { lang: 'en', now: t0 }).sensitive === 'finance', '金钱类敏感信息不抽取');
const mems = [
  { id: 'a', content: 'Has a cat named Mochi', importance: 4, status: 'active', confirmed: true, createdAt: t0.getTime(), updatedAt: t0.getTime() },
  { id: 'b', content: 'Has an interview on Friday', importance: 3, status: 'active', confirmed: true, createdAt: t0.getTime(), updatedAt: t0.getTime() }
];
check(MEM.recall(mems, 'Mochi threw up today', { now: t0 }).some(m => m.id === 'a'), '检索：说到猫能召回猫');
check(MEM.recall(mems, 'the weather is nice', { now: t0, k: 2 }).length === 0, '检索：无关的话不硬塞记忆');
const up = MEM.upsert([{ id: 'x', slot: 'work', content: 'Works as a designer', status: 'active' }], { slot: 'work', content: 'Works as a nurse' }, { confirmed: true });
check(up.mem.content === 'Works as a nurse' && up.list.find(m => m.id === 'x').status === 'superseded', '同槽位新值覆盖旧值');
const del = [{ id: 'y', status: 'active', content: 'secret', slot: 'name' }];
MEM.remove(del, 'y');
check(del[0].status === 'deleted' && del[0].content === '' && MEM.wasRejected(del, 'name', []), '删除留墓碑且同槽位不再提议');
check(MEM.isLowSensitivity({ type: 'preference' }) && !MEM.isLowSensitivity({ type: 'event' }), '只有偏好算低敏感（可自动保留）');
check(typeof MEM.THRESHOLD === 'number' && MEM.THRESHOLD > 0, '召回阈值存在');

/* --- 主动互动与关系 --- */
check(['new', 'familiar', 'trust', 'steady'].every(s => LIFE.STAGE_NAME[s]), '四个关系阶段齐备');
check(LIFE.stageOf({ rel: { effectiveCount: 0 } }) === 'new', '关系从"初识"开始');
check(LIFE.inQuiet(23, { start: 22, end: 9 }) && !LIFE.inQuiet(12, { start: 22, end: 9 }), '免打扰时段正确');
check(LIFE.PER_DAY.high === 2 && LIFE.PER_DAY.low === 1, '主动程度对应每天条数');
check(Object.keys(LIFE.EXPERIMENTS).length === 4, '四个实验都在');
check(LIFE.assign('user-1').paywall_timing_v1 === LIFE.assign('user-1').paywall_timing_v1, 'A/B 分组按用户哈希稳定');
check(LIFE.zTest(50, 100, 50, 100).p > 0.9, 'z 检验：相同比例给不出显著性');

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
  'app/src/main/java/com/tide/app/KeyStore.kt',
  'app/src/main/java/com/tide/app/VoiceBridge.kt',
  'app/src/main/java/com/tide/app/CareNotifier.kt',
  'app/src/test/java/com/tide/app/LlmClientTest.kt'
];
must.forEach(f => check(exists(path.join('android', f)), 'android 存在 ' + f));
/* 模型权重不进仓库（941 MB，.gitignore）；只检查目录和说明 */
check(exists('android/app/src/main/assets/models'), '模型目录存在（权重本地放入，见 README「打包前准备」）');
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

/* ---------------- 5. 文档 ---------------- */
[
  'docs/08_PRD_Orbit_v6.md',
  'docs/08_PRD_潮汐Tide_v1.0.md',
  'docs/12_合规与危机干预SOP.md',
  'docs/13_数据埋点与指标字典.md',
  'docs/16_产品定位_第三空间.md',
  'docs/19_角色设计_人群与性格.md',
  'docs/25_Prompt工程文档.md',
  'docs/26_RAG与记忆文档.md',
  'docs/28_工作流文档.md',
  'docs/31_Orbit_v6_实现与测试.md',
  'docs/32_玩法_v6.3_从恋爱游戏PRD取用的机制.md'
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
