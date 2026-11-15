/* Local stand-in for Ollama's OpenAI-compatible streaming endpoint: answers in small pieces so a
   reply visibly types out. DEV/TEST ONLY — it is never part of the app or the APK.
   Run: node tools/dev_stub_server.js   then: ORBIT_ENGINE=http://127.0.0.1:11500 node tools/orbit_e2e.js web
   Use it to check flow/layout only; speed and wording must come from the real model (tools/preflight.js). */
'use strict';
const http = require('http');
const PORT = +(process.env.STUB_PORT || 11500);
const REPLY = process.env.REPLY ||
  'Hey. Long day, huh? I am right here, no rush. Tell me the one part that took the most out of you today.';
const OPENING = "Hi, I'm Luna. I'm an AI, and I'm here whenever you want to talk — or just sit quietly for a bit. How has today been for you?";

function handle(req, res) {
  /* a browser page on another port calls this like Ollama does: answers need the CORS header,
     and the page's JSON POST first asks with OPTIONS */
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  Object.keys(cors).forEach(k => res.setHeader(k, cors[k]));
  if (req.url === '/api/tags') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"models":[]}'); }
  if (req.url.indexOf('/v1/chat/completions') !== 0) { res.writeHead(404); return res.end('{}'); }
  const chunks = [];
  req.on('data', d => chunks.push(d));
  req.on('end', () => {
    let m = {};
    try { m = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) {}
    const text = !m.messages || m.messages.length < 2 ? OPENING : REPLY;
    const parts = text.match(/.{1,4}/gs) || [];
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    let i = 0;
    const t = setInterval(() => {
      if (i < parts.length) {
        const line = JSON.stringify({ choices: [{ delta: { content: parts[i++] } }] });
        res.write('data: ' + line + '\n\n');
        return;
      }
      clearInterval(t);
      res.write('data: [DONE]\n\n');
      res.end();
    }, 25);
    res.on('close', () => clearInterval(t));
  });
}

http.createServer(handle).listen(PORT, '127.0.0.1', () => console.log('stand-in model server on http://127.0.0.1:' + PORT + ' (flow/layout only)'));
