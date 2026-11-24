// src/StoryExtras.jsx — the two special story looks: 3D Spatial photos and Voice stories.
import React, { useEffect, useRef } from 'react';
import { STORY_FONTS } from './StoryShared';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ── 3D Spatial: three depth layers of the same photo that slide against each other as the phone tilts
      (or drifts gently when there is no motion sensor). Cheap — no WebGL needed. ── */
export function Story3DPhoto({ src, onLoad, onError, fill = false }) {
  const stage = useRef(null), back = useRef(null), mid = useRef(null), fore = useRef(null), glow = useRef(null);
  useEffect(() => {
    let raf, tx = 0, ty = 0, cx = 0, cy = 0, sensor = false;
    const t0 = performance.now();
    const onOri = (e) => {
      if (e.gamma == null || e.beta == null) return;
      sensor = true;
      tx = clamp(e.gamma / 22, -1, 1);
      ty = clamp((e.beta - 50) / 22, -1, 1);
    };
    const onPtr = (e) => {
      const r = stage.current?.getBoundingClientRect(); if (!r) return;
      sensor = true;
      tx = clamp(((e.clientX - r.left) / r.width - 0.5) * 2, -1, 1);
      ty = clamp(((e.clientY - r.top) / r.height - 0.5) * 2, -1, 1);
    };
    window.addEventListener('deviceorientation', onOri);
    window.addEventListener('pointermove', onPtr);
    const loop = () => {
      const t = (performance.now() - t0) / 1000;
      if (!sensor) { tx = Math.sin(t * 0.9) * 0.8; ty = Math.cos(t * 0.7) * 0.5; }
      cx += (tx - cx) * 0.08; cy += (ty - cy) * 0.08;
      if (stage.current) stage.current.style.transform = `perspective(900px) rotateY(${cx * 7}deg) rotateX(${-cy * 7}deg)`;
      if (back.current) back.current.style.transform = `translate3d(${-cx * 16}px,${-cy * 16}px,0) scale(1.22)`;
      if (mid.current) mid.current.style.transform = `translate3d(${cx * 6}px,${cy * 6}px,0)`;
      if (fore.current) fore.current.style.transform = `translate3d(${cx * 22}px,${cy * 22}px,0) scale(1.05)`;
      if (glow.current) glow.current.style.transform = `translate3d(${cx * 40}px,${cy * 40}px,0)`;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('deviceorientation', onOri); window.removeEventListener('pointermove', onPtr); };
  }, []);

  const layer = { position: 'absolute', inset: 0, width: '100%', height: '100%', willChange: 'transform' };
  const mask = 'radial-gradient(ellipse 52% 46% at 50% 52%, #000 55%, transparent 100%)';
  return (
    <div style={{ position: 'relative', width: '100%', height: fill ? '100%' : '100%', overflow: 'hidden', background: '#000' }}>
      <div ref={stage} style={{ position: 'absolute', inset: 0, transformStyle: 'preserve-3d', willChange: 'transform' }}>
        <img ref={back} src={src} alt="" aria-hidden style={{ ...layer, objectFit: 'cover', filter: 'blur(14px) brightness(.55)' }} />
        <img ref={mid} src={src} alt="" onLoad={onLoad} onError={onError} style={{ ...layer, objectFit: 'contain' }} />
        <img ref={fore} src={src} alt="" aria-hidden style={{ ...layer, objectFit: 'contain', WebkitMaskImage: mask, maskImage: mask }} />
        <div ref={glow} style={{ ...layer, background: 'radial-gradient(circle at 30% 25%, rgba(255,255,255,.16), transparent 40%), radial-gradient(circle at 75% 80%, rgba(180,76,255,.22), transparent 45%)', mixBlendMode: 'normal', pointerEvents: 'none' }} />
      </div>
      <div style={{ position: 'absolute', left: 10, bottom: 10, background: 'rgba(0,0,0,.55)', color: '#fff', fontSize: 10, fontWeight: 800, letterSpacing: 1, padding: '3px 8px', borderRadius: 999, pointerEvents: 'none' }}>3D</div>
    </div>
  );
}

/* ── Voice story: gradient + animated orb; plays the recording ── */
export function StoryVoicePlayer({ src, bg, text, textColor = '#fff', fontStyle = 'system', paused, audioRef, onReady, onDuration, autoPlay = true, controls = false }) {
  const font = (STORY_FONTS.find(f => f.id === fontStyle) || STORY_FONTS[0]).style;
  const bars = useRef(Array.from({ length: 28 }, (_, i) => ({ h: 14 + Math.abs(Math.sin(i * 0.7)) * 46 + (i % 5) * 4, d: (i * 0.06).toFixed(2) }))).current;
  return (
    <div style={{ width: '100%', height: '100%', background: bg || 'linear-gradient(135deg,#9333ea,#4338ca,#2563eb)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 26, padding: 24, position: 'relative' }}>
      <style>{`@keyframes svBar{from{transform:scaleY(.3)}to{transform:scaleY(1)}} @keyframes svOrb{0%,100%{box-shadow:0 0 0 0 rgba(255,255,255,.35)}50%{box-shadow:0 0 0 26px rgba(255,255,255,0)}}`}</style>
      <div style={{ width: 120, height: 120, borderRadius: '50%', background: 'rgba(255,255,255,.18)', border: '2px solid rgba(255,255,255,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: paused ? 'none' : 'svOrb 1.8s ease-out infinite' }}>
        <svg width="54" height="54" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></svg>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, height: 70 }}>
        {bars.map((b, i) => (
          <span key={i} style={{ width: 4, height: b.h, borderRadius: 3, background: 'rgba(255,255,255,.85)', transformOrigin: 'center', animation: `svBar .6s ease-in-out ${b.d}s infinite alternate`, animationPlayState: paused ? 'paused' : 'running' }} />
        ))}
      </div>
      {text ? <p style={{ color: textColor, fontSize: 22, textAlign: 'center', margin: 0, textShadow: '0 2px 8px rgba(0,0,0,.45)', ...font }}>{text}</p> : null}
      {src && (
        <audio ref={audioRef} src={src} autoPlay={autoPlay} controls={controls} playsInline
          onLoadedMetadata={e => { const d = e.target.duration; if (d && isFinite(d) && onDuration) onDuration(d * 1000); }}
          onCanPlay={() => onReady?.()} onError={() => onReady?.()}
          style={controls ? { position: 'absolute', bottom: 16, width: '86%' } : { display: 'none' }} />
      )}
    </div>
  );
}

/* ── Story stickers shown by the viewer: Poll · Q&A · Music · Flip ──
   Everything sits above the story and swallows its own taps, so voting never skips to the next story. */
export function StoryStickers({ story, isOwn, snapFetch, showToast, mediaHref = (u) => u, onPause, onSendAnswer }) {
  const [poll, setPoll] = React.useState(story.poll || null);
  const [flipped, setFlipped] = React.useState(false);
  const [answer, setAnswer] = React.useState(''); const [sent, setSent] = React.useState(false);
  const audio = useRef(null);
  const stop = { onClick: e => e.stopPropagation(), onMouseDown: e => e.stopPropagation(), onMouseUp: e => e.stopPropagation(), onTouchStart: e => e.stopPropagation(), onTouchEnd: e => e.stopPropagation() };
  useEffect(() => { const a = audio.current; if (a) a.play().catch(() => {}); return () => { try { a?.pause(); } catch {} }; }, []);
  const vote = async (i) => {
    if (!poll || poll.myVote !== null && poll.myVote !== undefined) return;
    const r = await snapFetch(`/snapsa/stories/${story._id}/vote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ option: i }) }).catch(() => null);
    const d = await r?.json?.().catch(() => ({}));
    if (r?.ok && d.poll) setPoll(d.poll); else showToast?.(d?.error || 'Could not vote', 'error');
  };
  const box = { background: 'rgba(10,6,24,.72)', backdropFilter: 'blur(10px)', border: '1px solid rgba(255,255,255,.22)', borderRadius: 16, padding: 12, color: 'white' };
  const showRes = poll && (isOwn || (poll.myVote !== null && poll.myVote !== undefined));
  return (
    <>
      {story.song && <div {...stop} style={{ position: 'absolute', top: 70, left: 14, zIndex: 8, display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(0,0,0,.55)', color: 'white', borderRadius: 999, padding: '5px 12px', fontSize: 12, fontWeight: 700, maxWidth: '70%' }}>
        🎵 <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{story.song.title}{story.song.artist ? ` — ${story.song.artist}` : ''}</span>
        {story.song.audioUrl && <audio ref={audio} src={mediaHref(story.song.audioUrl)} loop />}
      </div>}
      {(poll || (story.qa && !isOwn) || (story.qa && isOwn)) && (
        <div {...stop} style={{ position: 'absolute', left: 14, right: 14, top: '46%', transform: 'translateY(-50%)', zIndex: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {poll && <div style={box}>
            <div style={{ fontWeight: 800, marginBottom: 8, fontSize: 15 }}>📊 {poll.question}</div>
            {poll.options.map((o, i) => { const pct = poll.total ? Math.round(o.count * 100 / poll.total) : 0; const mine = poll.myVote === i; return (
              <button key={i} onClick={() => vote(i)} disabled={showRes} style={{ position: 'relative', display: 'block', width: '100%', textAlign: 'left', overflow: 'hidden', marginBottom: 6, padding: '10px 12px', borderRadius: 11, border: mine ? '1.5px solid #60a5fa' : '1px solid rgba(255,255,255,.25)', background: 'rgba(255,255,255,.08)', color: 'white', fontWeight: 700, fontSize: 14 }}>
                {showRes && <span style={{ position: 'absolute', inset: 0, width: pct + '%', background: mine ? 'rgba(96,165,250,.4)' : 'rgba(255,255,255,.14)' }} />}
                <span style={{ position: 'relative', display: 'flex', justifyContent: 'space-between' }}><span>{o.text}</span>{showRes && <span>{pct}%</span>}</span>
              </button>); })}
            {showRes && <div style={{ fontSize: 11, opacity: .75 }}>{poll.total} vote{poll.total === 1 ? '' : 's'}</div>}
          </div>}
          {story.qa && <div style={box}>
            <div style={{ fontWeight: 800, fontSize: 15, marginBottom: isOwn ? 0 : 8 }}>❓ {story.qa}</div>
            {!isOwn && (sent ? <div style={{ fontSize: 13, color: '#86efac', fontWeight: 700 }}>✓ Answer sent privately</div> : (
              <div style={{ display: 'flex', gap: 6 }}>
                <input value={answer} onFocus={onPause} onChange={e => setAnswer(e.target.value.slice(0, 300))} placeholder="Type your answer…" style={{ flex: 1, minWidth: 0, background: 'rgba(255,255,255,.12)', border: '1px solid rgba(255,255,255,.25)', borderRadius: 999, padding: '9px 12px', color: 'white', outline: 'none' }} />
                <button onClick={async () => { if (!answer.trim()) return; const ok = await onSendAnswer?.(`❓ ${story.qa}\n💬 ${answer.trim()}`); if (ok) setSent(true); }} style={{ border: 'none', borderRadius: 999, padding: '0 16px', background: 'linear-gradient(135deg,#8b2cf5,#ff2d95)', color: 'white', fontWeight: 800 }}>Send</button>
              </div>))}
          </div>}
        </div>
      )}
      {story.flipText && <>
        <button {...stop} onClick={() => setFlipped(f => !f)} style={{ position: 'absolute', right: 14, bottom: 150, zIndex: 9, border: 'none', borderRadius: 999, padding: '9px 16px', background: 'rgba(255,255,255,.9)', color: '#111', fontWeight: 800, fontSize: 13 }}>🔄 {flipped ? 'Flip back' : 'Flip'}</button>
        {flipped && <div {...stop} onClick={() => setFlipped(false)} style={{ position: 'absolute', inset: 0, zIndex: 8, background: 'linear-gradient(135deg,#111827,#4c1d95)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 28 }}>
          <p style={{ color: 'white', fontSize: 26, fontWeight: 700, textAlign: 'center', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>{story.flipText}</p>
        </div>}
      </>}
    </>
  );
}
