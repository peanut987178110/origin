/* 10_play.js · the things you do together — claw machine · co-focus · shared records
   ---------------------------------------------------------------------------------
   All RULES live in shared/orbit_play.js (pure, exercised by "node tools/orbit_e2e.js"
   --unit"). This file is only plumbing and screens:
     · a result is written ONCE per run (idempotent by runId) and consumes a round once
     · a run that was opened but never played does not use up a round
     · relation credit is paid once per run, capped per day — the settlement states the
       reason when it does not pay; it never shows a made-up number
     · only visible records can be cited by an invitation */
const PLAY = OC.play;

function playState() {
  if (!S.play) S.play = {};
  const p = S.play;
  p.claw = p.claw || {}; p.claw.plays = p.claw.plays || {}; p.claw.runs = p.claw.runs || {}; p.claw.seen = p.claw.seen || {};
  p.focus = p.focus || {}; p.focus.runs = p.focus.runs || {};
  p.clawRecs = p.clawRecs || []; p.focusRecs = p.focusRecs || [];
  p.invites = p.invites || []; p.credited = p.credited || [];
  p.closedByType = p.closedByType || {}; p.pausedUntil = p.pausedUntil || 0;
  p.__fixed = true;             // states saved before v6.1 start from the default empty shape
  return p;
}
/* A dashboard demo ("simulate next day") moves the clock to deliver due check-ins. That is not the
   player living through a day: their claw rounds, co-focus feed must not reset, and repeated
   demo jumps would keep resetting them. The play calendar follows the clock except for those
   jumps, which this offset cancels out. */
const playNow = () => now() - (S.play && S.play.clockHold || 0);
const playDay = () => PLAY.dayKey(playNow());
const playDayFor = ts => PLAY.dayKey(ts);
const runsOf = k => Object.values(playState()[k].runs).sort((a, b) => (a.createdAt - b.createdAt) || String(a.id).localeCompare(String(b.id))); // a tie keeps the id order: two starts in the same millisecond must not swap places between calls
const playsLeft = () => Math.max(0, PLAY.CONFIG.claw.playsPerDay - (playState().claw.plays[playDay()] || 0));
const isClawRun = r => !!r && r.targets != null;
let clawLeftAt = 0;
const openClawRun = () => runsOf('claw').reverse().find(r => r.status === 'RUNNING' || r.status === 'READY') || null;
const openFocusRun = () => runsOf('focus').reverse().find(r => r.status === 'RUNNING' || r.status === 'PAUSED') || null;

function creditRelation(points, runId, why) {
  const p = playState(), chk = PLAY.canCredit(p, runId, playNow(), points);
  if (!chk.ok) { track('relation_credit_skipped', { reason: chk.reason, run_id: runId }); return chk; }
  p.credited.push({ runId, points, at: playNow(), why });
  S.rel.effectiveCount += 1;               // "we did something together today" — same counter as an effective chat
  markDay();
  track('relationship_progress', { points, source: why, run_id: runId });
  save();
  return { ok: true, points };
}
function saveRecord(kind, run, item) {
  const p = playState(), key = kind === 'claw' ? 'clawRecs' : 'focusRecs';
  const r = PLAY.addRecord(p[key], { characterId: run.characterId, type: kind, at: playNow(), item });
  p[key] = r.records;
  track('shared_record_created', { type: kind, merged: r.merged, record_id: r.record.id });
  return r.record;
}
function mergeInvites(inv) {
  const p = playState(), day = playDay();
  p.invites.push(Object.assign({}, inv, { sentAt: inv.createdAt, isSystem: false }));
  p.claw.seen[day] = (p.claw.seen[day] || 0) + 1;    // counted by LIFE.plan so it will not add a second check-in today
  if (p.invites.filter(i => i.sentAt && playDayFor(i.sentAt) === day).length >= PLAY.CONFIG.invitation.perDay) {
    // one invitation a day, whichever system asks — tell LIFE so it does not plan a second one
    S.proactive.lastSentDay = day;
  }
}

/* Every tap runs through here. One broken action must show its reason and leave the rest of
   the app usable — an exception used to leave the old page on screen with no explanation,
   which is indistinguishable from "the button does nothing". */
function guardActions(obj, label) {
  Object.keys(obj).forEach(k => {
    const fn = obj[k];
    obj[k] = function () { try { return fn.apply(this, arguments); } catch (e) { console.error('[' + label + '.' + k + ']', e); toast(tt('Something went wrong there — try again.', '这一步出了点问题，再试一次。')); return undefined; } };
  });
}

/* ======================= claw machine ======================= */
Actions['play.claw'] = () => {
  const run = openClawRun();
  if (!run && !playsLeft()) { toast(tt('That is all three rounds for today — they reset tomorrow at 4am.', '今天三局用完了，明天凌晨 4 点刷新。')); return; }
  go('claw'); rerender();
};
function startClawRun() {
  /* A round left open by a back press, on a day whose rounds are already spent (the test clock
     moved past midnight), must not be resumed — the render falls back to the cap screen instead. */
  if ((playState().claw.plays[playDay()] || 0) > PLAY.CONFIG.claw.playsPerDay) return null;
  const run = { id: rid('run_'), characterId: S.character.id, createdAt: playNow(), status: 'READY', played: false, selected: '',
    attempts: [], attemptsLeft: PLAY.CONFIG.claw.grabsPerRound, targets: PLAY.makeTargets(playNow() + '|' + S.character.id), lastLine: '', lines: [],
    aimedToy: '' };                                                // the toy the claw physically sits on (not the chosen one)
  playState().claw.runs[run.id] = run;
  track('activity_started', { type: 'claw', run_id: run.id });
  save(); return run;
}
/* A round is used by its FIRST ACCEPTED GRAB, not by opening the page. */
function consumePlay(run) {
  if (!run || run.played) return;
  run.played = true;
  const p = playState(), d = playDay();
  p.claw.plays[d] = (p.claw.plays[d] || 0) + 1;
  track('claw_round_consumed', { run_id: run.id, left: PLAY.CONFIG.claw.playsPerDay - p.claw.plays[d] });
}
/* Her grab comes after the player's first grab, and it is the round's LAST grab: her grab
   ends the round (the player keeps their other grab for her only if they have not grabbed
   yet — then her turn is just a nudge and does not close anything). */
const charCanGrab = run => !!run && run.attempts.length > 0 && run.attempts.every(a => a.operator !== 'character');
/* why an attempt never happened, in words for the player (an empty round that was simply
   left is not an error and says nothing) */
const GRAB_WHY = {
  stale_run: ['This round has already moved on.', '这一局已经结束了。'],
  not_ready: ['This round has already ended.', '这一局已经结束了。'],
  not_running: ['This round has already ended.', '这一局已经结束了。'],
  not_her_turn: ['Grab once first — then it is my turn.', '你先抓一下，再换我来。'],
  no_attempts_left: ['No grabs left this round. See how it went.', '这局抓的机会用完了，看看结果吧。'],
  no_targets: ['Nothing is left on the shelf.', '架子上已经空了。']
};
function grabWhy(code) { const w = GRAB_WHY[code]; return w ? tt(w[0], w[1]) : ''; }
function clawGrab(x, y, op, runId) {
  const fail = code => { save(); return { error: code, say: grabWhy(code) }; };
  const run = openClawRun();
  if (run && runId && run.id !== runId) return fail('stale_run');   // a second tap that arrives after the round moved on
  if (!run || run.status === 'TERMINATED' || run.settled) return fail('not_ready');
  if (op === 'character' && !charCanGrab(run)) return fail('not_her_turn');
  const left = run.targets.filter(t => !t.taken);
  const target = left.find(t => t.id === run.selected) || left[0];
  if (!target) return fail('no_targets');
  consumePlay(run);
  if (run.status !== 'RUNNING') run.status = 'RUNNING';
  /* Her first grab always lands (a partner who can miss her opening try is not much of a
     partner), and landing it takes the toy the claw is sitting on off the shelf. Two toys with
     the same face can sit close to each other, though: the player grabs the teddy, and her neat
     grab "wins" the second teddy right next to it. She reaches for the toy the player picked
     that is still within reach instead. */
  if (op === 'character' && run.selected) {
    const reach = PLAY.CONFIG.claw.radius * 1.5, pick = left.find(t => t.id === run.selected);
    if (pick && Math.hypot(x - pick.x, y - pick.y) > reach) { x = pick.x; y = pick.y; }
  }
  const res = PLAY.attempt(run, { targetId: target.id, claw: { x, y }, operator: op, at: playNow() });
  if (res.error) return fail(res.error);
  Object.assign(run, res.run);
  if (op === 'character') run.status = 'TERMINATED';              // her grab ends the round
  track('activity_attempt', { type: 'claw', run_id: run.id, part: run.attempts.length, hit: !!res.hit, operator: op === 'character' ? 'character' : 'player' });
  /* the remembered aim follows the grab that was just judged: the marker (and her turn, which
     descends from the claw's place) must show where this press landed, not where an older press did */
  run.aimX = Math.round(x); run.aimY = Math.round(y); run.aimedToy = ''; save();
  return res;
}
/* Settlement — callable more than once (re-render, app restart): record, relation credit
   and the "round finished" event happen exactly once per run. */
function settleClaw(run) {
  if (!run) return null;
  if (run.settled) return { run, won: PLAY.toysWon(run), credit: { ok: false, reason: 'already_settled' }, record: null };
  const won = PLAY.toysWon(run);
  const wantedT = run.targets.find(t => t.id === run.selected) || {};
  let credit = { ok: false, reason: 'no_play' }, record = null;
  if (run.played) {
    credit = creditRelation(PLAY.creditFor('claw'), run.id, 'claw_round');
    record = saveRecord('claw', run, { runId: run.id, won, wanted: wantedT.toy || '', got: !!wantedT.toy && won.includes(wantedT.toy), tries: run.attempts.length });
  }
  run.settled = true; run.status = 'TERMINATED'; run.endedAt = playNow();
  if (!run.played) track('activity_aborted', { type: 'claw', run_id: run.id, reason: 'no_play' });
  else track('activity_completed', { type: 'claw', run_id: run.id, won: won.length, credited: !!credit.ok });
  save();
  return { run, won, credit, record };
}

/* ======================= co-focus ======================= */
function startFocus(minutes) {
  const prevRun = openFocusRun();                                  // one co-focus session at a time: end the old one, never lose its time
  if (prevRun) {
    if (prevRun.status === 'RUNNING') return { error: 'busy', prev: prevRun };   // it is still counting: do not end it behind the user's back
    finishFocus('superseded');
  }
  const nowTs = now()      /* real time: the focus timer counts seconds as they pass, a demo clock jump must not finish it */, run = { id: rid('foc_'), characterId: S.character.id, createdAt: nowTs, status: 'RUNNING',
    targetMinutes: Math.max(PLAY.CONFIG.focus.min, Math.min(PLAY.CONFIG.focus.max, +minutes || 25)),
    accumulatedSec: 0, runningSince: nowTs, milestones: [], lines: [], lastLine: '' };   // one clock reading: a second call here is a millisecond the timer would gain/lose
  playState().focus.runs[run.id] = run;
  track('activity_started', { type: 'focus', run_id: run.id, minutes: run.targetMinutes });
  save(); return run;
}
function focusSay(run, event) {
  if (!run) return;
  const line = PLAY.pickLine('focus', event, S.character.base, run.lines, run.lines.length);
  run.lines = (run.lines || []).concat([line.en]).slice(-6);
  run.lastLine = line[lang()] || line.en;
  track('character_reaction_played', { type: 'focus', event });
}
/* The page never keeps its own counter: it asks the rule module for elapsed seconds.
   Called every second while the focus screen is visible, and again on resume. */
const focusDue = (run, at) => PLAY.focusElapsed(run, at) >= run.targetMinutes * 60;
function focusTick() {
  const run = openFocusRun(); if (!run) return null;
  if (run.status === 'PAUSED') return { run, sec: PLAY.focusElapsed(run, playNow()) };
  const sec = PLAY.focusElapsed(run, playNow());
  const ms = PLAY.focusMilestone(sec);
  if (ms !== 'start' && !run.milestones.includes(ms)) { run.milestones.push(ms); if (ms === 'halfway') { focusSay(run, 'halfway'); save(); } }
  if (sec >= run.targetMinutes * 60) { const r = finishFocus('completed'); return Object.assign(r, { justDone: true }); }
  return { run, sec };
}
function finishFocus(why) {
  const run = openFocusRun(); if (!run) return null;
  const fin = PLAY.focusFinish(run, playNow(), why);
  Object.assign(run, fin.run);
  let credit = { ok: false, reason: 'under_threshold' }, record = null;
  if (fin.qualifies) {
    credit = creditRelation(PLAY.creditFor('focus'), run.id, 'focus_session');
    record = saveRecord('focus', run, { runId: run.id, seconds: fin.seconds, target: run.targetMinutes, early: why === 'early' });
    focusSay(run, why === 'early' ? 'early' : 'done');
  } else focusSay(run, 'short');
  track(fin.qualifies ? 'activity_completed' : 'activity_aborted', { type: 'focus', run_id: run.id, seconds: fin.seconds, why });   // no "completed" on an early stop
  save();
  return { run, seconds: fin.seconds, qualifies: fin.qualifies, credit, record };
}

/* ======================= invitations ======================= */
/* The sentence is built from the clock AT DISPLAY TIME (the "tonight" case): the same invite,
   rendered tomorrow morning, says "today". Nothing stale is ever stored. */
function buildPlayInvite(pick) {
  const hour = PLAY.hourOf(playNow()), L = lang();
  const opts = Object.assign({ at: playNow(), characterId: S.character.id }, pick);
  const inv = PLAY.buildInvite(opts);
  if (pick.type === 'claw' && pick.kind === 'retry' && hour >= 18) {
    inv.body = L === 'zh' ? '上次那只' + PLAY.toyWord(pick.target, 'zh') + '还没抓到，今天还来得及，再试一次？' : 'We still haven\'t got the ' + PLAY.toyWord(pick.target, 'en') + ' — there\'s still time today. Try again?';
  } else if (pick.type === 'claw' && pick.kind === 'retry' && hour < 12) {
    inv.body = L === 'zh' ? '上次那只' + PLAY.toyWord(pick.target, 'zh') + '还在柜子里，今天要不要一起再试？' : 'The ' + PLAY.toyWord(pick.target, 'en') + ' is still in the cabinet — want to try again today?';
  } else inv.body = PLAY.inviteText(inv, L);
  return inv;
}
function planPlayInvite() {
  const p = playState();
  const chk = PLAY.canInvite({ invites: p.invites, quiet: S.settings.quiet, play: p }, playNow());
  if (!chk.ok) return null;
  const cands = [];
  const open = openClawRun() || openFocusRun();
  if (open && open.status !== 'READY') cands.push({ kind: 'resume', type: isClawRun(open) ? 'claw' : 'focus', sourceRunId: open.id, minutes: open.targetMinutes });
  const toys = PLAY.citableTargets(p.clawRecs, S.character.id);
  if (toys.length) cands.push({ kind: 'retry', type: 'claw', target: toys[toys.length - 1] });
  if (playsLeft() > 0) cands.push({ kind: 'general', type: 'claw' });
  if (!cands.length) return null;
  const pick = PLAY.rank(cands)[0];
  mergeInvites(buildPlayInvite(pick));
  track('activity_invitation_shown', { kind: pick.kind, type: pick.type });
  save();
  return pick;
}
function closeInvite(id) {
  const p = playState(), inv = p.invites.find(i => i.id === id); if (!inv || inv.status !== 'shown') return;
  inv.status = 'dismissed'; inv.dismissedAt = playNow();
  p.closedByType[inv.type] = (p.closedByType[inv.type] || 0) + 1;
  if (p.closedByType[inv.type] >= PLAY.CONFIG.invitation.closeToPause && p.pausedUntil < playNow()) {
    p.pausedUntil = playNow() + PLAY.CONFIG.invitation.pauseDays * PLAY.DAY;
    toast(tt('I get it — I won\'t invite you to that again for a week.', '知道了，这类邀请一周内不再发。'));
  }
  track('activity_invitation_dismissed', { type: inv.type, invitation_id: id }); save();
}
function acceptInvite(id) {
  const p = playState(), inv = p.invites.find(i => i.id === id); if (!inv || inv.status !== 'shown') return;
  inv.status = 'accepted'; inv.acceptedAt = playNow();
  track('activity_invitation_accepted', { type: inv.type, invitation_id: id }); save();
  if (inv.type === 'claw') {
    const run = openClawRun();
    if (!run && !playsLeft()) { toast(tt('Actually — the claw rounds are done for today. Tomorrow?', '其实今天的次数用完了，明天吧。')); return; }
    if (run && inv.kind === 'retry' && inv.target) { const t = run.targets.find(x => x.toy === inv.target && !x.taken); if (t) run.selected = t.id; }
    /* Back from the invited round returns to Together, never to the chat under the card. A plain
       reset did that by emptying the stack, but then the claw was the ONLY entry and back meant
       "exit": the back key did nothing on screen and the player was stuck on the cabinet. The
       stack is set to Together first, so back has a real page to return to. */
    nav.stack = ['life']; go('claw'); rerender();
  } else { go('focus'); rerender(); }
}
const pendingPlayInvite = () => playState().invites.filter(i => i.status === 'shown' && i.expiresAt > playNow()).slice(-1)[0] || null;

/* ======================= screens ======================= */
/* The tab is "Together" — everything here is something you DO WITH the companion,
   as opposed to what the companion says to you. */
Views.life = { render(el) {
  const p = playState(), inv = pendingPlayInvite();
  const clawRecs = p.clawRecs.filter(r => r.visible), focusRecs = p.focusRecs.filter(r => r.visible);
  const toys = clawRecs.reduce((a, r) => a.concat(r.items.reduce((b, i) => b.concat(i.won || []), [])), []);
  const focusMin = Math.round(focusRecs.reduce((a, r) => a + r.items.reduce((b, i) => b + (i.seconds || 0), 0), 0) / 60);
  const todayCredit = p.credited.filter(c => playDayFor(c.at) === playDay()).reduce((a, c) => a + c.points, 0);
  el.innerHTML = '<header class="top"><h2 style="padding-left:4px">' + tt('Together', '一起') + '</h2><span class="pill">' + esc(S.character.name) + '</span></header><div class="body">' +
    (inv ? '<div class="card" style="border-color:rgba(167,139,250,.45)"><div class="tiny">' + esc(S.character.name) + '</div><div style="margin-top:4px">' + esc(inv.body) + '</div>' +
      '<div style="display:flex;gap:8px;margin-top:10px"><button class="btn sm" data-act="inv.accept" data-arg="' + inv.id + '">' + tt('Sure', '好呀') + '</button>' +
      '<button class="btn sm ghost" data-act="inv.later" data-arg="' + inv.id + '">' + tt('Not now', '待会儿') + '</button></div></div>' : '') +
    '<button class="card opt" style="margin-top:12px" data-act="play.claw"><div style="font-size:28px">🪝</div><div style="flex:1"><div class="t">' + tt('Claw machine', '抓娃娃') + '</div>' +
      '<div class="d">' + tt('3 rounds a day · pick a toy, place the claw yourself', '每天 3 局 · 自己挑娃娃、自己放爪子') + '</div></div>' +
      '<span class="pill">' + playsLeft() + '/' + PLAY.CONFIG.claw.playsPerDay + '</span></button>' +
    '<button class="card opt" style="margin-top:10px" data-act="nav.go" data-arg="focus"><div style="font-size:28px">⏱</div><div style="flex:1"><div class="t">' + tt('Focus together', '一起专注') + '</div>' +
      '<div class="d">' + tt('A quiet timer that keeps counting in the background', '一个安静的计时器，切出去也照常计时') + '</div></div></button>' +
    '<div class="sec">' + tt('Shared records', '共同记录') + '</div>' +
    (clawRecs.length + focusRecs.length ? '<button class="card opt" data-act="nav.go" data-arg="records"><div style="flex:1"><div class="t">' + (clawRecs.length + focusRecs.length) + tt(' days written down', ' 天的记录') + '</div>' +
      '<div class="d">' + (toys.length ? tt('Toys won: ', '抓到的娃娃：') + toys.length : tt('Focus time: ', '专注时长：') + focusMin + tt(' min', ' 分钟')) + '</div></div><span>›</span></button>'
      : '<div class="card tiny">' + tt('Nothing yet. Your first round or focus session writes it down.', '还没有。第一局或第一次专注后会记下来。') + '</div>') +
    '<div class="sec">' + tt('How this works', '关于这里') + '</div><div class="card tiny">' + tt('These are things you did together on this phone. Wins are judged by position, not luck, and a round that did not work is never counted as a success.',
      '这里记的是你们两个在这台手机上真的一起做过的事。抓没抓到由位置判定，不是抽奖；没抓到的也不会被算成成功。') +
      (todayCredit ? '<div style="margin-top:6px">' + tt('Today\'s relationship progress: +', '今天的关系进度：+') + todayCredit + '</div>' : '') + '</div>' +
    '</div>' + tabs('life');
} };
Actions['inv.accept'] = acceptInvite;
Actions['inv.later'] = id => { closeInvite(id); rerender(); };

/* ---- claw ---- */
Views.claw = {
  leave() { clawLeftAt = playNow(); },                       // when the page was last left, see render
  render(el) {
  /* Every render drops the cabinet element, and the element that took its place is a NEW one:
     a click this press left behind, delivered after a re-render, reached the new cabinet,
     passed the "this press was already aimed" check (that flag belonged to the old element) and
     aimed the next, fresh round at the button's spot — so her turn was taken in a round that
     had no grabs yet, and the round ended before anyone touched it. The flag goes with the
     element that set it. */
  clawAimed = false; clearTimeout(clawAimedT);
  /* A round that has not been grabbed yet does not survive the page: the player left before
     the first grab, and coming back later started a SECOND round behind it — two open rounds
     (the older one only found because it has no attempts), and a result sheet that belonged
     to the round underneath the one on screen. Leaving drops it; the next visit starts one
     fresh round. A round with a grab in it is kept (also after a result was closed early). */
  if (clawLeftAt) {
    const empty = openClawRun();
    if (empty && !empty.attempts.length) { empty.status = 'TERMINATED'; track('activity_aborted', { type: 'claw', run_id: empty.id, reason: 'left_before_grab' }); }
    clawLeftAt = 0;
  }
  /* The round this page shows. A finished round is shown once, by reading it back from the state
     with runsOf (a plain truthy chain "closed && closed.settled || ..." went on to start a new
     round on a closed one — the re-render could then paint a fresh round behind a result). When
     there is nothing to show, a round starts (null only when the day's rounds are spent). */
  const latest = runsOf('claw').slice(-1)[0];
  const closed = openClawRun() ? null : latest;
  if (closed && closed.status === 'TERMINATED' && !closed.settled) settleClaw(closed);
  let shown = null;
  if (closed && closed.status === 'TERMINATED' && closed.settled) shown = latest;
  else { shown = openClawRun(); if (!shown) shown = startClawRun(); }
  /* Nothing to show: the cap screen. It never reads run.targets. */
  if (!shown || !Array.isArray(shown.targets)) {
    el.innerHTML = topBar(tt('Claw machine', '抓娃娃'), '') + '<div class="body"><div class="card">' +
      tt('That is all the rounds for today. The toys will be back tomorrow.', '今天的次数都用完啦，娃娃明天再来陪你。') + '</div></div>';
    return;
  }
  const run = shown;
  const L = lang(), toy = t => PLAY.toyWord(t, L);
  const left = run.targets.filter(t => !t.taken);
  const sel = run.targets.find(t => t.id === run.selected) || null;
  const done = run.status === 'TERMINATED';
  /* She gets her turn after the player's first grab, and the result opens itself after the round's
     last grab, so a round that still shows the cabinet always has grabs left. */
  const canSwap = !done && run.attemptsLeft > 0 && charCanGrab(run);
  const last = run.attempts.slice(-1)[0];
  const lastT = last && run.targets.find(t => t.id === last.targetId);
  const off = last ? Math.round(Math.sqrt(Math.pow(last.claw.x - lastT.x, 2) + Math.pow(last.claw.y - lastT.y, 2))) : 0;
  const disc = t => '<button class="tg' + (t.id === run.selected ? ' sel' : '') + (t.taken ? ' taken' : '') + '" data-act="claw.pick" data-arg="' + t.id + '"' +
    (t.taken || done ? ' disabled' : '') + ' style="left:' + (t.x / 10) + '%;top:' + (t.y / 10) + '%" aria-pressed="' + (t.id === run.selected) + '" aria-label="' + esc(toy(t.toy)) + '">' + (t.taken ? '✓' : t.emoji) + '</button>';
  el.innerHTML = topBar(tt('Claw machine', '抓娃娃'), '<span class="pill">' + tt('Today', '今日') + ' ' + (PLAY.CONFIG.claw.playsPerDay - (playState().claw.plays[playDay()] || 0)) + '/' + PLAY.CONFIG.claw.playsPerDay + '</span>') +
    '<div class="body" style="display:flex;flex-direction:column">' +
    '<div class="tiny" style="margin:0 4px 8px">' + tt('Tap a toy to choose it, tap the cabinet to place the claw, then grab. A grab wins when the claw lands within 40 of the toy.',
      '点一只娃娃选中，再点柜子里想放爪子的位置，然后「抓」。爪尖离娃娃不超过 40 就算抓中。') + '</div>' +
    '<div class="booth' + (done ? ' done' : '') + '" id="booth">' + run.targets.map(disc).join('') +
      '<div class="claw" id="clawMark" style="left:' + ((run.aimX == null ? 500 : run.aimX) / 10) + '%;top:' + ((run.aimY == null ? 780 : run.aimY) / 10) + '%">⤓</div></div>' +
    '<div class="card" style="margin-top:10px;min-height:54px">' + esc(run.lastLine || tt('Pick one. I\'ll wait for your go.', '先挑一只，等你动手。')) +
      (last ? '<div class="tiny" style="margin-top:4px">' + tt('Last grab: ', '刚才那下：') + (last.hit ? tt('got the ', '抓到了 ') + esc(toy(lastT.toy)) : tt('slipped off the ', '滑掉了 ') + esc(toy(lastT.toy))) + ' · ' + tt('off by ', '偏差 ') + off + '</div>' : '') + '</div>' +
    '<div class="stack" style="margin-top:10px">' +
      (done ? '<button class="btn" data-act="claw.settle" data-press="claw.settle">' + tt('See the result', '看结算') + '</button>'
        : '<button class="btn' + (run.aimX == null || !sel ? ' disabled' : '') + '" data-act="claw.grab" id="btnGrab" data-press="claw.grab">' + tt('Grab', '抓！') + ' · ' + tt('left', '剩余') + ' ' + run.attemptsLeft + '</button>' +
          (canSwap ? '<button class="btn ghost" data-act="claw.swap" data-press="claw.swap">' + tt('Let ', '换 ') + esc(S.character.name) + tt(' try this one', ' 来抓这只') + '</button>' : '')) +
      '<div class="tiny">' + (sel ? tt('Chosen: ', '已选：') + esc(toy(sel.toy)) : tt('No toy chosen yet.', '还没选娃娃。')) + ' · ' + (run.played ? tt('This round is already counted.', '这一局已经计入次数。') : tt('The round is counted at your first grab.', '第一次抓的时候才计次。')) + '</div>' +

    '</div></div>';
  /* A touch browser fires pointerdown BEFORE the click that selects a toy, so one tap both
     chooses and aims. Listener, not an inline attribute: the bundle runs in strict mode inside
     an IIFE, where inline handlers cannot see the page's functions. */
  const b = $('#booth', el); if (b) {
    b.addEventListener('pointerdown', clawAimAt); b.addEventListener('click', clawClick);
    /* Point-mode probes (web E2E, JS): a synthetic PointerEvent dispatched on the page has
       composed:false, so it never reaches the cabinet from the document, and without a real input
       pipeline one tap could not be seen. Record a note instead of guessing whether it arrived. */
    b.addEventListener('pointerdown', e => { window.__clawSeen = window.__clawSeen || []; window.__clawSeen.push({ n: window.__clawSeen.length + 1, x: Math.round(e.clientX), y: Math.round(e.clientY), pt: e.pointerType || 'none', tgt: e.target.id || e.target.className }); }, true);
  }
} };
/* A click on the cabinet counts too, not only a touch. A mouse reports pointerdown and then a
   click at the same point, so the click is ignored; a pointer event that was filtered (a second
   finger, or one whose id a browser had already consumed) still leaves the click, and without
   this the cabinet would silently ignore a press the user clearly made. */
function clawClick(e) {
  /* Purely a fallback: the cabinet knows whether this click belongs to a press it already
     aimed on touch-down (a mouse's own pointerdown does, so does our own pointer feed). The
     click a touch leaves after its pointerdown was prevented is never aimed — it used to land
     on the cabinet UNDER the grab button that had just moved and re-aim in the same gesture. */
  if (clawAimed) { clawAimed = false; return; }
  if (!e || (e.pointerType && e.pointerType !== 'mouse' && e.pointerType !== '')) return;
  clawAimAt(e);
}
let clawAimedT = 0;
let clawAimed = false;                                          // a press aimed on touch-down: its click is not a second aim
function clawAimAt(e) {
  if (e && e.isPrimary === false) return;               // a second finger must not drag the claw away from the first touch
  /* The cabinet's bounds are read at the moment of the press, and the ONE thing that changes
     them on the spot is the result sheet: on a press its pane slides OVER the cabinet, and the
     same press's click (what a finger's compatibility click is) then landed on the cabinet that
     had just been covered — a fresh round aimed at the sheet's spot and her turn taken in it.
     The sheet is on top; nothing on this page is being touched while it is. */
  if ($('#sheet').classList.contains('on')) return;
  const run = openClawRun(); if (!run || run.status === 'TERMINATED') return;
  const b = $('#booth');
  if (!b) return;
  const r = b.getBoundingClientRect(), pad = 22;                  // keep the claw inside the cabinet
  const x = Math.max(pad, Math.min(r.width - pad, e.clientX - r.left));
  const y = Math.max(pad, Math.min(r.height - pad, e.clientY - r.top));
  run.aimX = Math.round(x / r.width * 1000); run.aimY = Math.round(y / r.height * 1000);
  let aimed = null;                                               // the toy the claw is sitting on
  /* A toy button is 44 CSS px wide: near the cabinet's edge its centre can sit outside the
     padded area, so a tap dead-centre on it would be clamped away by the pad before the snap
     below ever sees it. The finger's real position decides which toy it is on. */
  const fx = Math.round((e.clientX - r.left) / r.width * 1000), fy = Math.round((e.clientY - r.top) / r.height * 1000);
  let best = 29;
  for (const t of run.targets) if (!t.taken) { const d = Math.hypot(fx - t.x, fy - t.y); if (d < best) { best = d; aimed = t; } }   // nearest one under the finger, not the first in list order
  /* A tap ON a toy snaps the claw onto the toy's own grid point. Without this the claw keeps
     the finger's pixel position, and a round on a narrow screen is a 1000-unit grid: a thumb
     that is visually on the toy can land 40+ units away and lose a grab the player can see
     was on target. The snap is what makes "what you see" and "what is judged" agree. */
  run.aimedToy = aimed ? aimed.id : '';
  clawAimed = true;
  // a press whose click the browser never sends (a synthetic mouse without compatibility events, a
  // finger that lifts and cancels) must not make the NEXT click a second aim — drop it shortly after
  clearTimeout(clawAimedT); clawAimedT = setTimeout(() => { clawAimed = false; }, 700);
  const gb = $('#btnGrab');                                  // the button checks this class at touch-down, before the render below
  if (gb) { gb.classList.remove('disabled'); gb.removeAttribute('disabled'); }
  if (aimed) { run.aimX = aimed.x; run.aimY = aimed.y; }
  /* the marker sits where the grab is judged (the toy's own point when the finger is on one), so
     what the player sees under the claw is what the judge compares */
  const m = $('#clawMark'); if (m) { m.style.left = (run.aimX / 10) + '%'; m.style.top = (run.aimY / 10) + '%'; }
  // the toy under the finger is the one being aimed at: choosing it here means one touch does both
  // (render, not save-before-render: a single run must never be written twice with different fields)
  if (aimed && run.selected !== aimed.id) { run.selected = aimed.id; track('activity_target_picked', { run_id: run.id, toy: aimed.toy }); }
  rerender();
}
Actions['claw.pick'] = id => { const run = openClawRun(); if (!run) return; run.selected = id; track('activity_target_picked', { run_id: run.id, toy: (run.targets.find(t => t.id === id) || {}).toy }); save(); rerender(); };
function clawReact(run, res, lineEv, extra) {
  const line = PLAY.pickLine('claw', lineEv, S.character.base, run.lines, run.attempts.length);
  run.lines = run.lines.concat([line.en]).slice(-6); run.lastLine = line[lang()] || line.en;
  if (extra) Object.assign(run, extra);
  track('character_reaction_played', { type: 'claw', event: lineEv });
  if (run.status === 'TERMINATED') settleClaw(run); else save();
  rerender();
}
/* One press = one grab. The grab button is pressed on touch-down because the button sits on a
   page that re-renders itself: "click" is dispatched on the button's parent after pointer-up,
   and the grab() below replaces that button first — so the click landed on the stack wrapper
   and nothing happened, while every pointer-press did grab. The board carries data-press (the
   delegated listener below runs it on pointerdown, which never re-targets) and that listener
   prevents the compatibility click. data-act stays only so the button is findable. */
/* One press, one grab — except for her turn. A grab is on touch-down and is the round's last
   press, so a duplicate press of it would hit the NEXT round's toy under the old aim (the
   window guards that). Her turn is meant to be reachable twice: the round-facing buttons carry
   data-press and data-act at once, and the press that runs it prevents its own click (browsers
   do not send one for a prevented pointerdown, but a test driver or a stale queued click can),
   so "her grab" arrives here twice — the second call must find the round over, not be swallowed
   by a time window that then ate a real press for 250 ms. */
function grabOnce(btn, fn) { fn(); return true; }
Actions['claw.grab'] = () => {
  const run = openClawRun(); if (!run || run.status === 'TERMINATED') return;
  // a stray delayed call (a second tap landing after the round ended or moved on) must not grab
  // the NEXT round's toy under the previous round's aim
  if (!document.querySelector('#s-claw.on')) return;
  if (run.aimX == null) { toast(tt('Tap inside the cabinet first to place the claw.', '先在柜子里点一下放爪子。')); return; }
  let res;
  if (!grabOnce(null, () => { res = clawGrab(run.aimX, run.aimY, 'player', run.id); })) return;
  if (res.error) { if (res.say) toast(res.say); return; }
  /* The last grab closes the round first, then reacts: settling takes the run off the shelf at
     once, so the reaction's render paints the closed round (see doClawSwap). The result comes
     after the reaction so the closing line is in the card. Leaving the result for the next visit
     meant a finished round sat there with a dead Grab button and no way to read it. */
  if (run.attemptsLeft <= 0) settleClaw(run);
  clawReact(run, res, res.hit ? 'playerWin' : 'playerMiss', { aimedToy: run.aimedToy });   // after her turn, the aim is hers again
  if (run.attemptsLeft <= 0) clawResult(run);
  else rerender();
};
Actions['claw.swap'] = () => { doClawSwap(); };
function doClawSwap() {
  const run = openClawRun(); if (!run || run.status === 'TERMINATED') return;
  if (!document.querySelector('#s-claw.on')) return;        // same guard as the grab: a call meant for the old round must not touch a newer one
  const left = run.targets.filter(t => !t.taken);
  if (!left.length) {
    // nothing left to reach for: her turn is the round's last grab, so it simply closes the round
    settleClaw(run); clawResult(run); return;
  }
  /* She "tries this one": the toy the player picked if it is still there (their choice stays
     theirs even after a miss), else whatever is still on the shelf. She used to fly over to the
     toy under the claw and the player saw the claw jump away from where they had just put it —
     clawGrab now keeps her descent in place and only leans towards the pick. */
  const t = left.find(x => x.id === run.selected) || left[0];
  if (run.aimX == null) { run.aimX = t.x; run.aimY = t.y; }   // she aims at her choice even if the player has not placed the claw
  /* Her own grab has a fixed error model, but a player who places the claw well should see
     that rewarded: she moves the claw straight down from where it is, and only her sideways
     error can make her miss. "Let me try" then means "try from here", not "start over". */
  const plan = PLAY.charGrab(t, S.character.base, run.attempts.length + 1);
  const res = clawGrab(run.aimX + (plan.x - t.x), run.aimY, 'character', run.id);
  if (res.error) { if (res.say) toast(res.say); return; }
  /* Settle BEFORE the reaction: settling marks the run taken off the shelf at once, and the
     reaction's render must then paint the closed round. Settling after it left the round still
     RUNNING under that render, which drew a new, empty round behind the result — the round on
     screen and the round in the state stopped being the same one. */
  if (run.attemptsLeft <= 0) settleClaw(run);   // her grab was the round's last one
  clawReact(run, res, res.hit ? 'charWin' : 'charMiss', { aimX: run.aimX, aimY: run.aimY });
  if (run.attemptsLeft <= 0) clawResult(run);
  else rerender();
}
/* The page being left keeps a press's last meaning: while its own view is on screen it does what
   it always did there; after the page is gone the same press means "show this round's result"
   (it then does nothing if no round of this visit has finished — never a new round, a grab or
   a credit). */
const employerOn = () => !!document.querySelector('#s-claw.on');
Actions['claw.settle'] = () => {
  const run = openClawRun();
  if (!run) {
    // nothing open (the page was re-entered after something closed the run): open the
    // most recent round of this visit and show its result rather than leaving the page
    const last = runsOf('claw').slice(-1)[0];
    if (last && last.status === 'TERMINATED') { if (!last.settled) settleClaw(last); clawResult(last); }
    else if (employerOn()) Actions['claw.done']();
    return;
  }
  if (!$('#sheet').classList.contains('on') || !employerOn()) { settleClaw(run); clawResult(run); }   // open already on its own page = one tap opened it: never re-open (and never settle twice)
};
function clawResult(run) {
  const L = lang(), won = PLAY.toysWon(run), rec = playState().clawRecs.find(r => (r.items || []).some(i => i.runId === run.id));
  const cred = playState().credited.filter(c => c.runId === run.id).reduce((a, c) => a + c.points, 0);
  /* "first time today" has to be true of THIS day: a second round used to say it as well. The day's
     first credit is whichever of today's entries was paid earliest. */
  const todays = playState().credited.filter(c => playDayFor(c.at) === playDay()).sort((a, b) => a.at - b.at);
  const isFirstToday = todays.length > 0 && todays[0].runId === run.id;
  const creditText = cred ? '+' + cred + (isFirstToday ? tt(' relationship progress — first time you two did this today', ' 关系进度——今天你们第一次一起做这个')
    : tt(' relationship progress', ' 关系进度'))
    : run.played ? tt('No relationship change: today\'s credit is used up, or this run was already counted.', '关系进度没变：今天的额度用完了，或这一局已经算过。')
    : tt('You left before grabbing, so this round was not used and nothing was recorded.', '在抓之前离开了，这一局没用掉，也没有留记录。');
  openSheet('<h2>' + tt('Round over', '这局结束') + '</h2>' +
    '<div class="card" style="margin-top:12px">' + (won.length ? tt('Won: ', '抓到：') + won.map(t => PLAY.toyWord(t, L)).join('、') : tt('Nothing this time — the toys are where they were, see them next round.', '这次没抓到——娃娃都还在，下一局再看。')) + '</div>' +
    '<div class="card"><div>' + esc(creditText) + '</div>' + (rec ? '<div class="tiny" style="margin-top:6px">' + tt('Written into shared records.', '已写进共同记录。') + '</div>' : '') + '</div>' +
    '<div class="stack" style="margin-top:14px"><button class="btn" data-act="claw.done" data-press="claw.done">' + tt('Done', '好了') + '</button>' +
    (playsLeft() > 0 ? '<button class="btn ghost" data-act="claw.again" data-press="claw.again">' + tt('Another round', '再来一局') + tt(' · left ', ' · 还剩 ') + playsLeft() + '</button>' : '') + '</div>');
}
/* A round that is over but already read: leaving is just leaving. Starting a new round here is
   wrong — an old round can have used up the day's rounds, and a new one would appear for a
   moment and then vanish. The "Another round" button (clawResult) is the real way to replay. */
Actions['claw.done'] = () => {
  /* "This sheet is open and is ours" has to be read before closing it: after closeSheet() the
     `#s-claw.on` check was never true, so Done on the claw page only closed the sheet and never
     went back. Read first, close, then leave. */
  const showedHere = !!document.querySelector('#s-claw.on');
  closeSheet();
  if (!showedHere) return;                                       // the sheet was opened over another page: back only closes it
  /* The round this sheet belongs to is the latest one, and a round that got here is over —
     openClawRun() only returns RUNNING/READY rounds, so it found nothing and Done never left. */
  const run = runsOf('claw').slice(-1)[0];
  if (!run || (run.status === 'TERMINATED' && run.settled)) back();  // read once → go back to wherever it was opened (invitation included)
};
Actions['claw.again'] = () => { closeSheet(); startClawRun(); rerender(); };
/* Leaving the claw without grabbing does not use the round: the run is closed as "no play",
   which writes no record and pays no credit. Wrapped so the in-app back button and the
   Android back key (window.__orbitBack) both go through it. */
const BACK_RAW = back;
window.__orbitBack = function () {
  if ($('#sheet').classList.contains('on')) return BACK_RAW();    // sheet open → back only closes it (back() would leave once for both)
  const top = nav.stack[nav.stack.length - 1];
  if (top === 'claw') {
    const run = openClawRun();
    if (run && !run.played) settleClaw(run);                      // an empty round folds away without a result card
    else if (run && run.played && !run.settled) {                 // played but not yet read: show its result once
      settleClaw(run); clawResult(run);
      return 'handled';
    }
  }
  return BACK_RAW();
};

/* ---- focus ---- */
Views.focus = { render(el) {
  const run = openFocusRun();
  if (!run) {
    const m = S.focusMinutes || 25;
    el.innerHTML = topBar(tt('Focus together', '一起专注'), '') + '<div class="body">' +
      '<div class="card">' + tt('Start a timer and do your own thing. It keeps counting if you leave this page or switch apps; pausing stops the clock.', '定个时间，各忙各的。离开这个页面、甚至切到别的应用也照样计时；暂停才停。') + '</div>' +
      '<div class="sec">' + tt('How long', '多久') + '</div><div class="seg">' + PLAY.CONFIG.focus.preset.concat([60]).map(v =>
        '<button class="' + (v === m ? 'on' : '') + '" data-act="focus.minutes" data-arg="' + v + '">' + v + ' ' + tt('min', '分钟') + '</button>').join('') + '</div>' +
      '<div class="row"><div class="grow"><div class="k">' + tt('Custom minutes', '自定义分钟') + '</div><div class="v">' + tt('10 – 120', '10 – 120') + '</div></div><input class="f" id="focusMin" type="number" min="10" max="120" value="' + m + '" style="width:88px"></div>' +
      '<div class="tiny" style="margin-top:10px">' + tt('10 minutes or more writes a shared record; the first session of the day adds to the relationship.', '满 10 分钟会留下共同记录；每天第一次专注才算进关系进度。') + '</div>' +
      '<button class="btn" style="margin-top:16px" data-act="focus.start">' + tt('Start', '开始') + '</button></div>';
    return;
  }
  const sec = PLAY.focusElapsed(run, playNow()), total = run.targetMinutes * 60;
  el.innerHTML = topBar(tt('Focus together', '一起专注'), '<span class="pill">' + (run.status === 'PAUSED' ? tt('Paused', '已暂停') : tt('Running', '计时中')) + '</span>') +
    '<div class="body" style="text-align:center">' +
    '<div class="card" style="padding:30px 14px"><div id="focusClock" style="font-size:46px;font-weight:700;letter-spacing:.04em;font-variant-numeric:tabular-nums">' + fmtSec(sec) + '</div>' +
      '<div class="tiny" style="margin-top:6px">' + tt('of ', '/ ') + run.targetMinutes + tt(' min · ', ' 分钟 · 还剩 ') + fmtSec(Math.max(0, total - sec)) + '</div>' +
      '<div class="bar" style="margin:14px 0 0"><i style="width:' + Math.min(100, Math.round(sec / total * 100)) + '%"></i></div></div>' +
    '<div class="card" style="margin-top:10px">' + esc(run.lastLine || tt('I\'ll stay out of the way. You do your thing.', '我不吵你，你做你的事。')) + '</div>' +
    '<div class="stack" style="margin-top:14px">' +
      (run.status === 'PAUSED' ? '<button class="btn" data-act="focus.resume">' + tt('Resume', '继续') + '</button>' : '<button class="btn ghost" data-act="focus.pause">' + tt('Pause', '暂停') + '</button>') +
      '<button class="btn ghost" data-act="focus.end">' + tt('End early', '提前结束') + '</button></div></div>';
} };
function fmtSec(s) { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
Actions['focus.minutes'] = m => { S.focusMinutes = +m; save(); rerender(); };
Actions['focus.start'] = () => {
  const inp = $('#focusMin'); if (inp) S.focusMinutes = Math.max(10, Math.min(120, +inp.value || 25));
  const run = startFocus(S.focusMinutes || 25);
  if (run.error) { toast(tt('A focus session is already running — resume or end it first.', '已经在专注了，先继续或结束上一段。')); rerender(); return; }
  focusSay(run, 'start'); save(); rerender();
};
Actions['focus.pause'] = () => { const run = openFocusRun(); if (!run || run.status !== 'RUNNING') return; Object.assign(run, PLAY.focusPause(run, playNow()).run); track('activity_paused', { type: 'focus', run_id: run.id }); save(); rerender(); };
Actions['focus.resume'] = () => { const run = openFocusRun(); if (!run || run.status !== 'PAUSED') return; Object.assign(run, PLAY.focusResume(run, playNow()).run); track('activity_resumed', { type: 'focus', run_id: run.id }); save(); rerender(); };
Actions['focus.end'] = () => { const r = finishFocus('early'); if (!r) return back(); focusResult(r); rerender(); };
function focusResult(r) {
  openSheet('<h2>' + tt('That\'s the session', '这次到这里') + '</h2>' +
    '<div class="card" style="margin-top:12px">' + tt('Timed ', '计时 ') + fmtSec(r.seconds) + ' · ' + tt('target ', '目标 ') + r.run.targetMinutes + tt(' min', ' 分钟') + '</div>' +
    '<div class="card">' + (r.qualifies ? (r.credit.ok ? '+' + r.credit.points + tt(' relationship progress', ' 关系进度') : tt('Saved to shared records. No relationship change — today\'s credit is used up.', '已记进共同记录。关系进度没变——今天的额度用完了。'))
      : tt('Under 10 minutes, so nothing was recorded. Showing up still counts for something.', '不到 10 分钟，所以没有留记录。来了本身也算数。')) + '</div>' +
    '<div class="stack" style="margin-top:14px"><button class="btn" data-act="claw.done" data-press="claw.done">' + tt('Done', '好了') + '</button></div>');
}
/* One ticker for the whole app: the clock on screen is updated only while the focus page is
   visible, but the session itself is ended the moment it is up even if the user is elsewhere
   (its record and credit are written then — otherwise coming back later would find it gone). */
setInterval(() => {
  const onFocus = nav.stack[nav.stack.length - 1] === 'focus';
  if (!onFocus) {
    const r0 = openFocusRun();
    if (r0 && r0.status === 'RUNNING' && focusDue(r0, playNow())) { const fin = finishFocus('completed'); if (fin) { planProactive(); save(); toast(tt('Your focus session is done — see Together', '专注结束了——去「一起」看看')); } }
    return;
  }
  const r = focusTick(); if (!r) return;
  if (r.justDone) { rerender(); focusResult(r); return; }
  const clk = $('#focusClock'); if (clk) clk.textContent = fmtSec(r.sec);
}, 1000);
window.addEventListener('focus', () => { if (nav.stack[nav.stack.length - 1] === 'focus') focusTick(); });

/* ---- records ---- */
Views.records = { render(el) {
  const p = playState(), L = lang();
  const recs = p.clawRecs.concat(p.focusRecs).filter(r => r.visible).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const hidden = p.clawRecs.concat(p.focusRecs).filter(r => !r.visible).length;
  el.innerHTML = topBar(tt('Shared records', '共同记录'), hidden ? '<span class="pill">' + hidden + tt(' hidden', ' 条已隐藏') + '</span>' : '') + '<div class="body">' +
    '<div class="tiny" style="margin:0 4px 8px">' + tt('What you two actually did together, from activity results — not from chats. Hiding one keeps its rewards and progress; it is simply never brought up again.',
      '你们真的一起做过的事，来自活动结果，不是聊天内容。隐藏一条不会收回奖励和进度，只是以后不会再被提起。') + '</div>' +
    (recs.length ? recs.map(r => { const toys = r.items.reduce((a, i) => a.concat(i.won || []), []).map(t => PLAY.toyWord(t, L));
      const mins = Math.round(r.items.reduce((a, i) => a + (i.seconds || 0), 0) / 60);
      return '<div class="card"><div style="display:flex;justify-content:space-between"><b>' + (r.type === 'claw' ? '🪝 ' + tt('Claw machine', '抓娃娃') : '⏱ ' + tt('Focus', '专注')) + '</b><span class="tiny">' + esc(r.day) + '</span></div>' +
        '<div class="tiny" style="margin-top:4px">' + (r.type === 'claw' ? tt('Rounds ', '局数 ') + r.count + (toys.length ? ' · ' + tt('won ', '抓到 ') + toys.join('、') : ' · ' + tt('no wins', '没有抓到'))
          : tt('Sessions ', '次数 ') + r.count + ' · ' + mins + tt(' min', ' 分钟')) + '</div>' +
        '<button class="btn sm ghost" style="margin-top:8px" data-act="rec.hide" data-arg="' + r.id + '">' + tt('Hide', '隐藏') + '</button></div>'; }).join('')
      : '<div class="card">' + tt('Nothing yet. Play a round or focus together once.', '还没有。抓一局或一起专注一次。') + '</div>') + '</div>';
} };
Actions['rec.hide'] = id => {
  const p = playState(); p.clawRecs = PLAY.hideRecord(p.clawRecs, id); p.focusRecs = PLAY.hideRecord(p.focusRecs, id);
  track('shared_record_hidden', { record_id: id }); save(); rerender(); toast(tt('Hidden. Your progress stays.', '已隐藏。进度不受影响。'));
};
guardActions(Actions, 'play');

