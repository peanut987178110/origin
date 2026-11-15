/* Every reply starts on the dev model server and ends with the dev model server actually answering.
   The E2E can only say "reply finished" once something came back: a dev server that is not running
   (the desktop dev path) or a machine saturated with demos is not a product test.
   Run: node tools/preflight.js */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const BASE = process.env.OLLAMA || 'http://127.0.0.1:11434';
const MODEL = process.env.ORBIT_MODEL || 'qwen2.5:1.5b';

function get(url, ms) {
  return new Promise(resolve => {
    const req = http.get(url, { timeout: ms }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ code: res.statusCode, body: b })); });
    req.on('timeout', () => { req.destroy(); resolve({ code: 0, body: 'timeout' }); });
    req.on('error', e => resolve({ code: 0, body: String(e.message || e) }));
  });
}
function post(pathname, payload, ms) {
  return new Promise(resolve => {
    const u = new URL(BASE + pathname), body = JSON.stringify(payload);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', timeout: ms,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ code: res.statusCode, body: b }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ code: 0, body: 'timeout after ' + ms + 'ms' }); });
    req.on('error', e => resolve({ code: 0, body: String(e.message || e) }));
    req.end(body);
  });
}
const cpu = () => { const c = os.cpus(); const t = c.reduce((a, x) => { const s = Object.values(x.times).reduce((p, q) => p + q, 0); return { idle: a.idle + x.times.idle, total: a.total + s }; }, { idle: 0, total: 0 }); return t; };
const pct = (a, b) => Math.round((1 - (b.idle - a.idle) / Math.max(1, b.total - a.total)) * 100);

(async () => {
  const tags = await get(BASE + '/api/tags', 15000);          // this normally just wakes Windows; it is not the answer
  const models = tags.code === 200 ? (JSON.parse(tags.body).models || []).map(m => m.name) : [];
  console.log('server  : ' + (tags.code === 200 ? 'up (' + BASE + ')' : 'DOWN — start it (ollama serve), then run the E2E (' + tags.body + ')'));
  console.log('models  : ' + (models.length ? models.join(', ') : '(none)'));

  const s0 = cpu();
  const native = await post('/api/generate', { model: MODEL, prompt: 'hi', stream: false, options: { num_predict: 8 } }, 240000);
  const s1 = cpu();
  let nativeOk = false;
  try { nativeOk = !!JSON.parse(native.body).response; } catch (e) {}
  console.log('native /api/generate : ' + (nativeOk ? 'answered during a ' + pct(s0, s1) + '% CPU window' : 'FAILED (' + native.body.slice(0, 160) + ')'));

  const c0 = cpu();
  const chat = await post('/v1/chat/completions', { model: MODEL, stream: false, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }, 240000);
  const c1 = cpu();
  console.log('compat /v1/chat/completions (the app\'s dev path, what the desktop tests use): ' +
    (chat.code === 200 ? 'ok' : 'FAILED code=' + chat.code + ' during a ' + pct(c0, c1) + '% CPU window :: ' + chat.body.slice(0, 200)));

  const npm = path.join(path.dirname(process.execPath), 'node_modules', 'npm');
  console.log('node    : ' + process.version + (fs.existsSync(npm) ? ' (' + path.dirname(process.execPath) + ')' : ''));
  process.exit(tags.code === 200 && nativeOk && chat.code === 200 ? 0 : 1);
})();
