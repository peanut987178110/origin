#!/usr/bin/env node
/**
 * build_app.js · assemble the Orbit page into the Android project
 * ------------------------------------------------------------------
 * Sources (v6):
 *   src/app/index.html          markup + styles, one placeholder:  ORBIT_JS (in a script comment)
 *   shared/orbit_*.js           pure logic (personas, mind, memory, life) — also required by Node tests
 *   shared/market_data.js       sourced industry facts for the About page (same data as docs/29)
 *   src/app/js/NN_*.js          page modules, concatenated in file-name order inside one IIFE
 * Output: android/app/src/main/assets/index.html (+ launcher icons)
 * No network code ships: the AI runs on the phone (window.AndroidOrbitAI).
 * Usage: node tools/build_app.js   (tools/build_apk.ps1 calls it)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'app', 'index.html');
const ANDROID = path.join(ROOT, 'android', 'app', 'src', 'main');
const PLACEHOLDER = '/*__ORBIT_JS__*/';
const SHARED = ['orbit_personas.js', 'orbit_mind.js', 'orbit_memory.js', 'orbit_life.js', 'orbit_play.js', 'market_data.js'];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/* Launcher icon: deep navy, violet→blue planet with an orbit ring (Orbit). */
function makeIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2, R = size * 0.27;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4, dx = x - cx, dy = y - cy, dist = Math.hypot(dx, dy);
    let r = 0x0a, g = 0x0b, b = 0x16;
    // tilted orbit ring (ellipse)
    const ex = (dx * 0.94 + dy * 0.34), ey = (-dx * 0.34 + dy * 0.94) * 2.6;
    const ring = Math.abs(Math.hypot(ex, ey) - size * 0.40);
    if (ring < size * 0.022 && !(ey < 0 && dist < R)) { const k = 1 - ring / (size * 0.022); r += (0x9b - r) * k; g += (0xa8 - g) * k; b += (0xf6 - b) * k; }
    if (dist <= R) {
      const t = Math.min(1, Math.max(0, (x - cx + R) / (2 * R) * 0.5 + (y - cy + R) / (2 * R) * 0.5));
      r = 0xa7 + (0x60 - 0xa7) * t; g = 0x8b + (0xa5 - 0x8b) * t; b = 0xfa + (0xfa - 0xfa) * t;
      const shade = 1 - Math.max(0, (dx + dy) / (2 * R)) * 0.35; r *= shade; g *= shade; b *= shade;
    }
    px[i] = Math.round(r); px[i + 1] = Math.round(g); px[i + 2] = Math.round(b); px[i + 3] = 255;
  }
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function pageModules() {
  const dir = path.join(ROOT, 'src', 'app', 'js');
  return fs.readdirSync(dir).filter(f => /^[0-9][0-9]_.*[.]js$/.test(f)).sort().map(f => path.join(dir, f));
}
function assemble() {
  const html = fs.readFileSync(SRC, 'utf8');
  if (!html.includes(PLACEHOLDER)) throw new Error('index.html is missing the ' + PLACEHOLDER + ' placeholder');
  const shared = SHARED.map(f => '/* ==== shared/' + f + ' ==== */\n' + fs.readFileSync(path.join(ROOT, 'shared', f), 'utf8'));
  const mods = pageModules();
  if (!mods.length) throw new Error('no page modules in src/app/js');
  const app = mods.map(f => '/* ==== src/app/js/' + path.basename(f) + ' ==== */\n' + fs.readFileSync(f, 'utf8'));
  const js = shared.join('\n') + '\n(function () {\n\'use strict\';\n' + app.join('\n') + '\n})();\n';
  if (/<\/script/i.test(js)) throw new Error('inlined script must not contain </script');
  return { out: html.replace(PLACEHOLDER, () => js), files: SHARED.length + mods.length };
}
function main() {
  if (!fs.existsSync(SRC)) { console.error('[error] src/app/index.html not found'); process.exit(1); }
  let r;
  try { r = assemble(); } catch (e) { console.error('[error] ' + e.message); process.exit(1); }
  fs.mkdirSync(path.join(ANDROID, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(ANDROID, 'assets', 'index.html'), r.out, 'utf8');
  for (const [dir, size] of [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]]) {
    const d = path.join(ANDROID, 'res', 'mipmap-' + dir);
    fs.mkdirSync(d, { recursive: true });
    const png = makeIcon(size);
    fs.writeFileSync(path.join(d, 'ic_launcher.png'), png);
    fs.writeFileSync(path.join(d, 'ic_launcher_round.png'), png);
  }
  console.log('built android/app/src/main/assets/index.html from ' + r.files + ' modules (+ launcher icons)');
}
if (require.main === module) main();
module.exports = { assemble, SHARED, pageModules, PLACEHOLDER };
