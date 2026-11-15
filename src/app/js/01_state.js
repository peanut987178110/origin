/* 01_state.js · state, persistence, i18n, event tracking
   Everything lives on the device (localStorage). No account, no server.
   Writes are debounced (250 ms) so typing/streaming never blocks on storage. */
const OC = window.OrbitCore;
const PER = OC.personas, MIND = OC.mind, MEM = OC.memory, LIFE = OC.life;
const VERSION = '6.1.0';
const KEY = 'orbit.v6';
const BR = window.AndroidOrbit || null;            // device bridge (locale, tz, notifications)
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rid = p => (p || '') + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
let S = null;
const now = () => Date.now() + (S ? S.clockOffset || 0 : 0);
const lang = () => (S && S.settings.lang) || 'en';
const tt = (en, zh) => (lang() === 'zh' ? zh : en);

function deviceLang() { try { const l = BR ? BR.lang() : navigator.language; return /^zh/i.test(l) ? 'zh' : 'en'; } catch (e) { return 'en'; } }
function deviceCountry() { try { return (BR ? BR.country() : (navigator.language.split('-')[1] || 'US')).toUpperCase(); } catch (e) { return 'US'; } }
function deviceTz() { try { return BR ? BR.timezone() : Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return 'UTC'; } }

function defaults() {
  return {
    v: 1,
    user: { id: rid('u'), createdAt: Date.now(), ageBand: null, country: deviceCountry(), timezone: deviceTz(), onboarded: false, name: '' },
    settings: { lang: deviceLang(), notifications: false, quiet: { start: 22, end: 8 }, proactiveHour: 19, mutedTypes: [],
      autoMemory: true, blockedKinds: ['health', 'finance', 'identity', 'intimate'], blockedWords: [], voiceReply: true },
    character: null,
    rel: { effectiveCount: 0, confirmedCount: 0, positiveFeedback: 0, days: [] },
    msgs: [], convs: [], memories: [], declined: [], pending: null,
    inbox: [], proactive: { sent: [], ignoreStreak: 0, clickStreak: 0 },
    plan: { tier: 'free', trialUntil: 0 }, quota: { day: '', used: 0 },
    exp: { overrides: {} }, avoid: [], clockOffset: 0, engineStats: [], events: [], perf: [],
    // v6.1 · activities you do together (rules in shared/orbit_play.js)
    play: { claw: { plays: {}, runs: {} }, focus: { runs: {} }, clawRecs: [], focusRecs: [],
      invites: [], credited: [], closedByType: {}, pausedUntil: 0 },
    focusMinutes: 25
  };
}
function load() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { saved = null; }
  const d = defaults();
  if (!saved) return d;
  for (const k of Object.keys(d)) if (saved[k] === undefined) saved[k] = d[k];
  saved.settings = Object.assign(d.settings, saved.settings);
  // a v6.0 session saved before the activity screens existed carries no play state at all
  if (saved.play && !saved.play.__fixed) saved.play = d.play;
  return saved;
}
let saveTimer = 0;
/* v6.2: a save on the last screen of an activity carried REAL state (claw attempts, sent
   invitations) built by shared/orbit_play.js — and closed it out with "{}.constructor",
   which is Object, which threw and lost the whole write. The boot re-read the older copy.
   Two guards: only plain records/arrays are written (anything else is dropped, not thrown),
   and a failed write is retried on the next save instead of being swallowed. */
function plain(o, depth) {
  if (o === null || typeof o !== 'object') return o;
  if (depth > 12) return undefined;
  if (Array.isArray(o)) return o.map(x => plain(x, depth + 1));
  let proto; try { proto = Object.getPrototypeOf(o); } catch (e) { return undefined; }
  if (proto !== Object.prototype && proto !== null) return undefined;
  const out = {};
  for (const k of Object.keys(o)) { const v = plain(o[k], depth + 1); if (v !== undefined) out[k] = v; }
  return out;
}
let lastSaveOk = true;
function save(now_) {
  clearTimeout(saveTimer);
  const doSave = () => {
    try {
      if (S.msgs.length > 400) S.msgs = S.msgs.slice(-400);
      if (S.events.length > 3000) S.events = S.events.slice(-3000);
      if (S.perf.length > 200) S.perf = S.perf.slice(-200);
      localStorage.setItem(KEY, JSON.stringify(plain(S, 0)));
      lastSaveOk = true;
    } catch (e) { lastSaveOk = false; saveTimer = setTimeout(doSave, 2000); }   // storage full / quota: retry, never lose silently
  };
  if (now_) doSave(); else saveTimer = setTimeout(doSave, 250);
}
document.addEventListener('visibilitychange', () => { if (document.hidden) save(true); });
window.addEventListener('pagehide', () => { if (!lastSaveOk) save(true); });

/* Activity events that count as "this person actually uses Orbit" — the play invitation waits for a few. */
const PLAY_USER_ACTS = new Set(['first_message_sent', 'activity_completed', 'shared_record_created', 'character_reaction_played']);

/* ---- experiments + tracking (PRD §9.3: every event carries experiment_id / variant_id) ---- */
let VAR = {};
function refreshVariants() { VAR = LIFE.assign(S.user.id, S.exp.overrides); }
function track(name, props) {
  S.events.push({ name, ts: now(), props: props || {}, exp: Object.entries(VAR).map(([experiment_id, variant_id]) => ({ experiment_id, variant_id })) });
  save();
}

/* ---- plan & limits (PRD §7.9) ---- */
const LIMITS = { free: { daily: 40, memories: 20 }, premium: { daily: 300, memories: 200 } };
const isPremium = () => S.plan.tier === 'premium' || (S.plan.trialUntil && now() < S.plan.trialUntil);
const limits = () => LIMITS[isPremium() ? 'premium' : 'free'];
const todayKey = () => LIFE.dayKey(now());
function quotaLeft() { if (S.quota.day !== todayKey()) S.quota = { day: todayKey(), used: 0 }; return limits().daily - S.quota.used; }

/* ---- character helpers ---- */
const persona = () => PER.PERSONAS[(S.character && S.character.base) || 'luna'];
const tonePersona = () => PER.PERSONAS[(PER.TONES[S.character && S.character.tone] || {}).from || persona().id];
function makeCharacter(pid, over) {
  const p = PER.PERSONAS[pid] || PER.PERSONAS.luna;
  return Object.assign({ id: rid('c'), base: p.id, name: p.name[lang()], emoji: p.emoji, color: p.color, color2: p.color2,
    createdAt: now(), topics: p.topics.slice(), blocked: [] }, p.defaults, over || {});
}
function orb(c, cls) {
  const ch = c || S.character || { emoji: '🪐', color: '#a78bfa', color2: '#60a5fa' };
  return '<div class="orb ' + (cls || '') + '" style="--c1:' + ch.color + ';--c2:' + ch.color2 + '">' + esc(ch.emoji) + '</div>';
}
function lifeLine() {
  const p = persona(), h = new Date(now()).getHours(), L = lang();
  const list = (h >= 23 || h < 5) ? p.late[L] : p.life[L];
  const d = new Date(now()); const k = (d.getFullYear() * 400 + d.getMonth() * 31 + d.getDate() + p.id.length) % list.length;
  return list[k];
}
function relStats() {
  const days = new Set(S.rel.days);
  return { effectiveCount: S.rel.effectiveCount, confirmedCount: S.memories.filter(m => m.status === 'active' && m.confirmed).length,
    activeDays: days.size, positiveFeedback: S.rel.positiveFeedback };
}
const stage = () => LIFE.stageOf(relStats());
function fmtTime(ts) { const d = new Date(ts); return d.toLocaleTimeString(lang() === 'zh' ? 'zh-CN' : 'en-US', { hour: 'numeric', minute: '2-digit' }); }
function fmtDay(ts) { const d = new Date(ts); return d.toLocaleDateString(lang() === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', weekday: 'short' }); }
const pct = x => (x == null ? '—' : Math.round(x * 100) + '%');
