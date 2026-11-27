// src/VideoShareExtras.jsx — "send this video to a chat" picker used by the feed's Share sheet.
import React, { useEffect, useMemo, useState } from 'react';
import { X, Send, Search, Check } from 'lucide-react';

const C = { pink: '#FF2D95', card: '#150B28', border: 'rgba(180,76,255,0.30)', gray: '#A59BC4' };

export default function SendToChatSheet({ video, snapFetch, snapUrl, showToast, onClose, message, sharedPath, title = 'Send to…' }) {
  const [people, setPeople] = useState(null);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let dead = false;
    Promise.all(['following', 'followers'].map(t => snapFetch(`/snapsa/users/me/follows?type=${t}`).then(r => r.ok ? r.json() : { users: [] }).catch(() => ({ users: [] }))))
      .then(([a, b]) => {
        if (dead) return;
        const seen = new Set(), out = [];
        for (const u of [...(a.users || []), ...(b.users || [])]) { const id = String(u.userId); if (!seen.has(id)) { seen.add(id); out.push({ ...u, userId: id }); } }
        setPeople(out);
      });
    return () => { dead = true; };
  }, [snapFetch]);

  const shown = useMemo(() => (people || []).filter(u => !q.trim() || `${u.username} ${u.displayName}`.toLowerCase().includes(q.trim().toLowerCase())), [people, q]);
  const ids = Object.keys(picked).filter(k => picked[k]);

  const send = async () => {
    if (!ids.length || busy) return; setBusy(true);
    const link = video ? `${snapUrl}/snapsa/v/${video.id}` : '';
    const text = message || `🎬 ${video.authorName ? '@' + video.authorName + "'s video" : 'A video'} on Snapsa\n${link}`;
    let ok = 0;
    for (const id of ids) {
      try {
        const r = await snapFetch(`/snapsa/messages/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
        if (r.ok) ok++;
      } catch {}
    }
    if (ok) snapFetch(sharedPath || `/snapsa/videos/${video.id}/shared`, { method: 'POST', body: JSON.stringify({ count: ok }) }).catch(() => {});
    setBusy(false);
    if (ok) { showToast?.(`✅ Sent to ${ok} chat${ok > 1 ? 's' : ''}`, 'success'); onClose(ok); }
    else showToast?.('Could not send. Check your connection', 'error');
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 700, background: 'rgba(0,0,0,.65)', display: 'flex', alignItems: 'flex-end' }} onClick={() => onClose(0)}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxHeight: '80vh', display: 'flex', flexDirection: 'column', background: '#12061f', borderTop: `1px solid ${C.border}`, borderRadius: '22px 22px 0 0', padding: '16px 16px calc(14px + env(safe-area-inset-bottom,0px))' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={{ margin: 0, color: 'white' }}>{title}</h3>
          <button onClick={() => onClose(0)} style={{ background: 'rgba(255,255,255,.1)', border: 'none', borderRadius: '50%', padding: 7 }}><X size={16} style={{ color: 'white' }} /></button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(255,255,255,.07)', border: `1px solid ${C.border}`, borderRadius: 999, padding: '8px 14px', marginBottom: 10 }}>
          <Search size={16} style={{ color: C.gray }} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search people" style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: 'white', fontSize: 15 }} />
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {people === null ? <p style={{ color: C.gray, textAlign: 'center' }}>Loading…</p>
            : shown.length === 0 ? <p style={{ color: C.gray, textAlign: 'center' }}>Follow people to send them videos.</p>
            : shown.map(u => (
              <button key={u.userId} onClick={() => setPicked(p => ({ ...p, [u.userId]: !p[u.userId] }))} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '9px 4px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
                <span style={{ width: 42, height: 42, borderRadius: '50%', overflow: 'hidden', background: 'linear-gradient(135deg,#8b2cf5,#ff2d95)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 800, flexShrink: 0 }}>
                  {u.avatarUrl ? <img src={u.avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : (u.username || '?')[0].toUpperCase()}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', color: 'white', fontWeight: 700, fontSize: 14 }}>{u.displayName || u.username}</span>
                  <span style={{ display: 'block', color: C.gray, fontSize: 12 }}>@{u.username}</span>
                </span>
                <span style={{ width: 24, height: 24, borderRadius: '50%', border: picked[u.userId] ? 'none' : `2px solid ${C.gray}`, background: picked[u.userId] ? C.pink : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{picked[u.userId] && <Check size={15} style={{ color: 'white' }} />}</span>
              </button>))}
        </div>
        <button onClick={send} disabled={!ids.length || busy} style={{ marginTop: 10, padding: 14, borderRadius: 14, border: 'none', background: ids.length ? 'linear-gradient(135deg,#8b2cf5,#ff2d95)' : 'rgba(255,255,255,.12)', color: 'white', fontWeight: 800, fontSize: 16, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8 }}>
          <Send size={17} /> {busy ? 'Sending…' : ids.length ? `Send to ${ids.length}` : 'Pick people'}
        </button>
      </div>
    </div>
  );
}
