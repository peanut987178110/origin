/* =========================================================================
   orbit_life.js · proactive messages, relationship stage, metrics, experiments
   (PRD §7.6, §7.8, §9, §10)
   ========================================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.OrbitCore = root.OrbitCore || {}).life = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DAY = 86400000;
  const dayKey = t => { const d = new Date(t); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };

  /* ---------------- proactive (PRD §7.6) ----------------
     "The test is not whether we CAN send, but whether this message is worth interrupting for."
     All six preconditions must hold; every message can be declined without guilt. */
  const PER_DAY = { low: 1, medium: 1, high: 2 };
  function inQuiet(hour, quiet) {
    const s = quiet ? quiet.start : 22, e = quiet ? quiet.end : 8;
    return s > e ? (hour >= s || hour < e) : (hour >= s && hour < e);
  }
  /* Next allowed send time at or after "t" (default evening slot 19:00, outside quiet hours). */
  function nextSlot(t, settings) {
    const d = new Date(t);
    const pref = settings.proactiveHour == null ? 19 : settings.proactiveHour;
    const slot = new Date(d.getFullYear(), d.getMonth(), d.getDate(), pref, 0, 0).getTime();
    let at = slot >= t ? slot : slot + DAY;
    if (inQuiet(new Date(at).getHours(), settings.quiet)) at += DAY;
    return at;
  }
  function textFor(type, ctx) {
    const L = ctx.lang === 'zh' ? 'zh' : 'en';
    const n = ctx.name;
    if (type === 'event') return L === 'zh'
      ? '你之前提到「' + ctx.memory.content + '」。如果你愿意，可以告诉我结果；不想聊也完全没关系。'
      : 'You mentioned your ' + ctx.memory.content.replace(/ on .*$/, '').toLowerCase().replace(/^(a|an|the|my) /, '') + '. If you feel like it, tell me how it went — and if not, that\'s completely okay.';
    if (type === 'interest') return L === 'zh'
      ? '想到你说过' + ctx.memory.content + '，今天碰到一个相关的小话题。有空想聊聊吗？不想也没事。'
      : 'You told me you ' + ctx.memory.content.replace(/^Likes /, 'like ') + ' — I had a small thought about that. Want to chat later? No pressure.';
    if (type === 'resume') return L === 'zh'
      ? '上次我们聊到一半。想接着说的时候，我在这儿。'
      : 'We left off mid-conversation last time. Whenever you want to pick it up, I\'m here.';
    if (type === 'light') return L === 'zh'
      ? n + '：来个 30 秒小问题？今天让你笑了一下的事是什么。'
      : n + ' here — 30-second question? What made you smile today, even a little?';
    return '';
  }
  /* Plan at most ONE next proactive message. Returns null when any precondition fails,
     with the reason — the dashboard shows why nothing was sent (PRD §15: 主动消息打扰用户). */
  function plan(state, nowMs) {
    const s = state.settings, c = state.character;
    if (!s.notifications) return { msg: null, reason: 'notifications_off' };
    const level = c.activity || 'low';
    let cap = PER_DAY[level] || 1;
    const p = state.proactive;
    if (p.ignoreStreak >= 3) cap = Math.min(cap, 0.5);           // 3 unopened → every other day
    if (p.clickStreak >= 2 && level === 'high') cap = 2;
    const sentToday = (p.sent || []).filter(x => dayKey(x.at) === dayKey(nowMs)).length;
    const lastAt = (p.sent || []).reduce((a, x) => Math.max(a, x.at), 0);
    if (cap < 1 && nowMs - lastAt < 2 * DAY) return { msg: null, reason: 'downgraded_after_ignores' };
    if (sentToday >= Math.max(1, cap)) return { msg: null, reason: 'daily_cap' };
    const muted = s.mutedTypes || [];
    const mems = (state.memories || []).filter(m => m.status === 'active');
    const done = new Set((p.sent || []).map(x => x.memoryId).filter(Boolean));
    const ctx = { lang: s.lang, name: c.name };
    const cands = [];
    // 1) event follow-up: the day after (or evening of) a dated event the user confirmed
    for (const m of mems) {
      if (m.type !== 'event' || !m.due || done.has(m.id) || !m.confirmed) continue;
      const dueMs = new Date(m.due + 'T12:00:00').getTime();
      if (nowMs >= dueMs - DAY / 2 && nowMs <= (m.expiresAt || dueMs + 3 * DAY)) cands.push({ type: 'event', memory: m, prio: 3 });
    }
    // 2) interest continuation (medium/high only), at most every 4 days
    if (level !== 'low') {
      const lastInterest = (p.sent || []).filter(x => x.type === 'interest').reduce((a, x) => Math.max(a, x.at), 0);
      const pref = mems.find(m => m.type === 'preference' && m.confirmed && !done.has(m.id));
      if (pref && nowMs - lastInterest > 4 * DAY) cands.push({ type: 'interest', memory: pref, prio: 2 });
    }
    // 3) resume a conversation that stopped mid-way (only after a real gap)
    const lastConv = state.lastConversation;
    if (lastConv && !lastConv.ended && nowMs - lastConv.lastAt > 6 * 3600000 && nowMs - lastConv.lastAt < 3 * DAY) cands.push({ type: 'resume', prio: 1 });
    // 4) light interaction (high activity only)
    if (level === 'high') cands.push({ type: 'light', prio: 0 });
    const pick = cands.filter(x => !muted.includes(x.type)).sort((a, b) => b.prio - a.prio)[0];
    if (!pick) return { msg: null, reason: cands.length ? 'type_muted' : 'nothing_worth_sending' };
    const at = nextSlot(nowMs, s);
    const body = textFor(pick.type, Object.assign({ memory: pick.memory }, ctx));
    return { msg: { id: 'p' + nowMs.toString(36), type: pick.type, memoryId: pick.memory ? pick.memory.id : null, title: c.name, body, plannedAt: at, status: 'planned' } };
  }
  function recordOutcome(p, opened) {
    if (opened) { p.clickStreak = (p.clickStreak || 0) + 1; p.ignoreStreak = 0; }
    else { p.ignoreStreak = (p.ignoreStreak || 0) + 1; p.clickStreak = 0; }
  }

  /* ---------------- relationship stage (PRD §7.8) ----------------
     Never tied to payment, never decays for absence, can be reset. */
  const STAGES = ['new', 'familiar', 'trust', 'steady'];
  const STAGE_NAME = {
    new: { en: 'Just met', zh: '初识' }, familiar: { en: 'Getting familiar', zh: '熟悉' },
    trust: { en: 'Trust', zh: '信任' }, steady: { en: 'Steady companion', zh: '稳定陪伴' }
  };
  function stageOf(st) {
    const eff = st.effectiveCount || 0, mem = st.confirmedCount || 0, days = st.activeDays || 0, pos = st.positiveFeedback || 0;
    if (eff >= 8 && days >= 5 && mem >= 3) return 'steady';
    if (eff >= 4 && mem >= 2 && (pos >= 1 || days >= 3)) return 'trust';
    if (eff >= 1 || days >= 2) return 'familiar';
    return 'new';
  }
  function stageProgress(st) {
    const s = stageOf(st);
    const next = { new: 'familiar', familiar: 'trust', trust: 'steady', steady: null }[s];
    const hints = {
      familiar: { en: 'Have one full conversation', zh: '完成一次完整的对话' },
      trust: { en: 'A few more real chats and saved memories', zh: '再多聊几次，留下几条记忆' },
      steady: { en: 'Keep coming back on different days', zh: '在不同的日子里常来聊聊' }
    };
    return { stage: s, next, hint: next ? hints[next] : null };
  }

  /* ---------------- effective companion interaction (PRD §2.4) ---------------- */
  function isEffective(conv) {
    return conv.messageCount >= 5 && conv.userCount >= 2 && !conv.quickExit && !conv.negative && conv.rating !== 'bad';
  }

  /* ---------------- experiments (PRD §10) ----------------
     Deterministic hash assignment; every tracked event carries experiment_id/variant_id pairs.
     One primary variable per experiment; success metric + stop condition are written next to it. */
  const EXPERIMENTS = {
    onboarding_order_v1: { variants: ['A_character_first', 'B_intro_first'], metric: 'first_message_rate, first_conv_completion, D1', stop: '2 weeks or n≥1,000 per arm' },
    memory_confirm_v1: { variants: ['A_confirm_all', 'B_auto_low'], metric: 'memory_confirm_rate, memory_delete_rate, negative_feedback', stop: 'delete rate +5pt in B → stop' },
    proactive_timing_v1: { variants: ['A_fixed_time', 'B_event_timezone'], metric: 'proactive_ctr, return_rate, notification_off_rate, D7', stop: 'notif-off rate +3pt → stop' },
    paywall_timing_v1: { variants: ['A_quota', 'B_stable'], metric: 'conversion, D7, refund_rate, satisfaction', stop: 'D7 −2pt in either arm → stop' }
  };
  function hash(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; }
  function assign(userId, overrides) {
    const out = {};
    for (const [id, e] of Object.entries(EXPERIMENTS)) out[id] = (overrides && overrides[id]) || e.variants[hash(userId + '|' + id) % e.variants.length];
    return out;
  }

  /* ---------------- metrics (PRD §9.1 口径) ----------------
     computeMetrics() works on ANY list of users' events — the real local log of this device,
     or the synthetic demo cohort below. Same code, same definitions. */
  function computeMetrics(users) {
    const n = users.length;
    const c = { users: n, activated: 0, firstMsg: 0, firstConvDone: 0, d1e: 0, d1: 0, d7e: 0, d7: 0, effUsers: 0,
      pSent: 0, pClick: 0, memCand: 0, memConf: 0, memDel: 0, fbAll: 0, fbHelp: 0, payView: 0, payBuy: 0, northStar: 0 };
    for (const u of users) {
      const ev = u.events, has = k => ev.some(e => e.name === k);
      const t0 = (ev.find(e => e.name === 'app_open') || ev[0] || { ts: 0 }).ts;
      const asOf = u.asOf || ev.reduce((a, e) => Math.max(a, e.ts), t0);
      const msgDays = new Set(ev.filter(e => e.name === 'message_sent').map(e => Math.floor((e.ts - t0) / DAY)));
      if (has('first_message_sent')) c.firstMsg++;
      if (has('character_selected') && has('first_message_sent')) c.activated++;
      const convs = ev.filter(e => e.name === 'conversation_completed');
      if (convs.length && convs[0].props && convs[0].props.messageCount >= 5) c.firstConvDone++;
      if (asOf - t0 >= DAY) { c.d1e++; if (msgDays.has(1)) c.d1++; }
      if (asOf - t0 >= 7 * DAY) { c.d7e++; if (msgDays.has(7)) c.d7++; }
      const eff = convs.filter(e => e.props && e.props.effective);
      if (eff.length) c.effUsers++;
      // North star: in the user's latest full week, ≥3 effective interactions
      const wk = new Map(); eff.forEach(e => { const w = Math.floor((e.ts - t0) / (7 * DAY)); wk.set(w, (wk.get(w) || 0) + 1); });
      if ([...wk.values()].some(v => v >= 3)) c.northStar++;
      const cnt = k => ev.filter(e => e.name === k).length;
      c.pSent += cnt('proactive_message_sent'); c.pClick += cnt('proactive_message_clicked');
      c.memCand += cnt('memory_candidate_created'); c.memConf += cnt('memory_confirmed'); c.memDel += cnt('memory_deleted');
      const fb = ev.filter(e => e.name === 'feedback_submitted' && e.props && e.props.scope === 'reply');
      c.fbAll += fb.length; c.fbHelp += fb.filter(e => e.props.value === 'helpful').length;
      if (has('paywall_viewed')) c.payView++;
      if (has('paywall_viewed') && (has('subscription_started') || has('trial_started'))) c.payBuy++;
    }
    const r = (a, b) => (b ? a / b : null);
    return {
      counts: c,
      rates: {
        install_to_first_message: r(c.firstMsg, n),
        first_conversation_completion: r(c.firstConvDone, c.firstMsg),
        d1: r(c.d1, c.d1e), d7: r(c.d7, c.d7e),
        effective_share: r(c.effUsers, c.activated),
        proactive_ctr: r(c.pClick, c.pSent),
        memory_confirm_rate: r(c.memConf, c.memCand),
        helpful_rate: r(c.fbHelp, c.fbAll),
        paywall_conversion: r(c.payBuy, c.payView)
      }
    };
  }
  /* PRD §9.2 validation targets (not promises). */
  const TARGETS = { install_to_first_message: 0.70, first_conversation_completion: 0.60, d1: 0.35, d7: 0.15, effective_share: 0.40,
    proactive_ctr: 0.15, memory_confirm_rate: 0.50, helpful_rate: 0.60, paywall_conversion: 0.05 };

  /* Two-proportion z-test for the dashboard's A/B card. */
  function zTest(x1, n1, x2, n2) {
    if (!n1 || !n2) return { z: 0, p: 1 };
    const p1 = x1 / n1, p2 = x2 / n2, p = (x1 + x2) / (n1 + n2);
    const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
    const z = se ? (p2 - p1) / se : 0;
    const pv = 2 * (1 - normCdf(Math.abs(z)));
    return { z, p: pv, diff: p2 - p1 };
  }
  function normCdf(x) { const t = 1 / (1 + 0.2316419 * x); const d = 0.3989423 * Math.exp(-x * x / 2); return 1 - d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); }

  /* SYNTHETIC demo cohort — for showing how the dashboard and the A/B readout work in an interview.
     Every user's behavior is drawn from FIXED, made-up probabilities below (seeded, reproducible).
     The UI watermarks it "SYNTHETIC — not real users". Never quote these numbers as results. */
  function syntheticCohort(n, seed) {
    let x = seed || 7;
    const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
    const users = [];
    const t0 = Date.UTC(2026, 9, 1, 20);
    for (let i = 0; i < (n || 400); i++) {
      const variant = i % 2 ? 'B_intro_first' : 'A_character_first';
      const ev = []; const base = t0 + (i % 14) * DAY; const add = (name, d, props) => ev.push({ name, ts: base + d, props: props || {} });
      add('app_open', 0); add('onboarding_started', 0);
      const pFirst = variant === 'B_intro_first' ? 0.78 : 0.72;            // assumption for the demo, not data
      if (rnd() < 0.92) add('character_selected', 60000);
      if (rnd() < pFirst) {
        add('first_message_sent', 120000);
        const conv = 3 + Math.floor(rnd() * 9);
        add('conversation_completed', 600000, { messageCount: conv, effective: conv >= 5 && rnd() < 0.8 });
        if (rnd() < 0.6) { add('memory_candidate_created', 300000); if (rnd() < 0.62) add('memory_confirmed', 310000); }
        for (let k = 0; k < 3; k++) add('feedback_submitted', 400000 + k, { scope: 'reply', value: rnd() < 0.66 ? 'helpful' : 'not_helpful' });
        if (rnd() < 0.38) add('message_sent', DAY + 3600000);
        if (rnd() < 0.5) { add('proactive_message_sent', 2 * DAY); if (rnd() < 0.18) add('proactive_message_clicked', 2 * DAY + 600000); }
        if (rnd() < 0.17) add('message_sent', 7 * DAY + 3600000);
        for (let w = 0; w < 3; w++) if (rnd() < 0.3) add('conversation_completed', 2 * DAY + w * DAY, { messageCount: 6, effective: true });
        if (rnd() < 0.22) { add('paywall_viewed', 3 * DAY); if (rnd() < 0.06) add('trial_started', 3 * DAY + 1000); }
      }
      users.push({ id: 'syn' + i, variant, events: ev, asOf: t0 + 30 * DAY });
    }
    return users;
  }

  return { plan, recordOutcome, nextSlot, inQuiet, textFor, PER_DAY, STAGES, STAGE_NAME, stageOf, stageProgress, isEffective, dayKey, DAY,
    EXPERIMENTS, assign, hash, computeMetrics, TARGETS, zTest, syntheticCohort };
});
