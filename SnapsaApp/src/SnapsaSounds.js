// src/SnapsaSounds.js — Snapsa's own chat sounds, synthesised in the app (no audio files to ship).
// Five unique sounds: drop (message sent), pluck (message arrives in the open chat), rec start, rec cancel, voice-note finished.
let ctx = null;
let masterOut = null;
const off = () => { try { return localStorage.getItem('snapsa_sounds_off') === '1'; } catch { return false; } };
export const setSoundsOff = (v) => { try { localStorage.setItem('snapsa_sounds_off', v ? '1' : '0'); } catch {} };
export const soundsAreOff = off;

const getOut = (c) => {
  if (masterOut) return masterOut;
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -8;
  comp.knee.value = 12;
  comp.ratio.value = 8;
  comp.attack.value = 0.002;
  comp.release.value = 0.12;
  comp.connect(c.destination);
  masterOut = comp;
  return masterOut;
};

const getCtx = () => {
  try {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      masterOut = null;
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  } catch { return null; }
};
// Android WebView only lets audio start after a touch — unlock it on the first one.
if (typeof window !== 'undefined') {
  const unlock = () => { getCtx(); window.removeEventListener('pointerdown', unlock, true); window.removeEventListener('keydown', unlock, true); };
  window.addEventListener('pointerdown', unlock, true); window.addEventListener('keydown', unlock, true);
}

// one tone: frequency glide f0 -> f1, soft attack, exponential fade
const tone = (c, { t = 0, f0, f1 = f0, dur = 0.25, vol = 3.0, type = 'sine', attack = 0.006, out }) => {
  const dest = out || getOut(c);
  const o = c.createOscillator(), g = c.createGain(), t0 = c.currentTime + t;
  o.type = type;
  o.frequency.setValueAtTime(f0, t0);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur * 0.85);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(dest);
  o.start(t0); o.stop(t0 + dur + 0.05);
};
const echo = (c) => { // short soft echo so sounds feel wet, like water
  const dest = getOut(c);
  const d = c.createDelay(0.5), fb = c.createGain(), mix = c.createGain(), bus = c.createGain();
  d.delayTime.value = 0.13; fb.gain.value = 0.28; mix.gain.value = 0.35;
  bus.connect(dest); bus.connect(d); d.connect(fb); fb.connect(d); d.connect(mix); mix.connect(dest);
  return bus;
};
const run = (fn) => { if (off()) return; const c = getCtx(); if (!c) return; try { fn(c); } catch {} };

/** Message sent (first check) — a water drop: a bright "plip" that falls, then a small ripple. */
export const playSent = () => run((c) => {
  const bus = echo(c);
  tone(c, { f0: 1500, f1: 420, dur: 0.18, vol: 3.0, out: bus });
  tone(c, { t: 0.07, f0: 2400, f1: 900, dur: 0.1, vol: 3.0, out: bus });
  tone(c, { t: 0.16, f0: 760, f1: 520, dur: 0.14, vol: 3.0, out: bus });
});

/** Message arrives while the chat is open — a two-note glassy pluck, going up. */
export const playIncoming = () => run((c) => {
  const bus = echo(c);
  tone(c, { f0: 784, dur: 0.22, vol: 3.0, type: 'triangle', out: bus });
  tone(c, { f0: 1175, t: 0.11, dur: 0.32, vol: 3.0, type: 'triangle', out: bus });
  tone(c, { f0: 2350, t: 0.11, dur: 0.18, vol: 3.0, type: 'triangle', out: bus });
});

/** Recording starts — a quick rising "blip-blip". */
export const playRecStart = () => run((c) => {
  tone(c, { f0: 520, f1: 780, dur: 0.1, vol: 3.0, type: 'triangle' });
  tone(c, { t: 0.1, f0: 780, f1: 1180, dur: 0.14, vol: 3.0, type: 'triangle' });
});

/** Recording cancelled — a soft falling sweep with a low thud. */
export const playRecCancel = () => run((c) => {
  tone(c, { f0: 900, f1: 180, dur: 0.3, vol: 3.0, type: 'sawtooth', attack: 0.02 });
  tone(c, { t: 0.18, f0: 140, f1: 70, dur: 0.16, vol: 3.0 });
});

/** Voice note finished playing — three soft bell notes settling down. */
export const playVoiceEnd = () => run((c) => {
  const bus = echo(c);
  tone(c, { f0: 1319, dur: 0.34, vol: 3.0, out: bus });
  tone(c, { t: 0.14, f0: 988, dur: 0.34, vol: 3.0, out: bus });
  tone(c, { t: 0.28, f0: 659, dur: 0.5, vol: 3.0, out: bus });
  tone(c, { t: 0.28, f0: 1318, dur: 0.3, vol: 3.0, out: bus });
});
