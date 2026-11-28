// src/SnapsaGroups.jsx — Group chats for Snapsa: the groups bar on the Messages tab, "New group", the group chat screen and group info.
// Features: create a group with ANY number of members (even none), text/photo/video/voice/file, replies, anonymous replies,
// 👻 ghost mode, 🔒 exclusive messages, reactions, delete for everyone, invite code + QR, admins, chat lock, Snapsa sounds.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import VoiceDraft from './VoiceDraft';
import { ArrowLeft, Plus, Users, Lock, Unlock, Send, Mic, X, Smile, Eye, Reply, Copy, Trash2, Crown, UserMinus, LogOut, Camera, Search, Check, Info, Play, Pause, CheckCheck } from 'lucide-react';
import { useChatLock, ChatLockOverlay, AttachSheet, FileBubble } from './ChatExtras';
import { CrewPill } from './CrewKit';
import { OfficialPill } from './PostExtras';
import { playSent, playIncoming, playRecStart, playRecCancel, playVoiceEnd } from './SnapsaSounds';

const C = { pink: '#FF2D95', dark: '#07030F', card: '#150B28', border: 'rgba(180,76,255,0.30)', gray: '#A59BC4', purple: '#B44CFF' };
const grad = 'linear-gradient(135deg,#8b2cf5,#ff2d95)';
const EMOJIS = ['😀', '😂', '🥹', '😍', '😘', '😎', '🤩', '🥳', '😭', '😡', '🤔', '🙄', '😴', '🤯', '🥶', '🤗', '👍', '👎', '👏', '🙌', '🙏', '💪', '🤝', '✌️', '❤️', '🧡', '💛', '💚', '💙', '💜', '🔥', '✨', '🎉', '💯', '💀', '👀', '🌹', '🍻', '⚽', '🎶'];
const QUICK = ['❤️', '👍', '😂', '😮', '😢', '🔥'];

const Avatar = ({ src, name, size = 40, ghost }) => (
  ghost ? <div style={{ width: size, height: size, borderRadius: '50%', background: '#2a2038', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.5, flexShrink: 0 }}>👻</div>
    : src ? <img src={src} alt="" style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
    : <div style={{ width: size, height: size, borderRadius: '50%', background: grad, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 800, fontSize: size * 0.42, flexShrink: 0 }}>{(name || '?')[0]?.toUpperCase()}</div>
);
const timeOf = (d) => { try { return new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
const dayLabel = (d) => {
  const x = new Date(d), t = new Date(); const y = new Date(); y.setDate(t.getDate() - 1);
  const same = (a, b) => a.toDateString() === b.toDateString();
  return same(x, t) ? 'Today' : same(x, y) ? 'Yesterday' : x.toLocaleDateString([], { day: 'numeric', month: 'short', year: x.getFullYear() === t.getFullYear() ? undefined : 'numeric' });
};
const lastSeen = (d) => { if (!d) return 'offline'; const m = Math.floor((Date.now() - new Date(d).getTime()) / 60000); if (isNaN(m)) return 'offline'; if (m < 1) return 'just now'; if (m < 60) return `${m}m ago`; const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`; const dd = Math.floor(h / 24); return dd < 7 ? `${dd}d ago` : new Date(d).toLocaleDateString([], { day: 'numeric', month: 'short' }); };
const Ticks = ({ r, pending }) => {
  if (pending) return <span style={{ fontSize: 11 }}>🕒</span>;
  if (!r || !r.total) return <Check size={14} style={{ opacity: .7 }} />;
  if (r.read >= r.total) return <CheckCheck size={14} style={{ color: C.pink }} />;
  if (r.read > 0) return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}><CheckCheck size={14} style={{ opacity: .85 }} /><span style={{ fontSize: 10 }}>{r.read}/{r.total}</span></span>;
  return <Check size={14} style={{ opacity: .7 }} />;
};
const cb = { padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1, cursor: 'pointer', flexShrink: 0 };
const inp = { width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,.07)', border: `1px solid ${C.border}`, borderRadius: 12, padding: '12px 14px', color: 'white', fontSize: 15, outline: 'none', marginBottom: 10 };

/* ───────────── people picker (search) ───────────── */
function MemberPicker({ snapFetch, selected, onToggle, exclude = [], me }) {
  const [q, setQ] = useState(''), [rows, setRows] = useState([]), [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.trim().length < 2) { setRows([]); return; }
    let dead = false; setBusy(true);
    const t = setTimeout(() => snapFetch(`/snapsa/search?q=${encodeURIComponent(q.trim())}`).then(r => r.ok ? r.json() : null).then(d => { if (!dead) setRows((d?.users || []).filter(u => String(u.userId || u.id) !== String(me) && !exclude.includes(String(u.userId || u.id)))); }).catch(() => {}).finally(() => { if (!dead) setBusy(false); }), 300);
    return () => { dead = true; clearTimeout(t); };
  }, [q]);
  return (
    <div>
      <div style={{ position: 'relative' }}>
        <Search size={16} style={{ position: 'absolute', left: 12, top: 14, color: C.gray }} />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search people to add…" style={{ ...inp, paddingLeft: 36 }} />
      </div>
      {busy && <p style={{ color: C.gray, fontSize: 12, margin: '0 0 8px' }}>Searching…</p>}
      {rows.map(u => {
        const id = String(u.userId || u.id), on = !!selected[id];
        return (
          <button key={id} onClick={() => onToggle(id, u)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 6px', background: on ? 'rgba(139,44,245,.18)' : 'transparent', border: 'none', borderRadius: 12, marginBottom: 2 }}>
            <Avatar src={u.avatarUrl} name={u.username} size={38} />
            <span style={{ flex: 1, textAlign: 'left', color: 'white', fontWeight: 600 }}>@{u.username}</span>
            {on ? <Check size={18} style={{ color: '#4ade80' }} /> : <Plus size={18} style={{ color: C.gray }} />}
          </button>);
      })}
    </div>
  );
}

/* ───────────── groups bar on the Messages tab + New group ───────────── */
export function GroupsBar({ snapFetch, showToast, currentUser, onOpen, refreshKey, isActive = true }) {
  const [groups, setGroups] = useState([]);
  const [creating, setCreating] = useState(false), [joining, setJoining] = useState(false);
  const load = useCallback(() => snapFetch('/snapsa/groups', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(d => { if (d?.groups) setGroups(d.groups); }).catch(() => {}), []);
  useEffect(() => { load(); }, [refreshKey]);
  useEffect(() => {
    if (!isActive) return;
    const t = setInterval(load, 8000), h = () => load();
    window.addEventListener('snapsa:groupUpdate', h);
    return () => { clearInterval(t); window.removeEventListener('snapsa:groupUpdate', h); };
  }, [isActive]);
  return (
    <>
      <div style={{ display: 'flex', gap: 10, overflowX: 'auto', padding: '8px 12px', flexShrink: 0, alignItems: 'center', scrollbarWidth: 'none' }}>
        <button onClick={() => setCreating(true)} style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 999, border: 'none', background: grad, color: 'white', fontWeight: 800, fontSize: 13 }}><Plus size={15} /> New group</button>
        <button onClick={() => setJoining(true)} style={{ flexShrink: 0, padding: '8px 14px', borderRadius: 999, border: `1px solid ${C.border}`, background: 'rgba(255,255,255,.05)', color: 'white', fontWeight: 700, fontSize: 13 }}>Join with code</button>
        {groups.map(g => (
          <button key={g.id} onClick={() => onOpen(g)} style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px 5px 5px', borderRadius: 999, border: `1px solid ${C.border}`, background: 'rgba(255,255,255,.05)', color: 'white', position: 'relative' }}>
            <Avatar src={g.photoUrl} name={g.name} size={30} />
            <span style={{ fontWeight: 700, fontSize: 13, maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.name}</span>
            {g.unread > 0 && <span style={{ background: C.pink, color: 'white', borderRadius: 999, fontSize: 10.5, fontWeight: 800, padding: '1px 6px' }}>{g.unread > 99 ? '99+' : g.unread}</span>}
          </button>))}
      </div>
      {creating && <NewGroupSheet snapFetch={snapFetch} showToast={showToast} me={currentUser?._id || currentUser?.id} onClose={() => setCreating(false)} onCreated={(g) => { setCreating(false); load(); onOpen(g); }} />}
      {joining && <JoinSheet snapFetch={snapFetch} showToast={showToast} onClose={() => setJoining(false)} onJoined={(g) => { setJoining(false); load(); onOpen(g); }} />}
    </>
  );
}

const Sheet = ({ title, onClose, children }) => createPortal(
  <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,.65)', display: 'flex', alignItems: 'flex-end' }}>
    <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxHeight: '92vh', overflowY: 'auto', WebkitOverflowScrolling: 'touch', background: '#12061f', borderTop: `1px solid ${C.border}`, borderRadius: '22px 22px 0 0', padding: '16px 16px calc(28px + env(safe-area-inset-bottom,0px))' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, position: 'sticky', top: -16, background: '#12061f', paddingBottom: 6, zIndex: 1 }}>
        <h3 style={{ margin: 0, color: 'white' }}>{title}</h3>
        <button onClick={onClose} style={{ ...cb, background: 'rgba(255,255,255,.1)', border: 'none', borderRadius: '50%', width: 32, height: 32 }}><X size={16} style={{ color: 'white' }} /></button>
      </div>
      {children}
    </div>
  </div>, document.body);

function NewGroupSheet({ snapFetch, showToast, me, onClose, onCreated }) {
  const [name, setName] = useState(''), [desc, setDesc] = useState(''), [photo, setPhoto] = useState(null), [prev, setPrev] = useState(null);
  const [picked, setPicked] = useState({}), [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const ids = Object.keys(picked);
  const toggle = (id, u) => setPicked(p => { const n = { ...p }; if (n[id]) delete n[id]; else n[id] = u; return n; });
  const create = async () => {
    if (!name.trim() || busy) return; setBusy(true);
    try {
      const fd = new FormData(); fd.append('name', name.trim()); fd.append('description', desc.trim()); fd.append('memberIds', JSON.stringify(ids)); if (photo) fd.append('media', photo);
      const r = await snapFetch('/snapsa/groups', { method: 'POST', body: fd }); const d = await r.json().catch(() => ({}));
      if (r.ok) { showToast?.('✅ Group created', 'success'); onCreated(d.group); } else showToast?.(d.error || 'Could not create the group', 'error');
    } catch { showToast?.('You need to be online', 'error'); }
    setBusy(false);
  };
  return (
    <Sheet title="New group" onClose={onClose}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
        <button onClick={() => fileRef.current?.click()} style={{ width: 64, height: 64, borderRadius: '50%', border: `1px dashed ${C.border}`, background: 'rgba(255,255,255,.05)', overflow: 'hidden', padding: 0, flexShrink: 0 }}>
          {prev ? <img src={prev} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <Camera size={22} style={{ color: C.gray }} />}
        </button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) { setPhoto(f); setPrev(URL.createObjectURL(f)); } }} />
        <input value={name} onChange={e => setName(e.target.value.slice(0, 40))} placeholder="Group name" style={{ ...inp, marginBottom: 0 }} />
      </div>
      <input value={desc} onChange={e => setDesc(e.target.value.slice(0, 200))} placeholder="Description (optional)" style={inp} />
      <p style={{ color: C.gray, fontSize: 12, margin: '0 0 8px' }}>Add as many people as you like — or none. You can add people later.</p>
      {ids.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>{ids.map(id => <span key={id} onClick={() => toggle(id)} style={{ background: 'rgba(139,44,245,.3)', color: 'white', borderRadius: 999, padding: '4px 10px', fontSize: 12, fontWeight: 700 }}>@{picked[id].username} ✕</span>)}</div>}
      <MemberPicker snapFetch={snapFetch} selected={picked} onToggle={toggle} me={me} />
      <button onClick={create} disabled={!name.trim() || busy} style={{ width: '100%', marginTop: 10, padding: 15, borderRadius: 14, border: 'none', fontWeight: 800, fontSize: 16, color: 'white', background: name.trim() ? grad : 'rgba(255,255,255,.1)' }}>{busy ? 'Creating…' : `Create group${ids.length ? ` with ${ids.length} ${ids.length === 1 ? 'person' : 'people'}` : ''}`}</button>
    </Sheet>
  );
}

function JoinSheet({ snapFetch, showToast, onClose, onJoined }) {
  const [code, setCode] = useState(''), [busy, setBusy] = useState(false);
  const go = async () => {
    if (!code.trim() || busy) return; setBusy(true);
    try { const r = await snapFetch('/snapsa/groups-join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.trim() }) }); const d = await r.json().catch(() => ({})); if (r.ok) onJoined(d.group); else showToast?.(d.error || 'Could not join', 'error'); } catch { showToast?.('You need to be online', 'error'); }
    setBusy(false);
  };
  return (
    <Sheet title="Join with an invite code" onClose={onClose}>
      <input value={code} onChange={e => setCode(e.target.value)} placeholder="Paste the invite code" style={inp} />
      <button onClick={go} disabled={!code.trim() || busy} style={{ width: '100%', padding: 14, borderRadius: 14, border: 'none', fontWeight: 800, color: 'white', background: code.trim() ? grad : 'rgba(255,255,255,.1)' }}>{busy ? 'Joining…' : 'Join group'}</button>
    </Sheet>
  );
}

/* ───────────── voice note player ───────────── */
function VoicePlayer({ src, duration, mine }) {
  const ref = useRef(null); const [playing, setPlaying] = useState(false), [pct, setPct] = useState(0);
  useEffect(() => { const a = ref.current; if (!a) return; const t = () => setPct(a.duration ? (a.currentTime / a.duration) * 100 : 0); const e = () => { setPlaying(false); setPct(0); playVoiceEnd(); }; a.addEventListener('timeupdate', t); a.addEventListener('ended', e); return () => { a.removeEventListener('timeupdate', t); a.removeEventListener('ended', e); }; }, [src]);
  const toggle = () => { const a = ref.current; if (!a) return; if (a.paused) { a.play().catch(() => {}); setPlaying(true); } else { a.pause(); setPlaying(false); } };
  const mm = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 190 }}>
      <audio ref={ref} src={src} preload="metadata" />
      <button onClick={toggle} style={{ width: 36, height: 36, borderRadius: '50%', border: 'none', background: 'rgba(255,255,255,.22)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{playing ? <Pause size={16} style={{ color: 'white' }} /> : <Play size={16} style={{ color: 'white' }} />}</button>
      <div style={{ flex: 1, height: 4, borderRadius: 4, background: 'rgba(255,255,255,.25)' }}><div style={{ width: pct + '%', height: '100%', borderRadius: 4, background: 'white' }} /></div>
      <span style={{ fontSize: 11.5, color: 'rgba(255,255,255,.85)' }}>{mm(duration || 0)}</span>
    </div>
  );
}

/* ───────────── group info ───────────── */
function GroupInfo({ snapFetch, showToast, group, me, onClose, onChanged, onLeft }) {
  const [info, setInfo] = useState(null), [adding, setAdding] = useState(false), [picked, setPicked] = useState({}), [qr, setQr] = useState(null), [showQr, setShowQr] = useState(false);
  const [name, setName] = useState(group.name), [desc, setDesc] = useState(group.description || '');
  const photoRef = useRef(null);
  const load = () => snapFetch(`/snapsa/groups/${group.id}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(d => { if (d) { setInfo(d); setName(d.group.name); setDesc(d.group.description || ''); } });
  useEffect(() => { load(); }, []);
  const g = info?.group || group, admin = g.isAdmin;
  useEffect(() => { if (!g.inviteCode) return; import('qrcode').then(Q => (Q.default || Q).toDataURL(g.inviteCode, { margin: 1, width: 220 })).then(setQr).catch(() => {}); }, [g.inviteCode]);
  const call = async (path, method = 'POST', body) => { const r = await snapFetch(path, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) }); const d = await r.json().catch(() => ({})); if (!r.ok) showToast?.(d.error || 'Something went wrong', 'error'); else { await load(); onChanged?.(); } return r.ok; };
  const saveText = () => call(`/snapsa/groups/${g.id}`, 'PATCH', { name, description: desc }).then(ok => ok && showToast?.('Saved', 'success'));
  const addPeople = async () => { const ids = Object.keys(picked); if (!ids.length) return; if (await call(`/snapsa/groups/${g.id}/members`, 'POST', { userIds: ids })) { setPicked({}); setAdding(false); showToast?.('People added', 'success'); } };
  const changePhoto = async (f) => { const fd = new FormData(); fd.append('media', f); const r = await snapFetch(`/snapsa/groups/${g.id}/photo`, { method: 'POST', body: fd }); if (r.ok) { await load(); onChanged?.(); } else showToast?.('Could not change the photo', 'error'); };
  const leave = async () => { if (!window.confirm('Leave this group?')) return; const r = await snapFetch(`/snapsa/groups/${g.id}/leave`, { method: 'POST' }); if (r.ok) onLeft?.(); else showToast?.('Could not leave', 'error'); };
  const toggle = (id, u) => setPicked(p => { const n = { ...p }; if (n[id]) delete n[id]; else n[id] = u; return n; });
  const members = info?.members || [];
  return (
    <Sheet title="Group info" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 12 }}>
        <button disabled={!admin} onClick={() => photoRef.current?.click()} style={{ background: 'none', border: 'none', padding: 0, position: 'relative' }}>
          <Avatar src={g.photoUrl} name={g.name} size={86} />{admin && <span style={{ position: 'absolute', right: 0, bottom: 0, background: C.pink, borderRadius: '50%', padding: 5 }}><Camera size={14} style={{ color: 'white' }} /></span>}
        </button>
        <input ref={photoRef} type="file" accept="image/*" hidden onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) changePhoto(f); }} />
      </div>
      {admin ? (<><input value={name} onChange={e => setName(e.target.value.slice(0, 40))} style={inp} /><input value={desc} onChange={e => setDesc(e.target.value.slice(0, 200))} placeholder="Description" style={inp} />
        <button onClick={saveText} disabled={name.trim() === g.name && desc === (g.description || '')} style={{ width: '100%', padding: 11, borderRadius: 12, border: 'none', background: 'rgba(255,255,255,.1)', color: 'white', fontWeight: 700, marginBottom: 12, opacity: (name.trim() === g.name && desc === (g.description || '')) ? .4 : 1 }}>Save name &amp; description</button></>)
        : (<><h3 style={{ color: 'white', textAlign: 'center', margin: '0 0 4px' }}>{g.name}</h3>{g.description && <p style={{ color: C.gray, textAlign: 'center', fontSize: 13, margin: '0 0 12px' }}>{g.description}</p>}</>)}
      <button onClick={leave} style={{ width: '100%', marginTop: 4, marginBottom: 14, padding: 13, borderRadius: 14, border: '1px solid rgba(248,113,113,.5)', background: 'transparent', color: '#f87171', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}><LogOut size={17} /> Leave group</button>
      {admin && g.inviteCode && (
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 14, marginBottom: 14, textAlign: 'center' }}>
          <p style={{ color: C.gray, fontSize: 11, fontWeight: 800, letterSpacing: 1, margin: '0 0 8px' }}>INVITE CODE</p>
          {showQr && qr && <img src={qr} alt="" style={{ width: 150, height: 150, borderRadius: 10, background: 'white', padding: 6 }} />}
          <button onClick={() => setShowQr(v => !v)} style={{ display: 'block', margin: '0 auto 6px', background: 'none', border: 'none', color: C.pink, fontWeight: 700, fontSize: 13 }}>{showQr ? 'Hide QR code' : 'Show QR code'}</button>
          <p style={{ color: 'white', fontFamily: 'monospace', fontSize: 15, margin: '8px 0', wordBreak: 'break-all' }}>{g.inviteCode}</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => { navigator.clipboard?.writeText(g.inviteCode).then(() => showToast?.('Code copied', 'success')).catch(() => {}); }} style={{ flex: 1, padding: 10, borderRadius: 10, border: 'none', background: grad, color: 'white', fontWeight: 700 }}>Copy code</button>
            <button onClick={() => window.confirm('Make a new code? The old one stops working.') && call(`/snapsa/groups/${g.id}/invite/reset`)} style={{ flex: 1, padding: 10, borderRadius: 10, border: `1px solid ${C.border}`, background: 'transparent', color: 'white', fontWeight: 700 }}>New code</button>
          </div>
        </div>)}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '4px 0 8px' }}>
        <span style={{ color: C.gray, fontSize: 11, fontWeight: 800, letterSpacing: 1 }}>{g.memberCount} MEMBER{g.memberCount === 1 ? '' : 'S'}</span>
        {admin && <button onClick={() => setAdding(a => !a)} style={{ background: 'none', border: 'none', color: C.pink, fontWeight: 800, fontSize: 13 }}>{adding ? 'Close' : '+ Add people'}</button>}
      </div>
      {adding && <div style={{ marginBottom: 10 }}><MemberPicker snapFetch={snapFetch} selected={picked} onToggle={toggle} exclude={members.map(m => m.id)} me={me} />
        <button onClick={addPeople} disabled={!Object.keys(picked).length} style={{ width: '100%', padding: 12, borderRadius: 12, border: 'none', color: 'white', fontWeight: 800, background: Object.keys(picked).length ? grad : 'rgba(255,255,255,.1)' }}>Add {Object.keys(picked).length || ''} to group</button></div>}
      {members.map(m => (
        <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0' }}>
          <Avatar src={m.avatarUrl} name={m.name} size={40} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}><span style={{ color: 'white', fontWeight: 700 }}>{m.id === String(me) ? 'You' : m.name}</span>{m.crew && <CrewPill position={m.crew} size={11} />}{m.isAdmin && <span style={{ color: '#facc15', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 2 }}><Crown size={11} /> Admin</span>}</div>
            <span style={{ color: m.online ? C.pink : C.gray, fontSize: 12, fontWeight: m.online ? 700 : 400 }}>{m.online ? '● online' : m.lastActiveAt ? `Last active ${lastSeen(m.lastActiveAt)}` : `@${m.username}`}</span>
          </div>
          {admin && m.id !== String(me) && (<>
            <button onClick={() => call(`/snapsa/groups/${g.id}/admins/${m.id}`, 'POST', { admin: !m.isAdmin })} title={m.isAdmin ? 'Remove admin' : 'Make admin'} style={{ background: 'rgba(255,255,255,.08)', border: 'none', borderRadius: 10, padding: 8 }}><Crown size={15} style={{ color: m.isAdmin ? '#facc15' : C.gray }} /></button>
            <button onClick={() => window.confirm(`Remove @${m.username}?`) && call(`/snapsa/groups/${g.id}/members/${m.id}`, 'DELETE')} title="Remove" style={{ background: 'rgba(248,113,113,.12)', border: 'none', borderRadius: 10, padding: 8 }}><UserMinus size={15} style={{ color: '#f87171' }} /></button></>)}
        </div>))}

    </Sheet>
  );
}

/* ───────────── the group chat screen ───────────── */
export function SnapsaGroupChat({ snapFetch, group: initial, currentUser, showToast, onBack, isActive = true, mediaHref = (u) => u, onOpenProfile }) {
  const gid = initial.id, me = String(currentUser?._id || currentUser?.id || '');
  const [group, setGroup] = useState(initial), [msgs, setMsgs] = useState([]), [members, setMembers] = useState([]);
  const [text, setText] = useState(''), [replyTo, setReplyTo] = useState(null), [ghost, setGhost] = useState(false), [ghostReply, setGhostReply] = useState(false);
  const [excl, setExcl] = useState([]), [pickExcl, setPickExcl] = useState(false), [emoji, setEmoji] = useState(false), [attach, setAttach] = useState(false);
  const [seen, setSeen] = useState(null), [menu, setMenu] = useState(null), [info, setInfo] = useState(false), [viewer, setViewer] = useState(null);
  const [voiceDraft, setVoiceDraft] = useState(null), [recording, setRecording] = useState(false), [recSecs, setRecSecs] = useState(0);
  const chatLock = useChatLock(`group_${gid}`, showToast);
  const endRef = useRef(null), tempRef = useRef([]), knownRef = useRef(null), activeRef = useRef(isActive); activeRef.current = isActive;
  const recRef = useRef(null), recT0 = useRef(0), recTimer = useRef(null), recCancel = useRef(false);

  const load = useCallback(() => snapFetch(`/snapsa/groups/${gid}/messages`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(d => {
    if (!d?.messages) return;
    if (knownRef.current && activeRef.current && document.visibilityState !== 'hidden' && d.messages.some(m => !knownRef.current.has(m.id) && !m.mine && m.type !== 'system')) playIncoming();
    knownRef.current = new Set(d.messages.map(m => m.id));
    setMsgs(tempRef.current.length ? [...d.messages, ...tempRef.current] : d.messages);
  }).catch(() => {}), [gid]);
  const loadInfo = useCallback(() => snapFetch(`/snapsa/groups/${gid}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(d => { if (d) { setGroup(d.group); setMembers(d.members); } }).catch(() => {}), [gid]);
  useEffect(() => { load(); loadInfo(); }, [gid]);
  useEffect(() => { if (!isActive) return; const t = setInterval(() => { if (!document.hidden) loadInfo(); }, 15000); return () => clearInterval(t); }, [isActive, gid]);
  useEffect(() => {
    if (!isActive) return;
    const t = setInterval(load, 3500), h = (e) => { if (!e.detail?.groupId || e.detail.groupId === gid) load(); };
    window.addEventListener('snapsa:groupUpdate', h); return () => { clearInterval(t); window.removeEventListener('snapsa:groupUpdate', h); };
  }, [isActive, gid]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [msgs.length]);

  /* send — the message shows at once with a clock; the water-drop plays when the server has it */
  const send = async ({ text: t = '', file = null, asFile = false, duration = 0 } = {}) => {
    const body = t.trim();
    if (!body && !file) return;
    const tmpId = `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const asGhost = ghost || ghostReply, reply = replyTo, exTo = excl;
    const tmp = { id: tmpId, _tmp: true, mine: true, ghost: asGhost, type: file ? (asFile ? 'file' : /^audio\//.test(file.type) ? 'voice' : /^video\//.test(file.type) ? 'video' : 'photo') : 'text', text: body, mediaUrl: file ? URL.createObjectURL(file) : null, fileName: file?.name, duration,
      replyTo: reply ? { id: reply.id, text: reply.text || '', senderName: reply.ghost ? '👻 Ghost' : reply.senderName } : null, exclusive: exTo.length > 0, exclusiveCount: exTo.length, reactions: [], createdAt: new Date().toISOString(), pending: true, senderName: currentUser?.username, avatarUrl: currentUser?.avatarUrl };
    tempRef.current = [...tempRef.current, tmp]; setMsgs(p => [...p, tmp]);
    setText(''); setReplyTo(null); setEmoji(false); if (ghost || ghostReply) { setGhost(false); setGhostReply(false); }
    const drop = () => { tempRef.current = tempRef.current.filter(x => x.id !== tmpId); setMsgs(p => p.filter(x => x.id !== tmpId)); };
    try {
      const fd = new FormData(); fd.append('text', body); if (file) { fd.append('media', file, file.name || 'upload'); if (asFile) fd.append('asFile', '1'); if (duration) fd.append('duration', String(duration)); }
      if (asGhost) fd.append('ghost', '1'); if (reply) fd.append('replyToId', reply.id); if (exTo.length) fd.append('exclusiveTo', JSON.stringify(exTo));
      const r = await snapFetch(`/snapsa/groups/${gid}/messages`, { method: 'POST', body: fd });
      if (r.ok) { playSent(); tempRef.current = tempRef.current.filter(x => x.id !== tmpId); await load(); setMsgs(p => p.filter(x => x.id !== tmpId)); }
      else { drop(); const d = await r.json().catch(() => ({})); showToast?.(d.error || 'Failed to send', 'error'); }
    } catch { drop(); showToast?.('Failed to send — check your connection', 'error'); }
  };

  /* voice notes: tap mic → recording bar → send or cancel */
  const stopTimer = () => { clearInterval(recTimer.current); setRecording(false); };
  const startRec = async () => {
    if (recording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mt = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(t => window.MediaRecorder?.isTypeSupported?.(t)) || '';
      const rec = new MediaRecorder(stream, mt ? { mimeType: mt } : undefined), chunks = [];
      rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        const secs = (Date.now() - recT0.current) / 1000;
        if (recCancel.current || secs < 0.7) return;
        const type = rec.mimeType || 'audio/webm'; setVoiceDraft({ blob: new Blob(chunks, { type }), ext: type.includes('mp4') ? '.m4a' : '.webm', duration: Math.round(secs) });   // pick a voice effect, then send
      };
      rec._stream = stream; recRef.current = rec; recCancel.current = false;
      playRecStart();                                                   // the blip first, the recorder starts just after so the blip is not in the note
      recT0.current = Date.now() + 240; setRecSecs(0); setRecording(true);
      setTimeout(() => { try { if (recRef.current === rec && rec.state === 'inactive' && !recCancel.current) rec.start(); } catch {} }, 240);
      recTimer.current = setInterval(() => setRecSecs(Math.max(0, Math.floor((Date.now() - recT0.current) / 1000))), 250);
    } catch { showToast?.('Allow the microphone to record', 'error'); }
  };
  const endRec = (cancel) => {
    const r = recRef.current; if (!r) return;
    recCancel.current = cancel; if (cancel) playRecCancel();
    if (r.state === 'inactive') { try { r._stream?.getTracks().forEach(t => t.stop()); } catch {} } else { try { r.stop(); } catch {} }
    recRef.current = null; stopTimer();
  };
  useEffect(() => () => { try { recRef.current?.state !== 'inactive' && recRef.current?.stop(); recRef.current?._stream?.getTracks().forEach(t => t.stop()); } catch {} clearInterval(recTimer.current); }, []);

  const react = async (m, emo) => { setMenu(null); await snapFetch(`/snapsa/groups/${gid}/messages/${m.id}/react`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emoji: emo }) }).catch(() => {}); load(); };
  const del = async (m) => { setMenu(null); if (!window.confirm('Delete this message for everyone?')) return; const r = await snapFetch(`/snapsa/groups/${gid}/messages/${m.id}`, { method: 'DELETE' }).catch(() => null); if (r?.ok) load(); else showToast?.('Could not delete', 'error'); };
  const isAdmin = !!group.isAdmin;
  const onlineOthers = members.filter(m => m.online && m.id !== me);

  const pressTimer = useRef(null);
  const lp = (m) => ({
    onTouchStart: () => { pressTimer.current = setTimeout(() => { if (!chatLock.hidden && !m._tmp && m.type !== 'system' && !m.deleted) setMenu(m); }, 450); },
    onTouchEnd: () => clearTimeout(pressTimer.current), onTouchMove: () => clearTimeout(pressTimer.current),
    onContextMenu: (e) => { e.preventDefault(); if (!chatLock.hidden && !m._tmp && m.type !== 'system' && !m.deleted) setMenu(m); },
  });

  const body = (m) => {
    const hide = chatLock.hidden;
    if (m.deleted) return <span style={{ fontStyle: 'italic', opacity: .7, fontSize: 14 }}>🚫 This message was deleted</span>;
    if (m.hidden) return <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 700 }}>[🔒 EXCLUSIVE CHAT]</span>;
    if (hide) return <span style={{ letterSpacing: 2, opacity: .85 }}>🔒 ••••••••</span>;
    const url = m.mediaUrl ? mediaHref(m.mediaUrl) : null;
    return (
      <>
        {m.type === 'photo' && url && <img src={url} alt="" onClick={() => setViewer({ url, type: 'photo' })} style={{ maxWidth: '100%', width: 230, borderRadius: 12, display: 'block', marginBottom: m.text ? 6 : 0 }} />}
        {m.type === 'video' && url && <video src={url} controls playsInline preload="metadata" style={{ maxWidth: '100%', width: 230, borderRadius: 12, display: 'block', marginBottom: m.text ? 6 : 0 }} />}
        {m.type === 'voice' && url && <VoicePlayer src={url} duration={m.duration} mine={m.mine} />}
        {m.type === 'file' && <FileBubble m={m} mediaHref={mediaHref} />}
        {m.text ? <span style={{ fontSize: 15, lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.text}</span> : null}
      </>
    );
  };

  let lastDay = '';
  const exclNames = excl.map(id => members.find(x => x.id === id)?.username).filter(Boolean);
  const canSend = text.trim().length > 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.dark, position: 'relative', zIndex: 1 }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 10px', borderBottom: `1px solid ${C.border}`, background: 'rgba(18,6,31,.95)', flexShrink: 0 }}>
        <button onClick={onBack} aria-label="Back" style={{ background: 'none', border: 'none', padding: 6 }}><ArrowLeft size={22} style={{ color: 'white' }} /></button>
        <button onClick={() => setInfo(true)} style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0, background: 'none', border: 'none', padding: 0, textAlign: 'left' }}>
          <Avatar src={group.photoUrl} name={group.name} size={40} />
          <span style={{ minWidth: 0 }}><span style={{ display: 'block', color: 'white', fontWeight: 800, fontSize: 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{group.name}</span>
            <span style={{ display: 'block', color: C.gray, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {onlineOthers.length > 0 ? <><span style={{ color: C.pink, fontWeight: 700 }}>● {onlineOthers.length} online</span> · {onlineOthers.slice(0, 3).map(m => m.name.split(' ')[0]).join(', ')}{onlineOthers.length > 3 ? ` +${onlineOthers.length - 3}` : ''}</> : `${group.memberCount} member${group.memberCount === 1 ? '' : 's'} · none online`}
            </span></span>
        </button>
        <button aria-label="Chat lock" onClick={chatLock.openMenu} style={{ background: 'none', border: 'none', padding: 6 }}>{chatLock.locked ? <Lock size={19} style={{ color: '#4ade80' }} /> : <Unlock size={19} style={{ color: 'white' }} />}</button>
        <button aria-label="Group info" onClick={() => setInfo(true)} style={{ background: 'none', border: 'none', padding: 6 }}><Info size={20} style={{ color: 'white' }} /></button>
      </div>

      {/* messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 10px 6px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {msgs.length === 0 && <p style={{ color: C.gray, textAlign: 'center', marginTop: 40, fontSize: 14 }}>No messages yet. Say hi 👋</p>}
        {msgs.map(m => {
          const dl = dayLabel(m.createdAt), showDay = dl !== lastDay; lastDay = dl;
          return (
            <React.Fragment key={m.id}>
              {showDay && <div style={{ alignSelf: 'center', background: 'rgba(255,255,255,.08)', color: C.gray, fontSize: 11.5, fontWeight: 700, padding: '3px 12px', borderRadius: 999, margin: '8px 0 4px' }}>{dl}</div>}
              {m.type === 'system' ? <div style={{ alignSelf: 'center', color: C.gray, fontSize: 12, textAlign: 'center', padding: '2px 18px' }}>{m.text}</div> : (
                <div style={{ display: 'flex', flexDirection: m.mine ? 'row-reverse' : 'row', alignItems: 'flex-end', gap: 6 }}>
                  {!m.mine && <button onClick={() => !m.ghost && m.senderUsername && onOpenProfile?.({ id: m.senderId, username: m.senderUsername, authorName: m.senderUsername, avatarUrl: m.avatarUrl })} style={{ background: 'none', border: 'none', padding: 0 }}><Avatar src={m.avatarUrl} name={m.senderName} size={30} ghost={m.ghost} /></button>}
                  <div {...lp(m)} style={{ maxWidth: '78%', padding: '8px 11px', borderRadius: 18, borderBottomRightRadius: m.mine ? 6 : 18, borderBottomLeftRadius: m.mine ? 18 : 6, background: m.mine ? (m.ghost ? '#3b3350' : grad) : 'rgba(255,255,255,.09)', color: 'white', opacity: m.pending ? .75 : 1, border: m.exclusive ? '1px solid #a855f7' : 'none' }}>
                    {!m.mine && <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', marginBottom: 3 }}>
                      <span style={{ color: m.ghost ? '#9ca3af' : '#f0abfc', fontWeight: 800, fontSize: 12.5 }}>{m.ghost ? '👻 Ghost' : m.senderName}</span>
                      {!m.ghost && m.crew && <CrewPill position={m.crew} size={10} />}
                      {!m.ghost && m.official && <OfficialPill label={m.official === true ? 'OFFICIAL' : m.official} />}
                    </div>}
                    {m.ghost && m.mine && <div style={{ fontSize: 11, opacity: .8, marginBottom: 2 }}>👻 Sent as ghost</div>}
                    {m.exclusive && !m.hidden && <div style={{ fontSize: 11, color: '#e9d5ff', marginBottom: 3 }}>🔒 Exclusive to {m.exclusiveCount} member{m.exclusiveCount === 1 ? '' : 's'}</div>}
                    {m.replyTo && !chatLock.hidden && <div style={{ borderLeft: '3px solid rgba(255,255,255,.7)', background: 'rgba(0,0,0,.22)', borderRadius: 8, padding: '4px 8px', marginBottom: 5 }}><div style={{ fontSize: 11.5, fontWeight: 800, opacity: .9 }}>{m.replyTo.senderName}</div><div style={{ fontSize: 12.5, opacity: .85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>{m.replyTo.text}</div></div>}
                    {body(m)}
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4, marginTop: 3, fontSize: 10.5, opacity: .75 }}>{timeOf(m.createdAt)}{m.mine ? <span onClick={(e) => { if (m.receipt?.read) { e.stopPropagation(); setSeen(m); } }} style={{ display: 'inline-flex', alignItems: 'center', cursor: m.receipt?.read ? 'pointer' : 'default' }}><Ticks r={m.receipt} pending={m.pending} /></span> : null}</div>
                    {m.reactions?.length > 0 && !chatLock.hidden && <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>{m.reactions.map(r => <span key={r.emoji} onClick={() => react(m, r.emoji)} style={{ background: r.mine ? 'rgba(255,255,255,.3)' : 'rgba(0,0,0,.3)', borderRadius: 999, padding: '1px 7px', fontSize: 12 }}>{r.emoji} {r.count > 1 ? r.count : ''}</span>)}</div>}
                  </div>
                </div>)}
            </React.Fragment>);
        })}
        <div ref={endRef} />
      </div>

      {/* composer */}
      <div style={{ padding: '6px 10px calc(10px + env(safe-area-inset-bottom,0px))', background: 'rgba(18,6,31,.95)', borderTop: `1px solid ${C.border}`, flexShrink: 0 }}>
        {(ghost || ghostReply) && <div style={{ display: 'flex', justifyContent: 'space-between', background: '#2a2038', borderRadius: 10, padding: '6px 10px', marginBottom: 6, color: '#d1d5db', fontSize: 12.5 }}><span>👻 {ghostReply ? 'Anonymous reply' : 'Ghost mode'} — your name and photo are hidden (one message)</span><X size={14} onClick={() => { setGhost(false); setGhostReply(false); }} /></div>}
        {excl.length > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', background: 'rgba(168,85,247,.18)', border: '1px solid #a855f7', borderRadius: 10, padding: '6px 10px', marginBottom: 6, color: '#e9d5ff', fontSize: 12.5 }}><span>🔒 Exclusive to {exclNames.slice(0, 3).map(n => '@' + n).join(', ')}{excl.length > 3 ? ` +${excl.length - 3}` : ''} <u onClick={() => setPickExcl(true)}>change</u></span><X size={14} onClick={() => setExcl([])} /></div>}
        {replyTo && <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,.07)', borderLeft: '3px solid #ff2d95', borderRadius: 10, padding: '6px 10px', marginBottom: 6 }}>
          <div style={{ minWidth: 0 }}><div style={{ color: '#f0abfc', fontSize: 12, fontWeight: 800 }}>Replying to {replyTo.ghost ? '👻 Ghost' : replyTo.senderName}</div><div style={{ color: C.gray, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{replyTo.text || ({ photo: '📷 Photo', video: '🎬 Video', voice: '🎤 Voice message', file: '📎 File' })[replyTo.type]}</div></div>
          <X size={16} style={{ color: C.gray, flexShrink: 0 }} onClick={() => { setReplyTo(null); setGhostReply(false); }} /></div>}
        {emoji && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8,1fr)', gap: 2, background: 'rgba(255,255,255,.06)', borderRadius: 12, padding: 6, marginBottom: 6 }}>{EMOJIS.map(e => <button key={e} onClick={() => setText(t => t + e)} style={{ background: 'none', border: 'none', fontSize: 22, padding: 4 }}>{e}</button>)}</div>}
        {recording ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={() => endRec(true)} aria-label="Cancel recording" style={{ ...cb, width: 42, height: 42, borderRadius: '50%', border: 'none', background: 'rgba(248,113,113,.2)' }}><Trash2 size={19} style={{ color: '#f87171' }} /></button>
            <div style={{ flex: 1, color: 'white', fontWeight: 700 }}><span style={{ color: '#f87171' }}>●</span> Recording… {Math.floor(recSecs / 60)}:{String(recSecs % 60).padStart(2, '0')}</div>
            <button onClick={() => endRec(false)} aria-label="Send voice note" style={{ ...cb, width: 44, height: 44, borderRadius: '50%', border: 'none', background: grad }}><Send size={19} style={{ color: 'white' }} /></button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
            <button onClick={() => setAttach(true)} aria-label="Attach" style={{ ...cb, width: 38, height: 38, borderRadius: '50%', border: 'none', background: 'rgba(255,255,255,.1)', flexShrink: 0 }}><Plus size={19} style={{ color: 'white' }} /></button>
            <button onClick={() => setGhost(g => !g)} title="Ghost mode" style={{ ...cb, width: 38, height: 38, borderRadius: '50%', border: 'none', background: ghost ? '#4b3f6b' : 'rgba(255,255,255,.1)', fontSize: 17, flexShrink: 0 }}>👻</button>
            <button onClick={() => (excl.length ? setExcl([]) : setPickExcl(true))} title="Exclusive message" style={{ ...cb, width: 38, height: 38, borderRadius: '50%', border: 'none', background: excl.length ? '#7e22ce' : 'rgba(255,255,255,.1)', flexShrink: 0 }}><Eye size={17} style={{ color: 'white' }} /></button>
            <textarea value={text} onChange={e => setText(e.target.value)} rows={1} placeholder={ghost || ghostReply ? '👻 Type anonymously…' : excl.length ? 'Exclusive message…' : 'Group message…'}
              style={{ flex: 1, resize: 'none', maxHeight: 110, background: 'rgba(255,255,255,.09)', border: '1px solid transparent', borderRadius: 18, padding: '10px 14px', color: 'white', fontSize: 15, outline: 'none', lineHeight: 1.35 }} />
            <button onClick={() => setEmoji(v => !v)} aria-label="Emoji" style={{ ...cb, width: 36, height: 38, background: 'none', border: 'none', flexShrink: 0 }}><Smile size={21} style={{ color: C.gray }} /></button>
            {canSend ? <button onClick={() => send({ text })} aria-label="Send" style={{ ...cb, width: 42, height: 42, borderRadius: '50%', border: 'none', background: ghost || ghostReply ? '#4b3f6b' : grad, flexShrink: 0 }}><Send size={18} style={{ color: 'white' }} /></button>
              : <button onClick={startRec} aria-label="Record voice note" style={{ ...cb, width: 42, height: 42, borderRadius: '50%', border: 'none', background: 'rgba(255,255,255,.1)', flexShrink: 0 }}><Mic size={19} style={{ color: 'white' }} /></button>}
          </div>)}
      </div>

      {voiceDraft && createPortal(<VoiceDraft blob={voiceDraft.blob} ext={voiceDraft.ext} duration={voiceDraft.duration}
        onSend={(file, duration) => { setVoiceDraft(null); send({ file, duration }); }} onDiscard={() => { setVoiceDraft(null); playRecCancel(); }} />, document.body)}
      <ChatLockOverlay lock={chatLock} />
      <AttachSheet open={attach} onClose={() => setAttach(false)} onPick={(f, kind) => send({ file: f, asFile: kind === 'file' })} onNearbyText={() => {}} />

      {menu && createPortal(
        <div onClick={() => setMenu(null)} style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'flex-end' }}>
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', background: '#12061f', borderRadius: '22px 22px 0 0', padding: '14px 14px calc(18px + env(safe-area-inset-bottom,0px))', border: `1px solid ${C.border}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-around', paddingBottom: 10, borderBottom: `1px solid ${C.border}`, marginBottom: 6 }}>{QUICK.map(e => <button key={e} onClick={() => react(menu, e)} style={{ background: 'none', border: 'none', fontSize: 28 }}>{e}</button>)}</div>
            {[
              { i: <Reply size={19} />, t: 'Reply', f: () => { setGhostReply(false); setReplyTo({ id: menu.id, text: menu.text, type: menu.type, senderName: menu.senderName || 'Member', ghost: menu.ghost }); setMenu(null); } },
              { i: <span style={{ fontSize: 18 }}>👻</span>, t: 'Reply anonymously', f: () => { setGhostReply(true); setReplyTo({ id: menu.id, text: menu.text, type: menu.type, senderName: menu.senderName || 'Member', ghost: menu.ghost }); setMenu(null); } },
              ...(menu.text ? [{ i: <Copy size={19} />, t: 'Copy', f: () => { navigator.clipboard?.writeText(menu.text).then(() => showToast?.('Copied', 'success')).catch(() => {}); setMenu(null); } }] : []),
              ...((menu.mine || isAdmin) ? [{ i: <Trash2 size={19} />, t: 'Delete for everyone', f: () => del(menu), red: true }] : []),
            ].map(o => <button key={o.t} onClick={o.f} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 14, padding: '13px 8px', background: 'none', border: 'none', color: o.red ? '#f87171' : 'white', fontSize: 15, fontWeight: 600, textAlign: 'left' }}>{o.i}{o.t}</button>)}
          </div>
        </div>, document.body)}

      {pickExcl && (
        <Sheet title="Exclusive message" onClose={() => setPickExcl(false)}>
          <p style={{ color: C.gray, fontSize: 13, margin: '0 0 10px' }}>Only the people you choose can read it. Everyone else sees [🔒 EXCLUSIVE CHAT].</p>
          {members.filter(m => m.id !== me).map(m => { const on = excl.includes(m.id); return (
            <button key={m.id} onClick={() => setExcl(e => on ? e.filter(x => x !== m.id) : [...e, m.id])} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 6px', background: on ? 'rgba(168,85,247,.22)' : 'transparent', border: 'none', borderRadius: 12, marginBottom: 2 }}>
              <Avatar src={m.avatarUrl} name={m.name} size={38} /><span style={{ flex: 1, textAlign: 'left', color: 'white', fontWeight: 600 }}>{m.name} <span style={{ color: C.gray, fontWeight: 400 }}>@{m.username}</span></span>{on && <Check size={18} style={{ color: '#c084fc' }} />}
            </button>); })}
          <button onClick={() => setPickExcl(false)} disabled={!excl.length} style={{ width: '100%', marginTop: 10, padding: 14, borderRadius: 14, border: 'none', color: 'white', fontWeight: 800, background: excl.length ? '#7e22ce' : 'rgba(255,255,255,.1)' }}>{excl.length ? `Done — ${excl.length} selected` : 'Pick at least one person'}</button>
        </Sheet>)}

      {seen && (
        <Sheet title={`Seen by ${seen.receipt.read} of ${seen.receipt.total}`} onClose={() => setSeen(null)}>
          {seen.receipt.readers.map((r, i) => <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 2px', color: 'white', borderBottom: '1px solid rgba(255,255,255,.06)' }}><span style={{ fontWeight: 600 }}>{r.name}</span><span style={{ color: C.gray, fontSize: 13 }}>{dayLabel(r.at)} {timeOf(r.at)}</span></div>)}
        </Sheet>)}
      {info && <GroupInfo snapFetch={snapFetch} showToast={showToast} group={group} me={me} onClose={() => setInfo(false)} onChanged={() => { loadInfo(); }} onLeft={() => { setInfo(false); onBack(); }} />}
      {viewer && <div onClick={() => setViewer(null)} style={{ position: 'fixed', inset: 0, zIndex: 900, background: 'rgba(0,0,0,.95)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><img src={viewer.url} alt="" style={{ maxWidth: '100%', maxHeight: '100%' }} /></div>}
    </div>
  );
}
