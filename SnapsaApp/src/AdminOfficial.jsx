// src/AdminOfficial.jsx — admin tab: grant / revoke the OFFICIAL pin label (+ pink badge) for governments, companies and professional accounts.
import React, { useEffect, useState } from 'react';
import { OfficialPill } from './PostExtras';

const C = { pink: '#FF2D95', card: '#150B28', border: 'rgba(180,76,255,0.30)', gray: '#A59BC4' };
const inp = { width: '100%', boxSizing: 'border-box', padding: 10, borderRadius: 10, border: `1px solid ${C.border}`, background: 'rgba(255,255,255,0.05)', color: 'white', fontSize: 14, marginBottom: 8 };

export default function AdminOfficial({ snapFetch, showToast }) {
  const [list, setList] = useState(null);
  const [labels, setLabels] = useState(['OFFICIAL']);
  const [username, setUsername] = useState('');
  const [label, setLabel] = useState('OFFICIAL');
  const [org, setOrg] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => snapFetch('/snapsa/admin/official').then(r => r.ok ? r.json() : null).then(d => { setList(d?.accounts || []); if (d?.labels) setLabels(d.labels); }).catch(() => setList([]));
  useEffect(() => { load(); }, []);

  const send = async (body) => {
    setBusy(true);
    try {
      const r = await snapFetch('/snapsa/admin/official', { method: 'POST', body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Failed');
      showToast?.(body.on === false ? `Removed from @${d.username}` : `@${d.username} is now ${d.label}`, 'success');
      setUsername(''); setOrg(''); load();
    } catch (e) { showToast?.(e.message, 'error'); }
    setBusy(false);
  };

  return (
    <div style={{ padding: 12 }}>
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: 14, marginBottom: 14 }}>
        <p style={{ color: 'white', fontWeight: 800, margin: '0 0 4px' }}>Grant an official label</p>
        <p style={{ color: C.gray, fontSize: 12, margin: '0 0 10px' }}>Shows the label under the name on posts, videos and the profile, plus the pink Snapsa badge.</p>
        <input style={inp} placeholder="@username" value={username} onChange={e => setUsername(e.target.value)} autoCapitalize="none" />
        <select style={inp} value={label} onChange={e => setLabel(e.target.value)}>{labels.map(l => <option key={l} value={l} style={{ color: '#000' }}>{l}</option>)}</select>
        <input style={inp} placeholder="Organisation name (optional)" value={org} onChange={e => setOrg(e.target.value)} maxLength={80} />
        <button disabled={busy || !username.trim()} onClick={() => send({ username, label, org, on: true })} style={{ width: '100%', padding: 12, borderRadius: 10, border: 'none', background: C.pink, color: 'white', fontWeight: 800, opacity: (busy || !username.trim()) ? 0.5 : 1 }}>Grant label</button>
      </div>
      <p style={{ color: C.gray, fontSize: 12, fontWeight: 700, margin: '0 0 8px' }}>CURRENT OFFICIAL ACCOUNTS</p>
      {list === null && <p style={{ color: C.gray }}>Loading…</p>}
      {list?.length === 0 && <p style={{ color: C.gray }}>None yet.</p>}
      {list?.map(a => (
        <div key={a.userId} style={{ display: 'flex', alignItems: 'center', gap: 10, background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 10, marginBottom: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ color: 'white', fontWeight: 700, margin: 0 }}>@{a.username}</p>
            {a.org && <p style={{ color: C.gray, fontSize: 12, margin: '2px 0' }}>{a.org}</p>}
            <OfficialPill label={a.label} />
          </div>
          <button disabled={busy} onClick={() => send({ username: a.username, on: false })} style={{ padding: '8px 12px', borderRadius: 10, border: `1px solid ${C.border}`, background: 'transparent', color: '#ff7a9a', fontWeight: 700 }}>Remove</button>
        </div>
      ))}
    </div>
  );
}
