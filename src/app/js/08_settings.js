/* 08_settings.js · Settings + sub-pages, PM dashboard (PRD §6 设置页, §9, §10, §16) */

Views.settings = { render(el) {
  const s = S.settings;
  const link = (id, k, v) => '<button class="row tap" style="width:100%;text-align:left" data-act="nav.go" data-arg="' + id + '"><div class="grow"><div class="k">' + k + '</div>' + (v ? '<div class="v">' + v + '</div>' : '') + '</div><span class="tiny">›</span></button>';
  el.innerHTML = '<header class="top"><h2 style="padding-left:4px">' + tt('Settings', '设置') + '</h2></header><div class="body">' +
    '<div class="card"><div class="row"><div class="grow"><div class="k">' + tt('Account', '账号') + '</div><div class="v">' + tt('Anonymous · everything stays on this phone', '匿名使用 · 所有数据只在这台手机上') + '</div></div></div>' +
      '<div class="tiny" style="padding:4px 2px 2px">' + tt('Sign in with Apple / Google / email (to back up and move your data) arrives with the V1 account service. Until then there is nothing to sign up for.', '用 Apple / Google / 邮箱登录（用于备份和迁移数据）将随 V1 账号服务上线。在此之前无需注册。') + '</div></div>' +
    '<div class="card">' +
      link('notifs', tt('Notifications & quiet hours', '通知与免打扰'), (s.notifications ? tt('On', '开') : tt('Off', '关')) + ' · ' + pad(s.quiet.start) + '–' + pad(s.quiet.end)) +
      link('privacy', tt('Privacy & data', '隐私与数据'), tt('Export, delete', '导出、删除')) +
      link('safety', tt('Safety help', '安全帮助'), tt('Crisis lines for ', '求助热线：') + esc(S.user.country)) +
      link('language', tt('Language & region', '语言和地区'), (lang() === 'zh' ? '中文' : 'English') + ' · ' + esc(S.user.country)) +
      link('premium', 'Orbit Premium', isPremium() ? tt('Active', '已开通') : tt('Free plan', '免费版')) +
      link('about', tt('About Orbit', '关于 Orbit'), 'v' + VERSION) +
      link('dashboard', tt('Product dashboard (for demos)', '产品数据看板（演示用）'), tt('Metrics, experiments, event log', '指标、实验、埋点')) + '</div>' +
    '</div>' + tabs('settings');
} };
const pad = h => String(h).padStart(2, '0') + ':00';

Views.notifs = { render(el) {
  const s = S.settings;
  const types = [['event', tt('Follow-ups on things you mentioned', '你提到的事的回访')], ['interest', tt('Topics you like', '你喜欢的话题')], ['resume', tt('Picking up an unfinished chat', '续接没聊完的话')], ['light', tt('Small games & questions', '小游戏和小问题')]];
  el.innerHTML = topBar(tt('Notifications', '通知')) + '<div class="body"><div class="card">' +
    '<div class="row"><div class="grow"><div class="k">' + tt('Check-ins from ', '来自 ') + esc(S.character.name) + '</div><div class="v">' + tt('At most once a day by default. Fewer if you don\'t open them.', '默认每天最多 1 条；你没打开的话会自动减少。') + '</div></div>' + sw(s.notifications, 'n.toggle') + '</div></div>' +
    '<div class="sec">' + tt('Quiet hours (no messages)', '免打扰时段（不发消息）') + '</div><div class="card"><div class="row"><div class="grow">' + tt('From', '从') + '</div>' + hourSel('qStart', s.quiet.start) + '</div><div class="row"><div class="grow">' + tt('Until', '到') + '</div>' + hourSel('qEnd', s.quiet.end) + '</div></div>' +
    '<div class="sec">' + tt('Types', '类型') + '</div><div class="card">' + types.map(([k, l]) => '<div class="row"><div class="grow"><div class="k">' + esc(l) + '</div></div>' + sw(!s.mutedTypes.includes(k), 'n.type', k) + '</div>').join('') + '</div>' +
    '<div class="tiny" style="margin-top:10px">' + tt('Last planning result: ', '最近一次排程结果：') + esc(S.lastPlanReason || '—') + '</div></div>';
  ['qStart', 'qEnd'].forEach(id => $('#' + id, el).addEventListener('change', e => { s.quiet[id === 'qStart' ? 'start' : 'end'] = +e.target.value; save(); }));
} };
function hourSel(id, v) { let o = ''; for (let h = 0; h < 24; h++) o += '<option value="' + h + '"' + (h === v ? ' selected' : '') + '>' + pad(h) + '</option>'; return '<select id="' + id + '" class="f" style="width:110px">' + o + '</select>'; }
Actions['n.toggle'] = () => { if (S.settings.notifications) { S.settings.notifications = false; if (BR) try { BR.cancelScheduled(); } catch (e) {} track('notification_opt_out', {}); save(); } else enableNotifications(); rerender(); };
Actions['n.type'] = k => { const m = S.settings.mutedTypes; const i = m.indexOf(k); if (i >= 0) m.splice(i, 1); else muteProactive(k); save(); rerender(); };

Views.privacy = { render(el) {
  el.innerHTML = topBar(tt('Privacy & data', '隐私与数据')) + '<div class="body"><div class="card stack">' +
    '<div>🔒 ' + tt('Chats, memories and settings are stored only on this phone. The AI runs on the phone; nothing is uploaded.', '聊天、记忆和设置只保存在这台手机上。AI 在手机上运行，不上传任何内容。') + '</div>' +
    '<div>🎙 ' + tt('Voice input uses your phone\'s speech service, which may process audio online depending on the phone.', '语音输入使用手机系统的语音服务，部分手机会联网处理音频。') + '</div>' +
    '<div>🧠 ' + tt('Sensitive topics (health, money, IDs) are never saved as memories by default.', '默认不会把健康、金钱、证件等敏感话题保存为记忆。') + '</div></div>' +
    '<div class="stack" style="margin-top:14px"><button class="btn ghost" data-act="p.export">' + tt('Export my data (JSON)', '导出我的数据（JSON）') + '</button>' +
    '<button class="btn ghost" data-act="p.clearChat">' + tt('Delete chat history', '删除聊天记录') + '</button>' +
    '<button class="btn danger" data-act="p.delete">' + tt('Delete everything and start over', '删除全部数据并重新开始') + '</button></div></div>';
} };
Actions['p.export'] = () => {
  const data = JSON.stringify({ exportedAt: new Date().toISOString(), user: S.user, character: S.character, memories: S.memories.filter(m => m.status === 'active'), messages: S.msgs.filter(m => m.content) }, null, 2);
  openSheet('<h2>' + tt('Your data', '你的数据') + '</h2><div class="sub">' + tt('Copy and keep it somewhere safe.', '复制后妥善保存。') + '</div><textarea class="f" rows="10" style="margin-top:10px;font-size:12px" readonly>' + esc(data) + '</textarea><button class="btn" style="margin-top:10px" data-act="p.copyExport">' + tt('Copy', '复制') + '</button>');
};
Actions['p.copyExport'] = () => fallbackCopy($('#pane textarea').value, () => toast(tt('Copied', '已复制')));
Actions['p.clearChat'] = () => { S.msgs = []; S.convs.forEach(c => c.ended = true); S.convId = null; save(); toast(tt('Chat history deleted', '聊天记录已删除')); };
Actions['p.delete'] = () => openSheet('<h2>' + tt('Delete everything?', '删除全部数据？') + '</h2><div class="sub">' + tt('Chats, memories, companion and settings are erased from this phone and scheduled check-ins are cancelled. This cannot be undone.', '聊天、记忆、角色和设置都会从这台手机上清除，已排好的主动消息也会取消。此操作无法撤销。') + '</div><button class="btn danger" style="margin-top:14px" data-act="p.deleteYes">' + tt('Delete everything', '全部删除') + '</button>');
Actions['p.deleteYes'] = () => { if (BR) try { BR.cancelScheduled(); } catch (e) {} try { localStorage.removeItem(KEY); } catch (e) {} closeSheet(); S = defaults(); refreshVariants(); save(true); nav.stack = []; $$('.scr').forEach(s => s.remove()); go('welcome', { reset: true }); };

Views.safety = { render(el) {
  el.innerHTML = topBar(tt('Safety help', '安全帮助')) + '<div class="body"><div class="card">' +
    '<div style="font-weight:650">' + tt('If you are in danger or thinking about hurting yourself, please contact:', '如果你有危险，或在想伤害自己，请联系：') + '</div><div class="stack" style="margin-top:10px">' +
    MIND.hotlines(S.user.country).map(h => '<div>• ' + esc(h) + '</div>').join('') + '</div></div>' +
    '<div class="card"><div class="tiny">' + tt('Orbit is an AI companion. It is not therapy and cannot respond to emergencies. When someone mentions self-harm, Orbit stops the normal conversation and shows these resources instead.', 'Orbit 是 AI 陪伴，不是心理治疗，也无法处理紧急情况。当有人提到自伤时，Orbit 会停止普通对话，改为显示这些求助资源。') + '</div></div>' +
    '<div class="tiny" style="margin-top:10px">' + tt('Numbers last verified 2026-11-10.', '号码最近核验：2026-11-10。') + '</div></div>';
} };

Views.language = { render(el) {
  const C = [['US', 'United States'], ['CA', 'Canada'], ['GB', 'United Kingdom'], ['AU', 'Australia'], ['IE', 'Ireland'], ['NZ', 'New Zealand'], ['CN', '中国'], ['ZZ', tt('Other', '其他')]];
  el.innerHTML = topBar(tt('Language & region', '语言和地区')) + '<div class="body"><div class="sec">' + tt('Language', '语言') + '</div>' + seg([['en', 'English'], ['zh', '中文']], lang(), 'l.lang') +
    '<div class="sec">' + tt('Region', '地区') + '</div>' + seg(C, S.user.country, 'l.country') +
    '<div class="tiny" style="margin-top:12px">' + tt('Time zone: ', '时区：') + esc(S.user.timezone) + '</div></div>';
} };
Actions['l.lang'] = l => { S.settings.lang = l; save(); refreshVoiceLang(); lastWarmSig = ''; warmEngine(); $$('.scr').forEach(s => { if (s.id !== 's-language') { s.remove(); } }); rerender(); };
Actions['l.country'] = c => { S.user.country = c; save(); rerender(); };

Views.about = { render(el) {
  const M = window.OrbitMarket || { facts: [] }, st = Engine.refresh();
  const facts = M.facts.filter(f => f.level === 'A' || f.level === 'B').slice(0, 6);
  el.innerHTML = topBar(tt('About Orbit', '关于 Orbit')) + '<div class="body"><div class="card stack">' +
    '<div><b>Orbit ' + VERSION + '</b></div><div class="tiny">' + tt('A long-term AI companion that remembers only what you approve.', '一个长期陪伴型 AI，只记住你同意的事。') + '</div>' +
    '<div class="tiny">' + tt('AI model: ', 'AI 模型：') + esc(st.model || '—') + ' · ' + tt('runs on this phone', '在本机运行') + '</div>' +
    '<div class="tiny">' + tt('Not a medical or mental-health service. Not a replacement for people in your life.', '不是医疗或心理健康服务，也替代不了你身边的人。') + '</div></div>' +
    '<div class="sec">' + tt('Industry context', '行业背景') + '</div><div class="tiny" style="margin-bottom:8px">' + tt('Third-party public figures, not Orbit data.', '以下为第三方公开数据，不是 Orbit 的数据。') + '</div>' +
    '<div class="card">' + facts.map(f => '<div class="row" style="display:block"><div>' + esc(f[lang()] || f.en) + '</div><div class="tiny">' + esc(f.source) + ' · ' + esc(f.date) + '</div></div>').join('') + '</div></div>';
} };
