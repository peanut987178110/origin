/* 07_pages.js · Home, Companion, Memories, Premium (PRD §6 信息架构, §7.3, §7.5, §7.8, §7.9) */

Views.home = { render(el) {
  const c = S.character, st = LIFE.stageProgress(relStats());
  const inbox = S.inbox.filter(p => p.status === 'delivered' && !p.outcome).slice(-2).reverse();
  const last = S.convs.filter(x => x.ended && x.summary).slice(-1)[0];
  const sugg = suggestion();
  /* Home renders again when its own sheet closes — that is not a fresh visit, so an open check-in
     the user was reading must not be closed under them. Any other sheet came from another page. */
  if (document.getElementById('sheet').classList.contains('on') && !(VShown && VShown.homeCheckIn)) closeSheet();
  VShown.homeCheckIn = inbox.map(p => p.id).join(',');
  el.innerHTML = '<header class="top"><h2 style="padding-left:4px">Orbit</h2><button class="ib" data-act="nav.go" data-arg="dashboard" aria-label="dashboard">📊</button></header>' +
    '<div class="body">' +
    '<div class="card" style="display:flex;gap:14px;align-items:center">' + orb(c, 'big') +
      '<div style="flex:1;min-width:0"><div style="font-size:19px;font-weight:700">' + esc(c.name) + '</div>' +
      '<div class="tiny">' + esc(lifeLine()) + '</div>' +
      '<div style="margin-top:6px"><span class="pill">' + esc(LIFE.STAGE_NAME[st.stage][lang()]) + '</span></div></div></div>' +
    '<button class="btn" style="margin-top:12px" data-act="nav.tab" data-arg="chat">' + tt('Continue chatting', '继续聊天') + '</button>' +
    (inbox.length ? '<div class="sec">' + tt('From ', '来自 ') + esc(c.name) + '</div>' + inbox.map(p =>
      '<div class="card"><div>' + esc(p.body) + '</div><div class="acts" style="display:flex;gap:8px;margin-top:10px">' +
      '<button class="btn sm" data-act="pro.open" data-arg="' + p.id + '">' + tt('Reply', '回复') + '</button>' +
      '<button class="btn sm ghost" data-act="pro.later" data-arg="' + p.id + '">' + tt('Not now', '以后再说') + '</button>' +
      '<button class="btn sm ghost" data-act="pro.mute" data-arg="' + p.type + '">' + tt('Fewer like this', '少发这类') + '</button></div></div>').join('') : '') +
    '<div class="sec">' + tt('Something to talk about', '今天可以聊聊') + '</div>' +
      '<button class="card opt" style="border-radius:var(--r)" data-act="home.suggest" data-arg="' + esc(sugg) + '"><div><div class="t">' + esc(sugg) + '</div><div class="d">' + tt('Tap to start with this', '点一下就用这句开场') + '</div></div></button>' +
    (last ? '<div class="sec">' + tt('Last time', '上次') + '</div><div class="card"><div class="tiny">' + esc(fmtDay(last.endedAt)) + '</div><div style="margin-top:4px">' + esc(last.summary) + '</div></div>' : '') +
    '<div class="sec">' + tt('Your relationship', '你们的关系') + '</div><div class="card">' +
      '<div style="display:flex;justify-content:space-between"><b>' + esc(LIFE.STAGE_NAME[st.stage][lang()]) + '</b><span class="tiny">' + (LIFE.STAGES.indexOf(st.stage) + 1) + ' / 4</span></div>' +
      '<div class="bar" style="margin:10px 0"><i style="width:' + ((LIFE.STAGES.indexOf(st.stage) + 1) * 25) + '%"></i></div>' +
      '<div class="tiny">' + (st.hint ? tt('Next: ', '下一步：') + esc(st.hint[lang()]) : tt('A steady rhythm. No streaks, no pressure.', '稳定的节奏。没有打卡，没有压力。')) + '</div>' +
      '<button class="btn sm ghost" style="margin-top:10px" data-act="home.recap">' + tt('Relationship recap', '关系回顾') + ' · Premium</button></div>' +
    (S.homeUpsell && !isPremium() ? '<div class="card" style="margin-top:10px;border-color:rgba(167,139,250,.4)"><div>' + tt('You two have a steady rhythm now. Premium adds more memory space, a longer memory window and a relationship recap.', '你们已经形成稳定的节奏。Premium 提供更多记忆空间、更长记忆和关系回顾。') + '</div><button class="btn sm" style="margin-top:10px" data-act="pay.open" data-arg="stable">' + tt('See Premium', '了解 Premium') + '</button></div>' : '') +
    '<div class="tiny" style="text-align:center;margin-top:18px">' + esc(engineLine()) + '</div>' +
    '</div>' + tabs('home');
} };
function suggestion() {
  const L = lang(), mem = S.memories.filter(m => m.status === 'active' && m.confirmed);
  const ev = mem.find(m => m.type === 'event');
  if (ev) return L === 'zh' ? '关于' + ev.raw + '，我想跟你说说' : 'About my ' + (ev.raw || 'plans') + '…';
  const pref = mem.find(m => m.type === 'preference');
  if (pref && Math.random() < 0.5) return L === 'zh' ? '想聊聊' + pref.content.replace(/^喜欢/, '') : 'Can we talk about ' + pref.content.replace(/^Likes /, '') + '?';
  const T = { luna: ['Today felt a bit heavy.', '今天有点累。'], nova: ['Tell me something interesting!', '跟我说点有意思的！'], atlas: ['Help me sort out my week.', '帮我理一理这周的事。'], miko: ['Give me a quick game.', '来个小游戏吧。'] }[persona().id];
  return L === 'zh' ? T[1] : T[0];
}
Actions['home.suggest'] = t => { go('chat', { reset: true }); setTimeout(() => send(t), 30); };
Actions['pro.open'] = id => { openProactive(id); go('chat', { reset: true }); };
Actions['pro.later'] = id => { const p = S.inbox.find(x => x.id === id); if (p) { p.outcome = 'dismissed'; LIFE.recordOutcome(S.proactive, false); track('proactive_message_dismissed', { id }); save(); } rerender(); };
Actions['home.recap'] = () => { if (!isPremium()) { paywall('recap'); return; } openSheet(recapHtml()); };
function recapHtml() {
  const convs = S.convs.filter(c => c.ended && c.characterId === S.character.id);
  const mem = S.memories.filter(m => m.status === 'active' && m.confirmed);
  const emo = {}; convs.forEach(c => Object.entries(c.emotions).forEach(([k, v]) => emo[k] = (emo[k] || 0) + v));
  const top = Object.entries(emo).filter(([k]) => k !== 'uncertain').sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
  return '<h2>' + tt('You & ', '你和 ') + esc(S.character.name) + '</h2><div class="stack" style="margin-top:12px">' +
    '<div class="card">' + tt('Conversations: ', '对话次数：') + convs.length + ' · ' + tt('days together: ', '一起的天数：') + new Set(S.rel.days).size + '</div>' +
    '<div class="card">' + tt('Things you chose to share: ', '你选择分享的事：') + (mem.map(m => esc(m.content)).join(' · ') || '—') + '</div>' +
    '<div class="card">' + tt('Feelings that came up most: ', '最常出现的情绪：') + (top.join(', ') || '—') + '</div>' +
    '<div class="tiny">' + tt('Built only from data on this phone.', '只基于这台手机上的数据生成。') + '</div></div>';
}

/* ---------------- Companion (character) page ---------------- */
Views.character = { render(el) {
  const c = S.character, L = lang();
  const row = (label, body) => '<div class="sec">' + label + '</div>' + body;
  el.innerHTML = '<header class="top"><h2 style="padding-left:4px">' + tt('Companion', '角色') + '</h2></header><div class="body">' +
    '<div class="card" style="display:flex;gap:14px;align-items:center">' + orb(c, 'big') + '<div style="flex:1"><input class="f" id="cName" maxlength="20" value="' + esc(c.name) + '">' +
      '<div class="tiny" style="margin-top:6px">' + esc(persona().role[L]) + ' · ' + tt('based on ', '基于 ') + esc(persona().name[L]) + '</div></div></div>' +
    row(tt('Avatar', '头像'), '<div class="chips">' + PER.AVATARS.map(a => '<button class="chip" style="font-size:20px;' + (a === c.emoji ? 'border-color:var(--acc)' : '') + '" data-act="ch.emoji" data-arg="' + a + '">' + a + '</button>').join('') + '</div>') +
    row(tt('Tone', '语气'), seg(Object.entries(PER.TONES).map(([k, v]) => [k, v[L]]), c.tone, 'ch.tone')) +
    row(tt('Reply length', '回复长度'), seg(Object.entries(PER.LENGTHS).map(([k, v]) => [k, v[L]]), c.len, 'ch.len')) +
    row(tt('Relationship', '关系'), seg(Object.entries(PER.RELATIONS).map(([k, v]) => [k, v[L]]), c.relation, 'ch.rel')) +
    row(tt('Check-ins', '主动互动'), seg(Object.entries(PER.ACTIVITY).map(([k, v]) => [k, v[L] + (k === 'high' ? ' ★' : '')]), c.activity, 'ch.act') + '<div class="tiny" style="margin-top:6px">' + esc(PER.ACTIVITY[c.activity].desc[L]) + '</div>') +
    '<div class="card" style="margin-top:14px">' +
      '<div class="row"><div class="grow"><div class="k">' + tt('Light teasing', '轻度调侃') + '</div></div>' + sw(c.tease, 'ch.tease') + '</div>' +
      '<div class="row"><div class="grow"><div class="k">' + tt('Role-play', '角色扮演') + '</div></div>' + sw(c.roleplay, 'ch.roleplay') + '</div></div>' +
    row(tt('Topics they enjoy', '喜欢聊的话题'), '<div class="chips">' + c.topics.map((t, i) => '<button class="chip x" data-act="ch.topicDel" data-arg="t:' + i + '">' + esc(t) + '</button>').join('') +
      '<button class="chip" data-act="ch.topicAdd" data-arg="t">＋</button></div>') +
    row(tt('Topics to avoid', '不想聊的话题'), '<div class="chips">' + c.blocked.map((t, i) => '<button class="chip x" data-act="ch.topicDel" data-arg="b:' + i + '">' + esc(t) + '</button>').join('') +
      '<button class="chip" data-act="ch.topicAdd" data-arg="b">＋</button></div>') +
    '<div class="sec"></div><div class="stack">' +
      '<button class="btn ghost" data-act="ch.regen">↻ ' + tt('Regenerate character (new name & look)', '重新生成角色（换名字和形象）') + '</button>' +
      '<button class="btn ghost" data-act="ch.switch">' + tt('Switch to another companion', '换一个陪伴者') + ' · ' + tt('2nd companion is Premium', '第二个角色需 Premium') + '</button>' +
      '<button class="btn danger" data-act="ch.reset">' + tt('Reset relationship', '重置关系') + '</button></div>' +
    '</div>' + tabs('character');
  $('#cName', el).addEventListener('change', e => { const v = e.target.value.trim().slice(0, 20); if (v) { c.name = v; save(); warmEngine(); toast(tt('Saved', '已保存')); } });
} };
function chSet(k, v) { S.character[k] = v; save(); warmEngine(); track('character_configured', { field: k, value: v }); rerender(); }
Actions['ch.emoji'] = a => chSet('emoji', a);
Actions['ch.tone'] = k => chSet('tone', k);
Actions['ch.len'] = k => chSet('len', k);
Actions['ch.rel'] = k => chSet('relation', k);
Actions['ch.act'] = k => { if (k === 'high' && !isPremium()) { paywall('proactive_high'); return; } chSet('activity', k); };
Actions['ch.tease'] = () => chSet('tease', !S.character.tease);
Actions['ch.roleplay'] = () => chSet('roleplay', !S.character.roleplay);
Actions['ch.topicDel'] = a => { const [w, i] = a.split(':'); (w === 't' ? S.character.topics : S.character.blocked).splice(+i, 1); save(); warmEngine(); rerender(); };
Actions['ch.topicAdd'] = w => openSheet('<h2>' + (w === 't' ? tt('Add a topic', '添加话题') : tt('Add a topic to avoid', '添加不想聊的话题')) + '</h2><input class="f" id="topicInp" maxlength="24" style="margin-top:12px"><button class="btn" style="margin-top:12px" data-act="ch.topicSave" data-arg="' + w + '">' + tt('Add', '添加') + '</button>');
Actions['ch.topicSave'] = w => { const v = ($('#topicInp').value || '').trim(); closeSheet(); if (v) { (w === 't' ? S.character.topics : S.character.blocked).push(v); save(); warmEngine(); rerender(); } };
Actions['ch.regen'] = () => {
  const pool = PER.NAME_POOL.filter(n => n !== S.character.name);
  S.character.name = pool[Math.floor(Math.random() * pool.length)];
  const av = PER.AVATARS.filter(a => a !== S.character.emoji); S.character.emoji = av[Math.floor(Math.random() * av.length)];
  track('character_regenerated', {}); save(); warmEngine(); rerender(); toast(tt('Meet ', '认识一下 ') + S.character.name);
};
Actions['ch.switch'] = () => { if (!isPremium()) { paywall('second_character'); return; } OB.pick = null; go('pick'); };
Actions['ch.reset'] = () => openSheet('<h2>' + tt('Reset the relationship?', '重置关系？') + '</h2><div class="sub">' + tt('The relationship stage goes back to "Just met". Memories and chats are kept — delete those in Memories.', '关系阶段会回到「初识」。记忆和聊天记录保留，可以在「记忆」里删除。') + '</div>' +
  '<button class="btn danger" style="margin-top:14px" data-act="ch.resetYes">' + tt('Reset', '重置') + '</button>');
Actions['ch.resetYes'] = () => { S.rel = { effectiveCount: 0, confirmedCount: 0, positiveFeedback: 0, days: [] }; track('relationship_reset', {}); save(); closeSheet(); warmEngine(); rerender(); };

/* ---------------- Memories page ---------------- */
const TYPE_NAME = { preference: ['Preferences', '偏好'], fact: ['Facts about you', '关于你'], event: ['Upcoming & recent', '近期的事'], commpref: ['How you like to talk', '沟通偏好'] };
Views.memory = { render(el) {
  const act = S.memories.filter(m => m.status === 'active');
  const groups = ['event', 'preference', 'fact', 'commpref'].map(t => [t, act.filter(m => m.type === t)]).filter(([, l]) => l.length);
  const kinds = [['health', tt('Health', '健康')], ['finance', tt('Money', '金钱')], ['identity', tt('IDs & passwords', '证件与密码')], ['intimate', tt('Relationships, faith & politics', '性取向、信仰与政治')]];
  el.innerHTML = '<header class="top"><h2 style="padding-left:4px">' + tt('Memories', '记忆') + '</h2><span class="pill">' + act.length + ' / ' + limits().memories + '</span></header><div class="body">' +
    '<div class="sub" style="margin-top:0">' + tt('Only things you approved. Edit or delete anything — deleted memories are never used again.', '这里只有你同意保存的内容。任何一条都可以编辑或删除，删除后不会再被使用。') + '</div>' +
    (groups.length ? groups.map(([t, l]) => '<div class="sec">' + esc(tt(TYPE_NAME[t][0], TYPE_NAME[t][1])) + '</div><div class="card">' + l.map(m =>
      '<div class="row"><div class="grow"><div>' + esc(m.content) + (m.confirmed ? '' : ' <span class="pill">' + tt('auto', '自动') + '</span>') + '</div>' +
      '<div class="tiny">' + esc(fmtDay(m.createdAt)) + (m.source ? ' · “' + esc(m.source.slice(0, 50)) + '”' : '') + (m.expiresAt ? ' · ' + tt('expires ', '到期 ') + esc(fmtDay(m.expiresAt)) : '') + '</div></div>' +
      '<button class="ib" data-act="m.edit" data-arg="' + m.id + '" aria-label="edit">✎</button><button class="ib" data-act="m.del" data-arg="' + m.id + '" aria-label="delete">🗑</button></div>').join('') + '</div>').join('')
      : '<div class="card" style="margin-top:14px">' + tt('Nothing yet. When you mention something worth remembering, ', '还没有。当你提到值得记住的事，') + esc(S.character.name) + tt(' will ask first.', ' 会先问你。') + '</div>') +
    '<div class="sec">' + tt('Settings', '设置') + '</div><div class="card">' +
      '<div class="row"><div class="grow"><div class="k">' + tt('Suggest memories while chatting', '聊天时提议记住') + '</div><div class="v">' + tt('Off = nothing new is ever proposed', '关闭后不会再提议任何新记忆') + '</div></div>' + sw(S.settings.autoMemory, 'm.auto') + '</div></div>' +
    '<div class="sec">' + tt('Never remember', '永远不记') + '</div><div class="card">' + kinds.map(([k, l]) =>
      '<div class="row"><div class="grow"><div class="k">' + esc(l) + '</div></div>' + sw(S.settings.blockedKinds.includes(k), 'm.kind', k) + '</div>').join('') +
      '<div class="row"><div class="grow"><div class="k">' + tt('My own words', '自定义词') + '</div><div class="v">' + (S.settings.blockedWords.map(esc).join(', ') || '—') + '</div></div><button class="btn sm ghost" data-act="m.words">' + tt('Edit', '编辑') + '</button></div></div>' +
    '<button class="btn danger" style="margin-top:16px" data-act="m.clear">' + tt('Clear all memories', '清空全部记忆') + '</button>' +
    '</div>' + tabs('memory');
} };
Actions['m.del'] = id => { MEM.remove(S.memories, id); track('memory_deleted', { via: 'memory_page' }); save(); warmEngine(); rerender(); toast(tt('Deleted', '已删除')); };
Actions['m.edit'] = id => { const m = S.memories.find(x => x.id === id); if (!m) return;
  openSheet('<h2>' + tt('Edit memory', '编辑记忆') + '</h2><textarea class="f" id="mEditInp" rows="3" style="margin-top:12px">' + esc(m.content) + '</textarea><button class="btn" style="margin-top:12px" data-act="m.editSave" data-arg="' + id + '">' + tt('Save', '保存') + '</button>'); };
Actions['m.editSave'] = id => { const v = ($('#mEditInp').value || '').trim(); closeSheet(); if (!v) return; MEM.edit(S.memories, id, v, new Date(now())); track('memory_edited', {}); save(); warmEngine(); rerender(); };
Actions['m.auto'] = () => { S.settings.autoMemory = !S.settings.autoMemory; track('auto_memory_toggled', { on: S.settings.autoMemory }); save(); rerender(); };
Actions['m.kind'] = k => { const b = S.settings.blockedKinds; const i = b.indexOf(k); if (i >= 0) b.splice(i, 1); else b.push(k); save(); rerender(); };
Actions['m.words'] = () => openSheet('<h2>' + tt('Words never to remember', '永远不记的词') + '</h2><div class="sub">' + tt('Comma separated. Any message containing one of these is never turned into a memory.', '用逗号分隔。包含这些词的消息永远不会被记成记忆。') + '</div><input class="f" id="wordsInp" style="margin-top:12px" value="' + esc(S.settings.blockedWords.join(', ')) + '"><button class="btn" style="margin-top:12px" data-act="m.wordsSave">' + tt('Save', '保存') + '</button>');
Actions['m.wordsSave'] = () => { S.settings.blockedWords = ($('#wordsInp').value || '').split(/[,，]/).map(x => x.trim()).filter(Boolean).slice(0, 30); closeSheet(); save(); rerender(); };
Actions['m.clear'] = () => openSheet('<h2>' + tt('Clear all memories?', '清空全部记忆？') + '</h2><div class="sub">' + tt('This cannot be undone.', '此操作无法撤销。') + '</div><button class="btn danger" style="margin-top:14px" data-act="m.clearYes">' + tt('Clear all', '全部清空') + '</button>');
Actions['m.clearYes'] = () => { S.memories.forEach(m => { if (m.status === 'active') MEM.remove(S.memories, m.id); }); track('memory_cleared', {}); save(); closeSheet(); warmEngine(); rerender(); };

/* ---------------- Premium (PRD §7.9) — shown only at moments of real value ---------------- */
const PAY_WHY = {
  quota: ['You reached today\'s free messages.', '今天的免费消息用完了。'], memory_full: ['Your memory space is full.', '记忆空间已满。'],
  voice: ['Voice replies are a Premium feature.', '语音回复是 Premium 功能。'], image: ['Image understanding is a Premium feature (coming in V1.1).', '图片理解是 Premium 功能（V1.1 推出）。'],
  second_character: ['A second companion is a Premium feature.', '第二个角色是 Premium 功能。'], recap: ['The relationship recap is a Premium feature.', '关系回顾是 Premium 功能。'],
  proactive_high: ['More frequent check-ins are a Premium feature.', '更高频的主动互动是 Premium 功能。'], stable: ['', ''], settings: ['', '']
};
function paywall(trigger) {
  track('paywall_viewed', { trigger });
  window.__orbitFrom = nav.stack[nav.stack.length - 1];          // where "back" must return to
  go('premium', { trigger });
}
Actions['pay.open'] = t => paywall(t || 'settings');
Views.premium = { render(el, o) {
  const why = PAY_WHY[o.trigger] || ['', ''];
  const F = [[tt('Messages per day', '每日消息'), '40', '300'], [tt('Memory space', '记忆容量'), '20', '200'], [tt('Read replies aloud', '语音朗读回复'), '✓', '✓'], [tt('Image understanding', '图片理解'), '—', 'V1.1'],
    [tt('Companions', '角色数量'), '1', tt('Several', '多个')], [tt('Character settings', '角色配置'), tt('Basic', '基础'), tt('Full', '完整')], [tt('Relationship recap', '关系回顾'), '—', '✓'], [tt('Check-in control', '主动互动控制'), tt('Low/Medium', '低/中'), tt('+ High', '+ 高')]];
  /* Premium has no tab bar, so this page carries its own back button (it used to rely on whatever was left over underneath). */
  el.innerHTML = '<header class="top"><button class="ib" data-act="nav.back" aria-label="back">‹</button><h2>Orbit Premium</h2></header>' + '<div class="body">' +
    (why[0] ? '<div class="card" style="border-color:rgba(167,139,250,.4)">' + esc(tt(why[0], why[1])) + '</div>' : '') +
    '<div class="card" style="margin-top:10px"><div class="row" style="font-weight:650"><div class="grow"></div><div style="width:70px;text-align:center">' + tt('Free', '免费') + '</div><div style="width:80px;text-align:center">Premium</div></div>' +
    F.map(([k, a, b]) => '<div class="row"><div class="grow">' + esc(k) + '</div><div style="width:70px;text-align:center" class="v">' + esc(a) + '</div><div style="width:80px;text-align:center">' + esc(b) + '</div></div>').join('') + '</div>' +
    (isPremium() ? '<div class="card" style="margin-top:12px">✓ ' + (S.plan.tier === 'premium' ? tt('Premium is active.', 'Premium 已开通。') : tt('Free trial active until ', '试用中，至 ') + esc(fmtDay(S.plan.trialUntil))) + '</div>' +
        '<button class="btn ghost" style="margin-top:10px" data-act="pay.cancel">' + tt('Manage / cancel subscription', '管理 / 取消订阅') + '</button>'
      : '<div class="stack" style="margin-top:14px"><button class="btn" data-act="pay.trial">' + tt('Start 7-day free trial', '开始 7 天免费试用') + '</button>' +
        '<button class="btn ghost" data-act="pay.buy" data-arg="year">' + tt('$59.99 / year', '$59.99 / 年') + '</button><button class="btn ghost" data-act="pay.buy" data-arg="month">' + tt('$7.99 / month', '$7.99 / 月') + '</button></div>') +
    '<button class="btn ghost sm" style="margin:12px auto 0" data-act="pay.restore">' + tt('Restore purchases', '恢复购买') + '</button>' +
    '<div class="tiny" style="margin-top:12px;text-align:center">' + tt('Demo build: no real payment is taken. Prices are a pricing assumption, not tested.', '演示版本：不会产生真实扣费。价格为定价假设，未经测试。') + '</div></div>';
} };
Actions['pay.trial'] = () => { S.plan.trialUntil = now() + 7 * LIFE.DAY; track('trial_started', {}); save(); toast(tt('Trial started (demo)', '试用已开始（演示）')); rerender(); };
Actions['pay.buy'] = p => { S.plan.tier = 'premium'; track('subscription_started', { period: p }); save(); toast(tt('Premium active (demo)', 'Premium 已开通（演示）')); rerender(); };
Actions['pay.cancel'] = () => { S.plan = { tier: 'free', trialUntil: 0 }; track('subscription_cancelled', {}); save(); toast(tt('Subscription cancelled (demo)', '已取消订阅（演示）')); rerender(); };
Actions['pay.restore'] = () => toast(tt('No previous purchases found (demo).', '没有找到之前的购买（演示）。'));
