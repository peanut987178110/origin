<!-- tide-v6-banner -->
> 当前版本 v6.3.0「Orbit」（2026-11-15）：按《Orbit PRD V2.0》重做，**下载即用**——不用登录、不用 API Key、不联网，模型（Qwen2.5-1.5B Q4_K_M）在手机上运行。安装包 `dist/Orbit-v6.3.0.apk`。产品定义见 `docs/08_PRD_Orbit_v6.md`；实现、测试与已知问题见 `docs/31_Orbit_v6_实现与测试.md`（§10 是最新一轮）；抓娃娃、一起专注等玩法取用的机制见 `docs/32_玩法_v6.3_从恋爱游戏PRD取用的机制.md`。**没有真实用户数据，没有真实支付；真机未测。** 下面的内容描述的是 v5「潮汐」，保留作对照。

# Orbit（原潮汐 Tide）· AI 陪伴产品经理实战项目

> **2026-11-15 清理说明**：本文提到的 `prompts/`、`workflow/`、`evalset/`、`demo/`、`server/`、`analytics/`、`shared/tide_core.js` 是 v5 服务端版的内容，已从仓库移除（保留在学习方法里作对照）。v6 运行中的对应物：提示词 `shared/orbit_mind.js`、人格 `shared/orbit_personas.js`、记忆 `shared/orbit_memory.js`、玩法 `shared/orbit_play.js`；测试见 `docs/31` §10。

一个**海外 AI 陪伴 App 的完整原型**，用来学习并通过「AI 陪伴产品经理（海外）」岗位的面试。
包含：安卓 App、自建服务端、数据分析 SQL、自动化测试，以及 PRD / Prompt / RAG / Skills / 工作流 / 市场数据 / 教程等全套文档。

> **一句话定位**：晚上可以来坐坐的地方——记得你、接得住你、不越界。不是心理治疗，不是恋人。

---

## 1. 现状（先看这个，面试别说错）

| | 状态 |
|---|---|
| App + 服务端 + SQL + 测试 | ✅ 完整可跑，自动化测试全部通过（见 `TEST_REPORT.md`） |
| 线上大模型 | 🟡 默认接 DeepSeek（按官方文档配置），**没有用真实 Key 跑过**；质量测试用的是本机 qwen2.5:3b |
| 服务端部署 | ❌ 没有部署到公网 |
| 支付 | ❌ 模拟（没接 Google Play Billing） |
| 用户数据 | ❌ **没有任何真实用户数据**。所有留存、转化数字都只存在于合成测试数据里 |

完整的"做了 / 只模拟过 / 没做"三栏表：`docs/24_v5当前实现与发布门槛.md`。

---

## 2. 小白从哪开始（推荐顺序）

| 顺序 | 读什么 | 学到什么 | 时间 |
|---|---|---|---|
| 1 | `00_小白教程_用生活比喻看懂潮汐.md` | 整个产品怎么工作（全是生活比喻） | 1 小时 |
| 2 | `docs/31_Orbit_v6_实现与测试.md`（§10 是最新一轮） | 哪些是真的、哪些不是、真机测出了什么 | 20 分钟 |
| 3 | `docs/28_工作流文档.md` | 一句话从输入到回复经过哪些环节；需求 → PRD → 复盘 | 40 分钟 |
| 4 | `docs/08_PRD_Orbit_v6.md` | 一份完整 PRD 长什么样（v5 的 `docs/08_PRD_潮汐Tide_v5.md` 保留作对照） | 40 分钟 |
| 5 | `docs/25_Prompt工程文档.md` | 提示词怎么写、为什么光有提示词不够 | 40 分钟 |
| 6 | `docs/26_RAG与记忆文档.md` | 记忆检索、调参集 vs 留出集 | 40 分钟 |
| 7 | `docs/27_Skills文档_智能体能力清单.md` | 19 个技能：哪些靠模型、哪些靠规则 | 30 分钟 |
| 8 | `docs/32_玩法_v6.3_从恋爱游戏PRD取用的机制.md` | 抓娃娃/专注这些玩法怎么从别人的 PRD 里取机制、改掉什么 | 20 分钟 |
| 9 | `docs/13`（末尾 v6 一节） | 埋点、漏斗、留存、分群、A/B 的口径 | 1 小时 |
| 10 | `docs/07`（末尾 v5 一节）+ `docs/09`（ADR-12～19） | 单位经济（v5 云端 vs v6 端侧）、关键决策 | 40 分钟 |
| 11 | `docs/29_市场数据手册.md` | 带来源和可信度等级的市场数据 | 30 分钟 |
| 12 | `docs/30_JD对照与面试题库.md` | 两份 JD 逐条对照 + 25 道面试题 | 反复练 |

学习方法与三周计划：`15_学习步骤与方法.md`、教程第 14 章。

---

## 3. 对照岗位 JD

两份 JD（产品经理（AI 陪伴）、AI 陪伴产品经理（海外））的每一条要求，在 `docs/30` 里都对应到了：**产品里的功能 → 代码/测试证据 → 一句话回答**。速览：

| JD 关键词 | Orbit 里在哪 |
|---|---|
| 角色发现 / 新手引导 / 首次互动 | 一个问题推荐角色、角色卡带示例台词、开场白接住回答 |
| 主动互动与召回 | 到期追问、主动消息（A/B）、回访承接 |
| 角色活感 | 角色"今晚在做什么"，深夜换"也还醒着" |
| 会员体验 | 免费 40 / Premium 300、软上限、付费墙不打断情绪（演示版不扣费） |
| 提示词工程 / 对话上下文 | `docs/25`、`shared/orbit_mind.js`、`shared/orbit_personas.js` |
| Memory / RAG | `docs/26`、`shared/orbit_memory.js`、`tools/rag_eval.js` |
| 埋点 / 漏斗 / 留存 / 分群 / A-B | `docs/13`（末尾 v6 一节）、`09_dashboard_boot.js`；v5 的 SQL 版本保留在 `analytics/` |
| 玩法设计 / 从别人的 PRD 取机制 | `docs/32`、`shared/orbit_play.js` |
| Prompt / Memory / 多模态 / Agent 边界 | `docs/30` §2 |
| 竞品与市场 | `docs/10`、`docs/29` |

---

## 4. 目录

```
├── 00_小白教程_用生活比喻看懂潮汐.md   ★ 入门（已按 v6 更新，标题沿用旧名）
├── README.md / TEST_REPORT.md / 15_学习步骤与方法.md / 00_学习路线图_14周.md / 00_体检报告_项目问题清单.md
├── docs/            产品文档：08 PRD（v6 现行 + v5 对照）、25/26/27/28 提示词·记忆·技能·工作流、
│                    31 实现与测试（§10 最新）、32 玩法取舍；其余为方法论，开头横幅说明其现状
├── shared/          ★ orbit_personas.js 角色 · orbit_mind.js 提示词与守卫 · orbit_memory.js 记忆
│                    orbit_life.js 主动互动/关系/实验 · orbit_play.js 玩法规则 · market_data.js 行业数据
│                    tide_core.js（v5 遗留，保留作对照，不参与 v6 运行）
├── src/app/         页面：index.html（结构与样式）+ js/01–10 模块（由 tools/build_app.js 拼成单页）
├── server/          v5 服务端（保留作对照，v6 不运行）
├── analytics/       v5 的 queries.sql + report.js（SQL 口径与自检，方法论仍可读）
├── android/         安卓外壳（WebView + cpp/orbit.cpp 端侧推理 + 语音 + 通知）
├── tools/           构建、校验、E2E（桌面/模拟器）、玩法单测、检索评测、APK 打包与校验
├── evalset/         120 例评测集与评测脚本
├── prompts/ workflow/   提示词与 Dify 工作流教学材料（运行中的提示词以 shared/orbit_mind.js 为准）
├── interview/       面试材料
├── demo/            早期规则引擎教学原型（不是产品）
└── dist/            安装包（当前：Orbit-v6.3.0.apk）
```

---

## 5. 怎么跑

需要：Node 22+、Python 3。打包 APK 另需 JDK 17、Android SDK 34、Gradle 8.7（见 `docs/17`）。**跑测试不需要模型、不需要联网。**

```powershell
# 全部静态检查（秒级，不需要模型）
node tools/verify_app.js
node tools/orbit_play_test.js
node tools/unit_engine_test.js
node tools/rag_eval.js
python -I tools/selftest.py

# 桌面 E2E（替身模型，只验流程与布局；需先起 tools/dev_stub_server.js）
node tools/dev_stub_server.js
$env:ORBIT_ENGINE="http://127.0.0.1:11500"; node tools/orbit_e2e.js web

# 模拟器 E2E（真触摸 + 真模型；先装 APK、开模拟器）
node tools/orbit_e2e.js device

# 打包 APK（含 14 项 Gradle 单测和产物校验）
powershell -ExecutionPolicy Bypass -File tools\build_apk.ps1
```

改完页面必须 `node tools/build_app.js` 重建 `android/app/src/main/assets/index.html`，否则 E2E 跑的是旧页面。

---

## 6. 数据纪律

这个项目早期最大的问题是**编造的效果数字**，已经全部删除（过程见 `00_体检报告`）。现在的规矩：

1. **产品效果数字**只来自脚本的真实输出，并写明测试集是什么（如"自建 36 例，非真实用户"）。
2. **市场数字**只来自 `docs/29`，每条都有来源、日期、口径、可信度等级；面试只引用 A/B 级。
3. **合成数据**（SQL 自检用）的报表打 `SYNTHETIC` 水印，不能出现在简历和汇报里。
4. 说不出出处和口径的数字，就不说。

`python tools/selftest.py` 的 T8 会扫描文档，防止被删掉的假数字被写回来。

---

## 7. 版本

| 版本 | 日期 | 变化 |
|---|---|---|
| v1–v2 | — | 规则引擎原型（`demo/`） |
| v3 | 2026-11-01 | 安卓 App，用户自填 API Key 直连 9 家厂商 |
| v4 / v4.1 | 2026-11-02 | 内置离线小模型、陪伴空间 |
| v5.0 | 2026-11-02 | 海外订阅版：自建服务端、静默注册、6 个双语角色、记忆、晚间关怀 A/B、埋点与 SQL |
| **v5.1** | **2026-11-10** | 对齐两份 JD：补回记忆陷阱与敷衍重生成；角色卡示例台词；深夜活感；回访承接；分群 / cohort / 召回 / 回复质量 SQL；同义词检索 + 留出集评测；"关于潮汐"行业数据；PRD / Prompt / RAG / Skills / 工作流 / 市场数据 / 教程 / JD 题库文档 |

| **v6.0** | **2026-11-10** | 改名 Orbit，按 PRD V2.0 重做：本地优先（无服务端、无登录），Qwen2.5-1.5B 端侧推理（KV 缓存复用 + 流式），4 个角色、受控记忆、主动回访、情绪策略、关系阶段、会员、实验与看板 |
| **v6.3** | **2026-11-15** | 抓娃娃 / 一起专注 / 共同记录（机制取自用户给的恋爱游戏 PRD，只取机制不取角色与文案）；逐句 TTS；这一轮在模拟器上用真手指复测，修掉「换她来抓」「好了」「受邀返回」点不动、关系进度每天上限失效、"今天第一次"文案说错等 6 处真 bug；测试数字见 `docs/31` §10（旧的 "桌面/模拟器各 121 项" 已作废） |

每个版本为什么这样改：`docs/09_版本规划与决策记录.md`。
