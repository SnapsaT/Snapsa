// src/voiceEffects.js — voice effects for voice notes (works on recorded audio, no live processing).
// Fix vs the WernTjat version: the output length now follows the speed change (pitch effects used to be cut off
// or padded), echo gets a tail, robot is a real ring modulator, and the result is a small mono WAV.
export const VOICE_EFFECTS = [
  { id: 'natural',  label: 'Natural',  emoji: '🎙️' },
  { id: 'deep',     label: 'Deep',     emoji: '🐻' },
  { id: 'chipmunk', label: 'Chipmunk', emoji: '🐿️' },
  { id: 'helium',   label: 'Helium',   emoji: '🎈' },
  { id: 'robot',    label: 'Robot',    emoji: '🤖' },
  { id: 'echo',     label: 'Echo',     emoji: '🏔️' },
  { id: 'whisper',  label: 'Whisper',  emoji: '🤫' },
];

const RATE = { deep: Math.pow(2, -5 / 12), chipmunk: Math.pow(2, 7 / 12), helium: 2 };
const OUT_RATE = 32000;

const toWav = (buf) => {
  const data = buf.getChannelData(0);
  const ab = new ArrayBuffer(44 + data.length * 2);
  const v = new DataView(ab);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + data.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, buf.sampleRate, true); v.setUint32(28, buf.sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, data.length * 2, true);
  let o = 44;
  for (let i = 0; i < data.length; i++) { const s = Math.max(-1, Math.min(1, data[i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
  return new Blob([ab], { type: 'audio/wav' });
};

export async function applyVoiceEffect(blob, id) {
  if (!id || id === 'natural') return blob;
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  let decoded;
  try { decoded = await ctx.decodeAudioData(await blob.arrayBuffer()); }
  finally { try { ctx.close(); } catch {} }

  const rate = RATE[id] || 1;
  const tail = id === 'echo' ? 2.5 : 0.2;
  const length = Math.ceil((decoded.duration / rate + tail) * OUT_RATE);
  const off = new OfflineAudioContext(1, length, OUT_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.playbackRate.value = rate;

  if (id === 'robot') {
    const ring = off.createGain(); ring.gain.value = 0;
    const osc = off.createOscillator(); osc.type = 'sine'; osc.frequency.value = 55;
    osc.connect(ring.gain);
    src.connect(ring); ring.connect(off.destination);
    const dry = off.createGain(); dry.gain.value = 0.25; src.connect(dry); dry.connect(off.destination);
    osc.start(0);
  } else if (id === 'echo') {
    const dry = off.createGain(); dry.gain.value = 0.85;
    const delay = off.createDelay(1.0); delay.delayTime.value = 0.28;
    const fb = off.createGain(); fb.gain.value = 0.4;
    const wet = off.createGain(); wet.gain.value = 0.55;
    src.connect(dry); dry.connect(off.destination);
    src.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(off.destination);
  } else if (id === 'whisper') {
    const hp = off.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1800;
    const lp = off.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 7000;
    const g = off.createGain(); g.gain.value = 2.4;
    src.connect(hp); hp.connect(lp); lp.connect(g); g.connect(off.destination);
    // soft breath noise under the voice
    const n = off.createBuffer(1, length, OUT_RATE); const d = n.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.04;
    const ns = off.createBufferSource(); ns.buffer = n;
    const nb = off.createBiquadFilter(); nb.type = 'bandpass'; nb.frequency.value = 4000;
    ns.connect(nb); nb.connect(off.destination); ns.start(0);
  } else {
    src.connect(off.destination);   // deep / chipmunk / helium: pitch + speed through playbackRate
  }
  src.start(0);
  const rendered = await off.startRendering();
  return toWav(rendered);
}
