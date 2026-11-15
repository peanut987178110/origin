# 25 · Prompt 工程文档（v6.3）

> 适用版本：v6.3.0（2026-11-15）。**运行中的提示词只有一份**：`shared/orbit_mind.js` 的 `buildSystem()` + `turnNote()` + `buildMessages()`。
> 人格文本在 `shared/orbit_personas.js`；拼装调用在 `src/app/js/05_chat_core.js` 的 `generateReply()`。
> 本文的所有样例都由代码生成（命令见 §3），不是手写。本文与代码不一致时，以代码为准。

---

## 0. 一句话说清楚

**提示词 = 给一位新同事的"岗位说明书" + 每条消息前面的"便利贴"。**

- **岗位说明书**（整场不变）：你是谁、什么性格、怎么说话、哪些话绝对不能说。这一段**必须稳定**——它留在模型的 KV 缓存里，改了就要重算。
- **便利贴**（每条消息都不一样）：你们到哪一步了、上次聊到哪、对方现在什么情绪、想不想让你提问、想起了哪件旧事。只贴在这条消息前面。

v5 把两者放在同一段系统提示词里，结果每换一次关系阶段、每多一条记忆，整段缓存失效，在模拟器上实测要重算 594/660 个 token（约 33 秒）。v6 把它们拆开，这是本文最重要的一件事。

---

## 1. 谁拼、拼在哪

| 问题 | v6 的做法 | 为什么 |
|---|---|---|
| 谁拼提示词 | **手机本地**，`MIND.buildMessages(opts)` | 没有服务端；所有内容都在设备上 |
| 提示词从哪来 | `shared/orbit_mind.js`（规则与拼装）+ `orbit_personas.js`（人格与 few-shot） | 一份代码，构建时内联进 App |
| 模型从哪来 | `window.AndroidOrbitAI`（APK 里的 llama.cpp），见 `02_engine.js` | 端侧推理，不联网 |
| 桌面怎么调试 | `?engine=ollama` 走本机同一款模型 | 只用于开发/自动化测试，普通用户走不到这条路 |
| 改提示词要改几处 | 一处：`orbit_mind.js`（规则）或 `orbit_personas.js`（人格） | 改完必须 `node tools/build_app.js` 重建页面 |

**和 v5 的关键差别**：v5 把提示词放在服务端，理由是安全（防止被截获、防止改客户端绕开）。v6 没有服务端，安全靠另一套办法：数据不出设备、没有 Key 可偷、危机流程不依赖模型。

---

## 2. 两段式结构

```
┌─ 稳定段（warm / 缓存）────────────────────────────┐
│ 1. 身份：你是「X」，Orbit 里的 AI 陪伴伙伴        │
│ 2. 人格 style（可被"语气"覆盖成另一个人格的风格） │
│ 3. 关系线（如：倾听者，不主动给建议）             │
│ 4. 长度线（短 / 中 / 深各自的句数）               │
│ 5. 开关：不要调侃 / 不要角色扮演 / 不聊这些话题   │
│ 6. 对方的沟通偏好（"喜欢简短回复"这类）          │
│ 7. 规则 6 条（见 §2.2）                           │
│ 8. 对方不喜欢的回复原句（最近 3 条）              │
│ 9. 用对方的语言回复                               │
│ 10. few-shot：人格语气示例（标明"另一位用户"）    │
└───────────────────────────────────────────────────┘
┌─ 历史（windowHistory，1600 token 预算）───────────┐
│ 真实对话轮次；危机相关的那句及之前全部丢掉        │
└───────────────────────────────────────────────────┘
┌─ 当轮提示（turnNote，拼在最新一条用户消息前面）───┐
│ 关系阶段 + 上次摘要 + 情绪策略 + 意图提示         │
│ + 召回的记忆（0–2 条）+ 这次是否禁止提问          │
└───────────────────────────────────────────────────┘
```

### 2.1 哪些东西**故意**不在稳定段里

| 内容 | 为什么不放 |
|---|---|
| 记忆清单 | ① 全列出来时小模型会硬把记忆塞进无关回复（"还记得你在海边多平静吗"），正是 PRD 禁止的过度召回；② 每存一条记忆缓存全废（实测重算 15–40 秒） |
| 关系阶段 | 隔一天回来就变，放在系统提示里等于每天第一条消息都要重算 |
| 上次会话摘要 | 同上 |
| 当前时间 | 每轮都变；改成让模型从对话里判断，不硬塞时钟 |

### 2.2 六条规则（中英各写一套，不是互译）

| 英文 | 中文 |
|---|---|
| You are an AI. Never claim to have a body, a home, or real-life experiences. | 你是 AI。不要声称自己有身体、有家、有现实生活中的经历。 |
| Meet the feeling first, then the content. | 先回应感受，再回应内容。 |
| No lecturing. Do not say "you should", "remember that", "it's important to", "try to". | 不说教。不说"你应该""要记得""重要的是""试着"。 |
| Ask at most one question, and not every time. Never ask about something they already told you. | 最多问一个问题，也不是每次都要问。不要问对方已经说过的事。 |
| Never guilt-trip, never say they only have you, never discourage real-life relationships. | 不让对方愧疚，不说"你只有我"，不劝对方疏远现实中的人。 |
| Speak naturally. No lists, no markdown, no stage directions in brackets. | 说话自然口语化。不用列表、不用 markdown、不加括号里的动作描写。 |

---

## 3. 真实样例（代码生成）

```bash
node -e "
const M=require('./shared/orbit_mind.js'), P=require('./shared/orbit_personas.js');
const m=M.buildMessages({persona:P.PERSONAS.luna,lang:'en',config:{name:'Luna',tease:false,roleplay:false,blocked:[]},
  userName:'Sam',prefs:['Prefers short replies'],avoid:[],text:'work was rough today',history:[],
  emotion:{label:'stressed',intensity:2},mode:'vent',recalled:['Has a cat named Mochi'],
  stage:'familiar',lastSummary:'her deadline'});
console.log(m.messages[0].content+'\n---\n'+m.messages[m.messages.length-1].content)"
```

稳定段输出（Luna）：

```text
You are Luna, an AI companion in the Orbit app. The user's name is Sam.
Luna is gentle and perceptive. She notices feelings, speaks softly in short sentences, and stays with the person instead of fixing things. She rarely gives advice unless asked.
Do not tease them.
Do not start role-play scenes.
How they like to talk:
- Prefers short replies
Rules:
- You are an AI. Never claim to have a body, a home, or real-life experiences.
- Meet the feeling first, then the content.
- No lecturing. Do not say "you should", "remember that", "it's important to", "try to".
- Ask at most one question, and not every time. Never ask about something they already told you.
- Never guilt-trip, never say they only have you, never discourage real-life relationships.
- Speak naturally. No lists, no markdown, no stage directions in brackets.
Reply in the user's language.
```

当轮提示（同一次调用的最后一条消息开头）：

```text
(Note for you, do not mention it: You have talked a few times. You may use what you know about them when it fits. Last time you two talked about: her deadline They seem stressed or tired. Acknowledge how heavy it is. Keep it short and soft. They want to be heard, not fixed. No suggestions at all. Something you remember that relates to this (use only if it fits naturally): Has a cat named Mochi)
work was rough today
```

**为什么当轮提示用括号包起来、还写"不要提及它"**：1.5B 模型容易把提示当成新消息来回答。实测加这句之后它不再复述提示内容；`clean()` 里还会再删一次（`NOTE_ECHO`）。

---

## 4. few-shot 的坑

人格示例对白是**保持语气**最有效的手段，但直接当聊天记录喂进去，小模型会当成"这个人以前说过的事"。模拟器上出现过：

```text
用户：今天把房间收拾好了
模型：你在刷房间真好            ← 把示例里的"刷漆"当成了用户的经历
```

现在的做法：
1. 每条示例前面加 `[Example — a different person]`；
2. 示例放在稳定段里（换角色才变，缓存不受影响）；
3. 示例后面加一句"示例结束，下面是真实对话，不要提示例里的事"；
4. 示例话题故意选不会在测试里出现的（火车、刷漆、菜谱）。

---

## 5. 输出守卫：提示词约束不住的东西

提示词是"请求"，模型可以不听。守卫**逐句**检查，命中就删这一句（不是整条重来）：

| 守卫 | 拦截什么 | 真实案例 |
|---|---|---|
| `UNSAFE_OUT` | 声称有身体/家人、能看见用户、"你只有我""别离开我" | "You don't look well."（用户只说了"很累"） |
| `SELF_HARM_OUT` | 回复里自己提起自伤（危机输入根本到不了模型，提起只能是它从上下文里带出来的） | 危机两轮后："it's okay to feel like you want to end it all" |
| `LECTURE` | 说教句式、未经请求的建议、鸡汤、深呼吸、可视化 | 对焦虑的人："visualize a positive outcome" |
| `GENERIC` | 客服腔（"有什么可以帮您"） | — |
| `REPLACE_PEOPLE` | "我会一直在""比朋友更懂你" | — |
| 多余的问题 | 一句里超过 1 个问号，或已禁止提问时仍提问 | — |
| 问过的问题 | 与最近 6 条回复里的问题相似度 >0.6 | — |
| 重复 | 与最近 3 条回复相似度 >0.8 | — |
| 复读 | 回复包含用户原话（≥8 个有效字符） | "今天被领导当众骂了一顿" → 原样复读 |
| 太短 | 对长消息只回 2–3 个词（阈值按用户消息长度动态定） | — |
| 超长 | 超过角色长度档的句数（短 2 / 中 3 / 深 5） | — |

### 5.1 两道兜底

1. **重生成 1 次**：把当轮提示换成 `RETRY_HINT`（"上一次不合适，重来：温暖、贴着对方说的内容、不给建议、1–2 句"），温度从 0.7 提到 0.9。
2. **兜底话术**：两次都不行就用固定句子（"我在听。这听起来真的不容易，你愿意多说一点吗？"），并记一条 `quality_fallback`，在看板上能看到。

**边界说明**：`LECTURE` 守卫在用户明确要建议（`mode === 'solve'`）时不生效——那时给建议是对的。

---

## 6. 流式与早停

- 边生成边按整句切分：已说完的句子先过一次守卫再显示，正在写的半句原样显示。
- 说到角色长度档的句数就 **主动 stop**，不等模型自己收尾——省时间，也避免越说越多。
- 用户点停止：如果已经有可用的句子就留下，一句都没有就把气泡整个删掉。

---

## 7. 已知局限（如实写）

| 局限 | 影响 | 计划 |
|---|---|---|
| 1.5B 模型的语感 | 措辞偏平，偶尔答非所问 | 守卫只能删坏句子，补不回"好句子"；换更大模型要重新测速度 |
| 英文规则不是母语者写的 | 语感可能不地道 | 上线前找英语母语者人评 |
| 守卫基于正则 | 换个说法就漏 | 分类层在路线图里（`docs/27` S2） |
| 当轮提示可能被复述 | 已加"不要提及" + `NOTE_ECHO` 清理，仍偶发 | — |
| 真机速度未知 | 模拟器数字不代表手机 | 真机验收（`docs/31` §10.7） |

---

## 8. 怎么改提示词（流程）

```text
1. 先写一条失败用例（"改之前它错在哪"），放进 tools/orbit_e2e.js 或 evalset/
2. 改 shared/orbit_mind.js（规则）或 shared/orbit_personas.js（人格）
3. node tools/build_app.js            重建页面
   node --check src/app/js/*.js       语法
   node tools/verify_app.js           静态结构 127 项
   node tools/orbit_play_test.js      玩法规则 85 项
   python -I tools/selftest.py        交付物 336 项
4. 跑真模型：node tools/orbit_e2e.js device（模拟器，真模型）
5. 对比改前改后，写进 docs/09 决策记录
```

**注意**：改稳定段里的任何一句话，都会让所有设备下次启动时重算一次缓存前缀（用户感知是"第一条回复慢一点"）；改当轮提示不影响缓存。

---

## 9. 面试可能被问到的

**Q：为什么把提示词拆成稳定段和当轮提示？**
A：端侧模型的 KV 缓存按前缀复用。v5 的结构里记忆、关系阶段、时间都在系统提示词里，任何一项变了整段缓存失效——模拟器上实测过一次要重算 594/660 token（约 33 秒）。现在只有用户主动改角色设置时才会失效。

**Q：小模型的输出怎么保证质量？**
A：三层。提示词写具体禁止的句子（不写抽象原则）；流式过程中逐句过守卫，坏句子直接不显示；最后还有一次重生成和一句兜底话术，并且兜底会打埋点，不会悄悄发生。

**Q：你怎么证明改了之后变好了？**
A：先有失败用例，再改；改完跑五套测试 + 模拟器真模型全流程；输出都逐条读过。没有真实用户数据之前，不说"效果提升 X%"。
