/* 06_chat_view.js · chat screen (PRD §6 聊天页, §7.4)
   The DOM is built once per visit and then only APPENDED to — streaming updates touch a
   single text node, so long chats stay smooth. */
Views.chat = {
  render(el, o) {
    if (o && o.soft && el.dataset.built) { renderMsgs(); return; }
    const c = S.character;
    el.dataset.built = '1';
    el.innerHTML =
      '<header class="top"><button class="ib" data-act="chat.home" aria-label="home">‹</button>' + orb(c, 's') +
      '<div style="flex:1;min-width:0"><div style="font-weight:650">' + esc(c.name) + '</div><div class="tiny" id="chatSub">' + esc(lifeLine()) + '</div></div>' +
      '<button class="ib" data-act="chat.search" aria-label="search">⌕</button><button class="ib" data-act="chat.menu" aria-label="menu">⋯</button></header>' +
      '<div id="searchBar" style="display:none;padding:8px 12px;border-bottom:1px solid var(--line)"><input class="f" id="searchInp" placeholder="' + tt('Search this chat', '搜索聊天记录') + '"></div>' +
      '<div class="ready" id="readyBar"></div>' + '<div class="ready" id="voiceBar"><span>' + tt('Reading this reply aloud', '正在朗读这条回复') + '</span><button class="btn sm" style="margin-left:auto" data-act="chat.stopVoice">' + tt('Stop', '停止') + '</button></div>' +
      '<div id="msgs" role="log"></div><div class="qr" id="qr"></div>' +
      '<div class="inp"><button class="ib" id="micBtn" data-act="chat.mic" aria-label="voice">🎙</button>' +
      '<button class="ib" data-act="chat.image" aria-label="image">🖼</button>' +
      '<textarea id="inp" rows="1" placeholder="' + tt('Message ', '发消息给 ') + esc(c.name) + '"></textarea>' +
      '<button class="send" id="sendBtn" data-act="chat.send" aria-label="send">↑</button></div>';
    const inp = $('#inp', el);
    inp.addEventListener('input', () => { inp.style.height = 'auto'; inp.style.height = Math.min(120, inp.scrollHeight) + 'px'; if (inp.value) clearChips(); });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); Actions['chat.send'](); } });
    $('#searchInp', el).addEventListener('input', e => filterMsgs(e.target.value));
    renderMsgs(); updateReady();
  },
  after() { deliverDue(); scrollEnd(true); },
  leave() { maybeAskRating(); }
};

function renderMsgs() {
  const box = $('#msgs'); if (!box) return;
  const list = S.msgs.slice(-80);
  box.innerHTML = '';
  let lastDay = '';
  for (const m of list) {
    const d = LIFE.dayKey(m.ts);
    if (d !== lastDay) { lastDay = d; box.insertAdjacentHTML('beforeend', '<div class="sysl">' + esc(fmtDay(m.ts)) + '</div>'); }
    box.appendChild(msgNode(m, list));
  }
  if (BUSY) setBusy(S.msgs.find(m => m.id === BUSY.msgId));
  scrollEnd(true);
}
function appendMsg(m) {
  const box = $('#msgs'); if (!box) return;
  const prev = S.msgs[S.msgs.length - 2];
  if (!prev || LIFE.dayKey(prev.ts) !== LIFE.dayKey(m.ts)) box.insertAdjacentHTML('beforeend', '<div class="sysl">' + esc(fmtDay(m.ts)) + '</div>');
  // only the newest AI reply carries "regenerate"
  $$('.meta [data-act="msg.regen"]', box).forEach(b => b.remove());
  box.appendChild(msgNode(m, S.msgs));
  scrollEnd();
}
function lastAiId(list) { for (let i = list.length - 1; i >= 0; i--) if (list[i].role === 'assistant' && !list[i].kind) return list[i].id; return null; }

function msgNode(m, list) {
  const w = document.createElement('div');
  w.id = 'm-' + m.id;
  if (m.role === 'user') { w.className = 'm me'; w.innerHTML = '<div class="bub"></div>'; w.firstChild.textContent = m.content; return w; }
  if (m.role === 'system') { w.className = 'mc'; w.innerHTML = cardHtml(m); if (!w.innerHTML) w.style.display = 'none'; return w; }
  w.className = 'm-wrap';
  const kindCls = m.kind === 'crisis' ? ' crisis' : m.kind === 'proactive' ? ' pro' : '';
  w.innerHTML = '<div class="m ai">' + orb(S.character, 's') + '<div class="bub' + kindCls + '"></div></div>';
  const bub = w.querySelector('.bub');
  if (m.kind === 'proactive') bub.insertAdjacentHTML('beforebegin', '');
  if (m.pending) { bub.innerHTML = '<span class="cur"></span>'; showStream(m, m.partial || ''); }   // re-entering chat mid-reply keeps the words already on screen
  else bub.textContent = m.content;
  if (m.kind === 'proactive') w.insertAdjacentHTML('afterbegin', '<div class="tiny" style="margin:0 0 3px 40px">' + tt('Check-in from ', '来自 ') + esc(S.character.name) + '</div>');
  if (!m.pending && !m.kind) w.insertAdjacentHTML('beforeend', metaHtml(m, list));
  if (m.kind === 'proactive' && !m.pending) w.insertAdjacentHTML('beforeend', '<div class="meta"><button data-act="pro.mute" data-arg="' + esc((S.inbox.find(p => p.id === m.proId) || {}).type || '') + '">' + tt('Fewer like this', '少发这类') + '</button></div>');
  if (m.kind === 'error') w.insertAdjacentHTML('beforeend', '<div class="meta"><button data-act="msg.retry" data-arg="' + m.id + '">' + tt('Try again', '重试') + '</button></div>');
  return w;
}
function metaHtml(m, list) {
  const fb = m.fb || '';
  return '<div class="meta"><button class="' + (fb === 'helpful' ? 'on' : '') + '" data-act="msg.up" data-arg="' + m.id + '">👍</button>' +
    '<button class="' + (fb && fb !== 'helpful' ? 'on' : '') + '" data-act="msg.down" data-arg="' + m.id + '">👎</button>' +
    '<button data-act="msg.copy" data-arg="' + m.id + '">' + tt('Copy', '复制') + '</button>' +
    (m.id === lastAiId(list) ? '<button data-act="msg.regen" data-arg="' + m.id + '">' + tt('Regenerate', '重新生成') + '</button>' : '') + '</div>';
}
function cardHtml(m) {
  const n = esc(S.character.name);
  if (m.kind === 'memAsk') return '<div class="q">🧠 ' + esc(MEM.consentText(m.cand, lang(), S.character.name)) + '</div>' +
    '<div class="acts"><button class="btn sm" data-act="mem.yes" data-arg="' + m.id + '">' + tt('Remember', '记住') + '</button>' +
    '<button class="btn sm ghost" data-act="mem.no" data-arg="' + m.id + '">' + tt('Not now', '暂时不用') + '</button>' +
    '<button class="btn sm ghost" data-act="mem.edit" data-arg="' + m.id + '">' + tt('Edit', '编辑') + '</button></div>';
  if (m.kind === 'memDone') return '<div class="tiny">' + (m.decision === 'saved' ? '✓ ' + tt('Saved to memories', '已保存到记忆') + ' · <button class="tiny" style="text-decoration:underline" data-act="nav.go" data-arg="memory">' + tt('Manage', '管理') + '</button>' : tt("Okay, I won't remember that.", '好的，这个我不记。')) + '</div>';
  if (m.kind === 'memAuto') { const mm = S.memories.find(x => x.id === m.memId); return mm && mm.status === 'active' ? '<div class="tiny">🧠 ' + tt('Remembered: ', '已记住：') + esc(mm.content) + ' · <button class="tiny" style="text-decoration:underline" data-act="mem.undo" data-arg="' + m.id + '">' + tt('Undo', '撤销') + '</button></div>' : '<div class="tiny">' + tt('Removed.', '已移除。') + '</div>'; }
  if (m.kind === 'memFull') return '<div class="q">' + tt('Your memory space is full on the free plan.', '免费版的记忆空间已满。') + '</div><div class="acts"><button class="btn sm" data-act="pay.open" data-arg="memory_full">' + tt('See Premium', '了解 Premium') + '</button><button class="btn sm ghost" data-act="nav.go" data-arg="memory">' + tt('Manage memories', '管理记忆') + '</button></div>';
  if (m.kind === 'forget') { const mm = S.memories.find(x => x.id === m.memId); return mm && mm.status === 'active' ? '<div class="q">' + tt('Forget this?', '忘掉这条？') + ' “' + esc(mm.content) + '”</div><div class="acts"><button class="btn sm danger" data-act="mem.forget" data-arg="' + m.id + '">' + tt('Forget it', '忘掉') + '</button><button class="btn sm ghost" data-act="card.dismiss" data-arg="' + m.id + '">' + tt('Keep', '保留') + '</button></div>' : ''; }
  if (m.kind === 'notifAsk') return m.done ? '' : '<div class="q">🔔 ' + tt('Can ', '允许 ') + n + tt(' send you an occasional check-in? Only about things you told them, at most once a day.', ' 偶尔主动问候你吗？只聊你说过的事，每天最多一次。') + '</div><div class="acts"><button class="btn sm" data-act="notif.yes" data-arg="' + m.id + '">' + tt('Allow', '允许') + '</button><button class="btn sm ghost" data-act="card.dismiss" data-arg="' + m.id + '">' + tt('Not now', '暂不') + '</button></div>';
  if (m.kind === 'relChips') return m.done ? '' : '<div class="q">' + tt('How should ', '你希望 ') + n + tt(' show up for you?', ' 以什么身份陪你？') + '</div><div class="acts">' +
    Object.entries(PER.RELATIONS).map(([k, r]) => '<button class="chip" data-act="rel.pick" data-arg="' + m.id + ':' + k + '">' + esc(r[lang()]) + '</button>').join('') + '</div>';
  return '';
}
function refreshCard(m) { const el = document.getElementById('m-' + m.id); if (el) { el.innerHTML = cardHtml(m); el.style.display = el.innerHTML ? '' : 'none'; } }

/* streaming: one text node update per chunk batch */
let __streamRaf = 0, __streamBub = null, __streamText = '';
function showStream(msg, text) {
  const el = document.getElementById('m-' + msg.id); if (!el) return;
  const bub = el.querySelector('.bub');
  // one text node, one cursor span: only the text node's value changes while streaming. Re-writing
  // bub.textContent on every chunk rebuilt the whole bubble (and forced a reflow) for each few
  // tokens, which is what made long replies crawl.
  let lead = bub.firstChild;
  if (!lead || lead.nodeType !== 3) {
    bub.textContent = text;
    if (!text && Engine.status.state !== 'ready' && Engine.native) bub.textContent = engineLine();
    const cur = document.createElement('span'); cur.className = 'cur';
    bub.appendChild(cur); lead = bub.firstChild;
    scrollEnd();
    return;
  }
  __streamBub = lead; __streamText = text;
  // paint at most once a frame: chunks that arrive inside one frame are written together
  if (!__streamRaf) __streamRaf = requestAnimationFrame(() => {
    __streamRaf = 0;
    if (__streamBub && __streamBub.nodeValue !== __streamText) { __streamBub.nodeValue = __streamText; scrollEnd(); }
  });
  msg.partial = text;   // the words that reached the screen, so a re-render never takes them back
}
function finalizeMsg(msg) {
  const el = document.getElementById('m-' + msg.id); if (!el) return;
  el.replaceWith(msgNode(msg, S.msgs));
  scrollEnd();
}
function setBusy(msg) {
  BUSY = msg ? Object.assign(BUSY || {}, { msgId: msg.id }) : null;
  const b = $('#sendBtn'); if (!b) return;
  b.classList.toggle('stop', !!BUSY); b.textContent = BUSY ? '■' : '↑';
  b.dataset.act = BUSY ? 'chat.stop' : 'chat.send';
  if (msg && msg.pending) showStream(msg, '');
}
function updateReady() {
  const bar = $('#readyBar'); if (!bar) return;
  const s = Engine.status;
  const show = s.state !== 'ready';
  bar.classList.toggle('on', show);
  bar.innerHTML = show ? esc(engineLine()) + (s.progress && s.progress < 1 ? '<div class="bar" style="margin-top:6px"><i style="width:' + Math.round(s.progress * 100) + '%"></i></div>' : '') : '';
  if (BUSY) { const m = S.msgs.find(x => x.id === BUSY.msgId); const el = m && document.getElementById('m-' + m.id); if (el && !el.querySelector('.bub').textContent.replace(engineLine(), '').trim()) showStream(m, ''); }
}
let scrollRaf = 0;
function scrollEnd(force) {
  const box = $('#msgs'); if (!box) return;
  cancelAnimationFrame(scrollRaf);
  scrollRaf = requestAnimationFrame(() => { if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 220) box.scrollTop = box.scrollHeight; });
}
function filterMsgs(q) {
  const s = q.trim().toLowerCase();
  $$('#msgs > *').forEach(n => {
    const b = n.querySelector('.bub');
    if (!b) { n.style.display = s ? 'none' : ''; return; }
    const id = (n.id || '').slice(2); const m = S.msgs.find(x => x.id === id); const t = m ? m.content || '' : b.textContent;
    const hit = !s || t.toLowerCase().includes(s);
    n.style.display = hit ? '' : 'none';
    if (m && !m.pending) b.innerHTML = s && hit ? esc(t).replace(new RegExp(esc(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), x => '<mark>' + x + '</mark>') : esc(t);
  });
}
function showModeChips() {
  const qr = $('#qr'); if (!qr) return;
  qr.innerHTML = MIND.MODE_CHIPS[lang()].map(([k, l]) => '<button class="chip" data-act="chip.mode" data-arg="' + k + '">' + esc(l) + '</button>').join('');
}
function clearChips() { const qr = $('#qr'); if (qr) qr.innerHTML = ''; }

/* ---- actions ---- */
Actions['chat.send'] = () => { const inp = $('#inp'); const v = inp.value; if (!v.trim() || BUSY) return; inp.value = ''; inp.style.height = 'auto'; send(v); };
Actions['chat.stop'] = () => { if (!BUSY) return; BUSY.userStopped = true; Engine.stop(BUSY.id); };
Actions['chat.home'] = () => { if (nav.stack.length > 1) back(); else go('home', { reset: true }); };
Actions['chat.search'] = () => { const b = $('#searchBar'); const on = b.style.display === 'none'; b.style.display = on ? 'block' : 'none'; if (on) $('#searchInp').focus(); else { $('#searchInp').value = ''; filterMsgs(''); } };
Actions['chat.menu'] = () => openSheet('<h2>' + esc(S.character.name) + '</h2><div class="stack" style="margin-top:12px">' +
  '<button class="btn ghost" data-act="sheet.go" data-arg="character">' + tt('Companion settings', '角色设置') + '</button>' +
  '<button class="btn ghost" data-act="sheet.go" data-arg="memory">' + tt('What they remember', 'TA 记得的事') + '</button>' +
  '<button class="btn ghost" data-act="chat.newConv">' + tt('Start a fresh conversation', '开始新对话') + '</button>' +
  '<div class="row"><div class="grow"><div class="k">' + tt('Read replies aloud', '语音朗读回复') + '</div><div class="v">' + tt('Free · a stop button shows while speaking', '免费 · 朗读时会出现停止按钮') + '</div></div>' + sw(S.settings.voiceReply, 'chat.voice') + '</div>' +
  '<button class="btn ghost" data-act="sheet.go" data-arg="safety">' + tt('Safety help', '安全帮助') + '</button></div>');
Actions['sheet.go'] = id => { closeSheet(); go(id); };
Actions['chat.newConv'] = () => { const c = S.convs.find(x => x.id === S.convId); if (c) endConv(c, 'manual'); S.convId = null; closeSheet(); addMsg({ role: 'system', kind: 'sep' }); toast(tt('New conversation', '已开始新对话')); };
Actions['chat.voice'] = () => { S.settings.voiceReply = !S.settings.voiceReply; track('voice_reply_toggled', { on: S.settings.voiceReply }); if (!S.settings.voiceReply) stopSpeaking(); save(); Actions['chat.menu'](); };
Actions['chat.mic'] = () => {
  const b = $('#micBtn'), V = window.AndroidVoice;
  if (!V) { toast(tt('Voice input works in the Android app.', '语音输入需要在安卓 App 中使用。')); return; }
  if (b.classList.contains('rec')) { b.classList.remove('rec'); try { V.stopListening(); } catch (e) {} return; }
  b.classList.add('rec'); try { V.startListening(); } catch (e) { b.classList.remove('rec'); }
};
window.__tideSpeech = t => { const inp = $('#inp'); if (inp && t) { inp.value = t; Actions['chat.send'](); } };
window.__tideSpeechEnd = () => { const b = $('#micBtn'); if (b) b.classList.remove('rec'); };
window.__tideSpeechError = m => { window.__tideSpeechEnd(); if (m) toast(m); };
window.__micDeniedText = '';
Actions['chat.image'] = () => {
  if (!isPremium()) { paywall('image'); return; }
  toast(tt('Image understanding is coming in V1.1 — the on-device model can\'t see images yet.', '图片理解将在 V1.1 推出——目前的本机模型还看不了图片。'));
};

Actions['msg.up'] = id => {
  const m = S.msgs.find(x => x.id === id); if (!m) return;
  m.fb = m.fb === 'helpful' ? '' : 'helpful';
  if (m.fb) { S.rel.positiveFeedback++; track('feedback_submitted', { scope: 'reply', value: 'helpful', message_id: id }); }
  save(); finalizeMsg(m);
};
const REASONS = [['not_helpful', ['Not helpful', '没有帮助']], ['too_long', ['Too long', '太长']], ['too_cold', ['Too cold', '太冷淡']], ['inaccurate', ['Not accurate', '不准确']], ['dont_show', ["Don't show replies like this", '不想再看到这类回复']]];
Actions['msg.down'] = id => openSheet('<h2>' + tt('What was wrong?', '哪里不好？') + '</h2><div class="sub">' + tt('This changes how they reply to you.', '这会改变 TA 之后回复你的方式。') + '</div><div class="stack" style="margin-top:12px">' +
  REASONS.map(([k, l]) => '<button class="btn ghost" data-act="msg.reason" data-arg="' + id + ':' + k + '">' + esc(tt(l[0], l[1])) + '</button>').join('') + '</div>');
Actions['msg.reason'] = arg => {
  const [id, why] = arg.split(':'); const m = S.msgs.find(x => x.id === id); if (!m) return;
  m.fb = why; closeSheet();
  const conv = S.convs.find(x => x.id === m.convId); if (conv) conv.negative = true;
  track('feedback_submitted', { scope: 'reply', value: why, message_id: id });
  let note = tt('Thanks — noted.', '谢谢，已记录。');
  if (why === 'too_long') { const order = ['deep', 'medium', 'short']; const i = order.indexOf(S.character.len); if (i < 2) S.character.len = order[i + 1]; note = tt('Got it — shorter replies from now on.', '收到，之后回复会更短。'); }
  if (why === 'too_cold') { S.memories = MEM.upsert(S.memories, { type: 'commpref', slot: 'comm:warm', content: tt('Prefers warmer, more personal replies', '喜欢更温暖、更贴近自己的回复'), importance: 5, confidence: 1 }, { now: new Date(now()), confirmed: true }).list; note = tt('Got it — warmer replies from now on.', '收到，之后会更温暖一些。'); }
  if (why === 'dont_show') { S.avoid.push((m.content || '').split(/(?<=[.!?。！？])/)[0].slice(0, 60)); note = tt("Okay — I'll avoid replies like that.", '好的，以后避免这样回复。'); }
  save(); warmEngine(); finalizeMsg(m); toast(note);
};
Actions['msg.copy'] = id => {
  const m = S.msgs.find(x => x.id === id); if (!m) return;
  const done = () => toast(tt('Copied', '已复制'));
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(m.content).then(done, () => fallbackCopy(m.content, done));
  else fallbackCopy(m.content, done);
};
function fallbackCopy(t, cb) { const a = document.createElement('textarea'); a.value = t; document.body.appendChild(a); a.select(); try { document.execCommand('copy'); } catch (e) {} a.remove(); cb(); }
Actions['msg.regen'] = id => {
  if (BUSY) return;
  const i = S.msgs.findIndex(x => x.id === id); if (i < 0) return;
  const u = S.msgs.slice(0, i).reverse().find(x => x.role === 'user'); if (!u) return;
  S.msgs.splice(i, 1); const el = document.getElementById('m-' + id); if (el) el.remove();
  track('reply_regenerated', { message_id: id }); send(u.content, { regen: true });
};
Actions['msg.retry'] = id => Actions['msg.regen'](id);

Actions['mem.yes'] = id => confirmMemory(id);
Actions['mem.no'] = id => declineMemory(id);
Actions['mem.edit'] = id => { const m = S.msgs.find(x => x.id === id); if (!m) return;
  openSheet('<h2>' + tt('Edit before saving', '保存前编辑') + '</h2><textarea class="f" id="memEditInp" rows="3" style="margin-top:12px">' + esc(m.cand.content) + '</textarea>' +
    '<button class="btn" style="margin-top:12px" data-act="mem.editSave" data-arg="' + id + '">' + tt('Save', '保存') + '</button>'); };
Actions['mem.editSave'] = id => { const v = ($('#memEditInp').value || '').trim(); closeSheet(); if (v) confirmMemory(id, v); };
Actions['mem.undo'] = id => { const card = S.msgs.find(x => x.id === id); if (!card) return; MEM.remove(S.memories, card.memId); track('memory_deleted', { via: 'undo' }); save(); refreshCard(card); warmEngine(); };
Actions['mem.forget'] = id => { const card = S.msgs.find(x => x.id === id); if (!card) return; MEM.remove(S.memories, card.memId); track('memory_deleted', { via: 'chat' }); card.kind = 'memDone'; card.decision = 'declined'; save(); refreshCard(card); warmEngine(); toast(tt('Forgotten.', '已忘掉。')); };
Actions['card.dismiss'] = id => { const m = S.msgs.find(x => x.id === id); if (m) { m.done = true; m.kind = m.kind === 'forget' ? 'memDone' : m.kind; save(); refreshCard(m); } };
Actions['notif.yes'] = id => { const m = S.msgs.find(x => x.id === id); if (m) { m.done = true; refreshCard(m); } enableNotifications(); };
Actions['rel.pick'] = arg => { const [id, k] = arg.split(':'); const m = S.msgs.find(x => x.id === id); S.character.relation = k; if (m) { m.done = true; refreshCard(m); } track('relationship_set', { relation: k, where: 'chat' }); save(); warmEngine(); toast(tt('Got it.', '好的。')); };
Actions['chip.mode'] = k => { const c = ensureConv(); c.mode = k; clearChips(); send(MIND.CHIP_TEXT[k][lang()]); };
Actions['pro.mute'] = type => { if (!type) return; muteProactive(type); toast(tt('Okay — fewer messages like this.', '好的，这类消息会少发。')); };

function enableNotifications() {
  S.settings.notifications = true; save();
  track('notification_opt_in', {});
  if (BR) { try { if (!BR.notificationsAllowed()) BR.requestNotifications(); } catch (e) {} }
  else toast(tt('Check-ins will appear in the app.', '主动消息会显示在 App 内。'));
  planProactive();
}
window.__tideNotifResult = ok => { if (!ok) { toast(tt('Notifications are off in system settings — check-ins will still appear in the app.', '系统通知已关闭——主动消息仍会显示在 App 内。')); } planProactive(); };
/* Read aloud — "a flat robot" comes from one call for the whole paragraph at one rate and
   one pitch. Instead the WebView (which owns the text) splits the reply into clauses,
   gives each clause a rate/pitch from the feeling of its words, and leaves a small breath
   between clauses. VoiceBridge only renders what it is told. */
const VOICE_FEEL = {
  down: { rate: -0.10, pitch: -0.08, gap: 120 },
  soft: { rate: -0.04, pitch: -0.02, gap: 40 },
  lift: { rate: 0.06, pitch: 0.09, gap: -30 },
  warm: { rate: 0.00, pitch: 0.00, gap: 0 }
};
const VOICE_TEST = {
  down: /\b(sorry|hard|sad|tired|miss|wish|hurt|alone|rough|tough|awful|scared|worried|worries|worry|heavy|lonely|stress|stressed|exhausted)\b|难过|累|害怕|担心|对不起|可惜|孤单|难受|辛苦|不容易|紧张|焦虑|失眠|委屈|沮丧|烦/i,
  soft: /\b(maybe|perhaps|gently|quiet|slowly|rest|tonight|remember|okay|just|breathe)\b|也许|轻轻|慢慢|休息|今晚|记得|没关系|别急|慢慢来/i,
  lift: /\b(great|glad|happy|excited|love|nice|fun|wonderful|yay|yes|congrat)\b|太好了|开心|喜欢|真好|当然|耶|恭喜|棒/i
};
const VOICE_EMO = { joy: 'lift', calm: 'soft', lonely: 'down', anxious: 'down', stressed: 'down', sad: 'down', confused: 'soft' };
/* Why the voice sounded like a robot and what changed (v6.2)
   A platform TTS reads ONE string as one flat contour, however long it is. So the reply is
   read in short phrases, each phrase gets its position on a gentle arc (a soft start, a
   small rise in the middle, a lift on the last clause of a question), and the feeling of
   the reply — the emotion the model's classifier found, plus the words in each phrase —
   decides how wide the arc is and whether it is fast or slow: a sad reply is lower, slower,
   with longer breaths; a happy one is higher, quicker and runs on. The pause after a phrase
   is made by VoiceBridge (nothing is spoken during it), because queuing the phrases back to
   back made the engine run them together into one long flat line. */
function voicePlan(text, mood) {
  const p = persona(), v = (p && p.voice) || { rate: 1, pitch: 1 };
  const base = VOICE_EMO[mood] || (VOICE_TEST.down.test(text) ? 'down' : VOICE_TEST.lift.test(text) ? 'lift' : 'warm');
  const parts = String(text || '').replace(/[*_#]+/g, '').split(/(?<=[.?!;,。！？；，])(?!\d)\s*/).map(s => s.trim()).filter(Boolean).slice(0, 14);
  return parts.map((s, i) => {
    const feel = VOICE_TEST.lift.test(s) && base !== 'down' ? 'lift' : VOICE_TEST.down.test(s) ? 'down' : base;
    const f = VOICE_FEEL[feel], last = i === parts.length - 1, q = /[?？]\s*$/.test(s);
    /* v6.3: platform TTS draws ONE contour per utterance. Moving pitch on every phrase made the
       voice wobble (the "robot" feeling). So the persona's pitch is the centre, the phrase's
       feeling shifts it a little, and a clause keeps a small arc; nothing leaves ±0.13. */
    const arc = (last ? (q ? 0.06 : -0.02) : i === 0 ? -0.03 : 0.015) + (f.pitch || 0) * 0.6;
    const shortPause = /[;,，；]\s*$/.test(s) ? 90 : 0;
    return { text: s, feel, rate: Math.max(0.6, Math.min(1.5, (v.rate || 1) * (1 + f.rate))),
      pitch: Math.max(0.6, Math.min(1.6, (v.pitch || 1) + Math.max(-0.13, Math.min(0.13, arc)))),
      gap: Math.max(0, f.gap + VOICE_FEEL[base].gap + shortPause) };
  });
}
let VOICE_JOB = null;
/* One phrase at a time. VoiceBridge speaks a phrase only after the previous one reported
   done (onDone/onError/onStop) plus the phrase's own pause, so nothing is cut off and
   nothing runs together. If the platform never reports (some engines don't), the page's
   estimate moves on; a language with no voice data is read once as plain text instead. */
function voiceFinished(job, token, err) {
  const j = VOICE_JOB; if (!j || j !== job) return;
  if (token && j.token && token !== j.token) return;         // a late report from an earlier phrase
  clearTimeout(j.timer);
  job.timer = 0;
  if (err) { if (err !== 4) voicePlain(job); return; }       // 4 = the phrase was stopped on purpose
  job.next();
}
window.__orbitVoiceEnd = (id, err) => { const j = VOICE_JOB; if (j && j.token === id) voiceFinished(j, id, err || 0); };
/* v6.3: the bridge says when a phrase actually starts speaking. The page waits for that (or for
   ~2 s) before starting its safety estimate, so a phrase is never cut off on a slow engine and a
   phrase never begins late because the estimate for the previous one was too long. */
window.__orbitVoiceStart = id => {
  const j = VOICE_JOB; if (!j || j.token !== id) return;
  clearTimeout(j.timer);
  const c = j.plan[j.i - 1]; if (!c) return;
  j.timer = setTimeout(() => voiceFinished(j, j.token), c.text.length * (72 / c.rate) * 2.2 + 2500);
};
function voicePlain(job) {
  // the device has no data for this language: say the whole reply at the default rate
  const rest = job.plan.slice(job.i).map(c => c.text).join(' ');
  const V = window.AndroidVoice;
  job.plan = []; job.i = 0;
  try { V.speak(rest, 1, 1, 0, 0); } catch (e) {}
  job.plain = true;
}
function speak(text, opts) {
  const V = window.AndroidVoice; if (!V) return false;
  const mood = opts && opts.mood;
  try {
    stopSpeaking();
    const plan = voicePlan(text, mood);
    if (!plan.length) return false;
    const job = { plan, i: 0, timer: 0, token: '', plain: false };
    job.next = () => {
      if (VOICE_JOB !== job) return;
      if (job.plain || job.i >= plan.length) {
        VOICE_JOB = null;
        const vb = document.getElementById('voiceBar'); if (vb) { vb.style.display = 'none'; vb.classList.remove('on'); }
        return;
      }
      const c = plan[job.i++];
      job.token = 'orbit_' + Date.now() + '_' + job.i;
      const spoken = c.text.length * (72 / c.rate);           // ~72 ms per character at rate 1.0 (measured mid range)
      try { V.speak(c.text, c.rate, c.pitch, c.gap > 0 ? c.gap : 0); } catch (e) { return; }
      clearTimeout(job.timer);
      // the bridge waits for "done" and then the pause; the timer is only a safety net.
      // It starts when the phrase really starts (__orbitVoiceStart) or after 2 s, whichever is first.
      job.timer = setTimeout(() => voiceFinished(job, job.token), 2000 + spoken * 2.2 + c.gap);
    };
    VOICE_JOB = job;
    const vb = document.getElementById('voiceBar'); if (vb) { vb.style.display = 'block'; vb.classList.add('on'); }
    job.next();
    track('voice_reply_played', { clauses: plan.length, kind: (opts && opts.kind) || 'reply' });
    return true;
  } catch (e) { return false; }
}
function stopSpeaking() { try { const vb = document.getElementById('voiceBar'); if (vb) { vb.style.display = 'none'; vb.classList.remove('on'); } if (VOICE_JOB && VOICE_JOB.timer) clearTimeout(VOICE_JOB.timer); VOICE_JOB = null; const V = window.AndroidVoice; if (V) { V.reset ? V.reset() : V.stop(); } } catch (e) {} }
Actions['chat.stopVoice'] = () => stopSpeaking();
function refreshVoiceLang() { try { window.AndroidVoice && window.AndroidVoice.setLanguage(lang() === 'zh' ? 'zh-CN' : 'en-US'); } catch (e) {} }

/* end-of-conversation rating (PRD §2.4: 体验反馈为正向或中性) — once, only after a real conversation */
function maybeAskRating() {
  const c = S.convs.find(x => x.id === S.convId);
  if (!c || c.rating || c.askedRating || c.messageCount < 5) return;
  c.askedRating = true; save();
  setTimeout(() => openSheet('<h2>' + tt('How did that chat feel?', '刚才聊得怎么样？') + '</h2><div class="sub">' + tt('Optional — helps ', '可选——帮助 ') + esc(S.character.name) + tt(' get better for you.', ' 更懂你。') + '</div>' +
    '<div class="seg" style="margin-top:14px;justify-content:center">' +
    [['good', '😊 ' + tt('Good', '不错')], ['ok', '😐 ' + tt('Okay', '一般')], ['bad', '🙁 ' + tt('Not great', '不太好')]].map(([k, l]) => '<button data-act="conv.rate" data-arg="' + k + '">' + esc(l) + '</button>').join('') +
    '</div><button class="btn ghost" style="margin-top:14px" data-act="sheet.close">' + tt('Skip', '跳过') + '</button>'), 0);
}
Actions['conv.rate'] = k => {
  const c = S.convs.find(x => x.id === S.convId); if (c) { c.rating = k; if (k === 'bad') c.negative = true; }
  track('feedback_submitted', { scope: 'conversation', value: k }); closeSheet(); save(); toast(tt('Thank you.', '谢谢。'));
};
