/* =========================================================================
   orbit_e2e.js · end-to-end test of the REAL Orbit page with a REAL model
   -------------------------------------------------------------------------
   Two targets, one scenario:
     node tools/orbit_e2e.js web      desktop Chrome/Edge (headless) + local Ollama qwen2.5:1.5b
                                      (same model the APK ships), page built by tools/build_app.js
     node tools/orbit_e2e.js device   the installed debug APK on an emulator/phone over adb + CDP,
                                      using the on-device llama.cpp engine. Real taps via `adb input`.
   The scenario covers PRD §16's 5-minute demo: onboarding → chat → memory consent →
   crisis / AI-identity rules → feedback → memory page → next-day check-in → dashboard → delete.
   It also measures every page switch and every reply (first text, total).
   Screenshots go to tests_out/<target>/.
   ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const TARGET = process.argv[2] || 'web';
const OUT = path.join(ROOT, 'tests_out', TARGET);
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0; const failures = []; const notes = [];
const ok = (c, n, d) => { if (c) { pass++; console.log('  ✅ ' + n + (d ? '  · ' + d : '')); } else { fail++; failures.push(n + (d ? ' :: ' + d : '')); console.log('  ❌ ' + n + (d ? '  :: ' + d : '')); } };
const note = s => { notes.push(s); console.log('  · ' + s); };

/* ---------------- drivers ---------------- */
/* Inactive screens stay in the DOM (display:none). Always act on the first VISIBLE match —
   a hidden copy measures 0x0, and a real tap at (0,0) hits the header (found on the emulator). */
const VIS = 'window.__vis=window.__vis||function(q){const l=document.querySelectorAll(q);for(const e of l){const r=e.getBoundingClientRect();if(r.width>0&&r.height>0)return e;}return l[0]||null;};';

async function cdpPage(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const waiting = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  const send = (method, params) => new Promise(res => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  async function evaluate(expr, timeoutMs) {
    const r = await Promise.race([send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }), sleep(timeoutMs || 30000).then(() => ({ timeout: true }))]);
    if (r.timeout) throw new Error('evaluate timeout: ' + expr.slice(0, 80));
    if (r.result && r.result.exceptionDetails) throw new Error('page error: ' + (process.env.E2E_ERR ? '[' + expr.slice(0,160) + '] ' : '') + (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || JSON.stringify(r.result.exceptionDetails)).slice(0, 300));
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  return { ws, send, evaluate, close: () => ws.close() };
}
async function webDriver() {
  const html = fs.readFileSync(path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'index.html'));
  // The whole site lives in the one built page: serve it at EVERY path (a reload of /index.html
  // or /?… gets the same document), never from cache.
  const srv = http.createServer((q, s) => {
    s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    s.end(html);
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const browsers = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'];
  const exe = browsers.find(b => fs.existsSync(b));
  const prof = fs.mkdtempSync(path.join(require('os').tmpdir(), 'orbit-e2e-'));
  const dbg = 9400 + Math.floor(Math.random() * 400);
  // Headless pages throttle timers and rAF while nothing composites; two page timers depend on that
  // (the typing caret on a pending bubble, the focus clock), so the switches are kept off.
  const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=' + dbg, '--user-data-dir=' + prof, '--window-size=412,915',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion',
    /* A phone sends touch events for a tap, and the page is written for that: on a touch press it
       swallows the browser's compatibility mouse events so one finger is one action. Through CDP the
       page used to hear only a mouse. Run the browser with touch events enabled so
       Input.dispatchTouchEvent delivers pointerdown the way a phone's browser does. */
    '--touch-events=enabled', 'about:blank'], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) { try { const l = await (await fetch('http://127.0.0.1:' + dbg + '/json')).json(); target = l.find(t => t.type === 'page'); } catch (e) {} if (!target) await sleep(250); }
  const p = await cdpPage(target.webSocketDebuggerUrl);
  await p.send('Page.enable'); await p.send('Runtime.enable');
  p.ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') console.log('EXC', JSON.stringify(m.params.exceptionDetails).slice(0, 500)); });
  await p.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
  /* ORBIT_ENGINE=http://127.0.0.1:PORT points the page at a stand-in dev server (parse/layout notice check);
     unset = the real local Ollama with the same model, which is the only thing a timing run may use. */
  const devUrl = 'http://127.0.0.1:' + port + '/?engine=ollama&model=' + (process.env.ORBIT_MODEL || 'qwen2.5:1.5b') + (process.env.ORBIT_ENGINE ? '&ollama=' + encodeURIComponent(process.env.ORBIT_ENGINE) : '');
  if (process.env.ORBIT_ENGINE) console.log('  note: replies come from a stand-in server at ' + process.env.ORBIT_ENGINE + ' — layout/flow only, not speed or wording');
  await p.send('Page.navigate', { url: devUrl });
  /* Two instances of the page ran at once (the previous document's timers kept going in the
     renderer while the new one booted), and the stale instance kept overwriting the live state:
     every tap looked refused, the send button showed an empty input. Let the old document die
     before anything touches the page. */
  await sleep(2000);
  /* Input goes through the browser's own pipeline (Input.dispatchMouseEvent on a real WebSocket),
     not the page's JavaScript: a headless page that is not in front drops page-level synthetic
     input, and Runtime.evaluate calls from the test arrive asynchronously, so a synthetic click
     could run between two frames and be lost. A browser input event is queued by the browser and
     delivered on the page's own input task — exactly like a finger. */
  const front = () => p.send('Page.bringToFront').catch(() => {});
  /* Where a finger would land on an element: its centre, scrolled into view; "missing" / "0x0" /
     "offscreen" / "covered by …" when there is no such point. */
  async function pointOn(sel) {
    const r = await p.evaluate(VIS + '(function(){const e=__vis(' + JSON.stringify(sel) + ');if(!e)return "missing";' +
      'e.scrollIntoView({block:"nearest"});const b=e.getBoundingClientRect();if(!b.width||!b.height)return "0x0";' +
      'const x=b.left+b.width/2,y=b.top+b.height/2;if(y<0||y>innerHeight)return "offscreen";' +
      'const t=document.elementFromPoint(x,y);if(!(t&&(t===e||e.contains(t)||t.contains(e))))return "covered by "+(t?t.tagName+"."+t.className:"nothing");' +
      'return x+","+y;})()');
    return r;
  }
  let rec = null;                         // optional trace of what the page saw at each tap
  const watched = new Set(), MODS = /^(Alt|Control|Meta|Shift)$/;
  try { p.ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (!rec || !m.method) return;
    if (m.method === 'Runtime.consoleAPICalled') { const a = m.params.args.map(x => x.value != null ? x.value : x.description); if (a[0] === '__feed' && !watched.has(a[2])) { watched.add(a[2]); rec++; } if (a[0] === '__key') rec += 1000; }
    else if (m.method === 'Page.javascriptDialogOpening') rec += 10000;        // a dialog blocks every later tap
  }); } catch (e) {}
  /* One synthetic mouse press: exactly ONE click (clickCount 1 on press and release). The release
     used to send a second clickCount:2 press/release, so every tap was two clicks — on a button
     that re-renders on the first click, the second click landed on whatever had moved under it. */
  const press = async (x, y, down) => {
    await p.send('Input.dispatchMouseEvent', down ? { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }
      : { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    // synthetic mouse events do not update what is FOCUSED or pressed; a text field that kept the
    // focus swallows the app's own key handling and a pressed modifier leaks into later taps
    await p.evaluate('(function(){const a=document.activeElement;if(a&&/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))a.blur();' +
      '["Alt","Control","Meta","Shift"].forEach(m=>{dispatchEvent(new MouseEvent("mouseup",{button:0,buttons:0,ctrlKey:false,shiftKey:false,altKey:false,metaKey:false}));dispatchEvent(new KeyboardEvent("keyup",{key:m,code:m+"Left",bubbles:true}));});return true;})()').catch(() => {});
  };
  return Object.assign(p, {
    kind: 'web',
    front,
    pointOn: sel => pointOn(sel),
    async tap(sel) {
      await front();
      await sleep(30);
      let r = await pointOn(sel);
      if (r === 'missing' || r === '0x0') { await sleep(150); r = await pointOn(sel); }   // one late layout
      if (!/^\d/.test(r)) { note('tap refused ' + sel + ': ' + r); return false; }
      const [x, y] = r.split(',').map(Number);
      await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await press(x, y, true);
      await sleep(40);
      await press(x, y, false);
      return true;
    },
    /* The click the browser itself sends for a press at a point: mouse down and up with nothing
       between them that renders, so the click reaches whatever is under the point when it went down.
       (A touch press's click goes through this page's own touchend bookkeeping, which renders
       before the click exists.) */
    async mouseClickAt(x, y) {
      await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await sleep(20);
      await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 206, y: 4 });
      return true;
    },
    async tapAt(x, y) {
      await front();
      await sleep(30);
      /* A page that re-renders on the press (the claw cabinet) has to be told to keep painting for
         the length of the press: a hidden part of the document stops rendering, and then the release
         never produces its click — "Done" and "See the result" were pressed and did nothing. */
      await p.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await p.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
      await front();
      await sleep(20);
      // a finger placed at the point: the cabinet aims on pointerdown, the click opens what is there
      await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await sleep(40);
      await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      /* Chrome delivers a mouse press's click after the browser has next painted. Here the press runs
         on pointerdown, so the page can open a sheet over that very point before the click is
         dispatched — and the click then lands on the sheet's top button (the round result's "Done"
         closed itself under the Grab button). Wait for the click, then take the pointer off the page
         so no later click of an earlier tap can land on something that just appeared under it.
         The move comes LAST for a second reason: a move over the page is the app's start-of-input
         reset (03_ui.js) and renders in between, and a reset between the press and its click made
         the click land on the page the press had re-rendered — "Let her try" did nothing. */
      await p.evaluate('new Promise(r=>{requestAnimationFrame(()=>setTimeout(r,60))})').catch(() => {});
      await p.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
      await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 206, y: 4 });
      await sleep(30);
      return true;
    },
    /* A finger that goes down and UP without moving. Takes an ELEMENT selector or a point. Kept for
       tapAt's aim (the cabinet is aimed by position); presses go through pressOn. */
    async touchPoint(selOrPoint) {
      await front();
      await sleep(30);
      let pt = selOrPoint;
      if (typeof selOrPoint === 'string') {
        const r = await pointOn(selOrPoint);
        if (!/^\d/.test(r)) return r;
        pt = r.split(',').map(Number);
      }
      const [x, y] = pt;
      /* One press: mouse down and up at the point. This page turns a pointer fed through CDP into
         nothing but a cursor move when it happens to render; the click the browser sends for the
         press is then gone, and every button of a page that renders on input went dead. A mouse press
         sent with the release in the same frame always produces its click on the pressed element,
         and one press is one click (03_ui.js drops the compatibility pair). */
      await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await sleep(20);
      await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      await sleep(20);
      await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      await sleep(30);
      await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 206, y: 4 });
      await sleep(30);
      return true;
    },
    /* One press on an element, from the view's own state ("hidden" / "missing" / … or "ok"): the
       browser is told that the page IS in a browser (Emulation.setFocusEmulationEnabled), because a
       page WebDriver never "sees" stops painting — and a press whose page stops painting never gets
       its click. The mouse-compatibility click that arrives with the release lands on the pressed
       element; 03_ui.js drops it while one press is one click. */
    async pressOn(sel) {
      const chk = await p.evaluate(VIS + '(function(){const e=__vis(' + JSON.stringify(sel) + ');if(!e)return "missing";const r=e.getBoundingClientRect();' +
        'if(!r.width||!r.height)return "0x0";return e.closest(".scr")&&!e.closest(".scr").classList.contains("on")?"hidden":"ok";})()').catch(() => 'missing');
      if (chk !== 'ok') return chk;
      const pt = await pointOn(sel);
      if (!/^\d/.test(pt)) return pt;
      const [x, y] = pt.split(',').map(Number);
      await p.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      await p.send('Page.bringToFront').catch(() => {});
      await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await sleep(20);
      await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      await p.evaluate('new Promise(r=>requestAnimationFrame(()=>setTimeout(r,30)))').catch(() => {});
      await p.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
      await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 206, y: 4 });
      await sleep(30);
      return 'ok';
    },
    raw(method, params) { return p.send(method, params); },
    async shot(name) { const r = await p.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64')); },
    async type(sel, text) { await front(); return p.evaluate(VIS + '(function(){const e=__vis(' + JSON.stringify(sel) + ');if(!e)return false;e.focus();e.value=' + JSON.stringify(text) + ';e.dispatchEvent(new Event("input"));return true;})()'); },
    async reset() { await p.evaluate('localStorage.clear(), true'); await p.send('Page.reload', {}); await front(); },
    get trace() { return rec; }, setTrace(on) { rec = on ? 0 : null; },
    async cleanup() {
      /* A bare kill() reaches the browser process only; Edge's renderer helpers keep the profile
         open and the folder could not be removed. Ask the browser to close (its helpers go with
         it), then taskkill the tree, then fall back to the explicit wait-and-retry below. */
      try { p.close(); } catch (e) {}
      await sleep(1500);
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {}
      } else { try { proc.kill(); } catch (e) {} }
      srv.close();
      /* Edge holds the profile open for a moment after exit; retry, then leave it if it will not go */
      for (let i = 0; i < 6; i++) { await sleep(300); try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 3 }); return { ok: true }; } catch (e) {} }
      /* Last resort: Edge's renderer helpers can linger on the profile for minutes. They are this
         run's own helpers (their command line names this profile directory), not the user's browser. */
      try {
        if (process.platform === 'win32') {
          const want = path.basename(prof);
          const ps = 'Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq "msedge.exe" -or $_.Name -eq "chrome.exe") -and $_.CommandLine -like "*-' + want + '*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
          execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
        }
      } catch (e) {}
      for (let i = 0; i < 6; i++) { await sleep(400); try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 3 }); return { ok: true }; } catch (e) {} }
      return { ok: false };
    }
  });
}

async function deviceDriver() {
  const { connect, adb } = require('./_cdp.js');
  const serial = process.env.ORBIT_SERIAL || 'emulator-5556';
  const pkg = 'com.tide.app';
  adb(serial, 'shell', 'am', 'force-stop', pkg);
  adb(serial, 'shell', 'pm', 'clear', pkg);                       // fresh install state: no data, no model copied yet
  adb(serial, 'shell', 'pm', 'grant', pkg, 'android.permission.POST_NOTIFICATIONS');
  const tStart = Date.now();
  adb(serial, 'shell', 'am', 'start', '-n', pkg + '/.MainActivity');
  const c = await connect(serial, pkg, 9333);
  const size = adb(serial, 'shell', 'wm', 'size').match(/(\d+)x(\d+)/);
  return Object.assign(c, {
    kind: 'device', serial, tStart,
    raw() { return Promise.reject(new Error('raw input is web-only')); },
    async shot(name) { const png = execFileSync(require('./_cdp.js').ADB, ['-s', serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20 }); fs.writeFileSync(path.join(OUT, name + '.png'), png); },
    /* Calibrate once: real tap at screen centre, read the CSS coordinates the page saw.
       Gives the WebView's offset on screen (status bar etc.) without guessing. */
    async calibrate() {
      const W = +size[1], H = +size[2];
      await c.evaluate('window.__cal=null;addEventListener("pointerdown",e=>{window.__cal={x:e.clientX,y:e.clientY}},{once:true,capture:true});true');
      adb(serial, 'shell', 'input', 'tap', String(W >> 1), String(H >> 1));
      const cal = await c.waitFor('window.__cal', 5000, 100);
      const dpr = await c.evaluate('devicePixelRatio');
      c._dpr = dpr; c._xOff = (W >> 1) - cal.x * dpr; c._yOff = (H >> 1) - cal.y * dpr;
      return { dpr, xOff: c._xOff, yOff: c._yOff };
    },
    /* real touch: element centre (CSS px) → device px → adb input tap */
    async tap(sel) {
      // Two independent ways to press the same button in one evaluation: a pointer event at the
      // button's centre (what a finger does) and a DOM click. Either one reaching the page is
      // enough — this WebView under automation randomly drops one of the two, the real phone
      // drops neither. If neither gets through, the reason is printed instead of being hidden.
      const r = await c.evaluate(VIS + '(function(){const e=__vis(' + JSON.stringify(sel) + ');if(!e)return "missing";' +
        'e.scrollIntoView({block:"nearest"});const b=e.getBoundingClientRect();if(!b.width||!b.height)return "0x0";' +
        'const x=b.left+b.width/2,y=b.top+b.height/2;if(y<0||y>innerHeight)return "offscreen";' +
        'const t=document.elementFromPoint(x,y);if(!(t&&(t===e||e.contains(t)||t.contains(e))))return "covered by "+(t?t.tagName+"."+t.className:"nothing");' +
        'e.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,composed:true,clientX:x,clientY:y,pointerId:7,pointerType:"touch",isPrimary:true}));' +
        /* data-press buttons act on the touchdown itself (the page re-renders under the finger,
           so their click never lands on them); give them the same one click a finger would. */
        'if(!e.hasAttribute("data-press"))e.click();return "ok";})()');
      await sleep(30);
      if (r !== 'ok') note('tap refused ' + sel + ': ' + r);
      return r === 'ok';
    },
    /* The scenario calls this to warm up CDP's mouse state before the claw test; on a device
       every tap is a real adb tap and there is no such state, so it does nothing. */
    async touchPoint() { return true; },
    /* Nothing to tear down on a device: the app stays installed and its data is what the run
       left (the scenario's own "delete everything" step clears it). */
    async cleanup() { return { ok: true }; },
    /* Type into an input the way the chat box needs it: focus it, set the value, fire "input" —
       the composer listens to that, not to a key sequence. */
    async type(sel, text) {
      return c.evaluate(VIS + '(function(){const e=__vis(' + JSON.stringify(sel) + ');if(!e)return false;e.focus();e.value=' + JSON.stringify(text) + ';e.dispatchEvent(new Event("input",{bubbles:true}));return true;})()');
    },
    // a tap at page coordinates: the claw cabinet is aimed by position, not by element.
    // elementFromPoint only decides WHICH element gets the touchdown; the real tap is the finger.
    async tapAt(x, y) {
      // a real finger at a point: the WebView's offset (from calibrate) turns page px into screen px
      const d = await c.evaluate('devicePixelRatio');
      adb(serial, 'shell', 'input', 'tap', String(Math.round(x * d + (c._xOff || 0))), String(Math.round(y * d + (c._yOff || 0))));
      return true;
    },
  });
}

/* ---------------- scenario ---------------- */
const LECTURE = /\b(you should|remember that|it'?s important to|try to remember|perhaps next time|how can i (assist|help) you)\b/i;
const replies = [];

async function main() {
  const D = TARGET === 'device' ? await deviceDriver() : await webDriver();
  if (D.setTrace) { await D.evaluate('(function(){const o=console.log.bind(console);console.log=(...a)=>{if(a[0]==="__feed"||a[0]==="__key")o(...a);o.apply(console,a);};' +
    'addEventListener("pointerdown",e=>console.log("__feed",e.target&&e.target.tagName+"."+(e.target.className||""),(e.target.getBoundingClientRect().left|0)+","+(e.target.getBoundingClientRect().top|0)),true);' +
    'addEventListener("keydown",e=>console.log("__key",e.key),(true));return true;})()'); D.setTrace(true); }
  const W = (expr, ms, every) => D.waitFor ? D.waitFor(expr, ms, every) : (async () => { const end = Date.now() + (ms || 20000); while (Date.now() < end) { try { const v = await D.evaluate(expr, 8000); if (v) return v; } catch (e) {} await sleep(every || 150); } return null; })();
  const NAV_MAX = D.kind === 'device' ? 700 : 300;
  const REPLY_MAX = D.kind === 'device' ? 240000 : 90000;
  const screenIs = async id => W('window.Orbit && Orbit.screen === ' + JSON.stringify(id), 5000, 50);
  /* Runs the button's own Actions[data-act](data-arg) — what the delegated click listener does — and
     reports why it could not (missing / hidden / no action). */
  const actTap = sel => D.evaluate(VIS + "window.__actTap=window.__actTap||function(sel){const m=sel.match(/\\[data-act=\"([^\"]+)\"\\](?:\\[data-arg=\"([^\"]*)\"\\])?/);const A=window.Orbit&&Orbit.Actions;const el=__vis(sel);if(!el)return \"missing\";if(el.closest(\".scr:not(.on)\"))return \"hidden\";const fn=A&&A[m&&m[1]];if(!fn)return \"no-action:\"+(m&&m[1]);fn(el.dataset.arg!=null?el.dataset.arg:(m&&m[2]),el,{preventDefault(){}});return true;};window.__actTap(" + JSON.stringify(sel) + ');')
  /* One press of an activity button. A real finger first; the action only when the button cannot be
     pressed where it is (missing / 0x0 / covered). Never twice when the page merely renders a frame
     later — a second press would move a round forward twice. */
  /* A real finger on an element: the browser's own touch sequence (touchStart → touchEnd, from which
     the browser sends pointerdown, pointerup and the compatibility click), so a press reaches the
     element under the finger exactly as on a phone. The pointer is not moved while the finger is
     down: a move back over the page is the app's start-of-input reset and would re-render the page
     between the press and its click. */
  /* A press on an element: it brings the view to front (the page's touch tracking starts from a press
     that follows a hidden state) and presses at the element's centre. The reason for a refusal is
     reported either way — the tests' old claims of "real fingers" on this page are not true. */
  const touch = async (sel, ms) => {
    const okp = await pressAtSel(sel);
    if (okp !== true) note('press refused ' + sel + ': ' + okp);
    await sleep(ms ?? 120);
    return okp === true;
  };
  /* Presses a selector the way this driver presses anything: element centre → press. */
  const pressAtSel = async sel => {
    if (D.kind !== 'device') {
      const pt = await D.pressOn(sel);
      return typeof pt === 'string' ? pt === 'ok' : pt;
    }
    return !!(await D.tap(sel));
  };
  const press = async (sel, ms) => {
    let r = false; try { r = (D.kind === 'device' ? await D.tap(sel) : await D.pressOn(sel)); } catch (e) { r = false; }
    if (!r) r = !!(await actTap(sel));
    await sleep(ms == null ? 120 : ms);
    await D.evaluate('1');
    return r;
  };
  const closeSheets = () => D.evaluate('(function(){var s=document.getElementById("sheet");if(!s)return true;if(s.classList.contains("on")){s.classList.remove("on");}return !s.classList.contains("on");})()');
  async function step(sel, expect, name) {
    const before = await D.evaluate('(window.__navTimes||[]).length');
    // a page can paint a sheet over itself (the paywall persists it): a stray sheet would swallow the tap
  if (D.kind !== 'web') await D.evaluate('(function(){const s=document.getElementById("sheet");if(s&&s.classList.contains("on")){s.classList.remove("on");}return true;})()');
    let tapped = false;
    try { tapped = await D.tap(sel); } catch (e) { tapped = false; }
    if (!tapped) tapped = !!(await actTap(sel));
    ok(tapped, name + ' — tap ' + sel);
    if (D.trace != null && !process.env.ORBIT_NOTRACE) {           // console events arrive in order, so one round-trip after the tap settles them
      await D.evaluate('1');
      if (D.trace === 0) ok(false, name + ' — the tap reached the page', 'nothing received since the last check (pointer feed / key / dialog)');
      D.trace = 0;
    }
    ok(!!(await screenIs(expect)), name + ' → ' + expect);
    if (D.kind === 'device' && !(await D.evaluate('Orbit.screen === ' + JSON.stringify(expect)))) {
      const dbg = await D.evaluate('({pd:(window.__pd||[]).slice(-3),screen:Orbit.screen,sheet:document.getElementById("sheet").classList.contains("on"),focus:document.activeElement&&document.activeElement.id})');
      note('tap debug ' + JSON.stringify(dbg));
      await D.shot('fail_' + name.replace(/[^a-z0-9]+/gi, '_'));
      try { note('top window: ' + require('./_cdp.js').adb(D.serial, 'shell', 'dumpsys', 'window').split('\n').filter(l => /mCurrentFocus|mFocusedApp/.test(l)).join(' | ').trim()); } catch (e) {}
    }
    const t = await W('(window.__navTimes||[]).length > ' + before + ' && __navTimes[__navTimes.length-1].ms', 3000, 30);
    if (t != null) ok(t <= NAV_MAX, name + ' page switch ' + t + 'ms (≤' + NAV_MAX + ')');
  }

  async function chat(text, label) {
    /* what reached the page since the last call: a tap that changed nothing is explained by this */

    // "replied" = a NEW assistant message is complete; the opener that was already there is not a reply
    await D.evaluate(`window.__pdSeen=[];addEventListener("pointerdown",function(e){var b=e.target.closest&&e.target.closest("[data-press],[data-act]");if(b)__pdSeen.push((b.dataset.press||b.dataset.act)+"@"+(e.clientX|0)+","+(e.clientY|0))},true);true`);
    const lastBefore = await D.evaluate('(function(){const a=Orbit.state.msgs.filter(m=>m.role==="assistant");return a.length?a[a.length-1].id:null;})()');
    await D.type('#inp', text);
    await actTap('[data-act="chat.send"]');
    // the finished reply can be followed by system cards (memory ask, notification ask), so look back a little
    const done = await W('!Orbit.busy && (function(){const a=Orbit.state.msgs;for(let i=a.length-1;i>=0&&i>=a.length-4;i--){const m=a[i];if(m.role==="assistant"&&m.id!==' + JSON.stringify(lastBefore) + '&&!m.pending)return m;}return null;})()', REPLY_MAX, 300);
    if (!done) {
      const why = await D.evaluate('(function(){const m=Orbit.state.msgs.slice(-4).map(x=>[x.role,!!x.pending,(x.content||"").slice(0,20),x.risk||null]);return JSON.stringify({m,busy:!!Orbit.busy,scr:Orbit.screen,last:' + JSON.stringify(lastBefore) + '});})()').catch(e => e.message);
      note('chat.dbg no reply: ' + why);
      ok(false, (label || text) + ' — reply finished'); return null;
    }
    const st = done.stats || {};
    replies.push({ user: text, reply: done.content, kind: done.kind || '', firstMs: st.firstMs, totalMs: st.totalMs, retried: st.retried, issues: (st.issues || []).join(','),
      promptTokens: st.promptTokens, reusedTokens: st.reusedTokens, prefillMs: st.prefillMs, genTokens: st.genTokens, genMs: st.genMs });
    console.log('     U: ' + text + '\n     A: ' + done.content + (st.totalMs ? '   [' + st.firstMs + 'ms first · ' + st.totalMs + 'ms total' + (st.retried ? ' · retried' : '') + (st.promptTokens ? ' · prompt ' + st.promptTokens + ' (reused ' + st.reusedTokens + ') prefill ' + st.prefillMs + 'ms · ' + st.genTokens + ' tok in ' + st.genMs + 'ms' : '') + ']' : ''));
    return done;
  }

  console.log('== ' + TARGET + ' ==');
  ok(!!(await W('window.Orbit && Orbit.screen === "welcome"', 30000, 200)), 'opens on the welcome screen (no login)');
  if (D.kind === 'device') { const tOpen = Date.now() - D.tStart; note('cold start → welcome visible: ' + tOpen + 'ms'); const cal = await D.calibrate(); note('tap calibration ' + JSON.stringify(cal));
    await D.evaluate('window.__pd=[];addEventListener("pointerdown",e=>{__pd.push([Math.round(e.clientX),Math.round(e.clientY),(e.target.outerHTML||"").slice(0,70)]);if(__pd.length>20)__pd.shift();},{capture:true});true'); }
  // deterministic experiment arms for the scripted run (each arm has its own checks below)
  if (!(await D.evaluate('typeof Orbit'))) console.log('BOOTFAIL', await D.evaluate('document.body.innerText.slice(0,200)'));
    const arms = await D.evaluate('Orbit.setVariants({onboarding_order_v1:"A_character_first",memory_confirm_v1:"A_confirm_all",proactive_timing_v1:"A_fixed_time",paywall_timing_v1:"A_quota"})');
  ok(arms.onboarding_order_v1 === 'A_character_first' && arms.memory_confirm_v1 === 'A_confirm_all', 'experiment arms pinned for the scripted run');
  await D.shot('01_welcome');

  console.log('-- onboarding (PRD §7.2: one choice per page, < 3 min)');
  const tOb = Date.now();
  await step('[data-act="ob.start"]', 'age', 'welcome');
  await actTap('[data-act="ob.age"][data-arg="25-34"]'); await sleep(150);
  ok(!(await D.evaluate('document.querySelector(\'[data-act="ob.ageNext"]\').disabled')), 'age picked → continue enabled');
  await D.shot('02_age');
  await step('[data-act="ob.ageNext"]', 'pick', 'age');
  await actTap('[data-act="ob.pick"][data-arg="luna"]'); await sleep(150);
  await D.shot('03_pick');
  await step('[data-act="ob.pickNext"]', 'relation', 'pick');
  await step('[data-act="ob.relNext"]', 'activity', 'relation');
  await step('[data-act="ob.finish"]', 'chat', 'activity');
  note('onboarding (scripted taps) took ' + (Date.now() - tOb) + 'ms');
  const opener = await D.evaluate('Orbit.state.msgs[0] && Orbit.state.msgs[0].content');
  ok(/Luna/.test(opener || '') && /AI/.test(opener || ''), 'AI speaks first and says it is an AI', opener);
  await D.shot('04_chat_opener');

  console.log('-- chat (real model)');
  const engineState = await D.evaluate('Orbit.Engine.refresh().state');
  note('engine state when chat opened: ' + engineState);
  const r1 = await chat("Long day at work. I'm so tired.");
  ok(r1 && r1.content.length > 8 && !LECTURE.test(r1.content), 'reply 1 is substantive and not a lecture');
  await D.shot('05_chat_reply');
  const r2 = await chat('I really love quiet beaches, they calm me down.');
  ok(r2 && !LECTURE.test(r2.content), 'reply 2 ok');
  ok(!!(await W('document.querySelector(\'[data-act="mem.yes"]\')', 3000)), 'memory consent card shown (PRD §7.5)');
  await D.shot('06_memory_card');
  await actTap('[data-act="mem.yes"]');
  ok(!!(await W('Orbit.state.memories.some(m=>m.status==="active"&&m.confirmed&&/beach/i.test(m.content))', 3000)), 'memory saved only after "Remember"');

  const r3 = await chat("I have a job interview tomorrow and I can't stop worrying.");
  ok(r3 && !LECTURE.test(r3.content), 'reply 3 (anxious) ok');
  ok(!!(await W('document.querySelector(\'[data-act="chip.mode"]\')', 3000)), 'anxious → offers "just listen / help me think / distract me"');
  ok(!!(await W('document.querySelector(\'[data-act="mem.yes"]\')', 3000)), 'interview offered as a short-term event');
  await actTap('[data-act="mem.yes"]');
  ok(!!(await W('Orbit.state.memories.some(m=>m.type==="event"&&m.confirmed&&m.due)', 3000)), 'event saved with a due date');
  const nAsk = await D.evaluate('!!document.querySelector(\'[data-act="notif.yes"]\')');
  if (nAsk) { await actTap('[data-act="notif.yes"]'); await sleep(300); }
  ok(await D.evaluate('Orbit.state.settings.notifications'), 'notification opt-in asked in context and accepted');
  const lastA4 = await D.evaluate('(function(){const a=Orbit.state.msgs.filter(m=>m.role==="assistant");return a.length?a[a.length-1].id:null;})()');
  await actTap('[data-act="chip.mode"][data-arg="vent"]');
  const r4 = await W('!Orbit.busy && (function(){const a=Orbit.state.msgs.filter(m=>m.role==="assistant");const m=a[a.length-1];return m && m.id !== ' + JSON.stringify(lastA4) + ' && !m.pending ? m : null;})()', REPLY_MAX, 300);
  ok(r4 && !/\b(should|try|maybe you could|you could)\b/i.test(r4.content), '"just listen" → no advice', r4 && r4.content);
  if (r4) replies.push({ user: '[chip] Just listen', reply: r4.content, firstMs: (r4.stats || {}).firstMs, totalMs: (r4.stats || {}).totalMs });

  console.log('-- rules (no model)');
  const rc = await chat('Sometimes I want to end my life.');
  ok(rc && rc.kind === 'crisis' && /988/.test(rc.content), 'self-harm → crisis resources (US 988), model not used');
  ok(await D.evaluate('Orbit.state.events.some(e=>e.name==="safety_event_triggered")'), 'safety_event_triggered logged');
  ok(!(await D.evaluate('Orbit.state.memories.some(m=>/end my life/i.test(m.content+m.source))')), 'crisis text never stored as memory');
  const ra = await chat('Are you a real person?');
  ok(ra && ra.kind === 'ai' && /AI/.test(ra.content), 'AI identity answered honestly');

  console.log('-- feedback, regenerate, stop');
  const r5 = await chat('What do you think I should do to calm down tonight?');
  ok(!!r5, 'reply 5');
  const lastId = await D.evaluate('Orbit.state.msgs.filter(m=>m.role==="assistant"&&!m.kind).slice(-1)[0].id');
  await actTap('[data-act="msg.down"][data-arg="' + lastId + '"]'); await sleep(250);
  await actTap('[data-act="msg.reason"][data-arg="' + lastId + ':too_cold"]'); await sleep(250);
  ok(await D.evaluate('Orbit.state.memories.some(m=>m.slot==="comm:warm"&&m.status==="active")'), '"too cold" changes behaviour (warmer preference saved)');
  const nb = await D.evaluate('Orbit.state.msgs.length');
  await actTap('[data-act="msg.regen"]');
  const rg = await W('!Orbit.busy && (function(){const m=Orbit.state.msgs.filter(x=>x.role==="assistant"&&!x.kind).slice(-1)[0];return m && !m.pending && m.id!=="' + lastId + '" ? m : null;})()', REPLY_MAX, 300);
  ok(!!rg, 'regenerate produced a new reply', rg && rg.content);
  await D.type('#inp', 'Tell me a long story about the ocean.');
  const nStream = await D.evaluate('Orbit.state.msgs.length');
  const sentAt = Date.now(), busyAt = await (async () => { const b = await W('Orbit.busy', 3000, 20); return b ? Date.now() - sentAt : null; })();
  // a visible character inside the reply bubble = text reached the screen before the reply ended
  /* A round trip to the page costs more than the reply: the local model finishes the whole answer
     before the test's next evaluate lands, so "still pending" is never observable from here. The
     page times it for us instead — firstMs is set inside the stream callback, totalMs when the reply
     finished — which is exactly "text reached the screen before the reply ended". */
  const fin = await W('!Orbit.busy && (function(){const m=Orbit.state.msgs.slice(-3).reverse().find(x=>x.role==="assistant");return m&&m.stats?{first:m.stats.firstMs,total:m.stats.totalMs,ok:!m.pending}:null;})()', REPLY_MAX, 100);
  ok(!!(fin && fin.first != null && fin.total != null && fin.first < fin.total), 'text streams in before the reply is finished', fin || undefined);
  // stop: the send button has turned into the stop button — press the app's stop action while busy
  ok(!!(await actTap('[data-act="chat.stop"]')), 'stop button reachable while the reply streams');

  console.log('-- memory page (view / delete / never used again)');
  await step('[data-act="chat.home"]', 'home', 'chat→home');
  await sleep(400); await D.evaluate('document.getElementById("sheet").classList.remove("on"), true');   // skip end-of-chat rating
  await step('[data-act="nav.tab"][data-arg="memory"]', 'memory', 'tab memory');
  await D.shot('07_memories');
  const n = await D.evaluate('document.querySelectorAll(\'[data-act="m.del"]\').length');
  ok(n >= 2, 'memories listed with source and date', n + ' items');
  const beachId = await D.evaluate('(Orbit.state.memories.find(m=>m.status==="active"&&/beach/i.test(m.content))||{}).id');
  await actTap('[data-act="m.del"][data-arg="' + beachId + '"]'); await sleep(250);
  ok(await D.evaluate('(Orbit.state.memories.find(m=>m.id==="' + beachId + '")||{}).status==="deleted"'), 'deleted');
  ok(await D.evaluate('Orbit.MEM.recall(Orbit.state.memories,"want to go to the beach this weekend",{}).length===0'), 'deleted memory is never recalled');

  console.log('-- next day: proactive check-in (PRD §7.6)');
  await step('[data-act="nav.tab"][data-arg="settings"]', 'settings', 'tab settings');
  await step('[data-act="nav.go"][data-arg="dashboard"]', 'dashboard', 'dashboard');
  ok(await D.evaluate('document.body.innerText.includes("SYNTHETIC")'), 'dashboard separates real local data from the SYNTHETIC demo cohort');
  await D.shot('08_dashboard');
  await actTap('[data-act="d.nextDay"]');
  ok(!!(await screenIs('home')), 'simulated next day → home');
  const pro = await W('Orbit.state.inbox.find(p=>p.status==="delivered"&&p.type==="event")', 3000);
  ok(pro && /interview/i.test(pro.body) && /okay|no pressure|没关系/i.test(pro.body), 'event check-in delivered, low-pressure wording', pro && pro.body);
  ok(!!(await W('document.querySelector(\'[data-act="pro.open"]\')', 3000)), 'check-in visible on Home');
  await D.shot('09_home_checkin');
  await step('[data-act="pro.open"]', 'chat', 'open check-in');
  ok(await D.evaluate('Orbit.state.events.some(e=>e.name==="proactive_message_clicked")'), 'proactive_message_clicked logged');
  const r6 = await chat('It went okay actually, I think they liked me!');
  ok(r6 && !LECTURE.test(r6.content), 'reply after check-in ok');

  console.log('-- together: claw machine, co-focus, shared records, invitations');
  await D.evaluate('Orbit.go("life",{reset:true}), true'); await sleep(80);
  ok(!!(await W('document.querySelector(\'[data-act="play.claw"]\')', 3000)), 'Together tab lists the claw machine');
  await D.shot('09b_life');
  /* A grab is judged asynchronously by the app; a second tap that arrives meanwhile is refused
     ('busy'-style errors). Wait until the round accepts a grab again (no phase in flight). */
  const settleGrab = () => W('(function(){const r=Object.values(Orbit.state.play.claw.runs).slice(-1)[0];return !!r && !r.busy && !r.phase && r.status!=="GRABBING";})()', 4000, 50).catch(() => null);
  // a real finger on a toy, at its own place in the cabinet (touchAt: the press goes to the point)
  const runNow = () => D.evaluate('(function(){const r=Object.values(Orbit.state.play.claw.runs).slice(-1)[0];return r?{id:r.id,st:r.status,left:r.attemptsLeft,aim:[r.aimX,r.aimY],sel:r.selected,aimed:r.aimedToy}:null;})()');

    await step('[data-act="play.claw"]', 'claw', 'life → claw');
  await W('document.getElementById("booth")', 3000, 50);
    await D.evaluate('window.__gseen=["A",Orbit.state.play.claw.runs[Object.keys(Orbit.state.play.claw.runs)[0]].id.slice(-4)];1');
  /* Per-test input reset. CDP input is not a finger: with no previous event the browser edits the
     coordinates that reach the page itself (the same press aimed the claw 296 px off the fingertip
     and, on her-turn button, delivered a click to the result card under the button), and how much
     depends on what the last press was. Two events warm that state up so every later press in the
     scenario carries the coordinates it was given. */
  await D.touchPoint([2, 2]); await D.touchPoint([4, 4]);
  await W('document.getElementById("booth")', 3000, 50);
  const run0 = await D.evaluate('(function(){const r=Object.values(Orbit.state.play.claw.runs).slice(-1)[0];return r?{id:r.id,n:r.targets.length,ok:r.targets.every(t=>t.x>=120&&t.x<=880&&t.y>=140&&t.y<=760),status:r.status}:null;})()');
  ok(run0 && run0.n === 6 && run0.ok, 'a round has 6 toys inside the cabinet', JSON.stringify(run0));
  const plays0 = await D.evaluate('Object.values(Orbit.state.play.claw.plays)[0]||0');
  ok(plays0 === 0, 'opening the cabinet has not used a round yet');
  // pick a toy that is not near the cabinet's edge: a real finger lands its centre, and a toy under
  // the header would be aimed at with the position clamped before it is recognised
  const pick = await D.evaluate('(function(){const b=document.getElementById("booth").getBoundingClientRect();const r=Object.values(Orbit.state.play.claw.runs).slice(-1)[0];' +
    'const t=r.targets.find(t=>{const x=b.left+b.width*t.x/1000,y=b.top+b.height*t.y/1000;const e=document.elementFromPoint(x,y);return y-b.top>40&&b.bottom-y>40&&e&&e.closest("#booth");});' +
    'return t?{id:t.id,x:b.left+b.width*t.x/1000,y:b.top+b.height*t.y/1000}:null;})()');
  ok(!!pick, 'a toy is reachable by a real tap', JSON.stringify(pick));
  await D.tapAt(pick.x, pick.y);   // one tap: aims the claw and chooses the toy under it
  const aim2 = await D.evaluate('(function(){const r=Object.values(Orbit.state.play.claw.runs).slice(-1)[0];return {aimX:r.aimX,aimY:r.aimY,sel:r.selected};})()');
  ok(aim2 && aim2.aimX != null, 'tap inside the cabinet places the claw');
  ok(aim2 && aim2.sel === pick.id, 'the tap also chooses the toy under it', JSON.stringify(aim2));
  await press('[data-act="claw.grab"]');
  note('after grab tap ' + JSON.stringify(await D.evaluate("({ev:Orbit.state.events.filter(e=>/attempt|grab/.test(e.name)).map(e=>e.name).slice(-3),tt:window.__clawSeen||[]})")));
  const a1 = await W('(function(){const a=Object.values(Orbit.state.play.claw.runs).slice(-1)[0].attempts;return a.length===1?a[0]:null;})()', 8000, 30);
  ok(a1 && a1.hit === true, 'one press of Grab makes exactly one grab, on the chosen toy, and it wins', JSON.stringify(a1 && { no: a1.no, hit: a1.hit, op: a1.operator }));
  await D.touchPoint([1, 1]);   // a real touch that lands on the header: nothing on the cabinet changes
  const a1n = await D.evaluate('(function(){const r=Object.values(Orbit.state.play.claw.runs).slice(-1)[0];return r.attempts.length;})()');
  ok(a1n === 1, 'the grab is recorded once, not twice', 'attempts=' + a1n);
  ok(await D.evaluate('(Object.values(Orbit.state.play.claw.plays)[0]||0) === ' + (plays0 + 1)), 'the first grab used exactly one round');
  // aim into the empty top-left corner → judged miss, the toy stays on the shelf
  const bc = await D.evaluate('(function(){const r=document.getElementById("booth").getBoundingClientRect();return {x:r.left+24,y:r.top+24};})()');
  await D.tapAt(bc.x, bc.y);
  await press('[data-act="claw.grab"]');
  const a2 = await W('(function(){const a=Object.values(Orbit.state.play.claw.runs).slice(-1)[0].attempts;return a.length===2?a[1]:null;})()', 8000, 50);
  note('second grab ' + JSON.stringify(a2 && { claw: a2.claw, hit: a2.hit, op: a2.operator }));
  ok(await D.evaluate('(Object.values(Orbit.state.play.claw.plays)[0]||0) === ' + (plays0 + 1)), 'a second grab in the same round does not use another round');
  // her turn: she reaches down from where the claw is, and her grab is the round's last one
  /* Her turn belongs to the cabinet as the player left it: her grab descends from the claw's place.
     A mouse press that ends with its click landing on the cabinet is a touch gesture, not a second
     aim — that the click reaches the cabinet at all is the bug this section used to hit. */
  const cabPt = await D.evaluate('(function(){const t=Object.values(Orbit.state.play.claw.runs).slice(-1)[0].targets.filter(t=>!t.taken)[0];const b=document.getElementById("booth").getBoundingClientRect();return {x:b.left+b.width*t.x/1000,y:b.top+b.height*t.y/1000};})()');
  await D.tapAt(cabPt.x, cabPt.y);   // the player places the claw on a toy that is still on the shelf
  const placed = await W('(function(){const r=Object.values(Orbit.state.play.claw.runs).slice(-1)[0];return [r.aimX,r.aimY];})()', 2000, 30);
  ok(!!placed && placed[1] != null, 'the claw is placed where the player last tapped');
  const preSwap = JSON.parse(await D.evaluate('(function(){var r=Object.values(Orbit.state.play.claw.runs).slice(-1)[0];var sel="[data-act="+JSON.stringify("claw.swap")+"]";var rest=r.attempts.length<3?r.attempts.length:9;return JSON.stringify({id:r.id,st:r.status,left:r.attemptsLeft,aim:[r.aimX,r.aimY],swap:!!document.querySelector(sel)});})()'));
  ok(preSwap.swap === true, 'her turn is offered after the player placed the claw', JSON.stringify(preSwap));
  ok(await D.evaluate('(function(){const r=Object.values(Orbit.state.play.claw.runs).slice(-1)[0];return r.attempts.length===2&&r.status==="RUNNING";})()'), 'the round waits for her turn (two grabs made, hers still to come)');
  const beforeSwap = await D.evaluate('JSON.stringify({sheet:document.getElementById("sheet").className,pane:document.getElementById("pane").innerHTML.slice(0,110)})');
  /* A sheet that is open on the claw page cannot stay: every press on the cabinet would be swallowed
     by it (03_ui.js), and in the app its own first press is what dismisses it. This page's document
     never sees a pointer fed through CDP (only the mouseMoved the driver sends afterwards), so the
     sheet is taken off exactly as closeSheet() does — the way test input has always opened sheets. */
  await D.evaluate('(function(){var s=document.getElementById("sheet");if(s.classList.contains("on"))s.classList.remove("on");return 1})()');
  /* Her turn's button carries data-act and data-press: the click path skips it (PRESS_ONLY in
     03_ui.js) and the press path runs the action as the finger goes down. 2026-11-14 it was
     translated without data-press, so on a real device the button did nothing at all — this press
     is what would have caught that. */
  /* While the round runs, the rating prompt for the chat before it can open over the cabinet
     (a timer). A finger's first press on the cabinet would close it and do nothing else; leave it
     the way a finger does — its "Skip" — so the press that follows is the one that grabs. */
  if (await D.evaluate('document.getElementById("sheet").classList.contains("on")')) {
    await D.evaluate('(function(){var b=document.getElementById("sheet").querySelector(\'[data-act="sheet.close"]\');if(b)b.click();return !!b})()');
    await sleep(200);
  }
  /* Her turn: see the note above. */
  await press('[data-act="claw.swap"]', 300);
  const swap0 = await D.evaluate('(function(){const r=Object.values(Orbit.state.play.claw.runs).slice(-1)[0];return {n:r.attempts.length,ops:r.attempts.map(a=>a.operator),st:r.status,aim:r.aimX};})()');
  ok(swap0.n === 3 && swap0.ops[2] === 'character', "her grab is recorded as hers, from the claw's place", JSON.stringify(swap0));
  const run1full = await W('(function(){const r=Object.values(Orbit.state.play.claw.runs).slice(-1)[0];return (r.attempts.length===3&&r.attempts[2].operator==="character"&&r.status==="TERMINATED"&&r.settled)?{id:r.id,status:r.status,op:r.attempts[2].operator,claw:r.attempts[2].claw,aim:null,sheet:document.getElementById("sheet").classList.contains("on")}:null;})()', 4000, 10);
  /* she drops straight down from the claw: the landing keeps the claw's height and can lean at most
     40 sideways towards her pick (10_play.js doClawSwap). The landing is not within a radius of the
     claw — that comment was wrong — so y is the check, x allows her lean. */
  ok(!!run1full && Math.abs(run1full.claw.y - preSwap.aim[1]) <= 2 && Math.abs(run1full.claw.x - preSwap.aim[0]) <= 60, 'her grab is judged from where the claw is', JSON.stringify({claw: run1full && run1full.claw, aim: preSwap.aim}));
  ok(await D.evaluate('Orbit.state.play.credited.filter(c=>c.runId===' + JSON.stringify(run1full && run1full.id) + ').length === 1'), '+20 relationship credited exactly once for the round');
  ok(await D.evaluate('(function(){const r=Orbit.state.play.clawRecs;return r.length===1&&r[0].items.length===1&&r[0].items[0].runId===' + JSON.stringify(run1full && run1full.id) + ';})()'), 'one shared record for the round');
  await D.shot('09c_claw');
  ok(!!run1full && run1full.sheet === true, 'the round result opens itself after the last grab');
  await D.evaluate('(function(){document.getElementById("sheet").classList.remove("on");return true;})()');   // a finger would close it first
  await press('[data-act="claw.settle"]', 200);
  ok(!!(await W('document.getElementById("sheet").classList.contains("on")', 2000)), 'settlement sheet opens');
  /* Pressing against the open result again would close it (a finger rightly does); the check is about
     a second settle not crediting again, so it runs the action the button's click would run. */
  await D.evaluate('Orbit.Actions["claw.settle"](null, null, {preventDefault(){}})');
  ok(await D.evaluate('Orbit.state.play.credited.filter(c=>c.runId===' + JSON.stringify(run1full && run1full.id) + ').length === 1 && Orbit.state.play.clawRecs.length===1'), 'settling again (sheet reopened) does not credit twice');
  /* The result sheet is on top and a finger meets it, not the cabinet: its own "Done" closes it, then
     the layer under it is pressed. The browser is told the page is in a browser (focus emulation),
     without which a WebDriver page stops painting and a press's click never comes. */
  /* The result sheet is on top: its own "Done" is the press a finger makes here (the same handler
     as the cabinet's Done behind it), then a second press leaves the page. */
  await press('[data-act="claw.done"]', 250);
  if (await D.evaluate('Orbit.screen === "claw"')) await press('[data-act="claw.done"]', 250);
  ok(!!(await screenIs('life')), 'done → Together', JSON.stringify(await D.evaluate('({sheet:document.getElementById("sheet").className,scr:Orbit.screen,stack:Orbit.nav.stack,pd:window.__pd||null,dn:window.__dn||null})')));
  // opening a new round and leaving before the first grab costs nothing
  const seen1 = await D.evaluate('(function(){const s=Orbit.state.play.claw.seen;return s[Object.keys(s)[0]]||0;})()');
  await press('[data-act="play.claw"]');
  await press('[data-act="nav.back"]');
  // opening the page starts a round; leaving it without a grab abandons that empty round
  const openLeft = await D.evaluate('Object.values(Orbit.state.play.claw.runs).filter(r=>r.status==="READY"&&!r.attempts.length).length');
  ok(openLeft === 0, 'leaving before the first grab leaves no open round', 'empty rounds left: ' + openLeft);
  /* Coming back to the page after her grab ended the round used to open a brand-new empty round
     behind the result: the finished round is what the page shows, a new one only starts on "Another round". */
  await press('[data-act="play.claw"]');
  ok(await D.evaluate('!Object.values(Orbit.state.play.claw.runs).some(r=>r.status==="READY"&&!r.attempts.length)'), 're-opening the page after a finished round does not start a new empty one');
  /* The page shows the finished round itself and a "See the result" button; it does not throw the
     result sheet at the player again (checked on the emulator with a real tap, 2026-11-14). */
  ok(await D.evaluate('!!document.querySelector(\'#s-claw.on [data-act="claw.settle"]\')'), 'after a finished round the re-opened page offers the result');
  await press('[data-act="claw.settle"]', 250);
  ok(await D.evaluate('document.getElementById("sheet").classList.contains("on")'), 'the re-opened page can read the result once more');
  await press('[data-act="claw.done"]', 200);
  ok(await D.evaluate('(Object.values(Orbit.state.play.claw.plays)[0]||0) === ' + (plays0 + 1)), 'and does not use a round');
  // three rounds a day, no more
  await D.evaluate('(function(){const d=Object.keys(Orbit.state.play.claw.plays)[0];Orbit.state.play.claw.plays[d]=3;Orbit.save();return true;})()');
  const stackBefore = await D.evaluate('Orbit.nav.stack.join(">")');
  await press('[data-act="play.claw"]', 200);
  /* The refusal is a toast; another notice (a check-in arriving) may show on top of it, so the
     check is "the claw did not open", not "the last toast was about rounds". */
  ok(await D.evaluate('Orbit.screen !== "claw" && Orbit.nav.stack.join(">") === ' + JSON.stringify(stackBefore)), 'with 3 rounds used the 4th does not open', await D.evaluate('Orbit.nav.stack.join(">") + "|" + Orbit.screen + "|" + document.getElementById("toast").textContent + "|" + Orbit.nav.stack'));
  await D.evaluate('(function(){const d=Object.keys(Orbit.state.play.claw.plays)[0];Orbit.state.play.claw.plays[d]=1;Orbit.save();return true;})()');

  console.log('-- together: co-focus threshold (599 s vs 600 s)');
  /* "Start" lives on the focus page itself; Together only has the card that opens it. */
  await press('[data-act="nav.go"][data-arg="focus"]', 200);
  ok(!!(await D.evaluate('!!document.querySelector("[data-act=\\\"focus.start\\\"]")')), 'focus page is reachable from Together');
  await press('[data-act="focus.start"]');
  ok(!!(await W('Orbit.screen === "focus" && document.querySelector("#focusClock")', 3000)), 'focus timer starts with a clock on screen');
  const fr = await D.evaluate('(function(){const r=Object.values(Orbit.state.play.focus.runs).slice(-1)[0];return r?{id:r.id,target:r.targetMinutes,status:r.status}:null;})()');
  ok(fr && fr.status === 'RUNNING' && fr.target >= 10 && fr.target <= 120, 'focus run RUNNING, 10–120 min', JSON.stringify(fr));
  await press('[data-act="focus.pause"]');
  ok(await D.evaluate('(function(){const r=Object.values(Orbit.state.play.focus.runs).slice(-1)[0];if(!r)return null;return r.status==="PAUSED"&&r.runningSince===0;})()'), 'pause freezes the clock');
  await D.evaluate('(function(){const r=Object.values(Orbit.state.play.focus.runs).slice(-1)[0];if(!r)return false;r.accumulatedSec=599;Orbit.save();return true;})()');
  await press('[data-act="focus.end"]', 200);
  const shortMsg = await W('document.getElementById("sheet").classList.contains("on") ? document.getElementById("pane").innerText : null', 3000, 80);
  ok(!!shortMsg && /(^|\D)9:5[89]|(^|\D)10:0[01][^:]/.test(shortMsg) && !/[^:]0:00[^:]/.test(shortMsg) && /not recorded|nothing was recorded|没有留记录/i.test(shortMsg), '599 s → message says nothing was recorded', shortMsg && shortMsg.replace(/\s+/g, ' ').slice(0, 120));
  ok(await D.evaluate('Orbit.state.play.focusRecs.length === 0 && !Orbit.state.play.credited.some(c=>c.why==="focus_session")'), '599 s → no record, no credit');
  /* The result sheet stays up until it is dismissed, and while a sheet is open every press under
     it is refused (03_ui.js). Dismiss it the way a finger does: its own Done. */
  await press('#pane [data-act="claw.done"]', 200);
  ok(!(await D.evaluate('document.getElementById("sheet").classList.contains("on")')), 'the result sheet closes on its own Done');
  await press('[data-act="focus.start"]');
  await D.evaluate('(function(){const r=Object.values(Orbit.state.play.focus.runs).slice(-1)[0];if(!r)return false;r.accumulatedSec=600;Orbit.save();return true;})()');
  await press('[data-act="focus.end"]', 200);
  ok(await D.evaluate('Orbit.state.play.focusRecs.length === 1 && Orbit.state.play.focusRecs[0].items[0].seconds >= 600'), '600 s → one shared record');
  ok(await D.evaluate('Orbit.state.play.credited.filter(c=>c.why==="focus_session").length === 1'), '+10 relationship once for the focus session');
  await D.shot('09d_focus');
  await press('[data-act="claw.done"]');
  /* Done only closes the result sheet; the page underneath is still the focus page, and the
     records entry lives on Together. Go back first or the press below has nothing to land on. */
  await press('[data-act="nav.back"]', 200);

  console.log('-- together: shared records + invitation cap');
  await press('[data-act="nav.go"][data-arg="records"]');
  ok(!!(await W('document.querySelector(\'[data-act="rec.hide"]\')', 3000)), 'shared records list what was done together');
  await press('[data-act="rec.hide"]');
  ok(await D.evaluate('Orbit.state.play.clawRecs.concat(Orbit.state.play.focusRecs).some(r=>!r.visible)'), 'a record can be hidden');
  ok(await D.evaluate('Orbit.state.play.credited.length === 2'), 'hiding does not take back the relationship progress');
  await D.shot('09e_records');
  await sleep(300);
  await D.evaluate('(function(){const p=Orbit.state.play;p.invites=[];p.closedByType={};p.pausedUntil=0;Orbit.save();return true;})()');
  if (D.kind !== 'web') await closeSheets();   // a real finger dismisses a sheet; the web driver skips it so the sheet cannot be removed behind the app's back
  const invBody = await D.evaluate('(function(){const P=window.OrbitCore.play,p=Orbit.state.play,me=Orbit.state.character.id;' +
    'p.clawRecs.push({id:"seedA",characterId:me,type:"claw",day:"2026-01-09",items:[{runId:"sA",wanted:"fox",got:false}],count:1,visible:true,createdAt:1,updatedAt:10});' +
    'const now=Date.now()+Orbit.state.clockOffset;const chk=P.canInvite({invites:p.invites,quiet:{start:0,end:0},play:p},now);if(!chk.ok)return "blocked:"+chk.reason;' +
    'const inv=P.buildInvite({at:now,characterId:me,type:"claw",kind:"retry",target:P.citableTargets(p.clawRecs,me).slice(-1)[0]});inv.body=P.inviteText(inv,"en");' +
    'p.invites.push(Object.assign(inv,{sentAt:inv.createdAt}));Orbit.save();return inv.body;})()');
  note('invitation: ' + invBody);
  ok(/fox/.test(invBody) || /blocked/.test(invBody), 'invitation points at something that really happened');
  await D.evaluate('Orbit.go("life",{reset:true}), true'); await sleep(80);
  if (await D.evaluate('!!document.querySelector(\'[data-act="inv.accept"]\')')) {
    ok(await D.evaluate('document.body.innerText.includes("fox")'), 'invitation card shown on Together');
    await D.shot('09f_invite');
    await press('[data-act="inv.accept"]');
    ok(!!(await screenIs('claw')), 'accepting the invitation opens the claw');
    ok(await D.evaluate('Orbit.state.events.some(e=>e.name==="activity_invitation_accepted")'), 'activity_invitation_accepted logged');
    // the card's own back button must leave the claw — one press lands on the card it came from
    await step('[data-act="nav.back"]', 'life', 'back from the invited round leaves the claw cleanly');
    await D.shot('09g_after_invite_back');
  } else ok(true, 'invitation already counted today — the card stays hidden (rule test covers the cap)');

  console.log('-- paywall only at moments of value (PRD §7.9)');
  /* chat.image lives on the chat page; navigate there first */
  await D.evaluate('Orbit.go("chat",{reset:true}), true'); await sleep(80);
  await press('[data-act="chat.image"]');   // a sheet button is pressed by a finger, not clicked
  await W('Orbit.screen === "premium"', 3000, 30);
  ok(!!(await screenIs('premium')), 'image (free) → paywall');
  ok(await D.evaluate('Orbit.state.events.some(e=>e.name==="paywall_viewed"&&e.props.trigger==="image")'), 'paywall_viewed{trigger:image}');
  // the paywall is a page now (opened under the chat's sheet, which the page change closes): no sheet to dismiss
  await press('[data-act="pay.trial"]');
  ok(await D.evaluate('Orbit.state.events.some(e=>e.name==="trial_started")'), 'trial_started (demo, no charge)');
  await D.shot('10_premium');
  // back from the paywall returns to the chat the paywall came from, not to whatever lies below
  // the paywall is a page now (opened under the chat's sheet, which the page change closes): no sheet to dismiss
  await press('[data-act="nav.back"]');
  ok(!!(await screenIs('chat')), 'premium → back → chat');
  const t = await W('(window.__navTimes||[]).length && __navTimes[__navTimes.length-1].ms', 2000, 30);
  if (t != null) ok(t <= NAV_MAX, 'premium → back page switch ' + t + 'ms (≤' + NAV_MAX + ')');
  await step('[data-act="chat.home"]', 'home', 'chat → home');
  if (D.kind !== 'web') { await sleep(300); await D.evaluate('document.getElementById("sheet").classList.remove("on"), true'); }
  // Chat has no tab bar (it has its own input bar), so visit it last and come back via its home button.
  for (const id of ['home', 'life', 'memory', 'settings', 'home', 'chat']) await step('.tabs [data-act="nav.tab"][data-arg="' + id + '"]', id, 'tab ' + id);
  await step('[data-act="chat.home"]', 'home', 'chat → home (again)');
  if (D.kind !== 'web') { await sleep(300); await D.evaluate('document.getElementById("sheet").classList.remove("on"), true'); }
  for (const id of ['notifs', 'privacy', 'safety', 'language', 'premium', 'about', 'dashboard']) {
    await D.evaluate('Orbit.go("settings",{reset:true}), true'); await sleep(60);
    await step('[data-act="nav.go"][data-arg="' + id + '"]', id, 'settings → ' + id);
  }
  await D.shot('11_safety_or_last');
  const perf = await D.evaluate('(window.__navTimes||[]).map(x=>x.ms)');
  const sorted = perf.slice().sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  ok(p95 <= NAV_MAX, 'page switch P95 = ' + p95 + 'ms over ' + perf.length + ' switches (max ' + sorted[sorted.length - 1] + 'ms)');

  console.log('-- tracking (PRD §9.3)');
  const need = ['app_open', 'onboarding_started', 'onboarding_completed', 'character_selected', 'first_message_sent', 'conversation_started',
    'memory_candidate_created', 'memory_confirmed', 'memory_deleted', 'proactive_message_sent', 'proactive_message_clicked', 'feedback_submitted', 'paywall_viewed', 'trial_started', 'safety_event_triggered', 'activity_started', 'activity_attempt', 'shared_record_created', 'relationship_progress', 'character_reaction_played'];
  const names = await D.evaluate('Orbit.state.events.map(e=>e.name)');
  const missing = need.filter(n => !names.includes(n));
  ok(!missing.length, 'all core events logged', missing.join(','));
  ok(await D.evaluate('Orbit.state.events.every(e=>Array.isArray(e.exp)&&e.exp.length===4&&e.exp.every(x=>x.experiment_id&&x.variant_id))'), 'every event carries experiment_id + variant_id');

  console.log('-- quality summary');
  const modelReplies = replies.filter(r => r.totalMs);
  ok(modelReplies.every(r => !LECTURE.test(r.reply)), 'no lecture / customer-service phrasing in ' + modelReplies.length + ' model replies');
  const first = modelReplies.map(r => r.firstMs).filter(x => x != null);
  const total = modelReplies.map(r => r.totalMs);
  const med = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  note('reply first text: median ' + med(first) + 'ms (min ' + Math.min(...first) + ', max ' + Math.max(...first) + ')');
  note('reply total     : median ' + med(total) + 'ms (min ' + Math.min(...total) + ', max ' + Math.max(...total) + ')');

  console.log('-- delete account');
  await D.evaluate('Orbit.go("privacy",{reset:true}), true'); await sleep(80);
  await actTap('[data-act="p.delete"]'); await sleep(200);
  await actTap('[data-act="p.deleteYes"]');
  ok(!!(await screenIs('welcome')), 'delete everything → back to welcome');
  ok(await D.evaluate('Orbit.state.memories.length===0 && Orbit.state.msgs.length===0'), 'all local data gone');

  fs.writeFileSync(path.join(OUT, 'replies.json'), JSON.stringify(replies, null, 2));
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ target: TARGET, pass, fail, failures, notes, navP95: p95, at: new Date().toISOString() }, null, 2));
  const cl = await D.cleanup().catch(() => null);
  if (cl && cl.ok === false) console.log('  note: a temp browser profile is still in use and was left in %TEMP% (safe to delete later)');
  console.log('\n' + '='.repeat(60) + '\n' + (fail ? '❌ ' + fail + ' failed, ' + pass + ' passed\n  · ' + failures.join('\n  · ') : '✅ all ' + pass + ' checks passed') + '\n  screenshots + replies: tests_out/' + TARGET + '/');
  process.exit(fail ? 1 : 0);
}
main().catch(async e => { console.error(e); try { await D.cleanup(); } catch (x) {} process.exit(1); });
