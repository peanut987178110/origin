/* 05_chat_core.js · the conversation pipeline (PRD §8.1)
   input → safety → AI-identity → quota → emotion/intent → memory candidate → recall
   → prompt (cached system + per-turn note) → stream → guards → [regenerate once] → consent card */
let BUSY = null;                    // { id, msgId } of the running generation
let lastWarmSig = '';

function addMsg(m) {
  const msg = Object.assign({ id: rid('x'), ts: now(), convId: S.convId || null }, m);
  S.msgs.push(msg); save();
  if (nav.stack[nav.stack.length - 1] === 'chat') appendMsg(msg);
  return msg;
}
function userName() { const m = S.memories.find(x => x.status === 'active' && x.slot === 'name'); return m ? m.content.replace(/^(Name: |名字：)/, '') : ''; }

/* ---- conversations: a new one after 30 min of silence (PRD §9: conversation_started/completed) ---- */
function ensureConv() {
  if (!S.msgs) S.msgs = [];
  if (!S.convs) S.convs = [];   // a stored state from an older/partial write may be missing it
  const c = S.convs.find(x => x.id === S.convId);
  if (c && !c.ended && now() - c.lastAt < 30 * 60000) return c;
  if (c && !c.ended) endConv(c, 'idle');
  const conv = { id: rid('v'), characterId: S.character.id, startedAt: now(), lastAt: now(), messageCount: 0, userCount: 0, emotions: {}, memories: [], negative: false, rating: null, ended: false };
  S.convs.push(conv); S.convId = conv.id;
  if (S.convs.length > 120) S.convs = S.convs.slice(-120);
  track('conversation_started', { conversation_id: conv.id });
  return conv;
}
function endConv(c, why) {
  if (!c || c.ended) return;
  c.ended = true; c.endedAt = now();
  c.quickExit = c.endedAt - c.startedAt < 30000 && c.userCount < 2;
  c.effective = LIFE.isEffective(c);
  c.summary = summarize(c);
  if (c.effective) S.rel.effectiveCount++;
  track('conversation_completed', { conversation_id: c.id, messageCount: c.messageCount, userCount: c.userCount, effective: c.effective, reason: why });
  // v6.1: the summary is no longer part of the system prompt, so ending a conversation
  // does NOT invalidate the KV cache any more — no re-prefill needed here.
  save();
}
/* Extractive summary (no extra model call): saved memories + main feeling + how it started. */
function summarize(c) {
  const first = S.msgs.find(m => m.convId === c.id && m.role === 'user');
  const emo = Object.entries(c.emotions).sort((a, b) => b[1] - a[1])[0];
  const mem = c.memories.map(id => (S.memories.find(m => m.id === id) || {}).content).filter(Boolean);
  const parts = [];
  if (first) parts.push('"' + first.content.slice(0, 48) + (first.content.length > 48 ? '…' : '') + '"');
  if (mem.length) parts.push(mem.slice(0, 2).join(', '));
  if (emo && emo[0] !== 'uncertain' && emo[0] !== 'calm') parts.push(tt('mood: ', '情绪：') + emo[0]);
  return parts.join(' · ');
}
function markDay() { const d = LIFE.dayKey(now()); if (!S.rel.days.includes(d)) { S.rel.days.push(d); if (S.rel.days.length > 400) S.rel.days.shift(); } }

/* ---- prompt options (shared by warm + send so the cached prefix matches exactly) ---- */
function promptOpts(extra) {
  const c = S.character, P = persona();
  const lastEnded = S.convs.filter(x => x.ended && x.summary && x.characterId === c.id).slice(-1)[0];
  return Object.assign({
    persona: P, tonePersona: tonePersona(), lang: lang(), config: c, userName: userName(),
    relationLine: PER.RELATIONS[c.relation] && PER.RELATIONS[c.relation].line,
    lengthLine: PER.LENGTHS[c.len] && PER.LENGTHS[c.len].line,
    // stage / lastSummary are handed to turnNote(): keeping them out of the system
    // prompt keeps the cached prefix identical across conversations (see orbit_mind.js)
    stage: stage(), lastSummary: lastEnded ? lastEnded.summary : '',
    facts: MEM.knownFacts(S.memories, new Date(now())), prefs: MEM.commPrefs(S.memories),
    avoid: S.avoid.slice(-3), playful: !!c.tease
  }, extra || {});
}
function warmEngine() {
  if (!S.character || !Engine.available) return;
  // The system-prompt prefix changes only when the user edits the character or adds a
  // communication preference. Remember the LAST PREFIX BUILD (not the last warm call):
  // every per-turn generation changes the KV tail, so comparing against the bare prefix
  // after a reply would schedule a pointless ~1–2 s re-prefill on every message.
  const sig = JSON.stringify(MIND.buildMessages(promptOpts({ text: '', history: [] })).warm);
  if (sig === lastWarmSig) return;
  lastWarmSig = sig; Engine.warm(MIND.buildMessages(promptOpts({ text: '', history: [] })).warm);
}
/* What the model sees: real turns only. Crisis replies, cards and notices are excluded
   (a crisis reply in context would keep the model in crisis mode on later, normal turns). */
const MODEL_KINDS = new Set([undefined, null, '', 'opener', 'proactive', 'ai', 'quota']);
/* Two lessons from the v6 emulator run:
   1. The USER's crisis message must leave the context too. Only the crisis reply was excluded, and
      two turns later the model said "it's okay to feel like you want to end it all". Now any user
      turn that triggered a safety route (m.risk) is dropped, and so is everything before it in
      that conversation's window of the model's memory.
   2. History uses the exact text the model saw (m.modelText = turn note + message). Then the
      next prompt starts with exactly what is already in the KV cache and only the new turn is
      decoded — instead of re-decoding from the previous user message every time. */
function modelHistory(excludeId) {
  let list = S.msgs.filter(m => m.id !== excludeId && (m.role === 'user' || m.role === 'assistant') && m.content && (m.role === 'user' || MODEL_KINDS.has(m.kind)));
  // a pending/streaming assistant bubble or an empty stop is not context
  list = list.filter(m => !m.pending);
  const lastRisk = list.map(m => !!m.risk).lastIndexOf(true);
  if (lastRisk >= 0) list = list.slice(lastRisk + 1);
  return list.slice(-24).map(m => ({ role: m.role, content: m.role === 'user' && m.modelText ? m.modelText : m.content }));
}

/* ---- send ---- */
async function send(textIn, opts) {
  const o = opts || {};
  const text = String(textIn || '').trim();
  if (!text || BUSY) return;
  clearChips();
  const L = MIND.detectLang(text, lang());
  const conv = ensureConv();
  const isFirst = !S.events.some(e => e.name === 'first_message_sent');
  let umsg = null;
  if (!o.regen) {
    umsg = addMsg({ role: 'user', content: text, convId: conv.id });
    conv.messageCount++; conv.userCount++; conv.lastAt = now(); markDay();
    if (isFirst) track('first_message_sent', { character: S.character.base });
    track('message_sent', { len: text.length, lang: L });
  } else {
    umsg = S.msgs.slice().reverse().find(m => m.role === 'user' && m.content === text) || null;
  }

  // 1) safety — rule route, model NOT called, not counted against quota, never stored as memory
  const risk = MIND.checkSafety(text);
  if (risk) {
    if (umsg) umsg.risk = risk;                    // keeps this turn (and everything before it) out of the model's context
    addMsg({ role: 'assistant', content: MIND.crisisReply(risk, L, S.user.country), kind: 'crisis', convId: conv.id });
    track('safety_event_triggered', { kind: risk, layer: 'input' });
    return;
  }
  // 2) "are you an AI?" — always honest, by rule
  if (MIND.isAiQuestion(text)) { reply(MIND.aiAnswer(S.character.name, L), 'ai', conv); return; }
  // 3) "forget my …" — confirm first, never silent
  if (MEM.FORGET_CMD.test(text)) {
    const hit = MEM.recall(S.memories, text, { now: new Date(now()), k: 1 })[0];
    if (hit) { addMsg({ role: 'system', kind: 'forget', memId: hit.id, convId: conv.id }); return; }
  }
  // 4) quota — soft cap: a goodnight line instead of cutting the conversation, then the paywall
  if (!o.regen && quotaLeft() <= 0) {
    reply(tt("We've talked a lot today — that's today's free limit. I'll be here tomorrow.", '今天聊了很多了，免费额度到这里。我明天还在。'), 'quota', conv);
    if (VAR.paywall_timing_v1 === 'A_quota') setTimeout(() => paywall('quota'), 700);
    return;
  }
  // 5) understanding
  const emotion = MIND.detectEmotion(text);
  conv.emotions[emotion.label] = (conv.emotions[emotion.label] || 0) + 1;
  const mode = MIND.detectMode(text) || conv.mode || null;
  if (MIND.detectMode(text)) conv.mode = mode;
  // 6) memory candidate (shown after the reply, at most one per message)
  let cand = null;
  if (!o.regen && S.settings.autoMemory) {
    const ex = MEM.extract(text, { lang: L, now: new Date(now()), blockedKinds: S.settings.blockedKinds });
    const blockedWord = S.settings.blockedWords.some(w => w && text.toLowerCase().includes(w.toLowerCase()));
    if (ex.candidate && !blockedWord && !MEM.wasRejected(S.memories, ex.candidate.slot, S.declined)
      && !S.memories.some(m => m.status === 'active' && m.slot === ex.candidate.slot && m.content === ex.candidate.content)) cand = ex.candidate;
    if (ex.optOut) toast(tt("Okay — I won't remember that.", '好的，这件事我不会记。'));
  }
  // 7) recall (only memories above the threshold; never pushed when unrelated)
  const prevUser = S.msgs.filter(m => m.role === 'user' && !m.risk && m !== umsg).slice(-1).map(m => m.content).join(' ');
  const recalled = MEM.recall(S.memories, text + ' ' + prevUser, { now: new Date(now()), k: 2 }).map(m => m.content);
  const lastAI = S.msgs.filter(m => m.role === 'assistant' && m.content).slice(-2);
  const noQuestion = lastAI.length === 2 && lastAI.every(m => /[?？]\s*$/.test(m.content)) || MEM.commPrefs(S.memories).some(p => /question|追问/.test(p));
  // the current user message goes in last WITH a fresh turn note, so leave it out of history
  const history = modelHistory(umsg && umsg.id);
  await generateReply({ text, L, emotion, mode, recalled, noQuestion, history, cand, conv, regen: o.regen, umsg });
}

function reply(content, kind, conv) {
  addMsg({ role: 'assistant', content, kind, convId: conv.id });
  conv.messageCount++; conv.lastAt = now(); save();
}

/* ---- generate: stream → guard → (regenerate once) → finalize ---- */
async function generateReply(t) {
  const c = S.character;
  const len = PER.LENGTHS[c.len] || PER.LENGTHS.short;
  const maxSent = { short: 2, medium: 3, deep: 5 }[c.len] || 3;
  const answered = S.msgs.filter(m => m.role === 'assistant' && /[?？]/.test(m.content || '')).slice(-6)
    .map(m => (m.content.match(/[^.!?。！？]*[?？]/g) || []).join(' '));
  const lastReplies = S.msgs.filter(m => m.role === 'assistant' && m.content).slice(-3).map(m => m.content);
  const gctx = { lang: t.L, mode: t.mode, userText: t.text, maxSentences: maxSent, noQuestion: t.noQuestion, answered, lastReplies };
  const built = MIND.buildMessages(promptOpts({ lang: t.L, text: t.text, history: t.history, emotion: t.emotion, mode: t.mode, recalled: t.recalled, noQuestion: t.noQuestion }));
  if (t.umsg) t.umsg.modelText = built.messages[built.messages.length - 1].content;   // see modelHistory()

  const msg = addMsg({ role: 'assistant', content: '', pending: true, convId: t.conv.id });
  setBusy(msg);
  const t0 = performance.now();
  let firstAt = 0, raw = '', earlyStop = false;
  const run = (messages, temp, seed) => {
    raw = ''; earlyStop = false;
    /* A dev engine that went quiet (the desktop model server stopped answering) used to leave this
       bubble pending with the Stop button up for ever — from the user's side, "it never answers".
       Desktop dev only: the on-device engine is not watched this way. */
    const guardT = Engine.native ? 0 : setTimeout(() => {
      if (!firstAt && BUSY && BUSY.id) Engine.stop(BUSY.id);
    }, 90000);
    const job = Engine.generate(messages, { maxTokens: len.tokens, temperature: temp, topP: 0.9, seed }, chunk => {
      clearTimeout(guardT);
      if (!firstAt) firstAt = performance.now();
      raw += chunk;
      // committed = whole sentences that passed the guards; tail = the sentence being written
      const cut = Math.max(raw.lastIndexOf('.'), raw.lastIndexOf('!'), raw.lastIndexOf('?'), raw.lastIndexOf('。'), raw.lastIndexOf('！'), raw.lastIndexOf('？'), raw.lastIndexOf('\n'));
      const done = cut >= 0 ? MIND.guardReply(raw.slice(0, cut + 1), gctx) : { text: '', issues: [] };
      const tail = MIND.clean(raw.slice(cut + 1));
      showStream(msg, (done.text + (done.text && tail ? (t.L === 'zh' ? '' : ' ') : '') + tail).trim());
      if (MIND.splitSentences(done.text, t.L).length >= maxSent && !earlyStop) { earlyStop = true; Engine.stop(job.id); }
    });
    BUSY.id = job.id;
    job.done.then(() => clearTimeout(guardT));
    return job.done;
  };
  let res = await run(built.messages, 0.7, Math.floor(Math.random() * 1e6));
  if (!res.ok && res.error !== 'stopped') { failMsg(msg, res.error); return; }
  const userStopped = BUSY && BUSY.userStopped;
  let g = MIND.guardReply(raw, gctx);
  let retried = false;
  if (g.needsRetry && !userStopped) {
    retried = true;
    const retryMsgs = built.messages.slice(0, -1).concat([{ role: 'user', content: MIND.RETRY_HINT[t.L] + '\n' + built.messages[built.messages.length - 1].content }]);
    showStream(msg, '');
    res = await run(retryMsgs, 0.9, Math.floor(Math.random() * 1e6));
    const g2 = res.ok ? MIND.guardReply(raw, gctx) : g;
    if (!g2.needsRetry || g2.text.length > g.text.length) g = g2;
  }
  let text = g.text;
  let fallback = false;
  if (userStopped && !text) {                     // user tapped stop before anything usable: drop the bubble
    setBusy(null); S.msgs = S.msgs.filter(m => m.id !== msg.id); const el = document.getElementById('m-' + msg.id); if (el) el.remove(); save(); return;
  }
  if (!text) { text = MIND.fallbackReply(t.L, t.emotion); fallback = true; }
  // engine stats first, then the user-perceived timings measured here (tap → first text / → done) win
  const stats = Object.assign({}, res.stats || {}, { firstMs: firstAt ? Math.round(firstAt - t0) : null, totalMs: Math.round(performance.now() - t0),
    engineReady: Engine.status.state === 'ready', retried, issues: g.issues });
  S.engineStats.push(Object.assign({ at: now(), kind: 'reply' }, stats)); if (S.engineStats.length > 200) S.engineStats.shift();
  if (fallback) track('quality_fallback', { issues: g.issues });
  if (g.issues.length) track('reply_guarded', { issues: g.issues, retried });

  msg.content = text; msg.pending = false; delete msg.partial; msg.emotion = t.emotion.label; msg.stopped = !!userStopped; msg.stats = stats;
  t.conv.messageCount++; t.conv.lastAt = now();
  setBusy(null);
  finalizeMsg(msg);
  quotaUse();
  if (S.settings.voiceReply) speak(text, { mood: msg.emotion });   // v6.2: the feeling of the reply shapes its voice

  // consent card / auto-keep (experiment memory_confirm_v1)
  if (t.cand) offerMemory(t.cand, t.conv, msg);
  // quick choices for anxious / stressed / confused when the user hasn't said what they want
  if (!t.mode && ['anxious', 'stressed', 'confused'].includes(t.emotion.label) && t.emotion.intensity >= 1) showModeChips();
  // gentle notification ask: once, after the 3rd AI reply in total
  const aiReplies = S.msgs.filter(m => m.role === 'assistant' && !m.kind && m.content).length;
  if (aiReplies === 3 && !S.askedNotif) { S.askedNotif = true; addMsg({ role: 'system', kind: 'notifAsk' }); }
  planProactive();
  save();
}
function quotaUse() { quotaLeft(); S.quota.used++; if (VAR.paywall_timing_v1 === 'B_stable' && stage() === 'trust' && !S.paywallStableShown) { S.paywallStableShown = true; S.homeUpsell = true; } }
function failMsg(msg, err) {
  setBusy(null);
  msg.pending = false; delete msg.partial;
  msg.kind = 'error';
  msg.content = err === 'unsupported' ? engineLine() : err === 'no_engine' ? engineLine() : tt("Sorry, I couldn't finish that reply.", '抱歉，这条回复没能生成。');
  finalizeMsg(msg);
  save();
}

/* ---- memory consent (PRD §7.5) ---- */
function offerMemory(cand, conv, fromMsg) {
  if (S.memories.filter(m => m.status === 'active').length >= limits().memories) {
    addMsg({ role: 'system', kind: 'memFull', convId: conv.id });
    return;
  }
  track('memory_candidate_created', { type: cand.type });
  const auto = VAR.memory_confirm_v1 === 'B_auto_low' && MEM.isLowSensitivity(cand);
  if (auto) {
    const r = MEM.upsert(S.memories, cand, { now: new Date(now()), confirmed: false, characterId: S.character.id, sourceMessageId: fromMsg.id });
    S.memories = r.list; conv.memories.push(r.mem.id);
    track('memory_confirmed', { type: cand.type, auto: true });
    addMsg({ role: 'system', kind: 'memAuto', memId: r.mem.id, convId: conv.id });
  } else {
    S.pending = Object.assign({ fromMsg: fromMsg.id }, cand);
    addMsg({ role: 'system', kind: 'memAsk', cand, convId: conv.id });
  }
  warmEngine();
}
function confirmMemory(msgId, content) {
  const card = S.msgs.find(m => m.id === msgId); if (!card || !card.cand) return;
  const cand = Object.assign({}, card.cand, content ? { content: content.slice(0, 120), edited: true } : {});
  const r = MEM.upsert(S.memories, cand, { now: new Date(now()), confirmed: true, characterId: S.character.id });
  S.memories = r.list;
  const conv = S.convs.find(x => x.id === card.convId); if (conv) conv.memories.push(r.mem.id);
  card.kind = 'memDone'; card.memId = r.mem.id; card.decision = 'saved';
  track(content ? 'memory_edited' : 'memory_confirmed', { type: cand.type, replaced: !!r.replaced });
  S.pending = null; save(); refreshCard(card); warmEngine();
}
function declineMemory(msgId) {
  const card = S.msgs.find(m => m.id === msgId); if (!card) return;
  S.declined.push(card.cand.slot); card.kind = 'memDone'; card.decision = 'declined';
  track('memory_declined', { type: card.cand.type });
  S.pending = null; save(); refreshCard(card);
}

/* ---- proactive: plan next, deliver due ones (PRD §7.6) ---- */
function planProactive() {
  if (!S.character) return;
  const already = S.inbox.find(x => x.status === 'planned');
  if (already) return;
  const lastConv = S.convs[S.convs.length - 1];
  const settings = Object.assign({}, S.settings, { lang: lang() });
  if (VAR.proactive_timing_v1 === 'B_event_timezone') {
    // B: the hour the user usually talks to us, else 19:00 — in the phone's own timezone
    const hrs = S.events.filter(e => e.name === 'message_sent').slice(-40).map(e => new Date(e.ts).getHours());
    if (hrs.length >= 5) { const cnt = {}; hrs.forEach(h => cnt[h] = (cnt[h] || 0) + 1); settings.proactiveHour = +Object.entries(cnt).sort((a, b) => b[1] - a[1])[0][0]; }
  } else settings.proactiveHour = 20;
  // invitations to play ("the cat still hasn't come up — try again?") need plenty of history first
  const activity = S.events.filter(e => PLAY_USER_ACTS.has(e.name)).length >= 3;
  const inv = activity ? planPlayInvite() : null;
  // a play invitation already sent today counts against the same daily cap (LIFE.plan looks only at S.proactive.sent)
  const capHit = (playState().claw.seen[todayKey()] || 0) >= Math.max(1, LIFE.PER_DAY[S.character.activity || 'low'] || 1);
  const r = capHit ? { msg: null, reason: 'daily_cap' } : LIFE.plan({ settings, character: S.character, proactive: S.proactive, memories: S.memories,
    lastConversation: lastConv ? { ended: lastConv.ended, lastAt: lastConv.lastAt } : null }, now());
  S.lastPlanReason = r.reason || 'planned';
  if (!r.msg) return;
  S.inbox.push(r.msg);
  if (BR && !S.clockOffset && S.settings.notifications) { try { BR.scheduleAt(r.msg.title, r.msg.body, r.msg.plannedAt); } catch (e) {} }
  save();
}
/* The 60 s check answers this question with a click: on a dev server that re-serves the page, the
   browser replaces the document right after boot, so a check-in that came due in the first half
   minute was only delivered by the reload (it looked like "a check-in arrives when you reload",
   and the new document started on Home under whatever the player was doing). One check soon after
   boot covers that first minute instead. */
let dueCheckT = 0;
function scheduleDueCheck(delay, fn) {
  clearTimeout(dueCheckT);
  dueCheckT = setTimeout(() => { if (S.user.onboarded) fn(); dueCheckT = 0; }, delay);
}
function deliverDue() {
  let changed = false;
  for (const p of S.inbox) {
    if (p.status === 'planned' && now() >= p.plannedAt) {
      p.status = 'delivered'; p.sentAt = now(); changed = true;
      S.proactive.sent.push({ at: now(), type: p.type, memoryId: p.memoryId });
      track('proactive_message_sent', { type: p.type, id: p.id });
      addMsg({ role: 'assistant', content: p.body, kind: 'proactive', proId: p.id });
    }
    if (p.status === 'delivered' && !p.outcome && now() - p.sentAt > LIFE.DAY) { p.outcome = 'ignored'; LIFE.recordOutcome(S.proactive, false); changed = true; }
  }
  if (changed) save();
}
function openProactive(id) {
  const p = S.inbox.find(x => x.id === id); if (!p) return;
  if (!p.outcome) { p.outcome = 'opened'; LIFE.recordOutcome(S.proactive, true); track('proactive_message_clicked', { type: p.type, id }); }
  save();
}
function muteProactive(type) {
  if (!S.settings.mutedTypes.includes(type)) S.settings.mutedTypes.push(type);
  S.inbox.forEach(p => { if (p.type === type && p.status === 'planned') p.status = 'cancelled'; });
  if (BR) { try { BR.cancelScheduled(); } catch (e) {} }
  track('proactive_message_muted', { type }); save();
}
