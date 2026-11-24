// src/AdminCoinTransfers.jsx — admin tab: review coin → money transfer requests, see ID + selfie, approve / reject, and message the user as Snapsa.
import React, { useEffect, useState } from 'react';

const C = { pink: '#FF2D95', card: '#150B28', border: 'rgba(180,76,255,0.30)', gray: '#A59BC4' };
const money = (n, cur) => `${cur} ${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const btn = (bg) => ({ flex: 1, padding: 10, borderRadius: 10, border: 'none', background: bg, color: 'white', fontWeight: 700, cursor: 'pointer' });

export default function AdminCoinTransfers({ snapFetch, showToast }) {
  const [status, setStatus] = useState('pending');
  const [rows, setRows] = useState(null);
  const [act, setAct] = useState(null);     // { id, kind: 'reject' | 'reply' | 'approve' }
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [photo, setPhoto] = useState(null);

  const load = () => snapFetch(`/snapsa/admin/wallet/coin-transfers?status=${status}`).then(r => r.ok ? r.json() : null).then(d => setRows(d?.requests || [])).catch(() => setRows([]));
  useEffect(() => { setRows(null); load(); }, [status]);

  const call = async (path, body) => {
    const r = await snapFetch(path, { method: 'POST', body: JSON.stringify(body || {}) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Failed');
    return d;
  };
  const view = async (id, which) => {
    try {
      const r = await snapFetch(`/snapsa/admin/wallet/coin-transfers/${id}/file/${which}`);
      if (!r.ok) throw new Error();
      setPhoto({ url: URL.createObjectURL(await r.blob()), title: which === 'id' ? 'ID' : 'Selfie' });
    } catch { showToast?.('Could not open the photo', 'error'); }
  };
  const run = async () => {
    if (!act || busy) return; setBusy(true);
    try {
      if (act.kind === 'reply') { if (!text.trim()) throw new Error('Write a message'); await call(`/snapsa/admin/wallet/coin-transfers/${act.id}/reply`, { message: text.trim() }); showToast?.('Sent as Snapsa', 'success'); }
      if (act.kind === 'reject') { if (!text.trim()) throw new Error('Enter a reason'); await call(`/snapsa/admin/wallet/coin-transfers/${act.id}/reject`, { reason: text.trim() }); showToast?.('Rejected. Coins returned', 'success'); }
      if (act.kind === 'approve') { await call(`/snapsa/admin/wallet/coin-transfers/${act.id}/approve`, { note: text.trim() }); showToast?.('Approved', 'success'); }
      setAct(null); setText(''); load();
    } catch (e) { showToast?.(e.message, 'error'); }
    setBusy(false);
  };

  return (
    <>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        {['pending', 'approved', 'rejected'].map(s => <button key={s} onClick={() => setStatus(s)} style={{ ...btn(status === s ? C.pink : C.card), flex: 'none', padding: '7px 14px', fontSize: 12.5, textTransform: 'capitalize' }}>{s}</button>)}
      </div>
      {rows === null ? <p style={{ color: C.gray, textAlign: 'center', padding: 24 }}>Loading…</p>
        : rows.length === 0 ? <p style={{ color: C.gray, textAlign: 'center', padding: 24, fontSize: 13 }}>Nothing here</p>
        : rows.map(r => (
          <div key={r.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: 14, marginBottom: 12 }}>
            <p style={{ color: 'white', fontWeight: 800, fontSize: 16, margin: 0 }}>{r.coins} coins → {money(r.amount, r.currency)}</p>
            <p style={{ color: C.gray, fontSize: 12.5, lineHeight: 1.6, margin: '6px 0 10px' }}>
              {r.mode === 'wallet' ? 'Into their Snapsa Wallet' : 'Bank transfer'} · {r.countryCode || 'unknown country'} · user {String(r.userId).slice(-6)}<br />
              {r.bank && <>{r.bank.holder}<br />{r.bank.bankName} · {r.bank.accountNumber}{r.bank.branch ? ` · ${r.bank.branch}` : ''}{r.bank.swift ? ` · ${r.bank.swift}` : ''}<br /></>}
              {new Date(r.createdAt).toLocaleString()}{r.adminNote ? <><br />Note: {r.adminNote}</> : null}
            </p>
            {r.status === 'pending' && <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <button style={btn(C.border)} onClick={() => view(r.id, 'id')}>See ID</button>
              <button style={btn(C.border)} onClick={() => view(r.id, 'selfie')}>See selfie</button>
            </div>}
            {act?.id === r.id ? (<>
              {act.kind !== 'approve' && <input value={text} onChange={e => setText(e.target.value.slice(0, 500))} placeholder={act.kind === 'reply' ? 'Message to the user (sent as Snapsa)' : 'Reason (the user is told)'}
                style={{ width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,.07)', border: `1px solid ${C.border}`, borderRadius: 10, padding: 10, color: 'white', marginBottom: 8, outline: 'none' }} />}
              <div style={{ display: 'flex', gap: 8 }}>
                <button style={btn(C.border)} onClick={() => { setAct(null); setText(''); }}>Cancel</button>
                <button style={btn(act.kind === 'reject' ? '#ef4444' : C.pink)} onClick={run} disabled={busy}>{busy ? '…' : act.kind === 'approve' ? 'Confirm approve' : act.kind === 'reject' ? 'Confirm reject' : 'Send'}</button>
              </div>
            </>) : (
              <div style={{ display: 'flex', gap: 8 }}>
                <button style={btn(C.border)} onClick={() => { setAct({ id: r.id, kind: 'reply' }); setText(''); }}>Message</button>
                {r.status === 'pending' && <>
                  <button style={btn('#ef4444')} onClick={() => { setAct({ id: r.id, kind: 'reject' }); setText(''); }}>Reject</button>
                  <button style={btn('#16a34a')} onClick={() => { setAct({ id: r.id, kind: 'approve' }); setText(''); }}>Approve</button>
                </>}
              </div>
            )}
          </div>
        ))}
      {photo && (
        <div onClick={() => { URL.revokeObjectURL(photo.url); setPhoto(null); }} style={{ position: 'fixed', inset: 0, zIndex: 9500, background: 'rgba(0,0,0,.92)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <p style={{ color: 'white', fontWeight: 700 }}>{photo.title} (tap to close)</p>
          <img src={photo.url} alt="" style={{ maxWidth: '100%', maxHeight: '80vh', objectFit: 'contain' }} />
        </div>
      )}
    </>
  );
}
