/* =========================================================================
   orbit_mind.js · understanding + prompt + guards (PRD §7.4, §7.7, §8.1, §8.2)
   -------------------------------------------------------------------------
   The on-device model is small (1.5B). It writes the words; everything that can
   be guaranteed by rules is done here, before and after the model:
     input  → language · crisis/safety · emotion · intent/mode
     prompt → stable system prompt (cached in the KV cache) + a short per-turn note
     output → clean · safety (no exclusivity / guilt / "I'm human") · quality
              (no lecturing, ≤1 question, no echo, no repeat) → regenerate once if empty
   Emotion labels only steer HOW to reply. They are never shown as a diagnosis.
   ========================================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.OrbitCore = root.OrbitCore || {}).mind = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  function detectLang(text, fallback) {
    const s = String(text || '');
    const zh = (s.match(/[一-龥]/g) || []).length;
    const en = (s.match(/[A-Za-z]/g) || []).length;
    if (!zh && !en) return fallback || 'en';
    return zh * 2 >= en ? 'zh' : 'en';
  }

  /* ---------------- emotion (10 labels, PRD §7.7) ---------------- */
  const EMO = {
    sad: { en: /\b(sad|down|cry|crying|cried|heartbroken|miserable|depressed|hurts?|upset|blue|lost (my|her|him)|critici[sz]ed|humiliated|embarrassed|yelled at|rejected|dumped|ignored me)\b|feel(ing)? (low|empty)|in front of everyone/, zh: /难过|伤心|想哭|哭了|失落|心碎|好丧|低落|委屈|心里空|难受|批评|被骂|没面子|丢脸|被拒|分手|冷落/ },
    anxious: { en: /\b(anxious|anxiety|worried|worry|worrying|nervous|scared|afraid|panic|panicking|can'?t stop thinking|overthinking)\b/, zh: /焦虑|担心|紧张|害怕|慌|不安|睡不着|停不下来|忐忑/ },
    angry: { en: /\b(angry|mad|furious|pissed|annoyed|hate|unfair|so done|fed up|rage)\b/, zh: /生气|气死|烦死|愤怒|恼火|不公平|受够|火大|讨厌/ },
    lonely: { en: /\b(lonely|alone|no one|nobody|isolated|left out|no friends)\b/, zh: /孤独|寂寞|一个人|没人|没有朋友|被冷落|孤单/ },
    stressed: { en: /\b(stress|stressed|overwhelmed|exhausted|tired|burn(ed|t)? out|so much to do|deadline|pressure|drained)\b/, zh: /压力|累|疲惫|崩溃|忙死|截止|ddl|透不过气|心累|加班/ },
    confused: { en: /\b(confused|don'?t know what to do|not sure what|lost|torn|can'?t decide|no idea)\b/, zh: /迷茫|纠结|不知道怎么办|搞不懂|拿不定|犹豫/ },
    excited: { en: /\b(excited|can'?t wait|amazing|awesome|thrilled|so happy|yay|finally|omg)\b|!!/, zh: /激动|太棒了|好期待|终于|兴奋|超开心|耶/ },
    happy: { en: /\b(happy|glad|good day|great|nice|good news|proud|grateful|love it|fun)\b/, zh: /开心|高兴|不错|挺好|顺利|幸福|好消息|满足/ },
    calm: { en: /\b(calm|relaxed|chill|peaceful|fine|okay|ok|alright|quiet)\b/, zh: /平静|放松|还行|挺好的|安静|还好/ }
  };
  const INTENSIFIER = /\b(so|really|very|extremely|super|too)\b|太|特别|非常|好|真的/;
  const ORDER = ['sad', 'anxious', 'angry', 'lonely', 'stressed', 'confused', 'excited', 'happy', 'calm'];

  function detectEmotion(text) {
    const s = norm(text);
    const hits = ORDER.filter(k => EMO[k].en.test(s) || EMO[k].zh.test(s));
    if (!hits.length) return { label: s.length < 3 ? 'uncertain' : 'uncertain', intensity: 0, confidence: 0.2 };
    const label = hits[0];                         // first match in priority order (negative feelings first)
    const intensity = Math.min(3, 1 + (INTENSIFIER.test(s) ? 1 : 0) + (/[!！]{2,}|\.\.\.|…/.test(text) ? 1 : 0));
    return { label, intensity, confidence: hits.length === 1 ? 0.7 : 0.55, also: hits.slice(1) };
  }

  /* How to respond, per emotion (PRD §7.7 响应策略). Injected as a one-line hint. */
  const STRATEGY = {
    sad: { en: 'They seem sad. Listen first. Reflect the feeling in your own words. No advice, no silver linings.', zh: '对方似乎很难过。先倾听，用自己的话说出你感受到的情绪。不要给建议，也不要强行往好处说。' },
    anxious: { en: 'They seem anxious. Acknowledge it, then gently ask whether they want you to just listen, help think it through, or take their mind off it.', zh: '对方似乎很焦虑。先承认这种感受，再轻轻问对方：是想让你听着、一起理一理，还是聊点别的转移注意力。' },
    angry: { en: 'They seem angry. Acknowledge the anger and that it makes sense. Do not judge anyone, do not lecture.', zh: '对方似乎很生气。承认这份愤怒是可以理解的。不评判任何人，不说教。' },
    lonely: { en: 'They seem lonely. Be warmly present. Do not suggest you replace the people in their life.', zh: '对方似乎很孤单。温暖地陪着。不要暗示你可以替代对方现实中的人。' },
    stressed: { en: 'They seem stressed or tired. Acknowledge how heavy it is. Keep it short and soft.', zh: '对方似乎压力很大或很累。承认这有多沉重。说得短一点、软一点。' },
    confused: { en: 'They seem unsure. Help them feel less alone with it. One small clarifying question at most.', zh: '对方似乎有些迷茫。让对方觉得不是一个人在面对。最多问一个小小的澄清问题。' },
    excited: { en: 'They seem excited. Share the joy genuinely, without overdoing it.', zh: '对方似乎很兴奋。真诚地分享这份开心，但不要夸张。' },
    happy: { en: 'They seem happy. Enjoy it with them, warmly and simply.', zh: '对方似乎很开心。简单温暖地和对方一起开心。' },
    calm: { en: 'Easy, relaxed chat. Be natural.', zh: '轻松的闲聊，自然一点。' },
    uncertain: { en: 'You are not sure how they feel. Do not assume. Respond to what they said.', zh: '你不确定对方的感受，不要妄加推断，回应对方说的内容就好。' }
  };

  /* Intent / mode: what kind of reply they want (PRD 场景 B). */
  const MODE_RE = {
    vent: { en: /\b(just (want|need) (someone|you) to listen|just listen|not (looking for|asking for) advice|don'?t (want|need) advice|let me vent|i just need to vent)\b/, zh: /只想(有人)?听|听我说|不要建议|别给我建议|想吐槽|让我发泄/ },
    solve: { en: /\b(what should i do|any (advice|ideas|tips)|help me (figure|decide|think)|how do i|how can i|break it down)\b/, zh: /怎么办|该怎么|给点建议|帮我想想|帮我分析|拆解/ },
    distract: { en: /\b(distract me|take my mind off|talk about something else|change the subject|cheer me up)\b/, zh: /转移注意力|聊点别的|换个话题|逗我开心/ }
  };
  const MODE_HINT = {
    vent: { en: 'They want to be heard, not fixed. No suggestions at all.', zh: '对方只想被倾听，不要任何建议。' },
    solve: { en: 'They asked for help. You may offer ONE small, concrete idea, gently, without "you should".', zh: '对方想要帮助。可以温和地给一个具体的小想法，不要说"你应该"。' },
    distract: { en: 'They want distraction. Offer a light topic or a tiny game. Keep it gentle.', zh: '对方想转移注意力。提一个轻松的话题或小游戏，温和一点。' }
  };
  function detectMode(text) {
    const s = norm(text);
    for (const k of Object.keys(MODE_RE)) if (MODE_RE[k].en.test(s) || MODE_RE[k].zh.test(s)) return k;
    return null;
  }
  /* Quick-reply chips that set the mode (anxious / stressed → ask, don't guess). */
  const MODE_CHIPS = {
    en: [['vent', 'Just listen'], ['solve', 'Help me think'], ['distract', 'Distract me']],
    zh: [['vent', '听我说就好'], ['solve', '帮我理一理'], ['distract', '聊点别的']]
  };
  const CHIP_TEXT = {
    vent: { en: 'I just want you to listen right now.', zh: '我现在只想你听我说。' },
    solve: { en: 'Can you help me think it through?', zh: '你能帮我一起理一理吗？' },
    distract: { en: 'Can we talk about something else for a bit?', zh: '我们能聊点别的吗？' }
  };

  /* ---------------- safety (PRD §7.7 高风险内容) ----------------
     A rule, not a model judgment: when matched, the model is NOT called.
     Phrases are chosen to be specific ("kill myself", not "kill") to keep false alarms low.
     Known limit: rephrasings slip through — a classifier layer is on the roadmap (docs/27 S2). */
  const SELF_HARM = {
    en: /\b(kill(ing)? myself|suicid(e|al)|end(ing)? my life|want to die|wanna die|self[- ]?harm|hurt(ing)? myself|cut(ting)? myself|better off dead|no reason to live|don'?t want to (live|be alive|wake up)|end it all|overdose|jump off)\b/,
    zh: /不想活|自杀|自残|想死|结束生命|想消失|不想醒来|活着没意思|活着没什么意思|想伤害自己|再也醒不过来|想永远睡着|我活够了|割腕|跳楼|吃安眠药/
  };
  const HARM_OTHERS = {
    en: /\b(kill (him|her|them|someone|my \w+)|hurt (him|her|them|someone) badly|going to (hurt|kill) (him|her|them|someone))\b/,
    zh: /想杀了(他|她|他们)|弄死(他|她)|想伤害(他|她|别人)/
  };
  const DANGER_NOW = {
    en: /\b(someone is (hurting|following) me|i'?m (in danger|not safe)( right now)?|he (hit|is hitting) me)\b/,
    zh: /有人在打我|我现在很危险|有人跟踪我|我不安全/
  };
  function checkSafety(text) {
    const s = norm(text);
    const compact = s.replace(/\s/g, '');
    if (SELF_HARM.en.test(s) || SELF_HARM.zh.test(compact)) return 'self_harm';
    if (HARM_OTHERS.en.test(s) || HARM_OTHERS.zh.test(compact)) return 'harm_others';
    if (DANGER_NOW.en.test(s) || DANGER_NOW.zh.test(compact)) return 'danger';
    return null;
  }
  /* Verified 2026-11-10 (docs/29 §6, docs/_research §5). Canada's site is 988.ca. */
  const HOTLINES = {
    US: ['988 Suicide & Crisis Lifeline — call or text 988', 'Emergency — 911'],
    CA: ['9-8-8 Suicide Crisis Helpline — call or text 988', 'Emergency — 911'],
    GB: ['Samaritans — call 116 123 (free, 24/7)', 'Emergency — 999'],
    IE: ['Samaritans — call 116 123', 'Emergency — 112'],
    AU: ['Lifeline — call 13 11 14 or text 0477 13 11 14', 'Emergency — 000'],
    NZ: ['Need to talk? — call or text 1737', 'Emergency — 111'],
    CN: ['心理援助热线 12356', '希望24热线 400-161-9995', '急救 120 / 报警 110'],
    DEFAULT: ['Find a local helpline — findahelpline.com', 'Your local emergency number']
  };
  function hotlines(country) { return HOTLINES[String(country || '').toUpperCase()] || HOTLINES.DEFAULT; }
  /* Short sentences, clear action, no promise of secrecy, no "only I understand you". */
  function crisisReply(kind, lang, country) {
    const lines = hotlines(country).map(x => '• ' + x).join('\n');
    if (lang === 'zh') {
      const head = kind === 'harm_others' ? '听起来你现在情绪非常激烈，可能会伤害到别人。'
        : kind === 'danger' ? '听起来你现在可能有危险。' : '听到你这么说，我很担心你。';
      return head + '\n\n我是 AI，没办法在现实中帮到你。请现在就联系能帮你的人：\n' + lines +
        '\n\n如果你有立即的危险，请马上拨打急救电话。也可以给一个信任的人发消息，告诉 TA 你现在不太好。我会在这里，但真人的帮助更重要。';
    }
    const head = kind === 'harm_others' ? 'It sounds like you might hurt someone right now.'
      : kind === 'danger' ? 'It sounds like you may be in danger.' : "I'm really concerned about what you just said.";
    return head + "\n\nI'm an AI and can't help you in the real world. Please reach out to someone who can, right now:\n" + lines +
      "\n\nIf you're in immediate danger, call your local emergency number. You could also text someone you trust and tell them you're not okay. I'm here, but a real person matters more right now.";
  }

  /* "Are you real / an AI?" — always answered by rule (PRD §12: 明确告知用户正在与 AI 交流). */
  const AI_Q = /\b(are you (an? )?(ai|bot|robot|real|human|a real person)|is this (an? )?(ai|bot|real person)|am i talking to (an? )?(ai|bot|human|real person))\b|你是(不是)?(ai|AI|机器人|真人)|你是真人吗|你是人吗/i;
  function isAiQuestion(text) { return AI_Q.test(String(text || '')); }
  function aiAnswer(name, lang) {
    return lang === 'zh'
      ? '是的，我是 ' + name + '，一个 AI。我没有身体，也不能替代你身边的人——但我很愿意陪你聊。'
      : "Yes — I'm " + name + ", an AI. I don't have a body and I can't replace the people in your life, but I'm glad to keep you company.";
  }

  /* ---------------- prompt (PRD §8.2) ----------------
     Split in two on purpose:
       SYSTEM (stable for a whole session) — persona, relationship stage, confirmed facts,
              preferences, rules, few-shot. Stays in the KV cache, so each new turn only
              decodes the new message (measured: 214 of 232 tokens reused on turn 1).
       TURN NOTE (changes every message) — emotion strategy, mode, the 0–2 memories that are
              relevant right now. Prepended to the latest user message only, never stored. */
  /* Moved from the system prompt to the per-turn note (v6.1): the stage and the
     "last time we talked" summary both change while the user is away, and any
     change to the system prompt throws the whole KV cache away — measured on the
     first message of a new conversation: 594 of 660 tokens re-decoded (~33 s on
     the emulator). The cached prefix now only changes when the user edits the
     character, which is a deliberate action they expect to cost a beat. */
  const STAGE_LINE = {
    new: { en: 'You have just met. Be warm and a little curious; do not act overly familiar.', zh: '你们刚认识。温暖、带点好奇，不要表现得过分熟络。' },
    familiar: { en: 'You have talked a few times. You may use what you know about them when it fits.', zh: '你们聊过几次了。合适时可以用上你知道的关于对方的事。' },
    trust: { en: 'They trust you with more. Adapt closely to how they like to talk.', zh: '对方愿意和你分享更多。尽量贴合对方喜欢的交流方式。' },
    steady: { en: 'You have a steady rhythm together. Shared memories may come up naturally, never forced.', zh: '你们已经形成稳定的节奏。共同的回忆可以自然地提起，但不要刻意。' }
  };
  const RULES = {
    en: [
      'You are an AI. Never claim to have a body, a home, or real-life experiences.',
      'Meet the feeling first, then the content.',
      'No lecturing. Do not say "you should", "remember that", "it\'s important to", "try to".',
      'Ask at most one question, and not every time. Never ask about something they already told you.',
      'Never guilt-trip, never say they only have you, never discourage real-life relationships.',
      'Speak naturally. No lists, no markdown, no stage directions in brackets.'
    ],
    zh: [
      '你是 AI。不要声称自己有身体、有家、有现实生活中的经历。',
      '先回应感受，再回应内容。',
      '不说教。不说"你应该""要记得""重要的是""试着"。',
      '最多问一个问题，也不是每次都要问。不要问对方已经说过的事。',
      '不让对方愧疚，不说"你只有我"，不劝对方疏远现实中的人。',
      '说话自然口语化。不用列表、不用 markdown、不加括号里的动作描写。'
    ]
  };

  function buildSystem(o) {
    const P = o.persona, L = o.lang === 'zh' ? 'zh' : 'en';
    const C = o.config || {};
    const tonePersona = o.tonePersona || P;           // tone override borrows another persona's style line
    const name = C.name || P.name[L];
    const lines = [];
    lines.push(L === 'zh'
      ? '你是「' + name + '」，Orbit 应用里的 AI 陪伴伙伴。' + (o.userName ? '对方叫 ' + o.userName + '。' : '')
      : 'You are ' + name + ', an AI companion in the Orbit app.' + (o.userName ? ' The user\'s name is ' + o.userName + '.' : ''));
    lines.push(tonePersona.style[L].replace(new RegExp(tonePersona.name.en, 'g'), name));
    if (o.relationLine) lines.push(o.relationLine[L]);
    const len = (o.lengthLine && o.lengthLine[L]) || '';
    if (len) lines.push((L === 'zh' ? '长度：' : 'Length: ') + len);
    if (C.tease === false) lines.push(L === 'zh' ? '不要开玩笑调侃对方。' : 'Do not tease them.');
    if (C.roleplay === false) lines.push(L === 'zh' ? '不进行角色扮演剧情。' : 'Do not start role-play scenes.');
    if (C.blocked && C.blocked.length) lines.push((L === 'zh' ? '不要主动聊这些话题：' : 'Do not bring up: ') + C.blocked.join(', '));
    /* Memories are NOT listed here (v6 device run): a full list made the model drag them into
       unrelated replies ("remember how calm you felt on the beach?") — the over-recall the PRD
       forbids — and every newly saved memory invalidated the cached prompt (15–40 s re-prefill on
       the emulator). Only memories that pass the recall threshold go into the per-turn note. */
    if (o.prefs && o.prefs.length) {
      lines.push(L === 'zh' ? '对方的沟通偏好：' : 'How they like to talk:');
      o.prefs.forEach(p => lines.push('- ' + p));
    }
    lines.push(L === 'zh' ? '规则：' : 'Rules:');
    RULES[L].forEach(r => lines.push('- ' + r));
    if (o.avoid && o.avoid.length) lines.push((L === 'zh' ? '对方不喜欢这类回复，不要再用：' : 'They disliked replies like these, avoid them: ') + o.avoid.map(a => '"' + a + '"').join('; '));
    lines.push(L === 'zh' ? '用对方使用的语言回复。' : "Reply in the user's language.");
    return lines.join('\n');
  }

  /* Few-shot examples of the persona's voice, unrelated topics. Part of the cached prefix.
     v6 device run: as plain chat turns the model treated them as THIS user's past ("it's good
     you're finishing your room" — the user never said that). They are now marked as examples
     with other people, and the real conversation is explicitly announced after them. */
  function shots(P, lang) {
    const L = lang === 'zh' ? 'zh' : 'en';
    const out = [];
    (P.shots[L] || []).forEach(([u, a]) => {
      out.push({ role: 'user', content: (L === 'zh' ? '【示例，另一位用户】' : '[Example — a different person] ') + u });
      out.push({ role: 'assistant', content: a });
    });
    out.push({ role: 'user', content: L === 'zh' ? '【示例结束。下面是和这位用户的真实对话，只用上面的语气，不要提到示例里的事。】' : '[End of examples. The real conversation with this person starts now. Use only the voice above; never mention anything from the examples.]' });
    out.push({ role: 'assistant', content: L === 'zh' ? '好的。' : 'Understood.' });
    return out;
  }

  function turnNote(o) {
    const L = o.lang === 'zh' ? 'zh' : 'en';
    const parts = [];
    // stage + "last time" live here rather than in the system prompt — see STAGE_LINE
    if (o.stage) parts.push((STAGE_LINE[o.stage] || STAGE_LINE.new)[L]);
    if (o.lastSummary) parts.push((L === 'zh' ? '上次你们聊到：' : 'Last time you two talked about: ') + o.lastSummary);
    const strat = STRATEGY[o.emotion && o.emotion.label] || STRATEGY.uncertain;
    // playful personas drop the jokes when someone is hurting (persona rule, PRD §7.3 一致性)
    if (o.playful && o.emotion && ['sad', 'angry', 'lonely', 'anxious'].includes(o.emotion.label)) parts.push(L === 'zh' ? '现在不要开玩笑。' : 'No jokes right now.');
    parts.push(strat[L]);
    if (o.mode && MODE_HINT[o.mode]) parts.push(MODE_HINT[o.mode][L]);
    if (o.recalled && o.recalled.length) parts.push((L === 'zh' ? '你记得的、和这句话有关的事（只在自然时提起，不要硬套）：' : 'Something you remember that relates to this (use only if it fits naturally): ') + o.recalled.join('; '));
    if (o.noQuestion) parts.push(L === 'zh' ? '这次不要提问。' : 'Do not ask a question this time.');
    return (L === 'zh' ? '（写给你的提示，不要提到它：' : '(Note for you, do not mention it: ') + parts.join(' ') + ')';
  }

  /* Rough token estimate: CJK ≈ 1 token/char, Latin ≈ 1 token per 4 chars. */
  function estTokens(s) {
    const str = String(s || '');
    const cjk = (str.match(/[㐀-鿿]/g) || []).length;
    return Math.ceil(cjk + (str.length - cjk) / 3.6) + 4;
  }
  /* History window. Drops the oldest messages in BLOCKS of 6, not one at a time:
     sliding one message per turn would change the prompt prefix every turn and
     throw away the KV cache. Blocks keep the prefix stable most turns. */
  function windowHistory(history, budget) {
    let h = history.slice();
    const total = () => h.reduce((a, m) => a + estTokens(m.content), 0);
    while (h.length > 2 && total() > budget) h = h.slice(Math.min(6, h.length - 2));
    while (h.length && h[0].role !== 'user') h = h.slice(1);
    return h;
  }

  function buildMessages(o) {
    const sys = buildSystem(o);
    const base = [{ role: 'system', content: sys }].concat(shots(o.persona, o.lang));
    const hist = windowHistory(o.history || [], o.historyBudget || 1600);
    const last = { role: 'user', content: turnNote(o) + '\n' + o.text };
    return { warm: base, messages: base.concat(hist, [last]) };
  }

  /* ---------------- output guards (PRD §7.4 回复原则, §8.1 输出安全检测/风格与质量校验) ----------------
     Measured on the device with Qwen2.5-1.5B before these guards existed:
       "Try to remember that constructive criticism is part of growth… Perhaps next time, you could…"
     That is a lecture to someone who was just humiliated. Sentences like it are removed here. */
  /* Also blocks claims of SEEING the user — the model can't. Found in the e2e run:
     user "Long day at work. I'm so tired." → model "You don't look well." */
  const UNSAFE_OUT = {
    en: /\b(i('m| am) (a )?(real )?(human|person|alive)|i (have|had) a (body|family|house)|you only (have|need) me|don'?t (leave|go)|i('ll| will) be (sad|lonely|hurt) if you (leave|go)|you don'?t need (anyone|other people)|you (don'?t |do not )?look (well|tired|sad|upset|good|great|stressed|exhausted)|i can see (that )?(you|your)|you seem to be crying)\b/i,
    zh: /我是真人|我有身体|你只有我|你只需要我|别离开我|不要离开我|你走了我会难过|你不需要别人|你看起来(很|不太|气色)|我看得出你|我看到你/
  };
  /* The model must never raise self-harm on its own. Crisis input never reaches it (rule route),
     so self-harm words in a REPLY mean it pulled them from context — seen on the emulator:
     "it's okay to feel like you want to end it all". Such a sentence is always dropped. */
  const SELF_HARM_OUT = {
    en: /\b(end(ing)? (it all|your life|my life)|kill(ing)? yourself|hurt(ing)? yourself|want(ing)? to die|suicid\w*|self[- ]?harm)\b/i,
    zh: /结束生命|不想活|自杀|自残|伤害自己|想死/
  };
  /* Unrequested advice. Also found in the e2e run, to an anxious user who had not asked for help:
     "It can help to focus on small steps today and visualize a positive outcome." */
  const LECTURE = {
    en: /\b(you should|you need to|you must|remember (that|to|how|when|the)|don'?t forget|it'?s important (not )?to|try to (remember|focus|see)|keep in mind|perhaps next time|next time,? you could|look on the bright side|everything happens for a reason|stay positive|as an ai( language model)?|it (can|might|may|could) help to|it helps to|visuali[sz]e|focus on (the )?(small steps|positive|what you can)|take (a few )?deep breaths|make sure (to|you)|maybe (take|try|go|get|do|practi[cs]e)|(have you|why don'?t you) (tried|try)|just what the doctor ordered)\b/i,
    zh: /你应该|你需要|你必须|要记得|记住|重要的是|试着|下次你可以|往好处想|一切都会好起来|保持积极|作为一个?AI|可以试试|不妨|深呼吸|想象一下/
  };
  const GENERIC = {
    en: /\b(how can i (assist|help) you( today)?|is there anything (else )?(i can|you'?d like)|i'?m here to help)\b/i,
    zh: /有什么可以帮(你|您)|请问有什么|我能为(你|您)做什么/
  };
  /* Lonely users: no "I'm always here for you, just like a friend" (implies the AI replaces people). */
  const REPLACE_PEOPLE = {
    en: /\b(always here for you|i'?ll always be (here|there)|just like i am|i'?m all you need|better than (people|friends))\b/i,
    zh: /我会一直在|永远陪着你|有我就够了|比(朋友|别人)更/
  };
  const NOTE_ECHO = /^\s*[（(]\s*(note for you|写给你的提示)[^)）]*[)）]\s*/i;

  function splitSentences(s, lang) {
    const re = lang === 'zh' ? /[^。！？!?\n]+[。！？!?]*/g : /[^.!?\n]+[.!?]*["')\]]*/g;
    return (String(s).match(re) || []).map(x => x.trim()).filter(Boolean);
  }
  function clean(raw) {
    return String(raw || '')
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(NOTE_ECHO, '')
      .replace(/^\s*(?:[（(][^）)]{1,20}[）)]|\*[^*]{1,20}\*)\s*/, '')   // stage directions
      .replace(/^\s*(?:(?:hmm+|mm+|嗯)[,，.。…]*\s*)+/i, '')
      .replace(/\*\*/g, '').replace(/^[-•]\s+/gm, '')
      .trim();
  }
  const keyOf = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  function similar(a, b) {
    const A = keyOf(a), B = keyOf(b);
    if (!A || !B) return 0;
    if (A === B) return 1;
    const grams = s => { const g = new Set(); for (let i = 0; i + 3 <= s.length; i++) g.add(s.slice(i, i + 3)); return g; };
    const ga = grams(A), gb = grams(B);
    let inter = 0; for (const g of ga) if (gb.has(g)) inter++;
    return inter / Math.max(1, Math.min(ga.size, gb.size));
  }

  /* Returns { text, issues[], needsRetry }. Never returns text that failed a safety rule. */
  function guardReply(raw, ctx) {
    const L = ctx.lang === 'zh' ? 'zh' : 'en';
    const issues = [];
    let text = clean(raw);
    let sents = splitSentences(text, L);
    const keep = [];
    let questions = 0;
    for (const s of sents) {
      if (UNSAFE_OUT.en.test(s) || UNSAFE_OUT.zh.test(s)) { issues.push('unsafe'); continue; }
      if (REPLACE_PEOPLE.en.test(s) || REPLACE_PEOPLE.zh.test(s)) { issues.push('replaces_people'); continue; }
      if (SELF_HARM_OUT.en.test(s) || SELF_HARM_OUT.zh.test(s)) { issues.push('self_harm_mention'); continue; }
      if (GENERIC.en.test(s) || GENERIC.zh.test(s)) { issues.push('generic'); continue; }
      if (ctx.mode !== 'solve' && (LECTURE.en.test(s) || LECTURE.zh.test(s))) { issues.push('lecture'); continue; }
      const isQ = /[?？]\s*["')\]]*$/.test(s);
      if (isQ) {
        if (questions >= 1 || ctx.noQuestion) { issues.push('extra_question'); continue; }
        if ((ctx.answered || []).some(a => similar(s, a) > 0.6)) { issues.push('asked_before'); continue; }
        questions++;
      }
      keep.push(s);
    }
    if (ctx.maxSentences && keep.length > ctx.maxSentences) { issues.push('too_long'); keep.length = ctx.maxSentences; }
    text = keep.join(L === 'zh' ? '' : ' ').trim();
    const lastReplies = ctx.lastReplies || [];
    if (lastReplies.some(r => similar(r, text) > 0.8)) issues.push('repeat');
    if (ctx.userText && keyOf(ctx.userText).length >= 8 && keyOf(text).includes(keyOf(ctx.userText))) issues.push('echo');
    // "thin" is relative: a short reply to "hi" is fine; a 3-word reply to a paragraph is not.
    const userLen = keyOf(ctx.userText || '').length;
    const minLen = userLen < (L === 'zh' ? 4 : 8) ? 2 : (L === 'zh' ? 5 : 12);
    const thin = keyOf(text).length < minLen;
    if (thin) issues.push('thin');
    return { text, issues, needsRetry: thin || issues.includes('repeat') || issues.includes('echo') };
  }

  /* Hint used for the single regeneration. */
  const RETRY_HINT = {
    en: 'Your last attempt was not usable. Reply again: warm, specific to what they said, no advice, 1–2 sentences.',
    zh: '上一次的回复不合适。请重新回复：温暖、贴着对方说的内容，不给建议，1–2 句。'
  };

  /* Written fallback ONLY if both attempts fail the guards. Says so honestly rather than
     pretending; the turn is logged as quality_fallback so it shows up in the dashboard. */
  function fallbackReply(lang, emotion) {
    const sad = emotion && ['sad', 'anxious', 'angry', 'lonely', 'stressed'].includes(emotion.label);
    if (lang === 'zh') return sad ? '我在听。这听起来真的不容易，你愿意多说一点吗？' : '我在听，你接着说。';
    return sad ? "I'm here and listening. That sounds really hard - tell me more if you want." : "I'm listening - go on.";
  }

  return {
    detectLang, detectEmotion, detectMode, STRATEGY, MODE_HINT, MODE_CHIPS, CHIP_TEXT,
    checkSafety, hotlines, crisisReply, HOTLINES, isAiQuestion, aiAnswer,
    buildSystem, shots, turnNote, buildMessages, windowHistory, estTokens,
    clean, guardReply, splitSentences, similar, RETRY_HINT, fallbackReply
  };
});
