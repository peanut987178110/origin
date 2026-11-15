#!/usr/bin/env node
/* =========================================================================
   orbit_play_test.js · unit tests for shared/orbit_play.js (no browser needed)
   -------------------------------------------------------------------------
   Every rule the activity screens rely on is checked here with plain numbers:
     · claw judgement at the boundary (d = 40 wins, d = 41 does not), idempotent attempts
     · day key with a 04:00 local boundary and the 1-per-day / 3-per-168 h invitation caps
     · quiet hours, repeated closes → 7-day pause
     · focus timer: pause/resume accumulation, 599 s vs 600 s threshold, milestones
     · records merge per (character, day, type); a hidden record can never be cited
     · relation credit: once per run, 30 points/day cap
   Usage: node tools/orbit_play_test.js
   ========================================================================= */
'use strict';
const path = require('path');
const P = require(path.resolve(__dirname, '..', 'shared', 'orbit_play.js'));

let pass = 0, fail = 0; const bad = [];
const ok = (c, n, d) => { if (c) { pass++; } else { fail++; bad.push(n + (d === undefined ? '' : ' :: ' + d)); } };
const eq = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), n, 'got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b));

/* build a local wall-clock time so the 04:00 boundary is the same on any machine */
const at = (y, m, d, h, mi) => new Date(y, m - 1, d, h, mi || 0, 0).getTime();

/* ---------------- claw judgement ---------------- */
const T = { id: 'a', x: 500, y: 500 };
ok(P.judge({ x: 500, y: 500 }, T), 'exact hit');
ok(P.judge({ x: 540, y: 500 }, T), 'd = 40 wins (boundary counts)');
ok(!P.judge({ x: 541, y: 500 }, T), 'd = 41 misses');
ok(P.judge({ x: 524, y: 532 }, T), '3-4-5 triangle: d = 40 wins');
ok(!P.judge({ x: 525, y: 532 }, T), 'd ≈ 40.6 misses');
eq(P.judge({ x: 500.6, y: 500 }, T), true, 'coordinates are rounded before judging (0.6 → same point)');

/* deterministic shelf: same run id → same targets */
eq(P.makeTargets('run-1'), P.makeTargets('run-1'), 'same run id → same shelf');
ok(JSON.stringify(P.makeTargets('run-1')) !== JSON.stringify(P.makeTargets('run-2')), 'different run → different shelf');
ok(P.makeTargets('r').every(t => t.x >= 120 && t.x <= 880 && t.y >= 140 && t.y <= 760), 'targets stay inside the cabinet (120–880, 140–760)');

/* the character's grab: fixed 70/30 error model, same for every companion */
const hitRate = id => { let h = 0; for (let i = 0; i < 400; i++) { const g = P.charGrab(T, id, i); const d = Math.hypot(g.x - T.x, g.y - T.y); if (d <= 40) h++; } return h / 400; };
ok(Math.abs(hitRate('luna') - 0.7) < 0.08, 'character grab ≈ 70% hits after her first try', hitRate('luna'));
{ const firstTry = P.CONFIG.claw.grabsPerRound - 1; let miss = 0; for (let k = 0; k < 200; k++) { const g = P.charGrab(T, ['luna', 'nova', 'atlas', 'miko'][k % 4], firstTry); if (Math.hypot(g.x - T.x, g.y - T.y) > P.CONFIG.claw.radius) miss++; }
  eq(miss, 0, 'her first grab of a round always lands (nobody starts with "she missed twice")'); }
eq(P.charGrab(T, 'luna', 1), P.charGrab(T, 'luna', 1), 'character grab is reproducible for the same attempt');
/* her landings agree with judge(): her sure grab is inside the radius, an "off" landing never is */
{ const R = P.CONFIG.claw.radius, sure = P.CONFIG.claw.grabsPerRound - 1; let n = 0, badSure = 0, nOff = 0, badOff = 0;
  for (const pid of ['luna', 'nova', 'atlas', 'miko']) for (let x = 130; x <= 870; x += 37) for (let y = 150; y <= 750; y += 53) {
    const tg = { x, y };
    for (const a of [0, 1, 2, 3]) { const g = P.charGrab(tg, pid, a), land = P.judge(g, tg);
      if (a === sure) { n++; if (!land) badSure++; } else if (!g.hit) { nOff++; if (land) badOff++; } }   // an "off" draw must never be judged a win
  }
  eq(badSure, 0, 'every sure grab of hers is judged a hit (' + n + ' targets)');
  eq(badOff, 0, 'a landing she missed is never judged a win (' + nOff + ' targets)'); }

/* a whole run: 3 grabs, the round terminates, a 4th attempt is refused */
let run = { status: 'RUNNING', attempts: [], attemptsLeft: 3, targets: [{ id: 'a', toy: 'cat', x: 500, y: 500, taken: false }, { id: 'b', toy: 'fox', x: 800, y: 200, taken: false }] };
let r = P.attempt(run, { targetId: 'a', claw: { x: 500, y: 500 }, at: 1 });
eq(r.hit, true, 'first grab on the toy wins');
eq(r.run.attemptsLeft, 2, 'two grabs left');
eq(P.toysWon(r.run), ['cat'], 'won toy recorded');
run = r.run;
r = P.attempt(run, { targetId: 'a', claw: { x: 500, y: 500 }, at: 2 });
eq(r.targetId, 'b', 'a taken toy is skipped; the nearest remaining target is used');
eq(r.hit, false, 'claw at the old spot misses the next toy');
run = r.run;
r = P.attempt(run, { targetId: 'b', claw: { x: 800, y: 200 }, at: 3 });
eq(r.run.status, 'TERMINATED', 'third grab ends the round');
eq(P.attempt(r.run, { targetId: 'b', claw: { x: 0, y: 0 }, at: 4 }).error, 'not_running', 'no grabs after the round ended');
eq(P.attempt({ status: 'RUNNING', attempts: [{ no: 1 }], targets: [] }, { claw: { x: 1, y: 1 } }).error, 'no_targets', 'empty shelf is refused, not crashed');

/* ---------------- day key: local 04:00 boundary ---------------- */
eq(P.dayKey(at(2026, 11, 12, 3, 59)), '2026-11-11', '03:59 belongs to the previous day');
eq(P.dayKey(at(2026, 11, 12, 4, 1)), '2026-11-12', '04:01 belongs to this day');
eq(P.dayKey(at(2026, 11, 11, 23, 30)), '2026-11-11', '23:30 is still the same day');
eq(P.dayKey(at(2027, 1, 1, 2, 0)), '2026-12-31', 'across new year: 02:00 on 1 Jan is 31 Dec');

/* quiet hours */
ok(P.inQuiet(at(2026, 11, 12, 23, 0), { start: 22, end: 8 }), '23:00 is quiet');
ok(!P.inQuiet(at(2026, 11, 12, 12, 0), { start: 22, end: 8 }), '12:00 is not quiet');
ok(P.inQuiet(at(2026, 11, 12, 7, 59), { start: 22, end: 8 }), '07:59 is quiet');
ok(!P.inQuiet(at(2026, 11, 12, 9, 0), { start: 22, end: 8 }), '09:00 is not quiet');

/* ---------------- invitations ---------------- */
const quietOff = { start: 0, end: 0 };
const IS = ms => ({ invites: [], quiet: quietOff, play: { clawRecs: [{ id: 'r1', visible: true, items: [] }] } });   // an account with some history
ok(!P.canInvite({ invites: [], quiet: quietOff, play: {} }, at(2026, 11, 12, 15, 0)).ok, 'a brand-new account is never invited (nothing has happened yet)');
eq(P.canInvite({ invites: [], quiet: quietOff, play: { clawRecs: [], focusRecs: [] } }, at(2026, 11, 12, 15, 0)).reason, 'no_history', 'empty cupboards → no_history');
let st = IS();
ok(P.canInvite(st, at(2026, 11, 12, 15, 0)).ok, 'first invitation of the day is allowed');
st = IS(); st.invites.push({ sentAt: at(2026, 11, 12, 3, 30) });           // 03:30 is the previous day
ok(P.canInvite(st, at(2026, 11, 12, 15, 0)).ok, 'an invitation sent at 03:30 does not use up the new day');
st.invites.push({ sentAt: at(2026, 11, 12, 9, 0) });
eq(P.canInvite(st, at(2026, 11, 12, 15, 0)).reason, 'daily_cap', 'second invitation the same day is refused');
st = IS(); st.invites.push({ sentAt: at(2026, 11, 11, 12, 0) }); for (let i = 0; i < 2; i++) st.invites.push({ sentAt: at(2026, 11, 12 - i, 0, 10) });
eq(P.canInvite(st, at(2026, 11, 12, 15, 0)).reason, 'rolling_cap', '3 in 168 h → refused even on a new day');
st = IS(); st.quiet = { start: 22, end: 8 };
eq(P.canInvite(st, at(2026, 11, 12, 23, 0)).reason, 'quiet_hours', 'no invitation during quiet hours');
st = IS(); st.play = { pausedUntil: at(2026, 11, 13, 0, 0) };
eq(P.canInvite(st, at(2026, 11, 12, 15, 0)).reason, 'paused', '7-day pause honoured');
st = IS(); st.play = { closedByType: { claw: 3 } };
ok(/closed_repeatedly/.test(P.canInvite(st, at(2026, 11, 12, 0, 0) + 9 * 3600000).reason), 'closed 3 times → suppressed');
st = IS(); st.invites.push({ sentAt: at(2026, 11, 12, 9, 0), isSystem: true });
ok(P.canInvite(st, at(2026, 11, 12, 15, 0)).ok, 'system notices do not count toward the cap');

/* ranking and text */
const ranked = P.rank([{ kind: 'general', type: 'claw' }, { kind: 'retry', type: 'claw', target: 'cat' }, { kind: 'resume', type: 'claw' }]);
eq(ranked.map(c => c.kind), ['resume', 'retry', 'general'], 'rank: resume > retry > general');
const inv = P.buildInvite({ at: at(2026, 11, 12, 15, 0), characterId: 'c', type: 'claw', kind: 'retry', target: 'cat' });
ok(/cat/.test(P.inviteText(inv, 'en')) && /小猫/.test(P.inviteText(inv, 'zh')), 'retry invitation names the actual toy');
ok(P.inviteText(P.buildInvite({ at: 0, type: 'focus', kind: 'general', minutes: 25 }), 'en').includes('25'), 'focus invitation names its minutes');
ok(P.inviteText(P.buildInvite({ at: 0, type: 'claw', kind: 'retry', target: 'dragon' }), 'en').length > 0, 'unknown toy still yields a sentence');

/* ---------------- focus ---------------- */
const t0 = at(2026, 11, 12, 10, 0);
let f = { status: 'RUNNING', accumulatedSec: 0, runningSince: t0 };
eq(P.focusElapsed(f, t0 + 300000), 300, '5 minutes after start');
let pf = P.focusPause(f, t0 + 300000).run;
eq(pf.accumulatedSec, 300, 'pause freezes the count');
eq(P.focusElapsed(pf, t0 + 900000), 300, 'time passes while paused without counting');
let rf = P.focusResume(pf, t0 + 900000).run;
eq(P.focusElapsed(rf, t0 + 990000), 390, 'resume continues from the frozen value');
eq(P.focusFinish({ status: 'RUNNING', accumulatedSec: 0, runningSince: t0 }, t0 + 599000).qualifies, false, '599 s does not qualify');
eq(P.focusFinish({ status: 'RUNNING', accumulatedSec: 0, runningSince: t0 }, t0 + 600000).qualifies, true, '600 s qualifies');
eq(P.focusFinish(rf, t0 + 990000, 'early').run.endReason, 'early', 'end reason kept');
eq(P.focusFinish(P.focusFinish(rf, t0 + 990000).run, t0 + 1000000).error, 'not_running', 'cannot finish a finished run');
eq(P.focusMilestone(300), 'halfway', 'halfway milestone');
eq(P.focusMilestone(600), 'done', 'done milestone');
eq(P.focusMilestone(1800), 'long', 'long milestone');

/* ---------------- records ---------------- */
let recs = [];
let add = P.addRecord(recs, { characterId: 'c', type: 'claw', at: at(2026, 11, 12, 10, 0), item: { runId: 'r1', wanted: 'cat', got: false } });
eq(add.merged, false, 'first round opens a record');
recs = add.records;
add = P.addRecord(recs, { characterId: 'c', type: 'claw', at: at(2026, 11, 12, 20, 0), item: { runId: 'r2', wanted: 'fox', got: true } });
eq(add.merged, true, 'same character + day + type → merged');
eq(add.record.count, 2, 'merged record counts both rounds');
recs = add.records;
eq(P.addRecord(recs, { characterId: 'c', type: 'claw', at: at(2026, 11, 13, 10, 0), item: {} }).merged, false, 'next day opens a new record');
eq(P.addRecord(recs, { characterId: 'd', type: 'claw', at: at(2026, 11, 12, 10, 0), item: {} }).merged, false, 'another companion is a separate record');
eq(P.addRecord(recs, { characterId: 'c', type: 'focus', at: at(2026, 11, 12, 10, 0), item: {} }).merged, false, 'focus is a separate record type');
recs = P.addRecord(recs, { characterId: 'c', type: 'focus', at: at(2026, 11, 12, 11, 0), item: {} }).records;
eq(P.citableTargets(recs, 'c'), ['cat'], 'only a wanted-but-missed toy is citable');
recs = P.hideRecord(recs, add.record.id === undefined ? recs[0].id : recs[0].id);
eq(P.citableTargets(recs, 'c'), [], 'a hidden record is never cited');
eq(P.visibleRecords(recs).length, 1, 'the hidden record drops out of the list');
eq(P.addRecord(recs, { characterId: 'c', type: 'claw', at: at(2026, 11, 12, 21, 0), item: { runId: 'r3' } }).merged, false, 'after hiding, a new round opens a new segment');

/* ---------------- relationship credit ---------------- */
let cs = { credited: [] };
ok(P.canCredit(cs, 'run1', t0).ok, 'first run of the day is credited');
cs.credited.push({ runId: 'run1', points: 20, at: t0 });
eq(P.canCredit(cs, 'run1', t0).reason, 'already_credited', 'the same run is never paid twice');
cs.credited.push({ runId: 'run2', points: 10, at: t0 + 1000 });
eq(P.canCredit(cs, 'run3', t0 + 2000, 10).reason, 'daily_cap', '20 + 10 = 30/day cap reached');
eq(P.canCredit(cs, 'run4', t0 + P.DAY, 20).ok, true, 'cap resets the next day');
/* the cap looks at what the run would earn, not only at the total already paid: on 2026-11-14 the
   second claw round of a day was paid another 20 on top of the first, taking the day to 40 */
eq(P.canCredit({ credited: [{ runId: 'a', points: 20, at: t0 }] }, 'b', t0 + 5000, 20).reason, 'daily_cap', 'a second claw round the same day would pass 30 and is refused');
eq(P.canCredit({ credited: [{ runId: 'a', points: 20, at: t0 }] }, 'b', t0 + 5000, 10).ok, true, '20 + 10 still fits exactly');
eq(P.canCredit({ credited: [{ runId: 'a', points: 30, at: t0 }] }, 'b', t0 + 5000, 10).reason, 'daily_cap', 'nothing is paid past the cap');
eq(P.creditFor('claw'), 20, 'claw pays 20');
eq(P.creditFor('focus'), 10, 'focus pays 10');

/* ---------------- lines ---------------- */
// "never repeat one of the last three" — checked against what the caller kept, as the screens do
for (const ev of ['playerWin', 'playerMiss', 'charWin', 'charMiss', 'start', 'swap', 'end']) {
  let lines = [], viol = 0;
  for (let i = 0; i < 12; i++) { const l = P.pickLine('claw', ev, 'luna', lines, i); if (lines.slice(-3).includes(l.en)) viol++; lines = lines.concat([l.en]).slice(-6); }
  ok(viol === 0, 'claw/' + ev + ': 12 reactions with no repeat inside the last three', viol);
}
let fl = [], fviol = 0;
for (let i = 0; i < 9; i++) { const l = P.pickLine('focus', 'halfway', 'atlas', fl, i); if (fl.slice(-3).includes(l.en)) fviol++; fl = fl.concat([l.en]).slice(-6); }
ok(fviol === 0, 'focus/halfway: no repeats', fviol);
ok(P.pickLine('claw', 'nope', 'luna', [], 0).en.length > 0, 'unknown event still yields a fallback line');
ok(P.pickLine('focus', 'done', 'luna', [], 0).zh.length > 0, 'lines are bilingual');
ok(P.toyWord('cat', 'zh') === '小猫' && P.toyWord('cat', 'en') === 'cat', 'toy names in both languages');

console.log('\norbit_play_test: ' + pass + ' passed, ' + fail + ' failed');
if (fail) { bad.forEach(b => console.log('  ❌ ' + b)); process.exit(1); }
