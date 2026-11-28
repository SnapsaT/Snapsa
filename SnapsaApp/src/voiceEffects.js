// src/voiceEffects.js — voice effects for voice notes (DMs, groups and stories). Works on the recorded audio, no live processing.
// Real pitch shifting (the voice gets higher/lower WITHOUT getting faster/slower) for Child / Lady / Man / Presenter / Monster / Alien,
// plus classic effects (echo, hall, robot, radio, whisper). Output is a small mono WAV.
export const VOICE_EFFECTS = [
  { id: 'natural',   label: 'Natural',   emoji: '🎙️' },
  { id: 'child',     label: 'Child',     emoji: '🧒' },
  { id: 'lady',      label: 'Lady',      emoji: '👩' },
  { id: 'man',       label: 'Man',       emoji: '👨' },
  { id: 'presenter', label: 'Presenter', emoji: '📻' },
  { id: 'echo',      label: 'Echo',      emoji: '🏔️' },
  { id: 'hall',      label: 'Big hall',  emoji: '🏛️' },
  { id: 'monster',   label: 'Monster',   emoji: '👹' },
  { id: 'alien',     label: 'Alien',     emoji: '👽' },
  { id: 'robot',     label: 'Robot',     emoji: '🤖' },
  { id: 'radio',     label: 'Radio',     emoji: '📞' },
  { id: 'deep',      label: 'Deep',      emoji: '🐻' },
  { id: 'chipmunk',  label: 'Chipmunk',  emoji: '🐿️' },
  { id: 'helium',    label: 'Helium',    emoji: '🎈' },
  { id: 'whisper',   label: 'Whisper',   emoji: '🤫' },
];

const SR = 24000;                                    // working / output sample rate (plenty for speech, keeps the file small)
const st = (n) => Math.pow(2, n / 12);               // semitones → ratio

// pitch ratio (voice stays the same speed) + what to do afterwards
const PITCH = { child: st(6.5), lady: st(3.2), man: st(-3.6), presenter: st(-1.6), monster: st(-8), alien: st(2.5) };
// effects that simply speed the voice up/down (pitch AND speed change, like a tape)
const TAPE = { deep: st(-5), chipmunk: st(7), helium: 2 };

const toWav = (data, rate) => {
  const ab = new ArrayBuffer(44 + data.length * 2);
  const v = new DataView(ab);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + data.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, data.length * 2, true);
  let o = 44;
  for (let i = 0; i < data.length; i++) { const s = Math.max(-1, Math.min(1, data[i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
  return new Blob([ab], { type: 'audio/wav' });
};

// linear-interpolation resample: ratio > 1 → shorter & higher
const resample = (x, ratio) => {
  const n = Math.max(1, Math.floor(x.length / ratio)), y = new Float32Array(n);
  for (let i = 0; i < n; i++) { const p = i * ratio, k = p | 0, f = p - k; y[i] = (x[k] || 0) * (1 - f) + (x[k + 1] || 0) * f; }
  return y;
};

// WSOLA time-stretch: output length = input length × factor, pitch unchanged
const stretch = (x, factor) => {
  const N = 1024, H = N >> 1, SEARCH = 160;
  const outLen = Math.max(N, Math.floor(x.length * factor)), y = new Float32Array(outLen + N), norm = new Float32Array(outLen + N);
  const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  let prev = 0, o = 0;                                   // prev = start of the segment that would naturally follow the last grain
  for (let g = 0; o < outLen; g++, o += H) {
    const nominal = Math.round(o / factor);
    let best = Math.min(Math.max(0, nominal), Math.max(0, x.length - N));
    if (g > 0) {                                         // look near the nominal spot for the grain that best continues the last one
      let bs = -1e30; const lo = Math.max(0, nominal - SEARCH), hi = Math.min(x.length - N, nominal + SEARCH);
      for (let c = lo; c <= hi; c += 2) { let s = 0; for (let i = 0; i < H; i += 4) s += x[c + i] * x[prev + i]; if (s > bs) { bs = s; best = c; } }
    }
    for (let i = 0; i < N; i++) { const v = x[best + i] || 0; y[o + i] += v * win[i]; norm[o + i] += win[i]; }
    prev = best + H;
  }
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = norm[i] > 1e-3 ? y[i] / norm[i] : 0;
  return out;
};
const pitchShift = (x, r) => (Math.abs(r - 1) < 0.01 ? x : stretch(resample(x, r), r));

// a simple room: decaying noise as an impulse response
const roomIR = (ctx, secs, decay) => {
  const n = Math.floor(secs * ctx.sampleRate), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
  return b;
};

export async function applyVoiceEffect(blob, id) {
  if (!id || id === 'natural') return blob;
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  let decoded;
  try { decoded = await ctx.decodeAudioData(await blob.arrayBuffer()); }
  finally { try { ctx.close(); } catch {} }

  // 1) bring it to a mono 24 kHz buffer
  const pre = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * SR)), SR);
  const ps = pre.createBufferSource(); ps.buffer = decoded; ps.connect(pre.destination); ps.start(0);
  let data = (await pre.startRendering()).getChannelData(0);

  // 2) pitch change that keeps the speed (child, lady, man, presenter, monster, alien)
  if (PITCH[id]) data = pitchShift(data, PITCH[id]);

  // 3) the effect chain
  const rate = TAPE[id] || 1;
  const tail = (id === 'echo' || id === 'hall' || id === 'monster' ? 2.6 : 0.4);
  const length = Math.ceil((data.length / SR / rate + tail) * SR);
  const off = new OfflineAudioContext(1, length, SR);
  const buf = off.createBuffer(1, data.length, SR); buf.copyToChannel(data, 0);
  const src = off.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate;
  const out = off.destination;
  const biq = (type, f, gain = 0, q = 1) => { const b = off.createBiquadFilter(); b.type = type; b.frequency.value = f; b.gain.value = gain; b.Q.value = q; return b; };
  const chain = (...nodes) => { nodes.reduce((a, b) => { a.connect(b); return b; }); return nodes[nodes.length - 1]; };
  const gain = (v) => { const g = off.createGain(); g.gain.value = v; return g; };
  const comp = () => { const c = off.createDynamicsCompressor(); c.threshold.value = -26; c.knee.value = 18; c.ratio.value = 4; c.attack.value = 0.005; c.release.value = 0.2; return c; };
  const reverb = (from, secs, decay, wet) => { const cv = off.createConvolver(); cv.buffer = roomIR(off, secs, decay); const w = gain(wet); from.connect(cv); cv.connect(w); w.connect(out); };

  if (id === 'presenter') {                              // warm, close, confident "radio presenter"
    const t = chain(src, biq('highpass', 70), biq('lowshelf', 180, 5), biq('peaking', 2800, 3, 0.9), biq('highshelf', 8000, 1.5), comp(), gain(1.35));
    t.connect(out); reverb(t, 0.28, 3.5, 0.12);
  } else if (id === 'child') {
    const t = chain(src, biq('highshelf', 3500, 3), gain(1.1)); t.connect(out);
  } else if (id === 'lady') {
    const t = chain(src, biq('peaking', 2600, 2, 0.8), biq('highshelf', 5000, 2), gain(1.05)); t.connect(out);
  } else if (id === 'man') {
    const t = chain(src, biq('lowshelf', 200, 4), biq('highshelf', 6000, -2), gain(1.15)); t.connect(out);
  } else if (id === 'monster') {
    const t = chain(src, biq('lowshelf', 160, 6), biq('lowpass', 3800), comp(), gain(1.3)); t.connect(out); reverb(t, 1.6, 2.2, 0.3);
  } else if (id === 'alien') {
    const ring = gain(0); const osc = off.createOscillator(); osc.type = 'sine'; osc.frequency.value = 90; osc.connect(ring.gain); osc.start(0);
    src.connect(ring); ring.connect(out); const dry = gain(0.55); src.connect(dry); dry.connect(out);
    const d = off.createDelay(0.1); d.delayTime.value = 0.03; const w = gain(0.4); src.connect(d); d.connect(w); w.connect(out);
  } else if (id === 'robot') {
    const ring = gain(0); const osc = off.createOscillator(); osc.type = 'square'; osc.frequency.value = 50; osc.connect(ring.gain); osc.start(0);
    src.connect(ring); ring.connect(out); const dry = gain(0.22); src.connect(dry); dry.connect(out);
  } else if (id === 'radio') {                           // old telephone / walkie-talkie
    const shaper = off.createWaveShaper(); const c = new Float32Array(256); for (let i = 0; i < 256; i++) { const x = (i / 128) - 1; c[i] = Math.tanh(x * 3); } shaper.curve = c;
    const t = chain(src, biq('highpass', 420), biq('lowpass', 3200), shaper, gain(0.9)); t.connect(out);
    const n = off.createBuffer(1, length, SR), nd = n.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * 0.015;
    const ns = off.createBufferSource(); ns.buffer = n; ns.connect(out); ns.start(0);
  } else if (id === 'echo') {
    const dry = gain(0.85), delay = off.createDelay(1.0); delay.delayTime.value = 0.28;
    const fb = gain(0.42), wet = gain(0.55);
    src.connect(dry); dry.connect(out); src.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(out);
  } else if (id === 'hall') {
    const dry = gain(0.8); src.connect(dry); dry.connect(out); reverb(src, 2.4, 2.6, 0.75);
  } else if (id === 'whisper') {
    const hp = biq('highpass', 1800), lp = biq('lowpass', 7000), g = gain(2.4);
    src.connect(hp); hp.connect(lp); lp.connect(g); g.connect(out);
    const n = off.createBuffer(1, length, SR), nd = n.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * 0.04;
    const ns = off.createBufferSource(); ns.buffer = n; const nb = biq('bandpass', 4000); ns.connect(nb); nb.connect(out); ns.start(0);
  } else {
    src.connect(out);                                    // deep / chipmunk / helium: tape-speed pitch
  }
  src.start(0);
  const rendered = await off.startRendering();
  return toWav(rendered.getChannelData(0), SR);
}
