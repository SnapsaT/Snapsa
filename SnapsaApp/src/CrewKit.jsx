// src/CrewKit.jsx — Work section, SNAPSA CREW pill, crew shirt (3D flip) and the admin crew tab.
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { RotateCw } from 'lucide-react';

export const HOT_PINK = '#FF1493';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const isSnapsaCompany = (n) => /snapsa/i.test(String(n || ''));
export const fmtStart = (ym) => { const m = /^(\d{4})-(\d{2})$/.exec(ym || ''); return m ? `${MONTHS[+m[2] - 1]} ${m[1]}` : ''; };

/* ── Ember CREW pill (≈80% of the badge height). Tap → "<position> at Snapsa" ── */
export const CrewPill = ({ position, size = 13 }) => {
  const [show, setShow] = useState(false);
  useEffect(() => { if (!show) return; const t = setTimeout(() => setShow(false), 2600); return () => clearTimeout(t); }, [show]);
  const h = Math.max(9, Math.round(size * 0.8));
  return (
    <>
      <span onClick={(e) => { e.stopPropagation(); setShow(true); }}
        style={{ display: 'inline-flex', alignItems: 'center', height: h, padding: `0 ${Math.round(h * 0.42)}px`, borderRadius: 999, cursor: 'pointer', flexShrink: 0,
          background: 'linear-gradient(135deg,#ff9a1f 0%,#ff4d00 55%,#d61a00 100%)', color: '#fff', fontWeight: 900, fontSize: Math.max(6, Math.round(h * 0.6)), letterSpacing: 0.6,
          boxShadow: '0 0 6px rgba(255,90,0,0.75), inset 0 0 3px rgba(255,220,120,0.6)', textShadow: '0 1px 1px rgba(120,20,0,0.7)', lineHeight: 1 }}>CREW</span>
      {show && typeof document !== 'undefined' && createPortal(
        <div onClick={() => setShow(false)} style={{ position: 'fixed', left: 0, right: 0, top: 'calc(env(safe-area-inset-top,0px) + 90px)', display: 'flex', justifyContent: 'center', zIndex: 99999, pointerEvents: 'auto' }}>
          <div style={{ background: 'linear-gradient(135deg,#ff7a1a,#d61a00)', color: '#fff', padding: '9px 16px', borderRadius: 999, fontWeight: 800, fontSize: 13.5, boxShadow: '0 6px 24px rgba(255,80,0,0.5)', maxWidth: '88vw', textAlign: 'center' }}>
            {(position || 'Crew member')} at Snapsa
          </div>
        </div>, document.body)}
    </>
  );
};

/* ── "🏢 Works at SNAPSA as Developer since November 2026" ── */
export const WorkLine = ({ work, crew, isSelf, onEdit }) => {
  if (!work?.company) {
    return isSelf ? <button onClick={onEdit} style={{ background: 'none', border: 'none', padding: 0, color: 'rgba(255,255,255,0.35)', fontSize: 12.5, fontStyle: 'italic', cursor: 'pointer', textAlign: 'left' }}>🏢 Add where you work…</button> : null;
  }
  const hot = isSnapsaCompany(work.company) && (work.status === 'approved' || !!crew);
  const since = fmtStart(work.start);
  return (
    <div onClick={isSelf ? onEdit : undefined} style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.8)', margin: '3px 0', cursor: isSelf ? 'pointer' : 'default', lineHeight: 1.4 }}>
      🏢 Works at <b style={{ color: hot ? HOT_PINK : '#fff', textShadow: hot ? '0 0 8px rgba(255,20,147,0.55)' : 'none' }}>{work.company}</b>
      {work.position ? <> as <b style={{ color: '#fff' }}>{work.position}</b></> : null}{since ? <> since {since}</> : null}
      {isSelf && isSnapsaCompany(work.company) && work.status === 'pending' && <span style={{ marginLeft: 6, fontSize: 10.5, color: '#ffb347', fontWeight: 700 }}>· waiting for approval</span>}
      {isSelf && isSnapsaCompany(work.company) && work.status === 'rejected' && <span style={{ marginLeft: 6, fontSize: 10.5, color: '#ff7a9a', fontWeight: 700 }}>· not approved</span>}
    </div>
  );
};

/* ── Work editor (current job only) ── */
export const WorkEditor = ({ initial, snapFetch, showToast, onClose, onSaved }) => {
  const [company, setCompany] = useState(initial?.company || '');
  const [position, setPosition] = useState(initial?.position || '');
  const [start, setStart] = useState(initial?.start || '');
  const [busy, setBusy] = useState(false);
  const snapsa = isSnapsaCompany(company);
  const save = async (clear) => {
    if (busy) return; setBusy(true);
    try {
      const r = await snapFetch('/snapsa/profile/work', { method: 'POST', body: JSON.stringify(clear ? { company: '' } : { company, position, start }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not save');
      showToast?.(clear ? 'Work removed' : (snapsa ? 'Sent to Snapsa for approval' : 'Work saved'), 'success');
      onSaved?.(d.work || null); onClose();
    } catch (e) { showToast?.(e.message, 'error'); }
    setBusy(false);
  };
  const inp = { width: '100%', boxSizing: 'border-box', padding: 12, borderRadius: 12, border: '1px solid rgba(180,76,255,0.35)', background: 'rgba(255,255,255,0.06)', color: '#fff', fontSize: 15, marginBottom: 10, outline: 'none' };
  return createPortal(
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 20000, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', background: '#150B28', borderRadius: '22px 22px 0 0', padding: '18px 16px calc(env(safe-area-inset-bottom,0px) + 18px)', border: '1px solid rgba(180,76,255,0.3)' }}>
        <p style={{ color: '#fff', fontWeight: 900, fontSize: 17, margin: '0 0 4px' }}>🏢 Where you work</p>
        <p style={{ color: '#A59BC4', fontSize: 12, margin: '0 0 12px' }}>Your current job only.{snapsa ? ' Snapsa jobs are checked by an admin before the CREW badge appears.' : ''}</p>
        <input style={inp} placeholder="Company" value={company} maxLength={60} onChange={e => setCompany(e.target.value)} />
        <input style={inp} placeholder="Position (e.g. Software Developer)" value={position} maxLength={60} onChange={e => setPosition(e.target.value)} />
        <label style={{ color: '#A59BC4', fontSize: 12, display: 'block', marginBottom: 4 }}>Started</label>
        <input style={inp} type="month" value={start} onChange={e => setStart(e.target.value)} />
        <button disabled={busy || !company.trim() || !position.trim()} onClick={() => save(false)} style={{ width: '100%', padding: 13, borderRadius: 12, border: 'none', background: HOT_PINK, color: '#fff', fontWeight: 800, fontSize: 15, opacity: (busy || !company.trim() || !position.trim()) ? 0.5 : 1 }}>Save</button>
        {initial?.company && <button disabled={busy} onClick={() => save(true)} style={{ width: '100%', marginTop: 8, padding: 11, borderRadius: 12, border: '1px solid rgba(255,255,255,0.15)', background: 'transparent', color: '#ff7a9a', fontWeight: 700 }}>Remove work</button>}
      </div>
    </div>, document.body);
};

/* ── Flip icon that sits on the avatar's edge (crew only) ── */
export const ShirtFlipButton = ({ onClick }) => (
  <button onClick={(e) => { e.stopPropagation(); onClick(); }} aria-label="Crew shirt"
    style={{ position: 'absolute', right: -2, bottom: 2, width: 28, height: 28, borderRadius: '50%', border: '2px solid #0a0614', background: 'linear-gradient(135deg,#ff9a1f,#d61a00)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0, boxShadow: '0 0 10px rgba(255,80,0,0.7)', zIndex: 4 }}>
    <RotateCw size={15} />
  </button>
);

/* ── 3D crew shirt: front 3 s → turns → back 3 s → turns … ── */
export const CrewShirtModal = ({ firstName, position, snapFetch, onClose }) => {
  const [art, setArt] = useState(undefined);
  useEffect(() => { snapFetch('/snapsa/crew/shirt').then(r => r.ok ? r.json() : null).then(d => setArt(d || {})).catch(() => setArt({})); }, []);
  const L = { fx: 31.5, fy: 29, fs: 4.6, bx: 29.6, by: 58, bs: 0, py: 29, ps: 5, ...(art?.layout || {}) };
  const frontSrc = art?.front || '/CrewShirtFront.png', backSrc = art?.back || '/CrewShirtBack.png';
  const posText = String(position || '').toUpperCase();
  const ratio = art?.ratio || (847 / 1039);
  const posSize = Math.min(Number(L.ps) || 5, (0.47 * 100 / ratio) / (Math.max(posText.length, 1) * 1.0));
  const face = { position: 'absolute', inset: 0, backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden', borderRadius: 14, overflow: 'hidden' };
  const txt = { position: 'absolute', transform: 'translate(-50%,-50%)', whiteSpace: 'nowrap', fontFamily: '"Arial Black", Impact, system-ui, sans-serif', fontWeight: 900, textTransform: 'uppercase', color: '#ff2d95', WebkitTextStroke: '0.6px #6b0046', textShadow: '0 0 8px rgba(255,45,149,0.7)' };
  return createPortal(
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 20000, background: 'rgba(5,2,12,0.92)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <style>{`@keyframes crewTurn{0%,41%{transform:rotateX(-8deg) rotateY(-10deg)}50%,91%{transform:rotateX(-8deg) rotateY(170deg)}100%{transform:rotateX(-8deg) rotateY(350deg)}}`}</style>
      <p style={{ color: '#fff', fontWeight: 900, fontSize: 16, margin: '0 0 14px', letterSpacing: 1 }}>SNAPSA CREW</p>
      {art === undefined ? <p style={{ color: '#A59BC4' }}>Loading…</p> : (
        <div style={{ perspective: 1100, width: 'min(88vw, 420px)', aspectRatio: `${ratio}` }} onClick={e => e.stopPropagation()}>
          <div style={{ position: 'relative', width: '100%', height: '100%', transformStyle: 'preserve-3d', animation: 'crewTurn 7.2s ease-in-out infinite', filter: 'drop-shadow(0 18px 24px rgba(255,45,149,0.35))' }}>
            <div style={{ ...face, containerType: 'inline-size' }}>
              <img src={frontSrc} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} onLoad={e => { const r = e.target.naturalWidth / e.target.naturalHeight; if (r && art.ratio !== r) setArt(a => ({ ...a, ratio: r })); }} />
              <span style={{ ...txt, left: `${L.fx}%`, top: `${L.fy}%`, fontSize: `${L.fs}cqw`, fontFamily: 'Arial, Helvetica, system-ui, sans-serif', fontWeight: 800, color: '#ff22b4', WebkitTextStroke: 0, textShadow: '0 0 6px rgba(255,34,180,0.55)', letterSpacing: '0.02em' }}>{String(firstName || '').toUpperCase()}</span>
            </div>
            <div style={{ ...face, transform: 'rotateY(180deg)', containerType: 'inline-size' }}>
              <img src={backSrc} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
              {Number(L.bs) > 0 && <span style={{ ...txt, left: `${L.bx}%`, top: `${L.py}%`, fontSize: `${L.bs}cqw` }}>CREW</span>}
              <span style={{ ...txt, left: `${L.bx}%`, top: `${L.by}%`, fontSize: `${posSize}cqw`, writingMode: 'vertical-rl', textOrientation: 'upright', fontFamily: 'Georgia, "Times New Roman", serif', fontWeight: 700, letterSpacing: '0.02em', lineHeight: 0.95, background: 'linear-gradient(180deg,#fff0a0,#ffc21a 45%,#e07b00)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', WebkitTextFillColor: 'transparent', WebkitTextStroke: 0, textShadow: 'none', filter: 'drop-shadow(0 1px 2px rgba(80,40,0,0.8))' }}>{posText}</span>
            </div>
          </div>
        </div>
      )}
      <p style={{ color: '#A59BC4', fontSize: 12, marginTop: 18 }}>Tap anywhere to close</p>
    </div>, document.body);
};

/* ── Admin tab: approve crew + upload shirt artwork ── */
export function AdminCrew({ snapFetch, showToast }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pos, setPos] = useState({});
  const [layout, setLayout] = useState(null);
  const load = () => snapFetch('/snapsa/admin/crew').then(r => r.ok ? r.json() : null).then(d => { setData(d || { pending: [], approved: [], shirt: {} }); if (d?.shirt?.layout) setLayout(d.shirt.layout); }).catch(() => setData({ pending: [], approved: [], shirt: {} }));
  useEffect(() => { load(); }, []);
  const card = { background: '#150B28', border: '1px solid rgba(180,76,255,0.3)', borderRadius: 14, padding: 12, marginBottom: 10 };
  const btn = (bg) => ({ padding: '8px 14px', borderRadius: 10, border: 'none', background: bg, color: '#fff', fontWeight: 800, fontSize: 13 });
  const decide = async (u, action) => {
    setBusy(true);
    try { const r = await snapFetch('/snapsa/admin/crew/decision', { method: 'POST', body: JSON.stringify({ userId: u.userId, action, position: pos[u.userId] ?? u.position }) }); if (!r.ok) throw new Error('Failed'); showToast?.(action === 'approve' ? 'Approved' : 'Done', 'success'); load(); }
    catch (e) { showToast?.(e.message, 'error'); }
    setBusy(false);
  };
  const upload = async (side, file) => {
    if (!file) return; setBusy(true);
    try { const fd = new FormData(); fd.append('shirt', file); const r = await snapFetch(`/snapsa/admin/crew/shirt/${side}`, { method: 'POST', body: fd }); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Upload failed'); showToast?.(`${side} saved`, 'success'); load(); }
    catch (e) { showToast?.(e.message, 'error'); }
    setBusy(false);
  };
  const removeArt = async (side) => { setBusy(true); try { await snapFetch(`/snapsa/admin/crew/shirt/${side}/remove`, { method: 'POST', body: '{}' }); load(); } catch {} setBusy(false); };
  const saveLayout = async () => { setBusy(true); try { const r = await snapFetch('/snapsa/admin/crew/shirt-layout', { method: 'POST', body: JSON.stringify(layout) }); if (!r.ok) throw new Error('Failed'); showToast?.('Text placement saved', 'success'); } catch (e) { showToast?.(e.message, 'error'); } setBusy(false); };
  if (!data) return <p style={{ color: '#A59BC4', textAlign: 'center', padding: 24 }}>Loading…</p>;
  const LK = [['fx', 'Front name X %'], ['fy', 'Front name Y %'], ['fs', 'Front name size'], ['bx', 'Position X %'], ['by', 'Position Y %'], ['ps', 'Position max size'], ['bs', 'CREW size (0 = already on picture)'], ['py', 'CREW Y %']];
  return (
    <div style={{ padding: 12 }}>
      <p style={{ color: '#A59BC4', fontSize: 12, fontWeight: 700, margin: '0 0 8px' }}>WAITING FOR APPROVAL ({data.pending.length})</p>
      {data.pending.length === 0 && <p style={{ color: '#A59BC4', fontSize: 13 }}>Nobody waiting.</p>}
      {data.pending.map(u => (
        <div key={u.userId} style={card}>
          <p style={{ color: '#fff', fontWeight: 800, margin: 0 }}>@{u.username} <span style={{ color: '#A59BC4', fontWeight: 500, fontSize: 12 }}>· {u.company}</span></p>
          <input value={pos[u.userId] ?? u.position} onChange={e => setPos(p => ({ ...p, [u.userId]: e.target.value }))} maxLength={60} style={{ width: '100%', boxSizing: 'border-box', margin: '8px 0', padding: 10, borderRadius: 10, border: '1px solid rgba(180,76,255,0.3)', background: 'rgba(255,255,255,0.05)', color: '#fff' }} />
          <div style={{ display: 'flex', gap: 8 }}><button disabled={busy} style={btn('#16a34a')} onClick={() => decide(u, 'approve')}>Approve as CREW</button><button disabled={busy} style={btn('#6b7280')} onClick={() => decide(u, 'reject')}>Reject</button></div>
        </div>
      ))}
      <p style={{ color: '#A59BC4', fontSize: 12, fontWeight: 700, margin: '16px 0 8px' }}>CREW ({data.approved.length})</p>
      {data.approved.map(u => (
        <div key={u.userId} style={{ ...card, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}><p style={{ color: '#fff', fontWeight: 700, margin: 0 }}>@{u.username}</p><p style={{ color: '#A59BC4', fontSize: 12, margin: 0 }}>{u.position}</p></div>
          <button disabled={busy} style={btn('#6b7280')} onClick={() => decide(u, 'remove')}>Remove</button>
        </div>
      ))}
      <p style={{ color: '#A59BC4', fontSize: 12, fontWeight: 700, margin: '16px 0 8px' }}>CREW SHIRT PICTURES</p>
      {['front', 'back'].map(side => (
        <div key={side} style={card}>
          <p style={{ color: '#fff', fontWeight: 800, margin: '0 0 8px', textTransform: 'capitalize' }}>{side}{side === 'back' ? ' (upright photo, collar at top)' : ''}</p>
          {data.shirt?.[side] && <img src={data.shirt[side]} alt="" style={{ width: '100%', maxHeight: 220, objectFit: 'contain', borderRadius: 10, marginBottom: 8 }} />}
          <label style={{ ...btn('#7C3AED'), display: 'inline-block' }}>{data.shirt?.[side] ? 'Replace' : 'Upload'}<input type="file" accept="image/*" hidden onChange={e => { upload(side, e.target.files?.[0]); e.target.value = ''; }} /></label>
          {data.shirt?.[side] && <button disabled={busy} onClick={() => removeArt(side)} style={{ ...btn('transparent'), border: '1px solid rgba(255,255,255,0.2)', marginLeft: 8 }}>Remove</button>}
        </div>
      ))}
      {layout && (
        <div style={card}>
          <p style={{ color: '#fff', fontWeight: 800, margin: '0 0 8px' }}>Where the text goes (% of picture)</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {LK.map(([k, l]) => <label key={k} style={{ color: '#A59BC4', fontSize: 11 }}>{l}<input type="number" step="0.5" value={layout[k]} onChange={e => setLayout(v => ({ ...v, [k]: e.target.value }))} style={{ width: '100%', boxSizing: 'border-box', padding: 8, borderRadius: 8, border: '1px solid rgba(180,76,255,0.3)', background: 'rgba(255,255,255,0.05)', color: '#fff' }} /></label>)}
          </div>
          <button disabled={busy} onClick={saveLayout} style={{ ...btn('#FF1493'), marginTop: 10, width: '100%' }}>Save placement</button>
        </div>
      )}
    </div>
  );
}
