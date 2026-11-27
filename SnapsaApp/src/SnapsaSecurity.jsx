// src/SnapsaSecurity.jsx — the DEFCON tab of the profile screen (threat levels), built from WernTjat's Security Center.
import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Shield, AlertTriangle, Loader2, Lock, X, EyeOff, Flame } from 'lucide-react';

const C = { pink: '#FF2D95', dark: '#07030F', card: '#150B28', border: 'rgba(180,76,255,0.30)', gray: '#A59BC4' };
const LEVELS = [
  { level: 5, title: 'DEFCON 5 — Monitoring', desc: 'Normal operation. Everything works as usual.', color: '#16a34a' },
  { level: 4, title: 'DEFCON 4 — Restricted', desc: 'Your online status and last-seen are hidden from everyone.', color: '#84cc16' },
  { level: 3, title: 'DEFCON 3 — Lockdown', desc: "You can't do anything on the app: no calls, messages, posts, stories or uploads. You can only watch videos, read posts and use Snapsa Music.", color: '#eab308' },
  { level: 2, title: 'DEFCON 2 — Purge Cache', desc: 'Clears cached feeds, offline copies and temporary data on this device.', color: '#f97316' },
  { level: 1, title: 'DEFCON 1 — Factory Reset', desc: 'Permanently burns all your data but keeps your empty identity. All gifts are converted to coins and sent to your Snapsa Wallet. Snapsa Wallet is not affected.', color: '#dc2626' },
];

async function purgeLocalCache() {
  try { const ks = await (window.caches?.keys?.() || []); await Promise.all(ks.map(k => window.caches.delete(k))); } catch {}
  try { sessionStorage.clear(); } catch {}
  try { Object.keys(localStorage).filter(k => /cache|draft|temp|outbox/i.test(k)).forEach(k => localStorage.removeItem(k)); } catch {}
  try { const m = await import('./native/apiCache'); await (m.clearAll?.() || m.clear?.() || m.purge?.()); } catch {}
  window.dispatchEvent(new CustomEvent('snapsa:purgeCache'));
}

export default function SnapsaSecurity({ onClose, snapFetch, showToast }) {
  const [level, setLevel] = useState(5);
  const [busy, setBusy] = useState(null);
  const [burnOpen, setBurnOpen] = useState(false);
  const [confirm, setConfirm] = useState('');

  const load = useCallback(() => {
    snapFetch('/snapsa/defcon').then(r => r.ok ? r.json() : null).then(d => { if (d?.level) setLevel(d.level); }).catch(() => {});
  }, [snapFetch]);
  useEffect(() => { load(); }, [load]);

  const activate = async (lv) => {
    if (lv === 1) { setBurnOpen(true); return; }
    setBusy(lv);
    try {
      if (lv === 2) { await purgeLocalCache(); showToast?.('🧹 Cache purged on this device', 'success'); setBusy(null); return; }
      const r = await snapFetch('/snapsa/defcon/level', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: lv }) });
      if (r.ok) { setLevel(lv); showToast?.(`DEFCON ${lv} active`, 'success'); }
      else { const d = await r.json().catch(() => ({})); showToast?.(d.error || 'Could not change level', 'error'); }
    } catch { showToast?.('You need to be online to change DEFCON', 'error'); }
    setBusy(null);
  };

  const burn = async () => {
    if (confirm !== 'BURN') return;
    setBusy(1);
    try {
      const r = await snapFetch('/snapsa/defcon/burn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmation: 'BURN' }) });
      if (r.ok) {
        await purgeLocalCache();
        setLevel(5); setBurnOpen(false); setConfirm('');
        showToast?.('🔥 DEFCON 1 complete — your data has been burned', 'success');
        window.dispatchEvent(new CustomEvent('snapsa:storyPosted'));
      } else { const d = await r.json().catch(() => ({})); showToast?.(d.error || 'Burn failed', 'error'); }
    } catch { showToast?.('You need to be online to burn data', 'error'); }
    setBusy(null);
  };

  const badge = level === 5 ? ['NORMAL', '#16a34a'] : level >= 3 ? [`LEVEL ${level}`, '#eab308'] : [`LEVEL ${level}`, '#dc2626'];

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 560, background: C.dark, display: 'flex', flexDirection: 'column' }}>
      {busy === 1 && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(5,2,10,.96)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24, textAlign: 'center' }}>
          <div style={{ fontSize: 64, animation: 'snapsaBurnPulse 1s ease-in-out infinite alternate' }}>🔥</div>
          <div style={{ color: '#fff', fontSize: 20, fontWeight: 800 }}>Burning your data…</div>
          <div style={{ color: 'rgba(255,255,255,.7)', fontSize: 13, maxWidth: 280 }}>Videos, posts, stories and chats are being deleted. Keep the app open until this finishes.</div>
          <style>{'@keyframes snapsaBurnPulse{from{transform:scale(.9);opacity:.7}to{transform:scale(1.15);opacity:1}}'}</style>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 'calc(var(--sat, env(safe-area-inset-top, 0px)) + 12px) 14px 12px', background: 'linear-gradient(90deg,#020617,#172554,#3b0764)', borderBottom: `1px solid ${C.border}` }}>
        <button onClick={onClose} aria-label="Back" style={{ background: 'none', border: 'none', padding: 6, cursor: 'pointer' }}><ArrowLeft size={22} style={{ color: 'white' }} /></button>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, color: 'white', fontSize: 19, fontWeight: 800 }}>DEFCON</h2>
          <p style={{ margin: 0, color: 'rgba(255,255,255,.7)', fontSize: 12 }}>Your personal threat level</p>
        </div>
        <span style={{ background: badge[1] + '33', color: badge[1], padding: '4px 12px', borderRadius: 999, fontSize: 12, fontWeight: 800 }}>{badge[0]}</span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 14px 100px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 14, color: C.gray, fontSize: 13, lineHeight: 1.5 }}>
          <Shield size={18} style={{ color: C.pink, verticalAlign: -4, marginRight: 6 }} />
          Raise your level when you feel at risk. Higher levels protect you more but limit features. Stories, posts and chats are encrypted when stored.
        </div>

        {LEVELS.map(d => {
          const active = level === d.level;
          return (
            <div key={d.level} style={{ background: C.card, border: active ? `1.5px solid ${d.color}` : `1px solid ${C.border}`, borderRadius: 16, padding: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ width: 12, height: 12, borderRadius: '50%', background: d.color, flexShrink: 0, boxShadow: active ? `0 0 10px ${d.color}` : 'none' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: 'white', fontWeight: 800, fontSize: 14 }}>{d.title}</div>
                <div style={{ color: C.gray, fontSize: 12, marginTop: 3, lineHeight: 1.4 }}>{d.desc}</div>
              </div>
              <button onClick={() => activate(d.level)} disabled={busy !== null || (active && d.level !== 2 && d.level !== 1)}
                style={{ flexShrink: 0, border: 'none', borderRadius: 10, padding: '8px 14px', fontWeight: 800, fontSize: 13, color: 'white', cursor: 'pointer', background: d.level === 1 ? '#dc2626' : d.level === 2 ? '#f97316' : '#6d28d9', opacity: (busy !== null || (active && d.level > 2)) ? 0.5 : 1 }}>
                {busy === d.level ? <Loader2 size={14} style={{ animation: 'secSpin 1s linear infinite' }} /> : active && d.level > 2 ? 'Active' : d.level === 2 ? 'Purge' : d.level === 1 ? 'Burn' : 'Activate'}
              </button>
            </div>
          );
        })}
        <style>{`@keyframes secSpin{to{transform:rotate(360deg)}}`}</style>
        <p style={{ color: C.gray, fontSize: 12, display: 'flex', gap: 6, alignItems: 'center', margin: '4px 2px' }}><Lock size={12} /> Level 4 and 3 stay on until you set the level back to 5.</p>
      </div>

      {burnOpen && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 3, background: 'rgba(0,0,0,.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18 }}>
          <div style={{ background: '#12061f', border: '1px solid #dc2626', borderRadius: 18, padding: 18, width: '100%', maxWidth: 400 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <h3 style={{ margin: 0, color: 'white', fontSize: 17 }}><AlertTriangle size={18} style={{ color: '#ef4444', verticalAlign: -3 }} /> DEFCON 1 — Factory Reset</h3>
              <button onClick={() => { setBurnOpen(false); setConfirm(''); }} style={{ background: 'none', border: 'none', color: 'white' }}><X size={18} /></button>
            </div>
            <p style={{ color: '#fca5a5', background: 'rgba(220,38,38,.12)', border: '1px solid rgba(220,38,38,.4)', borderRadius: 12, padding: 10, fontSize: 13, margin: '0 0 12px' }}>
              This permanently deletes all your stories, posts, chats and notifications. It cannot be undone. All your gifts are converted to coins and sent to your Snapsa Wallet. Your identity, wallet and followers are kept.
            </p>
            <p style={{ color: C.gray, fontSize: 13, margin: '0 0 8px' }}>Type <strong style={{ color: '#f87171' }}>BURN</strong> to confirm:</p>
            <input value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="BURN" autoFocus style={{ width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,.08)', border: '1px solid #7f1d1d', borderRadius: 12, padding: 12, color: 'white', fontFamily: 'monospace', outline: 'none' }} />
            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button onClick={() => { setBurnOpen(false); setConfirm(''); }} style={{ flex: 1, padding: 12, borderRadius: 12, border: '1px solid rgba(255,255,255,.2)', background: 'transparent', color: 'white', fontWeight: 700 }}>Cancel</button>
              <button onClick={burn} disabled={confirm !== 'BURN' || busy !== null} style={{ flex: 1, padding: 12, borderRadius: 12, border: 'none', background: '#dc2626', color: 'white', fontWeight: 800, opacity: confirm !== 'BURN' || busy !== null ? 0.5 : 1 }}>{busy === 1 ? 'Burning…' : <><Flame size={14} style={{ verticalAlign: -2 }} /> Confirm Burn</>}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
