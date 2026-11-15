/* =========================================================================
   v5_docs_banner.js · 文档版本横幅统一工具（可重复运行）
   -------------------------------------------------------------------------
   问题：v4.0 和 v4.1 两次改版时，脚本在每份文档开头各叠了一段横幅，
         读者打开任何一份文档，先看到的是两段过时的版本说明。
   做法：
     1. 第一次运行时，把 docs/ prompts/ workflow/ interview/ 和根目录 .md
        原样备份到 docs/history_before_v5/（已存在就不覆盖）
     2. 去掉文档开头所有旧横幅（v4.0、v4.1、以及本工具自己上次写的 v5 横幅）
     3. 按文档类别加一段新横幅：说明这份文档在 v5 里是什么地位、当前实现看哪里
   用法：node tools/v5_docs_banner.js          （--dry 只打印将要改动的文件）
   ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry');
const HIST = path.join(ROOT, 'docs', 'history_before_v5');
const V5_MARK = '<!-- tide-v5-banner -->';

const CUR = '`docs/24_v5当前实现与发布门槛.md`';
const PR = '`docs/25_Prompt工程文档.md` 与 `docs/26_RAG与记忆文档.md`';
const TUT = '`00_小白教程_用生活比喻看懂潮汐.md`';
const PRD = '`docs/08_PRD_潮汐Tide_v5.md`';

/* 每类文档的横幅：只说"它现在算什么、现行内容在哪"，不复述细节，避免又一处口径漂移 */
const BANNERS = {
  method: `> 当前版本 v5.1.0（2026-11-10）。本文是**方法论/设计思路**，仍然有效；其中的实现细节、数字和"已完成"说法以 ${CUR} 为准。当前 PRD 见 ${PRD}。`,
  prompt: `> 当前版本 v5.1.0。**运行中的提示词不在本文**，而在 \`shared/tide_core.js\`（中英双语，App 与服务端共用），设计说明见 ${PR}。本文保留为提示词设计的教学材料；与代码不一致时以代码为准。`,
  workflow: `> 当前版本 v5.1.0。本文描述的是 **Dify/Coze 工作流教学方案**，不是潮汐 App 的实际运行链路。实际链路与 Dify 节点对照见 \`docs/28_工作流文档.md\`。`,
  interview: `> 当前版本 v5.1.0。讲项目时以 ${CUR} 的"已实现 / 只用模拟测过 / 未做"三栏为准：**没有真实用户数据，不讲留存和付费结果**；测试用的是模拟模型、本机小模型和合成数据。题库见 \`docs/30_JD对照与面试题库.md\`。`,
  legacy: `> 历史版本文档。当前为 v5.1.0，现行说明见 ${CUR}；本文只描述它所写的那个版本，保留用于对照。`,
  study: `> 当前版本 v5.1.0（2026-11-10）。入门先读 ${TUT}；涉及潮汐的实操按 ${CUR} 末尾"学习任务"执行；文中旧版本的完成状态以该文档为准。`,
  root: `> 当前版本 v5.1.0（2026-11-10）：海外在线订阅版。默认走潮汐服务端，断网退回手机内置模型。入门先读 ${TUT}；现行说明见 ${CUR}，PRD 见 ${PRD}，Prompt 与 RAG 见 ${PR}。**服务端尚未部署到公网，支付为模拟，没有真实用户数据。**`
};

function category(rel) {
  const n = rel.replace(/\\/g, '/');
  if (/^docs\/(08_PRD_潮汐Tide_v1|18_v3|20_连接|21_安装|22_v4|23_v4\.1)/.test(n)) return 'legacy';
  if (n.startsWith('prompts/')) return 'prompt';
  if (n.startsWith('workflow/')) return 'workflow';
  if (n.startsWith('interview/')) return 'interview';
  if (/^(00_学习路线图|15_学习步骤)/.test(n)) return 'study';
  if (/^(README|TEST_REPORT|00_体检报告)/.test(n)) return 'root';
  if (/^docs\/(2[4-9]_|30_|08_PRD_潮汐Tide_v5|_research\/)/.test(n)) return null;   // v5 新文档自己有完整说明
  if (/^00_小白教程/.test(n)) return null;
  if (n.startsWith('docs/history_before_v5')) return null;
  return 'method';
}

/* 去掉文档开头的旧横幅：连续的 "> " 引用块，且块内含版本口径关键词 */
function stripBanners(t) {
  let s = t.replace(/^\uFEFF/, '');
  for (let guard = 0; guard < 6; guard++) {
    const before = s;
    s = s.replace(/^\s+/, '');
    if (s.startsWith(V5_MARK)) {
      s = s.slice(V5_MARK.length).replace(/^\s*(>[^\n]*\n?)+/, '');
      continue;
    }
    const m = s.match(/^((?:>[^\n]*\n?)+)/);
    if (m && /(当前交付口径|v4\.1\.0 更新|v4\.0\.0|验证状态：v4|本地模式目前为整段返回)/.test(m[1])) {
      s = s.slice(m[1].length);
      continue;
    }
    if (s === before) break;
  }
  return s.replace(/^\s+/, '');
}

function walk(dir, out) {
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    const st = fs.statSync(full);
    if (st.isDirectory()) { if (!/history_before_v5|node_modules|^\./.test(f)) walk(full, out); }
    else if (f.endsWith('.md')) out.push(full);
  }
  return out;
}

const files = [];
for (const f of fs.readdirSync(ROOT)) if (f.endsWith('.md')) files.push(path.join(ROOT, f));
for (const d of ['docs', 'prompts', 'workflow', 'interview']) walk(path.join(ROOT, d), files);

/* 1. 备份（只在第一次） */
if (!DRY && !fs.existsSync(HIST)) {
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    const dst = path.join(HIST, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(f, dst);
  }
  console.log('已备份 ' + files.length + ' 份文档到 docs/history_before_v5/');
}

/* 2-3. 去旧横幅、加新横幅 */
let changed = 0;
for (const f of files) {
  const rel = path.relative(ROOT, f);
  const cat = category(rel);
  if (!cat) continue;
  const raw = fs.readFileSync(f, 'utf8');
  const body = stripBanners(raw);
  const next = V5_MARK + '\n' + BANNERS[cat] + '\n\n' + body;
  if (next !== raw) {
    changed++;
    if (DRY) console.log('[dry] ' + cat.padEnd(10) + rel);
    else fs.writeFileSync(f, next, 'utf8');
  }
}
console.log((DRY ? '[dry] 将更新 ' : '已更新 ') + changed + ' 份文档');
