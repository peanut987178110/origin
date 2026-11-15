/* =========================================================================
   orbit_play.js · activities you do together (v6.1)
   -------------------------------------------------------------------------
   Three things a companion can do WITH you, and the rules that keep them
   honest. The mechanics are generic (a claw-machine round that is judged by a
   rule, a shared focus timer, merged shared records, invitations with a
   frequency cap) — the cast, the lines and the evening scenes are Orbit's own.

   Why the judgement is a pure function here and not in the UI: the emulator
   run taught us that anything the screen decides (network, animation, the
   user's timing) ends up wrong after a crash or a resume. So:
     · claw result  = f(position, targets, attempt) — integer maths, no luck
     · focus time   = server-clock style: startedAt + accumulated seconds
     · consumption  = recorded ONCE per instance (idempotent by runId)
     · records      = merged by (character, day, type) and a hidden record can
                      never be used to invite you again
   Numbers (3 plays a day, 3 grabs, 10-minute threshold, 1/day invite) are
   design defaults of THIS build, not user data.
   ========================================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.OrbitCore = root.OrbitCore || {}).play = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY = 86400000;
  const CONFIG = {
    claw: { playsPerDay: 3, grabsPerRound: 3, targetsPerRound: 6, radius: 40, readyMinutes: 10, runHours: 24 },
    focus: { preset: [15, 25, 45], min: 10, max: 120, thresholdSec: 600, pauseGraceMin: 30, runHours: 24 },
    invitation: { ttlHours: 24, perDay: 1, per168h: 3, closeToPause: 3, pauseDays: 7 },
    relation: { clawPoints: 20, focusPoints: 10, maxPerDay: 30 },
    quiet: { start: 22, end: 9 }
  };

  /* ---------- time: one "day key" per device, 04:00 boundary like the design doc ---------- */
  /* Local-day key with a 04:00 boundary ("the day ends when you go to sleep, not at
     midnight"). Built from local Y/M/D — an earlier version used toISOString(), which
     is UTC, so with the 4-hour shift the boundary landed at noon local time. */
  function dayKey(ms, boundaryH) {
    const h = boundaryH == null ? 4 : boundaryH;
    const d = new Date(ms - h * 3600000);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  const hourOf = ms => new Date(ms).getHours();
  function inQuiet(ms, q) {
    const s = q && q.start != null ? q.start : CONFIG.quiet.start;
    const e = q && q.end != null ? q.end : CONFIG.quiet.end;
    const h = hourOf(ms);
    return s === e ? false : s < e ? (h >= s && h < e) : (h >= s || h < e);
  }

  /* ---------- claw machine ---------- */
  /* Six targets in a 0–1000 space, deterministic from the run id: the same round
     always shows the same shelf, even after the app was killed. */
  function rngFrom(seedStr) {
    let h = 2166136261;
    for (let i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 16777619); }
    return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return (h >>> 0) / 4294967296; };
  }
  const TOYS = [
    { id: 'bear', emoji: '🧸' }, { id: 'bunny', emoji: '🐰' }, { id: 'cat', emoji: '🐱' }, { id: 'fox', emoji: '🦊' },
    { id: 'panda', emoji: '🐼' }, { id: 'duck', emoji: '🦆' }, { id: 'frog', emoji: '🐸' }, { id: 'penguin', emoji: '🐧' },
    { id: 'koala', emoji: '🐨' }, { id: 'owl', emoji: '🦉' }
  ];
  function makeTargets(runId) {
    const rnd = rngFrom(String(runId || 'orbit'));
    const out = [];
    for (let i = 0; i < CONFIG.claw.targetsPerRound; i++) {
      const toy = TOYS[Math.floor(rnd() * TOYS.length)];
      /* Toys are judged on a 1000-unit grid with a radius of 40, so two toys closer than 80 units
         are one target: the toy under the finger could be the other one, and a grab that visibly
         sits on a toy missed (seen once in e2e). Draw again until the new toy stands apart. */
      let x = 0, y = 0;
      for (let k = 0; k < 40; k++) {
        x = 120 + Math.round(rnd() * 760); y = 140 + Math.round(rnd() * 620);
        if (out.every(o => Math.hypot(o.x - x, o.y - y) >= 80)) break;
      }
      out.push({ id: 't' + (i + 1), toy: toy.id, emoji: toy.emoji, x: x, y: y });
    }
    return out;
  }
  /* The rule, in integers — no floating point, no random success, no physics.
     d <= 40 is a win (boundary counts as success). */
  function judge(claw, target, radius) {
    const r = radius || CONFIG.claw.radius;
    const dx = Math.round(claw.x) - Math.round(target.x), dy = Math.round(claw.y) - Math.round(target.y);
    return dx * dx + dy * dy <= r * r;
  }
  /* The character's own grab: a fixed error model, identical odds for every
     companion (personality shows in words and timing, never in luck). */
  function charGrab(target, personaId, attempt) {
    const rnd = rngFrom(String(personaId) + ':' + String(attempt) + ':' + Math.round(target.x) + ':' + Math.round(target.y));
    // The first of her two grabs this round always lands: her opening try is one of the
    // player's two leftover tries and that try is the only one that can be "hers", so with
    // plain 70/30 odds roughly one round in ten ended in "she missed twice" — the player
    // saw a partner who never reached the shelf. Her second grab keeps the 70/30 odds, and
    // neither side's odds depend on the character (personality lives in words and timing).
    const first = Math.max(1, CONFIG.claw.grabsPerRound - 1);          // 3 grabs → her first try is #2
    const hit = attempt === first ? true : rnd() < 0.7;
    // The claw lands a safe distance from the toy: at most 20% of the radius for a hit and
    // at least 110% for a miss. The previous 0..40 / 41..80 range sat on the boundary, where
    // rounding could turn her "hit" into a miss on screen.
    const R = CONFIG.claw.radius;
    const off = hit ? Math.floor(rnd() * R * 0.2) : Math.ceil(R * 1.1) + Math.floor(rnd() * R * 0.9);
    const ang = rnd() * Math.PI * 2;
    return { x: Math.round(target.x + Math.cos(ang) * off), y: Math.round(target.y + Math.sin(ang) * off), operator: 'character', hit };
  }
  /* One attempt on a run (pure): returns the new run; never throws away a result. */
  function attempt(run, req) {
    if (!run || run.status !== 'RUNNING') return { run, error: 'not_running' };
    if (run.attempts.length >= CONFIG.claw.grabsPerRound) return { run, error: 'no_attempts_left' };
    const attemptNo = run.attempts.length + 1;
    const dup = run.attempts.find(a => a.no === attemptNo);
    if (dup) return { run, error: 'duplicate_attempt', existing: dup };     // runId+attemptNo is unique
    const left = (run.targets || []).filter(t => !t.taken);
    const target = left.find(t => t.id === req.targetId) || left[0];
    if (!target) return { run, error: 'no_targets' };
    const hit = judge(req.claw, target);
    const next = Object.assign({}, run, { attempts: run.attempts.concat([{ no: attemptNo, targetId: target.id, claw: { x: Math.round(req.claw.x), y: Math.round(req.claw.y) }, hit, operator: req.operator === 'character' ? 'character' : 'player', at: req.at }]) });
    if (hit) next.targets = next.targets.map(t => t.id === target.id ? Object.assign({}, t, { taken: true }) : t);
    next.attemptsLeft = CONFIG.claw.grabsPerRound - next.attempts.length;
    if (!next.attemptsLeft) next.status = 'TERMINATED';
    return { run: next, hit, targetId: target.id };
  }
  const toysWon = run => (run && run.targets ? run.targets.filter(t => t.taken).map(t => t.toy) : []);

  /* ---------- co-focus ---------- */
  /* elapsed = what the run has accumulated INCLUDING the running stretch. The
     app never writes back a total: it asks this function at display time, so a
     force-kill or a changed device clock cannot invent minutes. */
  function focusElapsed(run, atMs) {
    if (!run) return 0;
    const acc = run.accumulatedSec || 0;
    if (run.status !== 'RUNNING' || !run.runningSince) return acc;
    return acc + Math.max(0, Math.floor((atMs - run.runningSince) / 1000));
  }
  function focusPause(run, atMs) {
    if (!run || run.status !== 'RUNNING') return { run, error: 'not_running' };
    return { run: Object.assign({}, run, { status: 'PAUSED', accumulatedSec: focusElapsed(run, atMs), runningSince: 0, pausedAt: atMs }), elapsed: focusElapsed(run, atMs) };
  }
  function focusResume(run, atMs) {
    if (!run || run.status !== 'PAUSED') return { run, error: 'not_paused' };
    return { run: Object.assign({}, run, { status: 'RUNNING', runningSince: atMs, pausedAt: 0 }) };
  }
  /* finish: 'completed' or 'aborted'. Under the threshold = no record, no credit. */
  function focusFinish(run, atMs, why) {
    if (!run || (run.status !== 'RUNNING' && run.status !== 'PAUSED')) return { run, error: 'not_running' };
    const sec = focusElapsed(run, atMs);
    const qualifies = sec >= CONFIG.focus.thresholdSec;
    return { run: Object.assign({}, run, { status: 'TERMINATED', accumulatedSec: sec, runningSince: 0, endedAt: atMs, endReason: why || 'completed', qualifies }), seconds: sec, qualifies };
  }
  /* Result the character reacts to — used to pick her line, never to change time. */
  function focusMilestone(sec) {
    const th = CONFIG.focus.thresholdSec;
    if (sec >= 3 * th) return 'long';
    if (sec >= th) return 'done';
    if (sec >= th / 2) return 'halfway';
    return 'start';
  }

  /* ---------- shared records ---------- */
  /* One record per (character, day, type) while visible. A hidden record keeps its
     slot closed: later rounds open a NEW segment, and the hidden one can never be
     cited by an invitation again. */
  function recordFor(records, o) {
    const day = dayKey(o.at);
    const open = records.find(r => r.characterId === o.characterId && r.type === o.type && r.day === day && r.visible);
    return open || null;
  }
  function addRecord(records, o) {
    const open = recordFor(records, o);
    if (open) {
      open.items = open.items.concat([o.item]);
      open.count = open.items.length;
      open.updatedAt = o.at;
      return { records, record: open, merged: true };
    }
    const rec = { id: 'r_' + String(o.at) + '_' + Math.random().toString(36).slice(2, 6), characterId: o.characterId, type: o.type, day: dayKey(o.at),
      items: [o.item], count: 1, createdAt: o.at, updatedAt: o.at, visible: true };
    return { records: records.concat([rec]), record: rec, merged: false };
  }
  function hideRecord(records, id) {
    return records.map(r => r.id === id ? Object.assign({}, r, { visible: false, hiddenAt: Date.now() }) : r);
  }
  const visibleRecords = records => records.filter(r => r.visible);
  /* Only a visible record may fuel an invitation ("the cat you didn't get — want to try again?"). */
  function citableTargets(records, characterId) {
    const out = [];
    records.filter(r => r.visible && r.characterId === characterId).forEach(r => {
      (r.items || []).forEach(it => { if (it.wanted && !it.got) out.push(it.wanted); });
    });
    return Array.from(new Set(out)).slice(-3);
  }

  /* ---------- invitations ---------- */
  function invitationKey(inv) { return [inv.account || 'me', inv.characterId, inv.type, inv.target || '', inv.sourceRunId || ''].join('|'); }
  function canInvite(state, nowMs) {
    const inv = state.invites || [];
    const day = dayKey(nowMs);
    // every invitation already sent counts (including the proactive ones from LIFE.plan) —
    // the cap is about how often the companion may knock, not which system sent it
    const capped = inv.filter(i => i.sentAt && !i.isSystem);
    const sentToday = capped.filter(i => dayKey(i.sentAt) === day).length;
    if (sentToday >= CONFIG.invitation.perDay) return { ok: false, reason: 'daily_cap' };
    const last7 = capped.filter(i => nowMs - i.sentAt < 7 * DAY).length;
    if (last7 >= CONFIG.invitation.per168h) return { ok: false, reason: 'rolling_cap' };
    if (inQuiet(nowMs, state.quiet)) return { ok: false, reason: 'quiet_hours' };
    const pausedUntil = (state.play && state.play.pausedUntil) || 0;
    if (pausedUntil > nowMs) return { ok: false, reason: 'paused' };
    const closed = (state.play && state.play.closedByType) || {};
    for (const k of Object.keys(closed)) if (closed[k] >= CONFIG.invitation.closeToPause) return { ok: false, reason: 'closed_repeatedly:' + k };
    // playState() pre-creates its cupboards, so "no records at all" is the real test for a new account
    const any = ['clawRecs', 'focusRecs'].some(k => (state.play && state.play[k] || []).length);
    if (!any) return { ok: false, reason: 'no_history' };      // never invite to a first try: nothing has happened yet
    return { ok: true };
  }
  /* Rank: an invitation the player asked for > resuming a round > history retry >
     regular activity. A refused invite is not shown again the same day. */
  function rank(cands) {
    const w = c => ({ resume: 0, retry: 1, general: 2 }[c.kind] == null ? 3 : { resume: 0, retry: 1, general: 2 }[c.kind]);
    return cands.slice().sort((a, b) => w(a) - w(b) || (a.expiresAt || 0) - (b.expiresAt || 0));
  }
  function buildInvite(o) {
    return { id: 'i_' + String(o.at) + '_' + Math.random().toString(36).slice(2, 6), characterId: o.characterId, type: o.type, kind: o.kind,
      target: o.target || '', sourceRunId: o.sourceRunId || '', minutes: o.minutes || '', body: o.body, createdAt: o.at, expiresAt: o.at + CONFIG.invitation.ttlHours * 3600000,
      status: 'shown', shownAt: o.at };
  }
  /* Lines for an invitation. Filled with a real target when there is one — an
     invitation must point at something that actually happened, otherwise it is
     marketing noise. */
  const INVITE_LINES = {
    claw: {
      retry: {
        en: t => 'We still haven\'t got the ' + toyWord(t, 'en') + '. Try again tonight?',
        zh: t => '上次那只' + toyWord(t, 'zh') + '还没抓到，今天再试一次？'
      },
      resume: { en: () => 'That claw round is still open. Want to finish it?', zh: () => '刚才那局还没用完，要继续吗？' },
      general: { en: () => 'Want to play the claw machine together?', zh: () => '要不要一起去抓娃娃？' }
    },
    focus: {
      general: { en: m => 'Sit with me for ' + m + ' minutes?', zh: m => '陪我一起专注 ' + m + ' 分钟？' },
      resume: { en: () => 'That quiet stretch got interrupted. Pick it up?', zh: () => '刚才那段专心被打断了，要不要接着来？' }
    }
  };
  const TOY_NAME = { bear: ['teddy bear', '小熊'], bunny: ['bunny', '兔子'], cat: ['cat', '小猫'], fox: ['fox', '狐狸'], panda: ['panda', '熊猫'],
    duck: ['duck', '小鸭'], frog: ['frog', '青蛙'], penguin: ['penguin', '企鹅'], koala: ['koala', '考拉'], owl: ['owl', '猫头鹰'] };
  function toyWord(id, lang) { const n = TOY_NAME[id] || TOY_NAME.bear; return lang === 'zh' ? n[1] : n[0]; }
  function inviteText(inv, lang) {
    const L = lang === 'zh' ? 'zh' : 'en';
    const fam = INVITE_LINES[inv.type] && INVITE_LINES[inv.type][inv.kind];
    const tpl = fam && fam[L];
    if (!tpl) return INVITE_LINES.claw.general[L]();
    return inv.type === 'claw' && inv.kind === 'retry' ? tpl(inv.target) : (inv.minutes ? tpl(inv.minutes) : tpl());
  }

  /* ---------- idle lines (the "alive" part of doing something together) ---------- */
  /* During an activity the companion reacts to what just happened. Three rules
     that came out of the design review: never repeat one of the last three
     lines, never talk over the player (caller checks "busy"), and always have
     a plain fallback so a missing line never shows an empty bubble. */
  const REACT = {
    claw: {
      start: { en: ['Pick the one you want first.', 'Left or right? Your call.', 'Ready when you are.', 'Take your time.', 'No rush.', 'Whenever you want.'],
        zh: ['先挑一只你想要的。', '左边还是右边？你定。', '准备好了就说。', '慢慢挑。', '不用急。', '你准备好就行。'] },
      playerWin: { en: ['Got it. Clean grab.', 'That was steady.', 'Nice — that one came up easy.', 'That one\'s yours.', 'Nice and calm.', 'Lucky shelf.'],
        zh: ['拿到了。很稳。', '刚才那一下很准。', '抓得漂亮。', '这只归你。', '很稳。', '运气不错。'] },
      playerMiss: { en: ['Close. Want to adjust a little?', 'Not quite — aim a bit lower?', 'Almost. One more try.', 'Try nudging it.', 'Almost there.', 'You\'ve got this.'],
        zh: ['差一点，要不要再挪一点？', '没对准，再低一点试试？', '就快到了，再来一次。', '再挪一点。', '就快到了。', '你可以的。'] },
      charWin: { en: ['There. It\'s yours.', 'Knew that would come up.', 'Here — this one is for you.', 'I had a feeling.', 'It\'s yours.', 'Take it.'],
        zh: ['给你，这只到手了。', '我就说能抓上来。', '这个归你。', '我就觉得能抓上来。', '归你了。', '拿去吧。'] },
      charMiss: { en: ['Missed it. Want to take over?', 'My aim is off. Your turn?', 'Slipped. Try yourself?', 'I\'ll watch.', 'Your hands are steadier today.', 'I won\'t mind.'],
        zh: ['没抓着。换你试试？', '我这准头今天不太行。', '滑掉了，你来？', '我看着。', '你今天手更稳。', '不介意。'] },
      swap: { en: ['Alright, my turn.', 'I\'ll take this one.', 'Hand it to me.', 'Watch this.', 'I\'ll try.', 'This one\'s mine.'],
        zh: ['好，换我来。', '这局我来。', '交给我吧。', '看我的。', '我试试。', '这只我来。'] },
      end: { en: ['That\'s the round. If something slips, I won\'t count it.', 'Three grabs done.', 'We can leave the rest for next time.', 'Thanks for playing with me.'],
        zh: ['这局就到这儿了，没成功的就别硬凑了。', '三次抓完了。', '剩下的下次再说。', '谢谢你陪我玩。'] }
    },
    focus: {
      start: { en: ['Timer is going. I\'ll stay quiet.', 'All set. Let\'s do this quietly.', 'Starting now — I\'m here.', 'Just you and the work.', 'One thing at a time.', 'No rush.'],
        zh: ['计时开始了，我不吵你。', '都设好了，安静一起做吧。', '开始了，我在这儿。', '就你和手头的事。', '一件一件来。', '不用急。'] },
      halfway: { en: ['Halfway. Still with you.', 'Half done — keep going gently.', 'Breathe.', 'You\'re doing fine.', 'Still here.', 'Good pace.'],
        zh: ['过一半了，还在。', '一半了，慢慢来。', '慢慢呼吸。', '你做得很好。', '我还在。', '节奏正好。'] },
      done: { en: ['Time. Stretch a little.', 'That\'s it — well done.', 'Done. Go get some water.', 'You did it.', 'Proud of you.', 'Rest your eyes.'],
        zh: ['时间到了，起来伸个懒腰。', '到点了，做得好。', '结束了，去喝口水。', '你做到了。', '为你高兴。', '看看远处。'] },
      early: { en: ['Let\'s stop here for today.', 'That\'s okay — we can pick it up another time.', 'No guilt.', 'It\'ll keep.'],
        zh: ['今天先到这里。', '没关系，下次再来。', '别有负担。', '不着急，下次再来。'] },
      short: { en: ['That was short, but it still counted as showing up.', 'Even a few minutes is something.', 'Small is still something.', 'Glad you came.'],
        zh: ['虽然短了点，但来了就算。', '几分钟也是坚持。', '一点点也算。', '你来了就好。'] }
    }
  };
  function pickLine(type, event, personaId, history, seed) {
    const set = (REACT[type] && REACT[type][event]) || { en: ['Okay.'], zh: ['好。'] };
    const all = set.en.map((en, i) => ({ en, zh: set.zh[i] || set.zh[0] }));
    const recent = (history || []).slice(-3);
    const fresh = all.filter(l => !recent.includes(l.en));
    const pool = fresh.length ? fresh : all;
    const r = rngFrom(String(personaId) + ':' + event + ':' + String(seed || 0));
    // an event with only two lines would alternate forever (A B A B) when the random
    // pick is unlucky, so a repeat of the line just said is swapped for another one
    let pick = pool[Math.floor(r() * pool.length)];
    if (pool.length > 1 && history && history[history.length - 1] === pick.en) pick = pool[(pool.indexOf(pick) + 1) % pool.length];
    return pick;
  }

  /* ---------- relationship credit: paid once per run, capped per day ---------- */
  function creditFor(type) { return type === 'claw' ? CONFIG.relation.clawPoints : type === 'focus' ? CONFIG.relation.focusPoints : 0; }
  /* `points` is what this run would earn. The old check only asked "is the day's total already at
     the cap", so with 20 credited a second claw round was paid another 20 and the day went to 40
     against a stated maximum of 30 — the cap has to look at the earning, not just the total. */
  function canCredit(state, runId, atMs, points) {
    if (!runId) return { ok: false, reason: 'no_run' };
    if ((state.credited || []).some(c => c.runId === runId)) return { ok: false, reason: 'already_credited' };
    const day = dayKey(atMs);
    const used = (state.credited || []).filter(c => dayKey(c.at) === day).reduce((a, c) => a + (c.points || 0), 0);
    const want = Math.max(0, +points || 0);
    if (used + want > CONFIG.relation.maxPerDay) return { ok: false, reason: 'daily_cap', used };
    return { ok: true, used };
  }

  return {
    DAY, CONFIG, TOYS, REACT, INVITE_LINES, TOY_NAME,
    dayKey, hourOf, inQuiet, rngFrom, toyWord,
    makeTargets, judge, charGrab, attempt, toysWon,
    focusElapsed, focusPause, focusResume, focusFinish, focusMilestone,
    recordFor, addRecord, hideRecord, visibleRecords, citableTargets,
    invitationKey, canInvite, rank, buildInvite, inviteText,
    pickLine, creditFor, canCredit
  };
});
