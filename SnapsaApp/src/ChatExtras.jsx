// src/ChatExtras.jsx — chat features ported from WernTjat, rebuilt for Snapsa DMs:
//   • useChatLock + ChatLockOverlay   (chat lock: bubbles show "👻 ENCRYPTED" until you Unlock with PIN or fingerprint/face)
//   • BurnBubble                      (burn after view — opens a viewer; closing it burns the message)
//   • AttachSheet                     (photos/videos, camera, any file, Bluetooth/Nearby share, burn toggle)
//   • FileBubble                      (file messages)
//   • shareNearby                     (send text/file over Bluetooth or Quick Share through the Android share sheet)
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Lock, Fingerprint, X, Flame, Image as ImageIcon, Camera, FileText, Bluetooth, Download, Music } from 'lucide-react';
import { useScreenGuard } from './ScreenGuard';
import { isChatLocked, setChatPin, verifyChatPin, removeChatLock, chatLockUsesBio, bioAvailable, bioVerify, PIN_MIN, PIN_MAX } from './ChatLock';

const C = { pink: '#FF2D95', dark: '#07030F', card: '#150B28', border: 'rgba(180,76,255,0.30)', gray: '#A59BC4' };

/* ───────────────────────── Chat lock ─────────────────────────
   Lock ON  → the chat opens, but every bubble (sent and received, including new ones) shows 👻 ENCRYPTED.
   Unlock   → bubbles are readable until you tap the lock icon again, leave the chat or leave the app.
   The PIN is never stored; fingerprint/face is optional and needs the Android APK. */
export function useChatLock(chatId, notify) {
  const [locked, setLocked] = useState(false);
  const [unlocked, setUnlocked] = useState(false);   // in memory only → every time the chat is opened it starts hidden
  const [menu, setMenu] = useState(null);            // null | 'set' | 'manage'
  const [bio, setBio] = useState(false);
  useEffect(() => {
    setUnlocked(false); setMenu(null);
    if (!chatId) return;
    let dead = false;
    isChatLocked(chatId).then(l => { if (!dead) setLocked(l); });
    chatLockUsesBio(chatId).then(b => { if (!dead) setBio(b); });
    return () => { dead = true; };
  }, [chatId]);
  // leaving the app hides the bubbles again
  useEffect(() => {
    const h = () => { if (document.hidden) setUnlocked(false); };
    document.addEventListener('visibilitychange', h);
    return () => document.removeEventListener('visibilitychange', h);
  }, []);
  const hidden = locked && !unlocked;
  return {
    locked, unlocked, hidden, menu, bio,
    openMenu: () => {
      if (!locked) setMenu('set');
      else if (unlocked) { setUnlocked(false); notify?.('🔒 Chat locked again', 'success'); }
      else setMenu('manage');
    },
    closeMenu: () => setMenu(null),
    async setPin(pin, useBio) { await setChatPin(chatId, pin, useBio); setLocked(true); setBio(!!useBio); setUnlocked(false); setMenu(null); notify?.('🔒 Chat locked — messages now show as ENCRYPTED', 'success'); },
    async unlock(pin) { if (!(await verifyChatPin(chatId, pin))) return false; setUnlocked(true); setMenu(null); return true; },
    async unlockBio() { if (!(await bioVerify('Unlock this chat'))) return false; setUnlocked(true); setMenu(null); return true; },
    async remove(pin) { if (!(await verifyChatPin(chatId, pin))) return false; await removeChatLock(chatId); setLocked(false); setUnlocked(false); setBio(false); setMenu(null); notify?.('🔓 Lock removed', 'success'); return true; },
    async removeBio() { if (!(await bioVerify('Remove the lock from this chat'))) return false; await removeChatLock(chatId); setLocked(false); setUnlocked(false); setBio(false); setMenu(null); notify?.('🔓 Lock removed', 'success'); return true; },
  };
}

function PinBox({ title, sub, onSubmit, onCancel, submitLabel = 'Continue', confirm = false, offerBio = false, onBio }) {
  const [pin, setPin] = useState(''); const [pin2, setPin2] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const [useBio, setUseBio] = useState(false); const [bioOk, setBioOk] = useState(false);
  useEffect(() => { if (offerBio) bioAvailable().then(setBioOk); }, [offerBio]);
  const go = async () => {
    setErr('');
    if (pin.length < PIN_MIN) { setErr(`PIN must be ${PIN_MIN}–${PIN_MAX} digits`); return; }
    if (confirm && pin !== pin2) { setErr('The two PINs do not match'); return; }
    setBusy(true);
    const res = await onSubmit(pin, useBio && bioOk);
    setBusy(false);
    if (res === false) { setErr('❌ Incorrect PIN'); setPin(''); }
  };
  const inp = { width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,.08)', border: `1px solid ${C.border}`, borderRadius: 14, padding: 14, color: 'white', fontSize: 22, letterSpacing: 8, textAlign: 'center', outline: 'none' };
  return (
    <div style={{ width: '100%', maxWidth: 340, textAlign: 'center', background: '#12061f', border: `1px solid ${C.border}`, borderRadius: 20, padding: 20 }}>
      <div style={{ width: 60, height: 60, borderRadius: '50%', background: 'linear-gradient(135deg,#8b2cf5,#ff2d95)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}><Lock size={28} style={{ color: 'white' }} /></div>
      <h3 style={{ color: 'white', margin: '0 0 6px', fontSize: 18 }}>{title}</h3>
      <p style={{ color: C.gray, fontSize: 13, margin: '0 0 14px' }}>{sub}</p>
      {onBio && <button onClick={async () => { setBusy(true); const ok = await onBio(); setBusy(false); if (!ok) setErr('Fingerprint / face did not match — use your PIN'); }} style={{ width: '100%', padding: 13, borderRadius: 14, border: `1px solid ${C.border}`, background: 'rgba(255,255,255,.06)', color: 'white', fontWeight: 800, marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center' }}><Fingerprint size={20} /> Use fingerprint / face</button>}
      <input type="password" inputMode="numeric" maxLength={PIN_MAX} value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ''))} onKeyDown={e => e.key === 'Enter' && !confirm && go()} placeholder="••••" style={inp} />
      {confirm && <input type="password" inputMode="numeric" maxLength={PIN_MAX} value={pin2} onChange={e => setPin2(e.target.value.replace(/\D/g, ''))} placeholder="Repeat PIN" style={{ ...inp, marginTop: 10 }} />}
      {confirm && bioOk && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, color: 'white', fontSize: 13.5, textAlign: 'left', cursor: 'pointer' }}>
          <input type="checkbox" checked={useBio} onChange={e => setUseBio(e.target.checked)} style={{ width: 20, height: 20 }} />
          <span><Fingerprint size={15} style={{ verticalAlign: -2 }} /> Also unlock with fingerprint / face</span>
        </label>
      )}
      {err && <p style={{ color: '#f87171', fontSize: 13, margin: '10px 0 0' }}>{err}</p>}
      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        {onCancel && <button onClick={onCancel} style={{ flex: 1, padding: 13, borderRadius: 14, border: '1px solid rgba(255,255,255,.2)', background: 'transparent', color: 'white', fontWeight: 700 }}>Cancel</button>}
        <button onClick={go} disabled={busy} style={{ flex: 1, padding: 13, borderRadius: 14, border: 'none', background: 'linear-gradient(135deg,#8b2cf5,#ff2d95)', color: 'white', fontWeight: 800, opacity: busy ? .6 : 1 }}>{busy ? '…' : submitLabel}</button>
      </div>
    </div>
  );
}

export function ChatLockOverlay({ lock }) {
  const [mode, setMode] = useState('menu');          // menu | unlock | remove
  useEffect(() => { if (lock.menu) setMode('menu'); }, [lock.menu]);
  if (!lock.menu) return null;
  const wrap = { position: 'fixed', inset: 0, zIndex: 700, background: 'rgba(0,0,0,.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 };
  if (lock.menu === 'set') {
    return <div style={wrap}><PinBox title="Lock this chat" sub={`Choose a ${PIN_MIN}–${PIN_MAX} digit PIN. With the lock on, the chat still opens but every message shows as 👻 ENCRYPTED until you unlock. If you forget the PIN it cannot be recovered.`} confirm offerBio submitLabel="Lock chat" onSubmit={(p, b) => lock.setPin(p, b)} onCancel={lock.closeMenu} /></div>;
  }
  const bioFn = (fn) => async () => { const ok = await fn(); return ok; };
  return (
    <div style={wrap} onClick={lock.closeMenu}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 340 }}>
        {mode === 'menu' && (
          <div style={{ background: '#12061f', border: `1px solid ${C.border}`, borderRadius: 20, padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <h3 style={{ margin: '0 0 4px', color: 'white', textAlign: 'center' }}>🔒 Chat lock</h3>
            <button onClick={async () => { if (lock.bio && await lock.unlockBio()) return; setMode('unlock'); }} style={{ padding: 15, borderRadius: 14, border: 'none', background: 'linear-gradient(135deg,#8b2cf5,#ff2d95)', color: 'white', fontWeight: 800, fontSize: 17 }}>Unlock</button>
            <button onClick={() => setMode('remove')} style={{ padding: 14, borderRadius: 14, border: '1px solid rgba(248,113,113,.5)', background: 'transparent', color: '#f87171', fontWeight: 800 }}>Remove lock</button>
            <button onClick={lock.closeMenu} style={{ padding: 12, borderRadius: 14, border: 'none', background: 'rgba(255,255,255,.08)', color: 'white', fontWeight: 700 }}>Close</button>
          </div>
        )}
        {mode === 'unlock' && <PinBox title="Unlock chat" sub="Enter your PIN to read the messages." submitLabel="Unlock" onSubmit={(p) => lock.unlock(p)} onCancel={() => setMode('menu')} onBio={lock.bio ? bioFn(lock.unlockBio) : null} />}
        {mode === 'remove' && <PinBox title="Remove lock" sub="Confirm it is you to remove the lock from this chat." submitLabel="Remove" onSubmit={(p) => lock.remove(p)} onCancel={() => setMode('menu')} onBio={lock.bio ? bioFn(lock.removeBio) : null} />}
      </div>
    </div>
  );
}

/* ───────────────────────── Burn after view ─────────────────────────
   Receiver taps → a full-screen viewer opens with the content. It stays open until THEY press Close; closing burns it.
   The viewer lives in a portal and is independent of the message list refreshing (the server marks the message burned
   the moment it is opened, and the list reloads — that used to tear the viewer down immediately). */
export function BurnBubble({ m, isOwn, snapFetch, mediaHref, showToast, onChanged }) {
  const [content, setContent] = useState(null);
  const [opening, setOpening] = useState(false);
  const [closedHere, setClosedHere] = useState(false);
  useScreenGuard(!!content);

  const close = useCallback(() => { setContent(null); setClosedHere(true); onChanged?.(); }, [onChanged]);

  const open = async () => {
    if (opening) return; setOpening(true);
    try {
      const r = await snapFetch(`/snapsa/messages/message/${m._id}/open`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.content) setContent(d.content);
      else { showToast?.(d.error || 'Could not open', 'error'); onChanged?.(); }
    } catch { showToast?.('You need to be online to open this', 'error'); }
    setOpening(false);
  };

  // leaving the app while it is open burns it for good
  useEffect(() => {
    if (!content) return;
    const h = () => { if (document.hidden) close(); };
    document.addEventListener('visibilitychange', h);
    return () => document.removeEventListener('visibilitychange', h);
  }, [content, close]);

  const url = content?.mediaUrl ? (mediaHref ? mediaHref(content.mediaUrl) : content.mediaUrl) : null;
  const stop = (e) => e.stopPropagation();   // a portal still bubbles React events to the message row (long-press menu)
  const viewer = content ? createPortal(
    <div onClick={stop} onMouseDown={stop} onTouchStart={stop} onTouchEnd={stop} onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,.96)', display: 'flex', flexDirection: 'column', userSelect: 'none', WebkitUserSelect: 'none' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 'calc(var(--sat, env(safe-area-inset-top, 0px)) + 14px) 16px 10px' }}>
        <span style={{ color: '#fbbf24', fontWeight: 800 }}>🔥 Burns when you close this</span>
        <button onClick={close} aria-label="Close" style={{ background: 'rgba(255,255,255,.14)', border: 'none', borderRadius: '50%', padding: 10 }}><X size={20} style={{ color: 'white' }} /></button>
      </div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, overflow: 'auto' }}>
        {content.type === 'text' && <p style={{ color: 'white', fontSize: 24, textAlign: 'center', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>{content.text}</p>}
        {content.type === 'photo' && url && <img src={url} alt="" draggable={false} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />}
        {content.type === 'video' && url && <video src={url} controls autoPlay playsInline controlsList="nodownload" style={{ maxWidth: '100%', maxHeight: '100%' }} />}
        {content.type === 'voice' && url && <audio src={url} controls autoPlay style={{ width: '90%' }} />}
        {content.type === 'file' && url && <a href={url} target="_blank" rel="noreferrer" style={{ color: 'white', background: 'rgba(255,255,255,.1)', padding: '14px 20px', borderRadius: 14, textDecoration: 'none' }}>📎 {content.fileName || 'File'} — tap to download</a>}
      </div>
      <div style={{ padding: '10px 16px calc(16px + env(safe-area-inset-bottom,0px))' }}>
        <button onClick={close} style={{ width: '100%', padding: 15, borderRadius: 16, border: 'none', background: 'linear-gradient(135deg,#f59e0b,#dc2626)', color: 'white', fontWeight: 800, fontSize: 16 }}>Close &amp; burn</button>
      </div>
    </div>, document.body) : null;

  // while the viewer is open it always wins, even though the message is already marked burned on the server
  if (viewer) return <>{<span style={{ color: '#fbbf24', fontSize: 14, fontWeight: 700 }}>🔥 Opened…</span>}{viewer}</>;
  if (m.burned || closedHere) return <span style={{ color: '#fbbf24', fontSize: 14, fontWeight: 700 }}>🔥 {isOwn ? 'Opened and burned' : 'Burned'}</span>;
  if (isOwn) return <span style={{ color: '#fbbf24', fontSize: 14, fontWeight: 700 }}>🔥 Burn message · waiting to be opened</span>;
  return (
    <button onClick={open} disabled={opening} style={{ background: 'rgba(245,158,11,.14)', border: '1px dashed #f59e0b', borderRadius: 14, padding: '12px 16px', color: '#fbbf24', fontWeight: 800, cursor: 'pointer' }}>
      🔥 {opening ? 'Opening…' : 'Burn after view — tap to open'}
    </button>
  );
}

/* ───────────────────────── File messages ───────────────────────── */
const fmtSize = (b) => !b ? '' : b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`;
export function FileBubble({ m, mediaHref }) {
  const url = m.mediaUrl ? (mediaHref ? mediaHref(m.mediaUrl) : m.mediaUrl) : null;
  return (
    <a href={url || '#'} target="_blank" rel="noreferrer" download={m.fileName || true}
      style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', minWidth: 190, maxWidth: 260 }}>
      <span style={{ width: 42, height: 42, borderRadius: 12, background: 'rgba(255,255,255,.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><FileText size={22} style={{ color: 'white' }} /></span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', color: 'white', fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.fileName || 'File'}</span>
        <span style={{ display: 'block', color: 'rgba(255,255,255,.7)', fontSize: 11.5 }}>{fmtSize(m.fileSize)}</span>
      </span>
      <Download size={18} style={{ color: 'white', flexShrink: 0 }} />
    </a>
  );
}

/* ───────────────────────── Bluetooth / Nearby (share sheet) ───────────────────────── */
// Web Bluetooth cannot reach another phone's app, so we hand the message or file to Android's own share sheet.
// Bluetooth, Quick Share / Nearby Share and other nearby options all appear there and do the actual transfer.
export async function shareNearby({ text, file }) {
  const { Share } = await import('@capacitor/share');
  if (file) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
    const safe = (file.name || 'file').replace(/[^\w.\- ]+/g, '_');
    const path = `nearby/${Date.now()}_${safe}`;
    await Filesystem.writeFile({ path, data: b64, directory: Directory.Cache, recursive: true });
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
    await Share.share({ title: safe, files: [uri], dialogTitle: 'Send via Bluetooth or Nearby' });
  } else {
    await Share.share({ text, dialogTitle: 'Send via Bluetooth or Nearby' });
  }
}

/* ───────────────────────── Attach sheet ───────────────────────── */
export function AttachSheet({ open, onClose, onPick, onNearbyText, burn, setBurn }) {
  const photoRef = useRef(null), camRef = useRef(null), fileRef = useRef(null), audioRef = useRef(null), nearRef = useRef(null);
  if (!open) return null;
  const handle = (kind) => (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) { onPick(f, kind); onClose(); } };
  const tiles = [
    { l: 'Photos & Videos', I: ImageIcon, g: 'linear-gradient(135deg,#3b82f6,#6366f1)', fn: () => photoRef.current?.click() },
    { l: 'Camera', I: Camera, g: 'linear-gradient(135deg,#ef4444,#f97316)', fn: () => camRef.current?.click() },
    { l: 'Files', I: FileText, g: 'linear-gradient(135deg,#f59e0b,#eab308)', fn: () => fileRef.current?.click() },
    { l: 'Songs', I: Music, g: 'linear-gradient(135deg,#10b981,#14b8a6)', fn: () => audioRef.current?.click() },
    ...(setBurn ? [{ l: burn ? 'Burn: ON' : 'Burn after read', I: Flame, g: burn ? 'linear-gradient(135deg,#f59e0b,#dc2626)' : 'linear-gradient(135deg,#78350f,#7f1d1d)', fn: () => { setBurn(!burn); } }] : []),
  ];
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 700, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'flex-end' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', background: '#12061f', borderTop: `1px solid ${C.border}`, borderRadius: '22px 22px 0 0', padding: '16px 16px calc(18px + env(safe-area-inset-bottom,0px))' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, color: 'white' }}>Send</h3>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,.1)', border: 'none', borderRadius: '50%', padding: 7 }}><X size={16} style={{ color: 'white' }} /></button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
          {tiles.map(({ l, I, g, fn }) => (
            <button key={l} onClick={fn} style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.08)', borderRadius: 14, padding: '10px 2px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, color: 'white', cursor: 'pointer' }}>
              <span style={{ width: 42, height: 42, borderRadius: 13, background: g, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><I size={20} /></span>
              <span style={{ fontSize: 10.5, fontWeight: 700, textAlign: 'center', lineHeight: 1.2 }}>{l}</span>
            </button>
          ))}
        </div>
        {burn && <p style={{ color: '#fbbf24', fontSize: 12, margin: '12px 2px 0' }}>🔥 Your next message burns after the other person opens it once.</p>}
        <input ref={photoRef} type="file" accept="image/*,video/*" hidden onChange={handle('media')} />
        <input ref={camRef} type="file" accept="image/*,video/*" capture="environment" hidden onChange={handle('media')} />
        <input ref={fileRef} type="file" hidden onChange={handle('file')} />
        <input ref={audioRef} type="file" accept="audio/*" hidden onChange={handle('file')} />
      </div>
    </div>
  );
}
