/* 02_engine.js · one interface over the on-device model
   · Android: window.AndroidOrbitAI (llama.cpp in the APK). Default and only path for users.
   · Desktop dev/test only: ?engine=ollama → local Ollama with the SAME model (qwen2.5:1.5b),
     so tools/orbit_web_test.js can drive the real page in a desktop browser.
   Nothing here touches the network in the Android build. */
const Engine = (function () {
  const NATIVE = window.AndroidOrbitAI || null;
  const q = new URLSearchParams(location.search);
  const OLLAMA = !NATIVE && q.get('engine') === 'ollama' ? (q.get('ollama') || 'http://127.0.0.1:11434') : null;
  const MODEL = q.get('model') || 'qwen2.5:1.5b';
  const jobs = {};
  let status = NATIVE ? safeStatus() : { state: OLLAMA ? 'ready' : 'none', progress: 1, model: OLLAMA ? MODEL + ' (desktop dev)' : '' };
  const listeners = [];
  function safeStatus() { try { return JSON.parse(NATIVE.status()); } catch (e) { return { state: 'error', error: 'bridge' }; } }
  function emit() { listeners.forEach(fn => { try { fn(status); } catch (e) {} }); }

  window.__orbitStatus = s => { try { status = JSON.parse(s); } catch (e) {} emit(); };
  window.__orbitChunk = (id, text) => { const j = jobs[id]; if (j && j.onChunk) j.onChunk(text); };
  window.__orbitDone = (id, ok, payload) => {
    const j = jobs[id]; if (!j) return; delete jobs[id];
    let stats = null; if (ok) { try { stats = JSON.parse(payload); } catch (e) {} }
    j.resolve({ ok: !!ok, stats, error: ok ? null : String(payload || 'failed') });
  };
  window.__orbitWarm = s => { try { const st = JSON.parse(s); st.kind = 'warm'; S.engineStats.push(Object.assign({ at: now() }, st)); save(); } catch (e) {} };

  function prepare() { if (NATIVE) { try { NATIVE.prepare(); } catch (e) {} } }
  function warm(messages) { if (NATIVE) { try { NATIVE.warm(JSON.stringify(messages)); } catch (e) {} } }
  function stop(id) {
    if (NATIVE) { try { NATIVE.stop(); } catch (e) {} }
    const j = jobs[id]; if (j && j.abort) j.abort.abort();
  }
  function generate(messages, opts, onChunk) {
    const id = rid('g');
    const p = new Promise(resolve => { jobs[id] = { resolve, onChunk }; });
    if (NATIVE) {
      try { NATIVE.generate(JSON.stringify(messages), JSON.stringify(opts || {}), id); }
      catch (e) { window.__orbitDone(id, false, 'bridge'); }
    } else if (OLLAMA) {
      ollama(id, messages, opts || {});
    } else {
      setTimeout(() => window.__orbitDone(id, false, 'no_engine'), 0);
    }
    return { id, done: p };
  }
  async function ollama(id, messages, o) {
    /* One data: line is handled here. A stream can hold its last line without a closing newline:
       splitting only on "\n" left it unread, and a short reply could come out with zero words. */
    const takeLine = line => {
      line = line.trim(); if (!line.startsWith('data:')) return;
      const d = line.slice(5).trim(); if (d === '[DONE]') return;
      try { const c = JSON.parse(d).choices[0].delta.content; if (c) { if (!first) first = performance.now(); n++; window.__orbitChunk(id, c); } } catch (e) {}
    };
    const ac = new AbortController(); jobs[id].abort = ac;
    const t0 = performance.now(); let first = 0, n = 0;
    try {
      const r = await fetch(OLLAMA + '/v1/chat/completions', { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, messages, stream: true, max_tokens: o.maxTokens || 120, temperature: o.temperature || 0.7, top_p: o.topP || 0.9, seed: o.seed, keep_alive: '30m' }) });
      if (!r.ok) throw new Error('http ' + r.status);
      const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await rd.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n')) >= 0) { takeLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
      }
      takeLine(buf);
      /* a dev server restarting mid-stream closes the stream cleanly: without this check that
         "ended" looked like a finished reply of zero words */
      if (!n) throw new Error('empty stream');
      window.__orbitDone(id, true, JSON.stringify({ genTokens: n, firstMs: Math.round(first - t0), totalMs: Math.round(performance.now() - t0), dev: true }));
    } catch (e) {
      /* The dev server is not there (or dropped the stream): remember it, so the reply that is
         about to fail leaves a visible "can't reach it" instead of a pending bubble that waits
         forever — a reply that never ends is what "too slow" feels like. */
      if (!ac.signal.aborted) { status = Object.assign({}, status, { state: 'error', error: 'network' }); emit(); }
      window.__orbitDone(id, ac.signal.aborted, ac.signal.aborted ? JSON.stringify({ stopped: true }) : 'network');
    }
  }
  return {
    get status() { return status; }, get native() { return !!NATIVE; }, get available() { return !!(NATIVE || OLLAMA); },
    onStatus: fn => listeners.push(fn), prepare, warm, generate, stop,
    refresh() { if (NATIVE) status = safeStatus(); return status; }
  };
})();

/* What a status line under the name says. Every model state, plus the one case that is not about
   the model at all: the desktop dev build whose local server is not answering. */
function engineLine() {
  const s = Engine.status;
  if (!Engine.available) return tt('No AI on this device yet — the built-in model is missing.', '这台设备上还没有 AI——内置模型没有装好。');
  if (s.error === 'network') return tt('The AI server this dev build talks to is not reachable — start it and send again.', '开发者版连接的本机 AI 服务连不上——先把它启动，再发一次。');
  if (s.state === 'ready') return Engine.native ? tt('On-device AI ready', '端侧 AI 已就绪') : '';
  if (s.state === 'loading') return tt('Getting the AI ready… ', '正在准备 AI… ') + (s.progress && s.progress < 1 ? Math.round(s.progress * 100) + '%' : '');
  if (s.state === 'error') return tt("The AI could not start on this device. Everything else still works — your notes and records stay on the phone.", 'AI 在这台设备上没能启动。其他功能照常可用——你的记录都在这部手机上。');
  return tt('Preparing the AI…', '正在准备 AI…');
}
