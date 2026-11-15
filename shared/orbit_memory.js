/* =========================================================================
   orbit_memory.js · controlled long-term memory (PRD §7.5)
   -------------------------------------------------------------------------
   Write rule: only "clearly stated + useful later + fairly stable" → CANDIDATE.
   A candidate becomes memory only after the user taps [Remember] (experiment
   memory_confirm_v1 / variant B auto-keeps LOW-sensitivity preferences, but still
   shows them and still lets the user undo).
   Extraction is rule-based on purpose: a 1.5B model asked for JSON on-device is slow
   and unreliable, and the user confirms every candidate anyway.
   Never written: passwords / payment / ID numbers, health, money details, guesses,
   one-off emotions, anything after "don't remember this".
   ========================================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.OrbitCore = root.OrbitCore || {}).memory = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SENSITIVE = {
    health: /\b(diagnos\w*|medication|meds|therapy|therapist|depression|bipolar|adhd|cancer|hiv|pregnan\w*|disease|illness|surgery|hospital)\b|诊断|吃药|药物|抑郁症|双相|怀孕|癌|医院|手术|病/i,
    finance: /\b(salary|debt|loan|credit card|bank account|mortgage|income|\$\d|\d+k a year)\b|工资|欠款|贷款|信用卡|银行卡|房贷|收入|存款/i,
    identity: /\b(password|passcode|pin|ssn|social security|passport|id number|card number|cvv)\b|密码|身份证|护照|卡号|验证码/i,
    intimate: /\b(sex|sexual|gay|lesbian|bisexual|religion|church|mosque|vote|democrat|republican)\b|性取向|宗教|信仰|政治/i
  };
  function sensitiveKind(text, blockedKinds) {
    for (const k of Object.keys(SENSITIVE)) if (SENSITIVE[k].test(text)) return k;
    for (const k of (blockedKinds || [])) if (SENSITIVE[k] && SENSITIVE[k].test(text)) return k;
    return null;
  }

  const DONT_REMEMBER = /\b(don'?t remember (this|that)|please forget (this|that)|forget (i said|what i said)|don'?t save (this|that)|keep this between)\b|别记(住)?(这个|这件事)?|不要记(住)?|忘掉(这个|这件事)|不用记/i;
  const FORGET_CMD = /\b(forget (about )?(my|that|the) (\w+)|delete (the )?memory)\b|忘掉我的|删掉关于/i;

  const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().replace(/[.!?。！？,，]+$/, '').slice(0, n || 60);
  const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

  /* "I like quiet beaches and long walks because…" → "quiet beaches and long walks".
     Rejects pronoun objects ("I like you / it / that") and "I'd like to know". */
  const STOP_OBJ = /^(it|that|this|you|him|her|them|when|how|what|the way|to know|to think|it when|being|a lot|so much|very much)\b/i;
  function phrase(raw) {
    let x = String(raw || '').toLowerCase().split(/\b(?:because|but|since|so that|when|if|though|although|which|cause)\b|[,.;!?]/)[0];
    x = x.replace(/^to /, '').replace(/\s+(a lot|so much|very much|too)$/, '').trim();
    const words = x.split(/\s+/).filter(Boolean);
    if (!words.length || words.length > 6 || STOP_OBJ.test(x)) return '';
    return words.join(' ');
  }
  const NOT_NAMES = /^(Is|Was|And|But|The|Who|That|Just|Keeps|Kept|Has|Had|Knocked|Ran|Got|Gets|Likes|Loves|Died|Passed|Ate|Sleeps|Sleeping|Named|Called)$/;
  function petName(w) { return w && /^[A-Z][a-z]{1,14}$/.test(w) && !NOT_NAMES.test(w) ? w : ''; }
  function zhPhrase(raw) {
    const x = String(raw || '').split(/[，。！？,.!?因为但是所以]/)[0];
    if (/^(你|他|她|它|这|那|和你|跟你)/.test(x) || x.length < 2) return '';
    return x.slice(0, 12);
  }

  /* ---------------- dates for short-term events ---------------- */
  const WD_EN = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const WD_ZH = ['日', '一', '二', '三', '四', '五', '六'];
  function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function resolveDate(text, now) {
    const t = String(text).toLowerCase();
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const add = n => { const d = new Date(base); d.setDate(d.getDate() + n); return d; };
    if (/\btonight\b|今晚|今天晚上/.test(t)) return add(0);
    if (/\btoday\b|今天/.test(t)) return add(0);
    if (/\bday after tomorrow\b|后天/.test(t)) return add(2);
    if (/\btomorrow\b|明天|明早|明晚/.test(t)) return add(1);
    const wdEn = WD_EN.findIndex(w => new RegExp('\\b(this |next |on )?' + w + '\\b').test(t));
    let wd = wdEn;
    let next = /\bnext (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(t);
    const zh = t.match(/(下)?(周|星期|礼拜)([一二三四五六日天])/);
    if (zh) { wd = WD_ZH.indexOf(zh[3] === '天' ? '日' : zh[3]); next = !!zh[1]; }
    if (wd >= 0) {
      let diff = (wd - base.getDay() + 7) % 7;
      if (diff === 0) diff = 7;
      if (next && diff < 7) diff += 7;
      return add(diff);
    }
    if (/\bnext week\b|下周|下个星期/.test(t)) return add(7);
    return null;
  }

  /* ---------------- extraction rules ---------------- */
  const EVENT_WORDS = 'interview|exam|test|presentation|appointment|date|meeting|flight|trip|move|moving|deadline|surgery|recital|game|match|concert|birthday|wedding|first day';
  const EVENT_ZH = '面试|考试|答辩|汇报|约会|会议|航班|出差|搬家|截止|演出|比赛|音乐会|生日|婚礼|入职|体检|复试|笔试';
  const RULES = [
    // pets (long-term fact) — name optional
    // "my cat Mochi…", "I have a dog named Biscuit". The name must be Capitalized in the ORIGINAL
    // text (checked in petName) — otherwise "my cat knocked…" would save "Knocked" as a name.
    { type: 'fact', slot: m => 'pet:' + m[1].toLowerCase(), imp: 4,
      re: /\b(?:i have|i've got|i got|my) (?:a |an )?(?:little |old |new )?(cat|dog|kitten|puppy|rabbit|bunny|hamster|parrot|bird|fish)\b(?:,? (?:named|called|is called) | )?([A-Za-z]+)?/i,
      out: (m, L) => { const n = petName(m[2]); return 'Has a ' + m[1].toLowerCase() + (n ? ' named ' + n : ''); } },
    { type: 'fact', slot: () => 'pet', imp: 4,
      re: /我(?:家)?(?:有|养了)?(?:一只|只)?(猫|狗|兔子|仓鼠|鹦鹉|小猫|小狗)(?:，|,)?(?:它|他|她)?(?:叫|名字是)\s*([一-龥A-Za-z]{1,6})/,
      out: m => '有一只' + m[1] + '，叫' + m[2] },
    // job / study (long-term fact)
    { type: 'fact', slot: () => 'work', imp: 3,
      re: /\bi (?:work as|am working as|work in|work at|'m an?|am an?) ((?:[a-z]+ ){0,3}(?:designer|engineer|developer|teacher|nurse|student|manager|writer|artist|accountant|marketer|chef|barista|lawyer|analyst|researcher|consultant))\b/i,
      out: m => 'Works as ' + m[1].replace(/^(a|an) /i, '') },
    { type: 'fact', slot: () => 'work', imp: 3,
      re: /我(?:是|在)(?:一名|一个)?([一-龥]{2,8}(?:设计师|工程师|程序员|老师|护士|学生|经理|产品经理|运营|会计|厨师|研究生|博士))/,
      out: m => '是' + m[1] },
    // likes / dislikes (stable preference)
    { type: 'preference', slot: m => 'like:' + phrase(m[2]).toLowerCase(), imp: 3,
      re: /\bi (really |totally )?(?:love|like|enjoy|adore)\s+([a-z][a-z' -]{2,60})/i,
      out: m => phrase(m[2]) ? 'Likes ' + phrase(m[2]) : '' },
    { type: 'preference', slot: m => 'dislike:' + phrase(m[1]).toLowerCase(), imp: 3,
      re: /\bi (?:hate|can'?t stand|don'?t like|dislike)\s+([a-z][a-z' -]{2,60})/i,
      out: m => phrase(m[1]) ? 'Dislikes ' + phrase(m[1]) : '' },
    { type: 'preference', slot: m => 'like:' + zhPhrase(m[1]), imp: 3,
      re: /我(?:很|特别|超|挺|最)?(?:喜欢|爱|热爱)([一-龥A-Za-z]{2,14})/,
      out: m => zhPhrase(m[1]) ? '喜欢' + zhPhrase(m[1]) : '' },
    { type: 'preference', slot: m => 'dislike:' + zhPhrase(m[1]), imp: 3,
      re: /我(?:很|特别|最)?(?:讨厌|不喜欢|受不了)([一-龥A-Za-z]{2,14})/,
      out: m => zhPhrase(m[1]) ? '不喜欢' + zhPhrase(m[1]) : '' },
    // communication preferences
    { type: 'commpref', slot: () => 'comm:questions', imp: 5,
      re: /\b(stop asking (me )?so many questions|too many questions|don'?t (keep )?ask(ing)? me questions)\b|别(老)?问(我)?(那么多|这么多)?问题|问题太多/i,
      out: (m, L) => L === 'zh' ? '不喜欢被连续追问' : 'Prefers not to be asked many questions' },
    { type: 'commpref', slot: () => 'comm:advice', imp: 5,
      re: /\b(i (don'?t|do not) (want|need|like) advice|stop giving (me )?advice)\b|我不需要建议|别给我建议|不要建议/i,
      out: (m, L) => L === 'zh' ? '倾诉时不想要建议' : "Doesn't want advice when venting" },
    { type: 'commpref', slot: () => 'comm:short', imp: 4,
      re: /\b(keep it short|shorter (replies|answers)|too long)\b|说短点|太长了|简短一点/i,
      out: (m, L) => L === 'zh' ? '喜欢简短的回复' : 'Prefers short replies' },
    // name
    { type: 'fact', slot: () => 'name', imp: 5,
      re: /\b(?:my name is|call me|i'?m called)\s+([A-Z][a-z]{1,15})\b/,
      out: m => 'Name: ' + m[1] },
    { type: 'fact', slot: () => 'name', imp: 5,
      re: /(?:我叫|叫我)([一-龥A-Za-z]{1,6})(?:就好|吧|。|$)/,
      out: m => '名字：' + m[1] }
  ];

  function extractEvent(text, now, L) {
    const en = text.match(new RegExp('\\b(?:i have|i\'ve got|i got|got|have|there\'s|my)\\s+(?:a |an |my |the )?((?:[a-z]+ ){0,3}?(?:' + EVENT_WORDS + '))\\b', 'i'));
    const zh = text.match(new RegExp('([\\u4e00-\\u9fa5]{0,6}(?:' + EVENT_ZH + '))'));
    const m = en || zh;
    if (!m) return null;
    const when = resolveDate(text, now);
    if (!when) return null;                       // no clear time → not a short-term event
    // "我明天有个面试" → "面试"; "下周三有个答辩" → "答辩"
    const what = clip(String(m[1]).replace(/^(我|今天|今晚|明天|明早|明晚|后天|下周.|周.|星期.|下个?星期.?|这周.?)*(要|有个|有一个|有场|有一场|去|参加)?/, ''), 40) || clip(m[1], 40);
    const due = ymd(when);
    const label = L === 'zh' ? what + '（' + (when.getMonth() + 1) + '月' + when.getDate() + '日）'
      : cap(what) + ' on ' + when.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const exp = new Date(when); exp.setDate(exp.getDate() + 3);
    return { type: 'event', slot: 'event:' + what.toLowerCase() + ':' + due, content: label, due, expiresAt: exp.getTime(), importance: 4, confidence: 0.8, raw: what };
  }

  /* Returns at most ONE candidate per message (PRD: one choice per moment, no questionnaire feel). */
  function extract(text, opts) {
    const o = opts || {};
    const now = o.now || new Date();
    const L = o.lang === 'zh' ? 'zh' : 'en';
    const t = String(text || '').trim();
    if (!t || t.length > 600) return { candidate: null };
    if (DONT_REMEMBER.test(t)) return { candidate: null, optOut: true };
    const sens = sensitiveKind(t, o.blockedKinds);
    const cands = [];
    const ev = extractEvent(t, now, L);
    if (ev) cands.push(ev);
    for (const r of RULES) {
      const m = t.match(r.re);
      if (!m) continue;
      const content = r.out(m, L);
      if (!content || content.length < 3) continue;
      cands.push({ type: r.type, slot: r.slot(m), content, importance: r.imp, confidence: r.type === 'commpref' ? 0.9 : 0.75 });
    }
    if (!cands.length) return { candidate: null };
    // sensitive: never auto, never suggested by default (PRD: 敏感信息 默认不保存)
    if (sens) return { candidate: null, sensitive: sens };
    cands.sort((a, b) => b.importance - a.importance || b.confidence - a.confidence);
    const c = cands[0];
    c.source = clip(t, 120);
    return { candidate: c };
  }

  /* Consent wording (PRD §7.5 记忆确认交互). */
  function consentText(c, lang, name) {
    if (lang === 'zh') {
      if (c.type === 'event') return '你提到「' + c.content + '」。要我记下来，到时候问问你怎么样吗？';
      if (c.type === 'commpref') return '我注意到：' + c.content + '。以后我可以按这个方式和你聊吗？';
      return '我注意到「' + c.content + '」。以后聊天时，我可以记住这一点吗？';
    }
    if (c.type === 'event') return 'You mentioned: ' + c.content + '. Want me to remember it and check in afterwards?';
    if (c.type === 'commpref') return 'Noted: ' + c.content.toLowerCase() + '. Can I remember that for how we talk?';
    return 'I noticed: ' + c.content.charAt(0).toLowerCase() + c.content.slice(1) + '. Can I remember this for later chats?';
  }
  /* Low-sensitivity = may be auto-kept in experiment variant B. Events and comm prefs always ask. */
  const isLowSensitivity = c => c.type === 'preference';

  /* ---------------- recall (PRD §7.5 记忆调用规则) ----------------
     score = relevance × importance × freshness × trust
     · relevance  word / character-bigram overlap + alias groups (docs/26: held-out 6/12 with aliases)
     · importance 1–5 → 0.2–1.0
     · freshness  events: highest around the due date, 0 after expiry; others decay slowly over 90 days
     · trust      confirmed or edited by the user 1.0, auto-kept 0.7
     Below THRESHOLD → not used, even if loosely related. Deleted / expired → never used. */
  const ALIASES = [
    ['boss', 'manager', 'supervisor', 'lead', '领导', '老板', '上司', '主管', '经理'],
    ['sleep', 'insomnia', 'sleepless', 'awake', '失眠', '睡不着', '睡觉'],
    ['mom', 'mum', 'mother', '妈妈', '我妈', '母亲', '老妈'],
    ['dad', 'father', '爸爸', '我爸', '父亲'],
    ['sister', 'sis', '妹妹', '姐姐'], ['brother', 'bro', '哥哥', '弟弟'],
    ['cat', 'kitten', 'kitty', '猫', '小猫', '猫咪'], ['dog', 'puppy', '狗', '小狗'],
    ['interview', '面试'], ['exam', 'test', 'finals', '考试', '期末'],
    ['work', 'job', 'office', 'overtime', '工作', '上班', '加班', '公司'],
    ['beach', 'beaches', 'sea', 'ocean', '海边', '海', '大海'], ['quiet', 'calm', 'peaceful', '安静', '清静'],
    ['music', 'song', 'songs', 'playlist', '音乐', '歌']
  ];
  const STOP = new Set('a an the and or but i you he she it we they me my your our is are was were be been am to of in on at for with about from that this these those do did does have has had not no so just really very what when where who how why can could would should will im its dont today tonight likes dislikes works named'.split(' '));
  const hasCJK = w => /[一-龥]/.test(w);
  function tokens(text) {
    const s = String(text || '').toLowerCase();
    const out = new Set();
    for (const w of s.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)) {
      if (!w) continue;
      if (hasCJK(w)) { for (let i = 0; i + 1 < w.length; i++) out.add(w.slice(i, i + 2)); }
      else if (w.length > 2 && !STOP.has(w)) out.add(w.replace(/(ing|ed|es|s)$/, ''));
    }
    ALIASES.forEach((g, i) => {
      if (g.some(a => (hasCJK(a) ? s.includes(a) : new RegExp('(^|[^a-z])' + a + '([^a-z]|$)').test(s)))) out.add('#' + i);
    });
    return out;
  }
  const THRESHOLD = 0.12;
  function score(m, qTokens, nowMs) {
    if (m.status !== 'active') return 0;
    if (m.expiresAt && nowMs > m.expiresAt) return 0;
    const mt = tokens(m.content + ' ' + (m.raw || ''));
    let inter = 0; for (const w of mt) if (qTokens.has(w)) inter++;
    const relevance = inter ? Math.min(1, 0.45 + 0.25 * inter) : 0;
    const importance = Math.max(1, Math.min(5, m.importance || 3)) / 5;
    let freshness;
    if (m.type === 'event' && m.due) {
      const dueMs = new Date(m.due + 'T12:00:00').getTime();
      const days = Math.abs(nowMs - dueMs) / 86400000;
      freshness = days <= 1.5 ? 1 : Math.max(0.3, 1 - days / 10);
    } else {
      const age = Math.max(0, (nowMs - (m.updatedAt || m.createdAt || nowMs)) / 86400000);
      freshness = Math.max(0.5, 1 - age / 90);
    }
    const trust = m.confirmed ? 1 : 0.7;
    return relevance * importance * freshness * trust;
  }
  function recall(memories, query, opts) {
    const o = opts || {};
    const nowMs = (o.now || new Date()).getTime();
    const q = tokens(query);
    return (memories || [])
      .map(m => ({ m, s: score(m, q, nowMs) }))
      .filter(x => x.s >= THRESHOLD)
      .sort((a, b) => b.s - a.s)
      .slice(0, o.k || 2)
      .map(x => Object.assign({}, x.m, { score: Math.round(x.s * 100) / 100 }));
  }
  /* Stable "what you know" list for the system prompt: top facts & preferences, never events/sensitive. */
  function knownFacts(memories, now) {
    const t = (now || new Date()).getTime();
    return (memories || []).filter(m => m.status === 'active' && (m.type === 'fact' || m.type === 'preference') && (!m.expiresAt || t <= m.expiresAt))
      .sort((a, b) => (b.importance || 3) - (a.importance || 3) || (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 6).map(m => m.content);
  }
  function commPrefs(memories) {
    return (memories || []).filter(m => m.status === 'active' && m.type === 'commpref').map(m => m.content);
  }

  /* Write with conflict handling (PRD §7.5 记忆一致性): same slot → newest wins, old one is "superseded". */
  function upsert(memories, cand, opts) {
    const o = opts || {};
    const now = o.now ? o.now.getTime() : Date.now();
    const list = (memories || []).slice();
    let replaced = null;
    for (const m of list) {
      if (m.status === 'active' && m.slot && m.slot === cand.slot) { m.status = 'superseded'; m.updatedAt = now; replaced = m; }
    }
    const mem = Object.assign({
      id: 'm' + now.toString(36) + Math.random().toString(36).slice(2, 6),
      status: 'active', createdAt: now, updatedAt: now, confirmed: !!o.confirmed, characterId: o.characterId || null,
      sourceMessageId: o.sourceMessageId || null
    }, cand);
    list.unshift(mem);
    return { list, mem, replaced };
  }
  function edit(memories, id, content, now) {
    const m = (memories || []).find(x => x.id === id);
    if (!m) return false;
    m.content = String(content || '').slice(0, 120); m.raw = ''; m.confirmed = true; m.edited = true; m.updatedAt = (now || new Date()).getTime();
    return true;
  }
  /* Deleted memories are never used again; a content-free tombstone stays so that a later
     re-extraction of the same slot asks again instead of silently re-saving. */
  function remove(memories, id) {
    const m = (memories || []).find(x => x.id === id);
    if (!m) return false;
    m.status = 'deleted'; m.content = ''; m.source = ''; m.raw = '';
    return true;
  }
  /* Was this slot deleted or declined by the user? Then don't propose it again. */
  function wasRejected(memories, slot, declined) {
    return (memories || []).some(m => m.slot === slot && m.status === 'deleted') || (declined || []).includes(slot);
  }

  return { extract, consentText, isLowSensitivity, sensitiveKind, resolveDate, ymd, SENSITIVE, DONT_REMEMBER, FORGET_CMD,
    tokens, score, recall, knownFacts, commPrefs, upsert, edit, remove, wasRejected, THRESHOLD, phrase };
});
