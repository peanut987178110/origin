/* 04_onboarding.js · PRD §7.1 / §7.2 — value in < 3 minutes, one choice per page, no questionnaire.
   welcome → age & region → pick companion → (A) relationship → activity → chat
                                            (B) chat right away; relationship asked inside chat (experiment onboarding_order_v1) */
const OB = { pick: null, relation: null, activity: null };

Views.welcome = { render(el) {
  el.innerHTML = '<div class="body" style="display:flex;flex-direction:column;justify-content:center">' +
    '<div style="display:flex;gap:-10px;justify-content:center;margin-bottom:22px">' +
      ['luna', 'nova', 'atlas', 'miko'].map(id => orb(PER.PERSONAS[id], '')).join('') + '</div>' +
    '<h1 style="text-align:center">' + tt('Meet an AI companion<br>who remembers you', '认识一个<br>会记住你的 AI 伙伴') + '</h1>' +
    '<div class="sub" style="text-align:center">' + tt('Orbit keeps a steady, gentle conversation going — and you decide what it remembers.', 'Orbit 陪你持续地、温和地聊下去——记住什么，由你决定。') + '</div>' +
    '<div class="card stack" style="margin-top:22px">' +
      '<div>🧠 ' + tt('Remembers only what you approve', '只记住你同意的事') + '</div>' +
      '<div>🔒 ' + tt('Runs on your phone. No account, nothing sent anywhere', '在你的手机上运行。无需注册，不上传任何内容') + '</div>' +
      '<div>🤖 ' + tt('Always an AI — not a therapist, not a human', '始终是 AI——不是心理医生，也不是真人') + '</div></div>' +
    '<button class="btn" style="margin-top:22px" data-act="ob.start">' + tt('Get started', '开始') + '</button>' +
    '<div class="row" style="justify-content:center;border:none;margin-top:6px">' +
      seg([['en', 'English'], ['zh', '中文']], lang(), 'ob.lang') + '</div>' +
    '<div class="tiny" style="text-align:center;margin-top:4px" id="obEngine">' + esc(engineLine()) + '</div></div>';
} };
Actions['ob.lang'] = l => { S.settings.lang = l; save(); refreshVoiceLang(); rerender(); };
Actions['ob.start'] = () => { track('onboarding_started', {}); go('age'); };

Views.age = { render(el) {
  const bands = [['18-24', '18–24'], ['25-34', '25–34'], ['35+', '35+'], ['u18', tt('Under 18', '未满 18')]];
  const C = [['US', tt('United States', '美国')], ['CA', tt('Canada', '加拿大')], ['GB', tt('United Kingdom', '英国')], ['AU', tt('Australia', '澳大利亚')], ['OTHER', tt('Somewhere else', '其他地区')]];
  const cur = ['US', 'CA', 'GB', 'AU'].includes(S.user.country) ? S.user.country : 'OTHER';
  el.innerHTML = topBar('') + '<div class="body">' +
    '<h1>' + tt('How old are you?', '你的年龄？') + '</h1>' +
    '<div class="sub">' + tt('Orbit is for adults. We use this only to keep the experience safe.', 'Orbit 面向成年人。这一项只用于保障使用安全。') + '</div>' +
    '<div class="stack" style="margin-top:18px">' + bands.map(([k, l]) =>
      '<button class="opt ' + (S.user.ageBand === k ? 'on' : '') + '" data-act="ob.age" data-arg="' + k + '"><div class="t">' + esc(l) + '</div></button>').join('') + '</div>' +
    '<div id="u18" class="card" style="margin-top:12px;display:' + (S.user.ageBand === 'u18' ? 'block' : 'none') + '">' +
      tt('Sorry — Orbit is only for people 18 and older. If you need someone to talk to, a trusted adult or a helpline can help: ', '抱歉，Orbit 仅面向 18 岁以上的用户。如果你需要倾诉，可以找信任的大人，或拨打热线：') +
      esc(MIND.hotlines(S.user.country)[0]) + '</div>' +
    '<div class="sec">' + tt('Where are you?', '你在哪里？') + '</div>' + seg(C, cur, 'ob.country') +
    '<div class="tiny" style="margin-top:6px">' + tt('Used for local safety resources and message timing.', '用于显示当地的求助资源，以及安排消息时间。') + '</div>' +
    '<button class="btn" style="margin-top:22px" data-act="ob.ageNext" ' + (S.user.ageBand && S.user.ageBand !== 'u18' ? '' : 'disabled') + '>' + tt('Continue', '继续') + '</button></div>';
} };
Actions['ob.age'] = k => { S.user.ageBand = k; save(); rerender(); };
Actions['ob.country'] = k => { S.user.country = k === 'OTHER' ? 'ZZ' : k; save(); rerender(); };
Actions['ob.ageNext'] = () => go('pick');

Views.pick = { render(el) {
  const intro = VAR.onboarding_order_v1 === 'B_intro_first';
  el.innerHTML = topBar('') + '<div class="body">' +
    '<h1>' + (intro ? tt('Who would you like to talk to?', '你想和谁聊聊？') : tt('Choose your companion', '选择你的陪伴者')) + '</h1>' +
    '<div class="sub">' + tt('You can change anything about them later.', '之后随时可以修改。') + '</div>' +
    '<div class="stack" style="margin-top:16px">' + ['luna', 'nova', 'atlas', 'miko'].map(id => {
      const p = PER.PERSONAS[id];
      return '<button class="opt ' + (OB.pick === id ? 'on' : '') + '" data-act="ob.pick" data-arg="' + id + '">' + orb(p) +
        '<div style="flex:1"><div class="t">' + esc(p.name[lang()]) + ' · <span style="color:var(--dim);font-weight:500">' + esc(p.role[lang()]) + '</span></div>' +
        '<div class="d">' + esc(intro ? '“' + p.opener[lang()].split(/(?<=[.。!！?？])\s*/)[0] + '”' : p.blurb[lang()]) + '</div>' +
        '<div class="tiny" style="margin-top:3px">' + tt('Best for: ', '适合：') + esc(p.bestFor[lang()]) + '</div></div></button>';
    }).join('') +
    '<button class="opt ' + (OB.pick === 'blank' ? 'on' : '') + '" data-act="ob.pick" data-arg="blank">' + orb({ emoji: '＋', color: '#475569', color2: '#334155' }) +
      '<div><div class="t">' + tt('Start from blank', '从空白开始') + '</div><div class="d">' + tt('Name them and pick a vibe yourself.', '自己起名，自己定性格。') + '</div></div></button></div>' +
    '<div id="blankForm" style="display:' + (OB.pick === 'blank' ? 'block' : 'none') + ';margin-top:12px" class="card stack">' +
      '<input class="f" id="blankName" maxlength="20" placeholder="' + tt('Their name', '起个名字') + '" value="' + esc(OB.blankName || '') + '">' +
      seg(Object.entries(PER.TONES).map(([k, v]) => [k, v[lang()]]), OB.blankTone || 'gentle', 'ob.blankTone') + '</div>' +
    '<button class="btn" style="margin-top:18px" data-act="ob.pickNext" ' + (OB.pick ? '' : 'disabled') + '>' + tt('Continue', '继续') + '</button></div>';
} };
Actions['ob.pick'] = id => { OB.pick = id; rerender(); };
Actions['ob.blankTone'] = k => { OB.blankName = ($('#blankName') || {}).value || ''; OB.blankTone = k; rerender(); };
Actions['ob.pickNext'] = () => {
  if (OB.pick === 'blank') {
    const tone = OB.blankTone || 'gentle';
    const base = PER.TONES[tone].from;
    const name = (($('#blankName') || {}).value || '').trim().slice(0, 20) || PER.NAME_POOL[Math.floor(Math.random() * PER.NAME_POOL.length)];
    S.character = makeCharacter(base, { name, emoji: '🪐', tone, custom: true });
  } else {
    S.character = makeCharacter(OB.pick);
  }
  track('character_selected', { character: S.character.base, custom: !!S.character.custom });
  save();
  warmEngine();                                  // start filling the KV cache with this persona now
  if (VAR.onboarding_order_v1 === 'B_intro_first') finishOnboarding();
  else go('relation');
};

Views.relation = { render(el) {
  const cur = OB.relation || S.character.relation;
  el.innerHTML = topBar('') + '<div class="body"><h1>' + tt('How should ', '希望 ') + esc(S.character.name) + tt(' show up for you?', ' 以什么身份陪你？') + '</h1>' +
    '<div class="sub">' + tt('This shapes how they talk to you. Change it any time.', '这会影响 TA 和你说话的方式，随时可以改。') + '</div>' +
    '<div class="stack" style="margin-top:16px">' + Object.entries(PER.RELATIONS).map(([k, r]) =>
      '<button class="opt ' + (cur === k ? 'on' : '') + '" data-act="ob.rel" data-arg="' + k + '"><div><div class="t">' + esc(r[lang()]) + '</div><div class="d">' + esc(r.line[lang()]) + '</div></div></button>').join('') + '</div>' +
    '<button class="btn" style="margin-top:18px" data-act="ob.relNext">' + tt('Continue', '继续') + '</button>' +
    '<button class="btn ghost" style="margin-top:8px" data-act="ob.relNext">' + tt('Skip', '跳过') + '</button></div>';
} };
Actions['ob.rel'] = k => { OB.relation = k; rerender(); };
Actions['ob.relNext'] = () => { if (OB.relation) S.character.relation = OB.relation; save(); go('activity'); };

Views.activity = { render(el) {
  const cur = OB.activity || S.character.activity;
  el.innerHTML = topBar('') + '<div class="body"><h1>' + tt('How often may ', '允许 ') + esc(S.character.name) + tt(' check in?', ' 多久主动找你一次？') + '</h1>' +
    '<div class="sub">' + tt('Check-ins are always about something you told them, and easy to ignore.', '主动消息只会聊你告诉过 TA 的事，不想理随时可以忽略。') + '</div>' +
    '<div class="stack" style="margin-top:16px">' + Object.entries(PER.ACTIVITY).map(([k, a]) =>
      '<button class="opt ' + (cur === k ? 'on' : '') + '" data-act="ob.act" data-arg="' + k + '"><div><div class="t">' + esc(a[lang()]) + (k === 'high' ? ' <span class="pill">Premium</span>' : '') + '</div><div class="d">' + esc(a.desc[lang()]) + '</div></div></button>').join('') + '</div>' +
    '<button class="btn" style="margin-top:18px" data-act="ob.finish">' + tt('Start chatting', '开始聊天') + '</button></div>';
} };
Actions['ob.act'] = k => { if (k === 'high' && !isPremium()) { paywall('proactive_high'); return; } OB.activity = k; rerender(); };
Actions['ob.finish'] = () => { if (OB.activity) S.character.activity = OB.activity; finishOnboarding(); };

function finishOnboarding() {
  S.user.onboarded = true;
  const c = S.character, p = persona();
  // the opening line is a fixed card (no model turn): it is never re-generated, and it is
  // never picked up as "the last reply" when the next reply is measured
  addMsg({ role: 'assistant', content: p.opener[lang()].replace(p.name.en, c.name), kind: 'opener', pending: false, stats: null });
  if (VAR.onboarding_order_v1 === 'B_intro_first') addMsg({ role: 'system', kind: 'relChips' });
  track('onboarding_completed', { variant: VAR.onboarding_order_v1, character: c.base, relation: c.relation, activity: c.activity });
  save();
  go('chat', { reset: true });
}
