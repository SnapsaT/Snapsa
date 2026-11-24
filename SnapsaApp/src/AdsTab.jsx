// src/AdsTab.jsx — Profile "Ads" tab (create + manage), the sponsored card shown to viewers, and the admin review list.
import React, { useEffect, useRef, useState } from 'react';
import { Plus, Image as ImageIcon, X, ExternalLink } from 'lucide-react';

const C = { pink: '#FF2D95', card: '#150B28', border: 'rgba(180,76,255,0.30)', gray: '#A59BC4' };
const inp = { width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,.07)', border: `1px solid ${C.border}`, borderRadius: 12, padding: '12px 14px', color: 'white', fontSize: 15, outline: 'none', marginBottom: 10 };
const ST = { pending: ['⏳ In review', '#fbbf24'], active: ['🟢 Live', '#4ade80'], rejected: ['❌ Rejected', '#f87171'], cancelled: ['Stopped', '#A59BC4'], expired: ['Finished', '#A59BC4'] };
const left = (d) => { const ms = new Date(d) - Date.now(); return ms <= 0 ? '' : ms > 86400000 ? `${Math.ceil(ms / 86400000)} days left` : `${Math.ceil(ms / 3600000)} h left`; };

export function SponsoredCard({ snapFetch, mediaHref = (u) => u }) {
  const [ad, setAd] = useState(null);
  const ref = useRef(null), counted = useRef(false);
  useEffect(() => { snapFetch('/snapsa/promo/serve').then(r => r.ok ? r.json() : null).then(d => setAd(d?.ad || null)).catch(() => {}); }, []);
  useEffect(() => {
    if (!ad || !ref.current || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting && !counted.current) { counted.current = true; snapFetch(`/snapsa/promo/${ad.id}/impression`, { method: 'POST' }).catch(() => {}); } }, { threshold: 0.5 });
    io.observe(ref.current); return () => io.disconnect();
  }, [ad]);
  if (!ad) return null;
  const go = () => { snapFetch(`/snapsa/promo/${ad.id}/click`, { method: 'POST' }).catch(() => {}); if (ad.ctaUrl) window.open(ad.ctaUrl, '_blank', 'noopener'); };
  return (
    <div ref={ref} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 18, padding: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ color: C.gray, fontSize: 11, fontWeight: 800, letterSpacing: 1 }}>SPONSORED{ad.ownerName ? ` · @${ad.ownerName}` : ''}</span>
      </div>
      {ad.mediaUrl && (ad.mediaType === 'video'
        ? <video src={mediaHref(ad.mediaUrl)} controls playsInline muted style={{ width: '100%', borderRadius: 12, maxHeight: 320, background: '#000' }} />
        : <img src={mediaHref(ad.mediaUrl)} alt="" style={{ width: '100%', borderRadius: 12, maxHeight: 360, objectFit: 'cover' }} />)}
      <p style={{ color: 'white', fontWeight: 800, fontSize: 16, margin: '10px 0 4px' }}>{ad.title}</p>
      {ad.text && <p style={{ color: '#e9e2ff', fontSize: 14, margin: '0 0 10px', lineHeight: 1.45 }}>{ad.text}</p>}
      {ad.ctaUrl && <button onClick={go} style={{ width: '100%', padding: 12, borderRadius: 12, border: 'none', background: 'linear-gradient(135deg,#8b2cf5,#ff2d95)', color: 'white', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>{ad.ctaLabel} <ExternalLink size={15} /></button>}
    </div>
  );
}

// A full-screen sponsored slide for the video feed (shown after every few videos when an approved ad is running).
export function FeedAdSlide({ snapFetch, mediaHref = (u) => u, active }) {
  const [ad, setAd] = useState(null);
  const counted = useRef(false), vref = useRef(null);
  useEffect(() => { snapFetch('/snapsa/promo/serve').then(r => r.ok ? r.json() : null).then(d => setAd(d?.ad || null)).catch(() => {}); }, []);
  useEffect(() => { if (active && ad && !counted.current) { counted.current = true; snapFetch(`/snapsa/promo/${ad.id}/impression`, { method: 'POST' }).catch(() => {}); } }, [active, ad]);
  useEffect(() => { const v = vref.current; if (!v) return; if (active) v.play?.().catch(() => {}); else v.pause?.(); }, [active, ad]);
  const go = () => { if (!ad) return; snapFetch(`/snapsa/promo/${ad.id}/click`, { method: 'POST' }).catch(() => {}); if (ad.ctaUrl) window.open(ad.ctaUrl, '_blank', 'noopener'); };
  if (!ad) return <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.gray }}>Swipe up ↑</div>;
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#000', overflow: 'hidden' }}>
      {ad.mediaUrl && (ad.mediaType === 'video'
        ? <video ref={vref} src={mediaHref(ad.mediaUrl)} loop muted playsInline style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }} />
        : <img src={mediaHref(ad.mediaUrl)} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }} />)}
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '60px 18px calc(110px + env(safe-area-inset-bottom,0px))', background: 'linear-gradient(transparent,rgba(0,0,0,.88))' }}>
        <span style={{ background: 'rgba(255,255,255,.18)', color: 'white', fontSize: 10.5, fontWeight: 800, letterSpacing: 1.2, padding: '3px 9px', borderRadius: 999 }}>SPONSORED{ad.ownerName ? ` · @${ad.ownerName}` : ''}</span>
        <p style={{ color: 'white', fontWeight: 800, fontSize: 19, margin: '10px 0 4px' }}>{ad.title}</p>
        {ad.text && <p style={{ color: '#e9e2ff', fontSize: 14, margin: '0 0 12px', lineHeight: 1.45 }}>{ad.text}</p>}
        {ad.ctaUrl && <button onClick={go} style={{ width: '100%', padding: 14, borderRadius: 14, border: 'none', background: 'linear-gradient(135deg,#8b2cf5,#ff2d95)', color: 'white', fontWeight: 800, fontSize: 15, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>{ad.ctaLabel} <ExternalLink size={16} /></button>}
      </div>
    </div>
  );
}

export default function AdsTab({ snapFetch, showToast, coins = 0, onCoins }) {
  const [ads, setAds] = useState(null);
  const [plans, setPlans] = useState([]);
  const [creating, setCreating] = useState(false);
  const [f, setF] = useState({ title: '', text: '', ctaLabel: 'Learn more', ctaUrl: '', days: 7 });
  const [file, setFile] = useState(null), [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const load = () => snapFetch('/snapsa/promo/mine').then(r => r.ok ? r.json() : null).then(d => setAds(d?.ads || [])).catch(() => setAds([]));
  useEffect(() => { load(); snapFetch('/snapsa/promo/options').then(r => r.ok ? r.json() : null).then(d => setPlans(d?.plans || [])).catch(() => {}); }, []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const plan = plans.find(p => p.days === f.days);
  const enough = plan ? coins >= plan.coins : false;
  const valid = f.title.trim().length >= 3 && plan && enough;

  const publish = async () => {
    if (!valid || busy) return; setBusy(true);
    try {
      const fd = new FormData();
      if (file) fd.append('media', file);
      Object.entries({ title: f.title, text: f.text, ctaLabel: f.ctaLabel, ctaUrl: f.ctaUrl, days: f.days }).forEach(([k, v]) => fd.append(k, v));
      const r = await snapFetch('/snapsa/promo', { method: 'POST', body: fd });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { showToast?.('✅ Ad sent for review. It goes live once approved', 'success'); onCoins?.(d.newBalance); setCreating(false); setF({ title: '', text: '', ctaLabel: 'Learn more', ctaUrl: '', days: 7 }); setFile(null); setPreview(null); load(); }
      else showToast?.(d.error || 'Could not create the ad', 'error');
    } catch { showToast?.('You need to be online', 'error'); }
    setBusy(false);
  };
  const cancel = async (a) => {
    if (!window.confirm(a.status === 'pending' ? 'Cancel this ad and get your coins back?' : 'Stop this ad now? Coins for a running ad are not refunded.')) return;
    const r = await snapFetch(`/snapsa/promo/${a.id}/cancel`, { method: 'POST' }).catch(() => null);
    const d = await r?.json().catch(() => ({}));
    if (r?.ok) { showToast?.(d.refunded ? `Cancelled. ${d.refunded} coins returned` : 'Ad stopped', 'success'); if (d.refunded) onCoins?.(coins + d.refunded); load(); } else showToast?.(d?.error || 'Could not cancel', 'error');
  };

  if (creating) return (
    <div style={{ padding: '4px 16px 30px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '8px 0 12px' }}>
        <h3 style={{ margin: 0, color: 'white' }}>New ad</h3>
        <button onClick={() => setCreating(false)} style={{ background: 'rgba(255,255,255,.1)', border: 'none', borderRadius: '50%', padding: 7 }}><X size={16} style={{ color: 'white' }} /></button>
      </div>

      <p style={{ color: C.gray, fontSize: 11, fontWeight: 800, letterSpacing: 1, margin: '0 0 8px' }}>1 · HOW LONG SHOULD IT RUN?</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: 6 }}>
        {plans.map(p => (
          <button key={p.days} onClick={() => setF(x => ({ ...x, days: p.days }))} style={{ padding: '12px 4px', borderRadius: 14, border: f.days === p.days ? '1.5px solid #fff' : `1px solid ${C.border}`, background: f.days === p.days ? 'linear-gradient(135deg,#8b2cf5,#ff2d95)' : 'rgba(255,255,255,.06)', color: 'white', cursor: 'pointer' }}>
            <span style={{ display: 'block', fontWeight: 800 }}>{p.days} day{p.days > 1 ? 's' : ''}</span>
            <span style={{ display: 'block', fontSize: 12, opacity: .9 }}>{p.coins} coins</span>
            <span style={{ display: 'block', fontSize: 10.5, opacity: .7 }}>${p.usd.toFixed(2)}</span>
          </button>))}
      </div>
      {plan && !enough && <p style={{ color: '#f87171', fontSize: 13, margin: '4px 0 0' }}>You have {coins} coins. This plan needs {plan.coins}.</p>}

      <p style={{ color: C.gray, fontSize: 11, fontWeight: 800, letterSpacing: 1, margin: '16px 0 8px' }}>2 · YOUR AD</p>
      {preview ? (
        <div style={{ position: 'relative', marginBottom: 10 }}>
          {file?.type.startsWith('video/') ? <video src={preview} controls style={{ width: '100%', borderRadius: 12, maxHeight: 240 }} /> : <img src={preview} alt="" style={{ width: '100%', borderRadius: 12, maxHeight: 240, objectFit: 'cover' }} />}
          <button onClick={() => { setFile(null); setPreview(null); }} style={{ position: 'absolute', top: 6, right: 6, background: 'rgba(0,0,0,.6)', border: 'none', borderRadius: '50%', padding: 6 }}><X size={14} style={{ color: 'white' }} /></button>
        </div>
      ) : (
        <button onClick={() => fileRef.current?.click()} style={{ width: '100%', padding: 22, borderRadius: 14, border: `1px dashed ${C.border}`, background: 'rgba(255,255,255,.04)', color: C.gray, marginBottom: 10, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, cursor: 'pointer' }}><ImageIcon size={24} /> Add a photo or video (optional)</button>
      )}
      <input ref={fileRef} type="file" accept="image/*,video/*" hidden onChange={e => { const x = e.target.files?.[0]; e.target.value = ''; if (x) { setFile(x); setPreview(URL.createObjectURL(x)); } }} />
      <input style={inp} value={f.title} onChange={e => setF(x => ({ ...x, title: e.target.value.slice(0, 80) }))} placeholder="Headline" />
      <textarea style={{ ...inp, resize: 'none' }} rows={3} value={f.text} onChange={e => setF(x => ({ ...x, text: e.target.value.slice(0, 300) }))} placeholder="Short description (optional)" />
      <input style={inp} value={f.ctaUrl} onChange={e => setF(x => ({ ...x, ctaUrl: e.target.value.trim() }))} placeholder="Link (https://…), optional" />
      <input style={inp} value={f.ctaLabel} onChange={e => setF(x => ({ ...x, ctaLabel: e.target.value.slice(0, 24) }))} placeholder="Button text" />

      <button onClick={publish} disabled={!valid || busy} style={{ width: '100%', padding: 15, borderRadius: 14, border: 'none', fontWeight: 800, fontSize: 16, color: 'white', background: valid ? 'linear-gradient(135deg,#8b2cf5,#ff2d95)' : 'rgba(255,255,255,.12)', opacity: busy ? .6 : 1 }}>
        {busy ? 'Sending…' : plan ? `Pay ${plan.coins} coins and send for review` : 'Choose a plan'}
      </button>
      <p style={{ color: C.gray, fontSize: 12, margin: '10px 2px 0' }}>Every ad is checked before it goes live. If it is rejected, your coins come back. The run starts when it is approved.</p>
    </div>
  );

  return (
    <div style={{ padding: '4px 16px 30px' }}>
      <button onClick={() => setCreating(true)} style={{ width: '100%', padding: 14, borderRadius: 14, border: 'none', background: 'linear-gradient(135deg,#8b2cf5,#ff2d95)', color: 'white', fontWeight: 800, fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, margin: '8px 0 14px' }}><Plus size={18} /> Create an ad</button>
      {ads === null ? <p style={{ color: C.gray, textAlign: 'center' }}>Loading…</p>
        : ads.length === 0 ? <p style={{ color: C.gray, textAlign: 'center', fontSize: 14 }}>No ads yet. Pick how long you want to run an ad, add your message and we show it to people on Snapsa.</p>
        : ads.map(a => (
          <div key={a.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: 14, marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ color: 'white', fontWeight: 800 }}>{a.title}</span>
              <span style={{ color: ST[a.status]?.[1], fontWeight: 700, fontSize: 13, flexShrink: 0 }}>{ST[a.status]?.[0]}</span>
            </div>
            <p style={{ color: C.gray, fontSize: 12.5, margin: '6px 0 0' }}>{a.days} day plan · {a.coinsPaid} coins{a.status === 'active' ? ` · ${left(a.endsAt)}` : ''}</p>
            {a.status === 'rejected' && a.rejectReason && <p style={{ color: '#f87171', fontSize: 12.5, margin: '4px 0 0' }}>{a.rejectReason}</p>}
            {(a.status === 'active' || a.status === 'expired') && <p style={{ color: 'white', fontSize: 13, margin: '8px 0 0' }}>👁 {a.impressions} seen · 👆 {a.clicks} clicks</p>}
            {(a.status === 'pending' || a.status === 'active') && <button onClick={() => cancel(a)} style={{ marginTop: 10, padding: '8px 14px', borderRadius: 10, border: '1px solid rgba(248,113,113,.5)', background: 'transparent', color: '#f87171', fontWeight: 700 }}>{a.status === 'pending' ? 'Cancel and refund' : 'Stop ad'}</button>}
          </div>))}
    </div>
  );
}

export function AdminPromoReview({ snapFetch, showToast }) {
  const [rows, setRows] = useState(null);
  const load = () => snapFetch('/snapsa/admin/promo?status=pending').then(r => r.ok ? r.json() : null).then(d => setRows(d?.ads || [])).catch(() => setRows([]));
  useEffect(() => { load(); }, []);
  const decide = async (a, ok) => {
    let body = {};
    if (!ok) { const reason = window.prompt('Reason (the advertiser is told)'); if (!reason) return; body = { reason }; }
    const r = await snapFetch(`/snapsa/admin/promo/${a.id}/${ok ? 'approve' : 'reject'}`, { method: 'POST', body: JSON.stringify(body) }).catch(() => null);
    if (r?.ok) { showToast?.(ok ? 'Ad approved' : 'Ad rejected, coins returned', 'success'); load(); } else showToast?.('Could not save', 'error');
  };
  if (!rows || !rows.length) return null;
  return (
    <div style={{ marginBottom: 20 }}>
      <p style={{ color: 'white', fontWeight: 800, fontSize: 15, marginBottom: 10 }}>Ads to review ({rows.length})</p>
      {rows.map(a => (
        <div key={a.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: 14, marginBottom: 10 }}>
          {a.mediaUrl && (a.mediaType === 'video' ? <video src={a.mediaUrl} controls style={{ width: '100%', borderRadius: 10, maxHeight: 220 }} /> : <img src={a.mediaUrl} alt="" style={{ width: '100%', borderRadius: 10, maxHeight: 220, objectFit: 'cover' }} />)}
          <p style={{ color: 'white', fontWeight: 800, margin: '8px 0 2px' }}>{a.title}</p>
          <p style={{ color: C.gray, fontSize: 13, margin: 0 }}>{a.text}</p>
          <p style={{ color: C.gray, fontSize: 12, margin: '6px 0' }}>@{a.ownerName} · {a.days} days · {a.coinsPaid} coins{a.ctaUrl ? ` · ${a.ctaUrl}` : ''}</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => decide(a, false)} style={{ flex: 1, padding: 10, borderRadius: 10, border: 'none', background: '#ef4444', color: 'white', fontWeight: 700 }}>Reject</button>
            <button onClick={() => decide(a, true)} style={{ flex: 2, padding: 10, borderRadius: 10, border: 'none', background: '#16a34a', color: 'white', fontWeight: 700 }}>Approve</button>
          </div>
        </div>))}
    </div>
  );
}
