// src/VoiceDraft.jsx — shown after a voice note is recorded: pick an effect, listen, then send or discard.
import React, { useEffect, useRef, useState } from 'react';
import { VOICE_EFFECTS, applyVoiceEffect } from './voiceEffects';

export default function VoiceDraft({ blob, ext = '.webm', duration, onSend, onDiscard }) {
  const [fx, setFx] = useState('natural');
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState(null);
  const outRef = useRef(blob);

  useEffect(() => {
    let dead = false, made = null;
    setBusy(true);
    applyVoiceEffect(blob, fx).then((b) => {
      if (dead) return;
      outRef.current = b; made = URL.createObjectURL(b); setUrl(made); setBusy(false);
    }).catch(() => { if (!dead) { outRef.current = blob; setFx('natural'); setBusy(false); } });
    return () => { dead = true; if (made) URL.revokeObjectURL(made); };
  }, [blob, fx]);

  const send = () => {
    const out = outRef.current;
    const isWav = out !== blob;
    const type = isWav ? 'audio/wav' : (blob.type || 'audio/webm');
    onSend(new File([out], `voice_${Date.now()}${isWav ? '.wav' : ext}`, { type }), duration);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 800, background: 'rgba(0,0,0,.7)', display: 'flex', alignItems: 'flex-end' }}>
      <div style={{ width: '100%', background: '#12061f', borderTop: '1px solid rgba(180,76,255,.5)', borderRadius: '22px 22px 0 0', padding: '18px 16px calc(18px + env(safe-area-inset-bottom,0px))' }}>
        <p style={{ color: 'white', fontWeight: 800, fontSize: 16, margin: '0 0 12px' }}>Voice effect</p>
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 6, scrollbarWidth: 'none' }}>
          {VOICE_EFFECTS.map(e => (
            <button key={e.id} onClick={() => setFx(e.id)} disabled={busy && fx !== e.id}
              style={{ flexShrink: 0, padding: '8px 14px', borderRadius: 999, border: fx === e.id ? '1.5px solid #ff2d95' : '1px solid rgba(255,255,255,.25)', background: fx === e.id ? 'linear-gradient(135deg,#8b2cf5,#ff2d95)' : 'rgba(255,255,255,.08)', color: 'white', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
              {e.emoji} {e.label}
            </button>
          ))}
        </div>
        <div style={{ margin: '12px 0', minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {busy ? <span style={{ color: '#a99bd0', fontSize: 13 }}>Applying effect…</span>
            : url && <audio key={url} src={url} controls style={{ width: '100%' }} />}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onDiscard} style={{ flex: 1, padding: 13, borderRadius: 14, border: '1px solid rgba(255,255,255,.2)', background: 'transparent', color: 'white', fontWeight: 700, cursor: 'pointer' }}>Discard</button>
          <button onClick={send} disabled={busy} style={{ flex: 2, padding: 13, borderRadius: 14, border: 'none', background: 'linear-gradient(135deg,#8b2cf5,#ff2d95)', color: 'white', fontWeight: 800, cursor: 'pointer', opacity: busy ? 0.5 : 1 }}>Send</button>
        </div>
      </div>
    </div>
  );
}
