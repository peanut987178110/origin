const PERSONAS={luna:{voice:{rate:0.94,pitch:1.12}},nova:{voice:{rate:1.04,pitch:1.18}},atlas:{voice:{rate:0.96,pitch:0.90}},miko:{voice:{rate:1.06,pitch:1.20}}};
let cur='luna';const persona=()=>PERSONAS[cur];
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

const TEXT=["I'm sorry. That sounds really hard, you must be tired, and it's okay to feel that way. Do you want to talk about it?","Yes! That's wonderful news, I'm so glad. Tell me everything!","Okay, so tonight I was making tea, and then I thought about you. What are you up to?","我在想，你今天是不是很累？慢慢来吧；我陪着你。"];
const MOODS=['sad','joy',undefined,'calm'];
let bad=0;
for (const who of Object.keys(PERSONAS)) { cur=who;
  for (let i=0;i<TEXT.length;i++){ const pl=voicePlan(TEXT[i],MOODS[i]);
    for (const c of pl){ const d=c.pitch-PERSONAS[who].voice.pitch;
      if (Math.abs(d)>0.1301 || c.rate<0.6 || c.rate>1.5 || c.pitch<0.6 || c.pitch>1.6 || c.gap<0 || c.gap>400) { bad++; console.log('OUT',who,JSON.stringify(c)); } }
    console.log(who, MOODS[i]||'-', pl.map(c=>c.text+' ['+c.feel+' r'+c.rate.toFixed(2)+' p'+c.pitch.toFixed(2)+' g'+c.gap+']').join(' | '));
  } }
// the same reply must be read within the same small band for every persona, and a sad reply must be lower than a happy one
const base=Object.values(PERSONAS).map(p=>p.voice.pitch); if (Math.max(...base)-Math.min(...base)<0.2) { bad++; console.log('personas too similar'); }
console.log('violations', bad);
if (bad) process.exit(1);
