// src/ShareCard.jsx — "Share Snapsa" card: logo, avatar, name, QR (Snapsa logo in the middle), CONNECT ON SNAPSA, and CREW + position for crew only.
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { profileLink } from './DeepLink';

const loadImg = (src, cors) => new Promise((res, rej) => { const i = new Image(); if (cors) i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = rej; i.src = src; });
const firstOk = async (srcs, cors) => { for (const s of srcs) { try { return await loadImg(s, cors); } catch {} } return null; };

export async function drawShareCard({ name, username, avatarUrl, crewPosition }) {
  const W = 720, H = crewPosition ? 1160 : 1010;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  // background + rounded card
  const bg = ctx.createLinearGradient(0, 0, W, H); bg.addColorStop(0, '#1b0b3a'); bg.addColorStop(0.55, '#14082b'); bg.addColorStop(1, '#0c041c');
  ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect(0, 0, W, H, 40); ctx.fill();
  ctx.strokeStyle = 'rgba(180,76,255,0.55)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.roundRect(2, 2, W - 4, H - 4, 38); ctx.stroke();
  ctx.fillStyle = 'rgba(180,76,255,0.55)'; ctx.beginPath(); ctx.roundRect(W / 2 - 34, 22, 68, 7, 4); ctx.fill();

  // Snapsa logo (top-left)
  const logo = await firstOk(['/SnapsaWatermark.png', '/SnapsaLogo.png']);
  if (logo) { const lw = 360, lh = lw * logo.naturalHeight / logo.naturalWidth; ctx.drawImage(logo, 44, 52, lw, Math.min(lh, 130)); }
  else { ctx.fillStyle = '#fff'; ctx.font = '900 60px system-ui'; ctx.textAlign = 'left'; ctx.fillText('SNAPSA', 48, 120); }

  // avatar
  const ay = 270, ar = 78;
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(W / 2, ay, ar + 5, 0, Math.PI * 2); ctx.fill();
  ctx.save(); ctx.beginPath(); ctx.arc(W / 2, ay, ar, 0, Math.PI * 2); ctx.clip();
  let av = null; if (avatarUrl) av = await firstOk([avatarUrl].filter(Boolean).map(u => u), true).catch(() => null);
  if (av) { const s = Math.max(ar * 2 / av.naturalWidth, ar * 2 / av.naturalHeight); const dw = av.naturalWidth * s, dh = av.naturalHeight * s; ctx.drawImage(av, W / 2 - dw / 2, ay - dh / 2, dw, dh); }
  else { ctx.fillStyle = '#7C3AED'; ctx.fillRect(W / 2 - ar, ay - ar, ar * 2, ar * 2); ctx.fillStyle = '#fff'; ctx.font = '900 70px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(((name || username || 'S').replace(/^@/, '')[0] || 'S').toUpperCase(), W / 2, ay + 4); }
  ctx.restore();

  // name (shrinks to fit)
  const shown = name || (username ? `@${username}` : '');
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  let fs = 34; ctx.font = `700 ${fs}px system-ui, -apple-system, Roboto, sans-serif`;
  while (ctx.measureText(shown).width > W - 80 && fs > 18) { fs -= 1; ctx.font = `700 ${fs}px system-ui, -apple-system, Roboto, sans-serif`; }
  ctx.fillText(shown, W / 2, 398);

  // QR panel
  const qy = 430, qs = 440, px = (W - qs) / 2;
  ctx.fillStyle = '#161616'; ctx.beginPath(); ctx.roundRect(px, qy, qs, qs, 34); ctx.fill();
  const QR = await import('qrcode');
  const qc = document.createElement('canvas');
  await (QR.default || QR).toCanvas(qc, profileLink(username || ''), { errorCorrectionLevel: 'H', margin: 0, width: 360, color: { dark: '#0b0b14', light: '#ffffff' } });
  const qx = px + 40;
  ctx.fillStyle = '#fff'; ctx.fillRect(qx - 12, qy + 28, 384, 384); ctx.drawImage(qc, qx, qy + 40, 360, 360);
  // Snapsa logo in the middle of the QR
  const icon = await firstOk(['/SnapsaLogo.png', '/icon-foreground.png', '/SnapsaHub.png']);
  const cs = 92, cx = W / 2 - cs / 2, cy = qy + 220 - cs / 2;
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.roundRect(cx - 8, cy - 8, cs + 16, cs + 16, 22); ctx.fill();
  ctx.save(); ctx.beginPath(); ctx.roundRect(cx, cy, cs, cs, 18); ctx.clip();
  if (icon) { ctx.fillStyle = '#1b0b3a'; ctx.fillRect(cx, cy, cs, cs); ctx.drawImage(icon, cx, cy, cs, cs); } else { ctx.fillStyle = '#7C3AED'; ctx.fillRect(cx, cy, cs, cs); ctx.fillStyle = '#fff'; ctx.font = '900 56px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('S', W / 2, cy + cs / 2 + 3); }
  ctx.restore();

  // CONNECT ON SNAPSA
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.font = '900 52px system-ui, Impact, sans-serif'; ctx.shadowColor = '#ff2d95'; ctx.shadowBlur = 18;
  ctx.fillStyle = '#ff2d95'; ctx.fillText('CONNECT ON SNAPSA', W / 2, qy + qs + 78, W - 50);
  ctx.shadowBlur = 0; ctx.lineWidth = 1.5; ctx.strokeStyle = '#ff6a3d'; ctx.strokeText('CONNECT ON SNAPSA', W / 2, qy + qs + 78, W - 50);

  if (crewPosition) {
    ctx.fillStyle = '#fff'; ctx.font = '900 68px "Courier New", ui-monospace, monospace'; try { ctx.letterSpacing = '4px'; } catch {}
    ctx.fillText('CREW', W / 2, qy + qs + 170);
    ctx.fillStyle = '#cfc7e6'; ctx.font = '700 38px "Courier New", ui-monospace, monospace'; try { ctx.letterSpacing = '3px'; } catch {}
    let t = String(crewPosition).toUpperCase(), f2 = 38; while (ctx.measureText(t).width > W - 70 && f2 > 18) { f2 -= 1; ctx.font = `700 ${f2}px "Courier New", ui-monospace, monospace`; }
    ctx.fillText(t, W / 2, qy + qs + 232); try { ctx.letterSpacing = '0px'; } catch {}
  }
  return c;
}

export default function ShareSnapsaCard({ onClose, snapsaUsername, name, avatarUrl, crewPosition, showToast }) {
  const [src, setSrc] = useState('');
  const canvasRef = useRef(null);
  const link = profileLink(snapsaUsername || '');
  useEffect(() => { let alive = true; drawShareCard({ name: (name && name !== `@${snapsaUsername}`) ? name : '', username: snapsaUsername, avatarUrl, crewPosition }).then(c => { canvasRef.current = c; if (alive) setSrc(c.toDataURL('image/png')); }).catch(() => {}); return () => { alive = false; }; }, []);
  const blob = () => new Promise(r => canvasRef.current.toBlob(r, 'image/png'));
  const save = async () => { if (!canvasRef.current) return; const b = await blob(); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = `snapsa_${snapsaUsername || 'card'}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(u), 3000); showToast?.('Card saved', 'success'); };
  const share = async () => {
    try { const b = await blob(); const f = new File([b], `snapsa_${snapsaUsername}.png`, { type: 'image/png' });
      if (navigator.canShare?.({ files: [f] })) { await navigator.share({ files: [f], text: `Connect with me on Snapsa: ${link}` }); return; }
      if (navigator.share) { await navigator.share({ text: `Connect with me on Snapsa: ${link}`, url: link }); return; } } catch (e) { if (e?.name === 'AbortError') return; }
    navigator.clipboard?.writeText(link).catch(() => {}); showToast?.('Link copied', 'success');
  };
  const btn = (bg) => ({ width: '100%', padding: '13px 0', borderRadius: 12, background: bg, color: '#fff', fontWeight: 700, fontSize: 14, border: 'none', cursor: 'pointer', marginBottom: 10 });
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 9000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.8)', padding: 14 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 380, maxHeight: '100%', overflowY: 'auto' }}>
        {src ? <img src={src} alt="Snapsa card" style={{ width: '100%', display: 'block', borderRadius: 22, marginBottom: 12 }} /> : <p style={{ color: '#A59BC4', textAlign: 'center', padding: 40 }}>Making your card…</p>}
        <button onClick={share} style={btn('linear-gradient(90deg,#7C3AED,#FF2D95)')}>Share card</button>
        <button onClick={save} style={btn('rgba(255,255,255,0.12)')}>Save to device</button>
        <button onClick={() => { navigator.clipboard?.writeText(link).catch(() => {}); showToast?.('Link copied', 'success'); }} style={btn('rgba(255,255,255,0.12)')}>Copy link</button>
        <button onClick={onClose} style={btn('transparent')}>Close</button>
      </div>
    </div>, document.body);
}
