/* Unit check of the desktop dev engine path (02_engine.js, ?engine=ollama): stream parsing and
   failure reporting. No model server needed — the stream is played from a local stub.
   Run: node tools/unit_engine_test.js */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
/* test the copy that actually ships inside the page, not a re-typed copy of the source */
const PAGE = fs.readFileSync(path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'index.html'), 'utf8');
const a = PAGE.indexOf('const Engine = (function'), b = PAGE.indexOf('})();', a);
if (a < 0 || b < 0) { console.error('Engine block not found in the built page — run node tools/build_app.js'); process.exit(1); }
const SRC = PAGE.slice(a, b + 5);

let pass = 0, fail = 0;
const ok = (c, n, d) => { if (c) { pass++; console.log('  ✅ ' + n + (d ? '  · ' + d : '')); } else { fail++; console.log('  ❌ ' + n + (d ? '  · ' + d : '')); } };
const line = t => 'data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n';

function make(body, statusCode) {
  const window = {};
  const used = [];
  const Engine = new Function('window', 'location', 'localStorage', 'S', 'now', 'save', 'tt', 'rid', 'fetch', 'URLSearchParams', 'performance', 'AbortController', 'TextDecoder', 'ReadableStream', 'Response',
    SRC + '\nreturn Engine;')(window, { search: '?engine=ollama' }, { getItem: () => null, setItem() {} }, { engineStats: [] }, () => Date.now(), () => {}, a => a, p => p + Math.random(), async () => {
    const enc = new TextEncoder();
    return new Response(new ReadableStream({ start(c) { if (body) c.enqueue(enc.encode(body)); c.close(); } }), { status: statusCode || 200 });
  }, URLSearchParams, performance, AbortController, TextDecoder, ReadableStream, Response);
  window.__orbitChunk = (id, t) => used.push(t);
  return { Engine, window, used };
}

(async () => {
  console.log('-- dev engine stream');
  {
    const { Engine, used } = make(line('Hello') + line(' there') + 'data: [DONE]\n');
    const r = await Engine.generate([{ role: 'user', content: 'hi' }], {}, () => {}).done;
    ok(r.ok && used.join('') === 'Hello there', 'a newline-terminated stream is read whole', JSON.stringify(used.join('')));
  }
  {
    const { Engine, used } = make(line('Only one') + line(' line') + 'data: [DONE]');
    const r = await Engine.generate([{ role: 'user', content: 'hi' }], {}, () => {}).done;
    ok(r.ok && used.join('') === 'Only one line', 'the last line without a newline is not lost', JSON.stringify(used.join('')));
  }
  {
    const { Engine } = make('');
    const r = await Engine.generate([{ role: 'user', content: 'hi' }], {}, () => {}).done;
    ok(!r.ok && r.error === 'network', 'an empty stream (server restarted) is a failure, not a finished reply', r.error);
  }
  {
    const { Engine } = make('{"error":"model not found"}', 404);
    const r = await Engine.generate([{ role: 'user', content: 'hi' }], {}, () => {}).done;
    ok(!r.ok && r.error === 'network' && Engine.status.state === 'error' && Engine.status.error === 'network', 'an HTTP error marks the engine unreachable so the reply can say why', JSON.stringify(Engine.status));
  }
  console.log('\n' + (fail ? '❌ ' + fail + ' failed, ' + pass + ' passed' : '✅ all ' + pass + ' checks passed'));
  process.exit(fail ? 1 : 0);
})();
