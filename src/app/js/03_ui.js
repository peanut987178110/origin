/* 03_ui.js · router, sheet, toast, click delegation
   Navigation is synchronous: a view renders from local state and is on screen in the
   same frame. No step ever waits for the model, storage or network (v5's ~10 s waits
   came from awaiting an unreachable server before every page change). */
const Views = {};
const Actions = {};
const nav = { stack: [] };
const VShown = {};                  // what each view showed persistently (an open check-in on Home), so navigating away clears it
const app = document.getElementById('app');

function screen(id) {
  let el = document.getElementById('s-' + id);
  if (!el) { el = document.createElement('section'); el.className = 'scr'; el.id = 's-' + id; app.appendChild(el); }
  return el;
}
function go(id, opts) {
  VShown.homeCheckIn = '';             // going (back) to Home from elsewhere is a fresh visit: no sheet comes with it
  if (id !== 'home') closeSheet();     /* a sheet belongs to the page that opened it: no sheet survives a page change (it used to swallow the next page's taps). Home keeps an open check-in ("Reply" opens the check-in sheet over Home, see Views.home) */
  const o = opts || {};
  const t0 = performance.now();
  // leaving the current page counts as well: go() and the back key must run a page's leave() the same way
  if (o.reset) nav.stack = [];
  else if (o.replace) nav.stack.pop();
  const prev = nav.stack[nav.stack.length - 1];
  if (prev && prev !== id && Views[prev] && Views[prev].leave) Views[prev].leave();
  nav.stack.push(id);
  show(id, false, o);
  measure(id, t0);
}
function back() {
  /* the sheet case is checked first: a back press that only closes a sheet must not count as leaving Home */
  if ($('#sheet').classList.contains('on')) { closeSheet(); return 'handled'; }
  VShown.homeCheckIn = '';
  if (nav.stack.length <= 1) return 'exit';
  const leaving = nav.stack.pop();
  if (Views[leaving] && Views[leaving].leave) Views[leaving].leave();
  const t0 = performance.now();
  show(nav.stack[nav.stack.length - 1], true, {});
  measure(nav.stack[nav.stack.length - 1], t0);
  return 'handled';
}
function show(id, isBack, o) {
  $$('.scr.on').forEach(s => { if (s.id !== 's-' + id) { s.classList.remove('on', 'back'); const v = Views[s.id.slice(2)]; if (v && v.leave && !isBack) v.leave(); } });
  const el = screen(id);
  if (Views[id]) Views[id].render(el, o || {});
  el.classList.remove('on', 'back'); void el.offsetWidth;
  el.classList.add('on'); if (isBack) el.classList.add('back');
  if (Views[id] && Views[id].after) Views[id].after(el, o || {});
}
/* Transition timing: time from tap to the new screen's first painted frame. Shown in the
   dashboard and checked by tools/orbit_web_test.js / orbit_device_test.js. */
function measure(id, t0) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const ms = Math.round(performance.now() - t0);
    S.perf.push({ id, ms, at: now() });
    (window.__navTimes = window.__navTimes || []).push({ id, ms });
  }));
}
/* The last page of a pushed flow (the paywall, opened from anywhere) is not where the user came
   from. Going back from it returns to the page underneath, so a paywall opened over Chat comes
   back to Chat — it used to depend on whichever page happened to be left over below it. */
window.__orbitFrom = '';
window.__orbitBack = function () {
  if ($('#sheet').classList.contains('on')) { closeSheet(); return 'handled'; }
  const top = nav.stack[nav.stack.length - 1];
  if (window.__orbitFrom && top === 'premium') { go(window.__orbitFrom, { replace: true }); window.__orbitFrom = ''; return 'handled'; }
  if (window.__orbitFrom && top !== window.__orbitFrom) window.__orbitFrom = '';
  return back();
};

function rerender() { const id = nav.stack[nav.stack.length - 1]; if (id && Views[id]) Views[id].render(screen(id), { soft: true }); }

function openSheet(html) { $('#pane').innerHTML = html; $('#sheet').classList.add('on'); }
function closeSheet() { $('#sheet').classList.remove('on'); }
let toastTimer = 0;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2200); }

/* data-press="name" data-arg="x" → Actions.name(x, element, event) on the TOUCHDOWN itself.
   For buttons whose page re-renders on press: the browser dispatches "click" on the parent
   after pointer-up, and by then the pressed button has been replaced, so the click never
   reaches it. pointerdown is delivered to whatever is under the finger at that instant, and
   preventing the default stops the compatibility click (one press, one action). */
let pressConsumed = false;
/* actions that only ever run on the press. A finger or a mouse sometimes ends its press on another
   element than the one it went down on (the page re-rendered under it, or the sheet that just opened
   covers it), and some pressers cancel the click — so these buttons do not wait for a click at all */
const PRESS_ONLY = /^(claw[.](grab|swap|settle|done|again))$/;
const vTouchIR = () => (window.matchMedia && matchMedia('(pointer: coarse)').matches);
document.addEventListener('pointerdown', e => {
  const el = e.target.closest && e.target.closest('[data-press]');
  if (!el || el.disabled || el.classList.contains('disabled')) return;
  if ($('#sheet').classList.contains('on') && !e.target.closest('#pane')) return;
  /* a keyboard ``Enter'' on a focused button fires click without any pointer: run it on click, never on a press */
  if (e.pointerType === '' && e.detail === 0) return;
  /* on a touch screen the compatibility click that follows already lands on the pressed button (the sheet is
     gone, the cabinet has not moved), so it is dropped; on a fine pointer it is how the keyboard-free click path works */
  if (e.pointerType === 'mouse' && vTouchIR()) pressConsumed = true;
  const name = el.dataset.press, fn = Actions[name];
  if (typeof fn !== 'function') return;
  e.preventDefault();
  fn(el.dataset.arg != null ? el.dataset.arg : null, el, e);
}, { passive: false });

/* data-act="name" data-arg="x" → Actions.name(x, element, event) */
document.addEventListener('click', e => {
  /* A sheet covers the page: while one is open, a button underneath it must not act. A real click
     cannot reach it (the sheet is on top), but automation and a stale queued click still could —
     and then "Start focus" ran while the claw result sheet was up. Inside the sheet everything
     works as usual. */
  if ($('#sheet').classList.contains('on') && !e.target.closest('#pane')) return;
  /* the click a mouse press generates right after a data-press action has already acted: drop it once */
  if (pressConsumed) { pressConsumed = false; return; }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  if (PRESS_ONLY.test(el.dataset.act)) return;
  const fn = Actions[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el.dataset.arg, el, e); }
});
Actions['sheet.close'] = closeSheet;
Actions['nav.back'] = () => {                        // 10_play.js wraps window.__orbitBack so the hardware back key leaves a round cleanly
  const r = window.__orbitBack ? window.__orbitBack() : back();
  return r === 'exit' ? undefined : r;
};
Actions['nav.go'] = id => go(id);
Actions['nav.tab'] = id => go(id, { reset: true });

function tabs(active) {
  const T = [['home', '◎', tt('Home', '首页')], ['chat', '✦', tt('Chat', '聊天')], ['life', '✿', tt('Together', '一起')], ['memory', '❋', tt('Memories', '记忆')], ['settings', '⚙', tt('Settings', '设置')]];
  return '<nav class="tabs">' + T.map(([id, ic, label]) =>
    '<button data-act="nav.tab" data-arg="' + id + '" class="' + (active === id ? 'on' : '') + '"><b>' + ic + '</b>' + esc(label) + '</button>').join('') + '</nav>';
}
function topBar(title, right) {
  return '<header class="top"><button class="ib" data-act="nav.back" aria-label="back">‹</button><h2>' + esc(title) + '</h2>' + (right || '') + '</header>';
}
function sw(on, act, arg) { return '<button class="sw ' + (on ? 'on' : '') + '" data-act="' + act + '"' + (arg ? ' data-arg="' + esc(arg) + '"' : '') + ' role="switch" aria-checked="' + !!on + '"></button>'; }
function seg(items, cur, act) {
  return '<div class="seg">' + items.map(([k, label]) => '<button class="' + (k === cur ? 'on' : '') + '" data-act="' + act + '" data-arg="' + esc(k) + '">' + esc(label) + '</button>').join('') + '</div>';
}
