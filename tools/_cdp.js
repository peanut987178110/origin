/* _cdp.js · minimal Chrome DevTools Protocol client for the Orbit WebView (debug builds only)
   Used by tools/orbit_device_test.js to drive the REAL app on an emulator/phone:
     adb forward tcp:<port> localabstract:webview_devtools_remote_<pid>
   Node 22+ (global WebSocket, fetch). No dependencies. */
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

const ADB = process.env.ADB || path.join(process.env.LOCALAPPDATA || '', 'AndroidSdk', 'platform-tools', 'adb.exe');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function adb(serial, ...args) {
  return execFileSync(ADB, ['-s', serial, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
}

async function connect(serial, pkg, port) {
  port = port || 9333;
  let sock = null;
  for (let i = 0; i < 60 && !sock; i++) {
    let pid = '';
    try { pid = adb(serial, 'shell', 'pidof', pkg).trim(); } catch (e) { await sleep(500); continue; }   // not started yet
    const unix = adb(serial, 'shell', 'cat', '/proc/net/unix');
    const m = unix.match(new RegExp('@(webview_devtools_remote_' + (pid || '\\d+') + ')'));
    if (m) sock = m[1]; else await sleep(500);
  }
  if (!sock) throw new Error('WebView devtools socket not found (is the debug APK running?)');
  execFileSync(ADB, ['-s', serial, 'forward', 'tcp:' + port, 'localabstract:' + sock]);
  let page = null;
  for (let i = 0; i < 40 && !page; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
      page = list.find(p => p.type === 'page' && /appassets/.test(p.url));
    } catch (e) {}
    if (!page) await sleep(500);
  }
  if (!page) throw new Error('page target not found');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const waiting = new Map(); const listeners = [];
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    else if (msg.method) listeners.forEach(fn => fn(msg));
  };
  const send = (method, params) => new Promise(res => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  /* Evaluate an expression in the page; awaits promises; returns the JSON value. */
  async function evaluate(expr, timeoutMs) {
    const p = send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const r = await Promise.race([p, sleep(timeoutMs || 60000).then(() => ({ timeout: true }))]);
    if (r.timeout) throw new Error('evaluate timeout: ' + expr.slice(0, 80));
    if (r.result && r.result.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  async function waitFor(expr, timeoutMs, everyMs) {
    const end = Date.now() + (timeoutMs || 30000);
    while (Date.now() < end) {
      try { const v = await evaluate(expr, 10000); if (v) return v; } catch (e) {}
      await sleep(everyMs || 200);
    }
    return null;
  }
  await send('Runtime.enable');
  return { ws, send, evaluate, waitFor, on: fn => listeners.push(fn), close: () => ws.close(), port };
}

module.exports = { connect, adb, sleep, ADB };
