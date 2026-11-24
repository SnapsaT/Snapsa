// src/CoinTransferSheet.jsx — "Transfer to Snapsa Wallet". Coins are only a number in the app until the user asks to cash them in.
// The request carries an ID photo, a selfie and the amount (plus bank details outside the five wallet countries). An admin reviews it.
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Camera, FileText, Check } from 'lucide-react';

const C = { pink: '#FF2D95', card: '#150B28', border: 'rgba(180,76,255,0.30)', gray: '#A59BC4' };
const inp = { width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,.07)', border: `1px solid ${C.border}`, borderRadius: 12, padding: '12px 14px', color: 'white', fontSize: 15, outline: 'none', marginBottom: 10 };
const money = (n, cur) => `${cur} ${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const STATUS = { pending: ['⏳ In review', '#fbbf24'], approved: ['✅ Approved', '#4ade80'], rejected: ['❌ Rejected', '#f87171'] };

export default function CoinTransferSheet({ coins, snapFetch, showToast, onClose, onDone }) {
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState(null);
  const [idFile, setIdFile] = useState(null), [selfie, setSelfie] = useState(null);
  const [bank, setBank] = useState({ holder: '', name: '', account: '', branch: '', swift: '' });
  const [mine, setMine] = useState(null);
  const [busy, setBusy] = useState(false);
  const idRef = useRef(null), selfRef = useRef(null);

  const loadMine = () => snapFetch('/snapsa/wallet/coin-transfer/mine').then(r => r.ok ? r.json() : null).then(d => setMine(d?.requests || [])).catch(() => setMine([]));
  useEffect(() => { loadMine(); }, []);
  useEffect(() => {
    const n = parseInt(amount, 10) || 0;
    const t = setTimeout(() => snapFetch(`/snapsa/wallet/coin-transfer/quote?coins=${n}`).then(r => r.ok ? r.json() : null).then(setQuote).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [amount]);

  const n = parseInt(amount, 10) || 0;
  const hasPending = (mine || []).some(r => r.status === 'pending');
  const bankMode = quote?.mode === 'bank';
  const ok = n >= (quote?.minCoins || 5) && n <= coins && idFile && selfie && !quote?.needsWallet && !hasPending
    && (!bankMode || (bank.holder.trim().length > 2 && bank.name.trim() && bank.account.trim().length > 4));

  const submit = async () => {
    if (!ok || busy) return; setBusy(true);
    try {
      const fd = new FormData();
      fd.append('coins', String(n)); fd.append('idDocument', idFile); fd.append('selfie', selfie);
      if (bankMode) { fd.append('bankHolder', bank.holder); fd.append('bankName', bank.name); fd.append('bankAccount', bank.account); fd.append('bankBranch', bank.branch); fd.append('bankSwift', bank.swift); }
      const r = await snapFetch('/snapsa/wallet/coin-transfer', { method: 'POST', body: fd });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { showToast?.('✅ Request sent. We will message you here', 'success'); onDone?.(d.newBalance); setAmount(''); setIdFile(null); setSelfie(null); loadMine(); }
      else showToast?.(d.error || 'Could not send the request', 'error');
    } catch { showToast?.('You need to be online to send a request', 'error'); }
    setBusy(false);
  };

  const pick = (setter) => (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) setter(f); };
  const Photo = ({ label, file, onClick, icon: I }) => (
    <button onClick={onClick} style={{ flex: 1, padding: '14px 6px', borderRadius: 14, border: file ? '1.5px solid #4ade80' : `1px dashed ${C.border}`, background: 'rgba(255,255,255,.05)', color: 'white', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
      {file ? <Check size={22} style={{ color: '#4ade80' }} /> : <I size={22} />}
      <span style={{ fontSize: 12, fontWeight: 700 }}>{file ? 'Added' : label}</span>
    </button>
  );

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 9000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', background: 'rgba(0,0,0,.7)' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 440, maxHeight: '92vh', overflowY: 'auto', background: C.card, borderRadius: '24px 24px 0 0', padding: '20px 20px calc(24px + env(safe-area-inset-bottom,0px))' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0, color: 'white', fontSize: 18 }}>Transfer to Snapsa Wallet</h3>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,.1)', border: 'none', borderRadius: '50%', padding: 7 }}><X size={16} style={{ color: 'white' }} /></button>
        </div>
        <p style={{ color: C.gray, fontSize: 13, margin: '6px 0 14px' }}>1 Snapsa Coin = $0.60. You have <b style={{ color: 'white' }}>{coins}</b> coins. Our team checks every request before money moves.</p>

        {quote?.needsWallet && <p style={{ color: 'white', background: `${C.pink}22`, border: `1px solid ${C.pink}55`, borderRadius: 12, padding: 12, fontSize: 14 }}>You need an approved Snapsa Wallet first. Apply in Snapsa Wallet, then come back.</p>}
        {hasPending && <p style={{ color: '#fbbf24', background: 'rgba(245,158,11,.12)', borderRadius: 12, padding: 12, fontSize: 14 }}>You have a request in review. You can send another once it is decided.</p>}

        <input style={inp} inputMode="numeric" value={amount} onChange={e => setAmount(e.target.value.replace(/\D/g, '').slice(0, 7))} placeholder={`Coins to transfer (min ${quote?.minCoins || 5})`} />
        {n > 0 && quote && <p style={{ color: '#4ade80', fontWeight: 800, margin: '-2px 0 12px' }}>You receive {money(quote.amount, quote.currency)}{bankMode ? ' by bank transfer' : ' in your Snapsa Wallet'}</p>}
        {n > coins && <p style={{ color: '#f87171', fontSize: 13, margin: '-4px 0 10px' }}>You only have {coins} coins.</p>}

        {bankMode && (<>
          <p style={{ color: C.gray, fontSize: 12.5, margin: '0 0 8px' }}>Snapsa Wallet is not available in your country, so we pay into your bank account in USD.</p>
          <input style={inp} value={bank.holder} onChange={e => setBank(b => ({ ...b, holder: e.target.value }))} placeholder="Account holder name" />
          <input style={inp} value={bank.name} onChange={e => setBank(b => ({ ...b, name: e.target.value }))} placeholder="Bank name" />
          <input style={inp} value={bank.account} onChange={e => setBank(b => ({ ...b, account: e.target.value }))} placeholder="Account number / IBAN" />
          <input style={inp} value={bank.branch} onChange={e => setBank(b => ({ ...b, branch: e.target.value }))} placeholder="Branch (optional)" />
          <input style={inp} value={bank.swift} onChange={e => setBank(b => ({ ...b, swift: e.target.value }))} placeholder="SWIFT / BIC (optional)" />
        </>)}

        <p style={{ color: C.gray, fontSize: 11, fontWeight: 800, letterSpacing: 1, margin: '6px 0 8px' }}>PROVE IT'S YOU</p>
        <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
          <Photo label="Photo of your ID" file={idFile} icon={FileText} onClick={() => idRef.current?.click()} />
          <Photo label="Selfie" file={selfie} icon={Camera} onClick={() => selfRef.current?.click()} />
        </div>
        <input ref={idRef} type="file" accept="image/*" capture="environment" hidden onChange={pick(setIdFile)} />
        <input ref={selfRef} type="file" accept="image/*" capture="user" hidden onChange={pick(setSelfie)} />
        <p style={{ color: C.gray, fontSize: 11.5, margin: '0 0 12px' }}>Your ID and selfie are stored privately, only our team can see them, and they are deleted once the request is decided.</p>

        <button onClick={submit} disabled={!ok || busy} style={{ width: '100%', padding: 14, borderRadius: 14, border: 'none', fontWeight: 800, fontSize: 16, color: 'white', background: ok ? 'linear-gradient(135deg,#8b2cf5,#ff2d95)' : 'rgba(255,255,255,.12)', opacity: busy ? .6 : 1 }}>
          {busy ? 'Sending…' : 'Send request'}
        </button>

        {mine && mine.length > 0 && (<>
          <p style={{ color: C.gray, fontSize: 11, fontWeight: 800, letterSpacing: 1, margin: '18px 0 8px' }}>YOUR REQUESTS</p>
          {mine.map(r => (
            <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid rgba(255,255,255,.07)', fontSize: 14, color: 'white' }}>
              <span>{r.coins} coins · {money(r.amount, r.currency)}</span>
              <span style={{ color: STATUS[r.status]?.[1], fontWeight: 700 }}>{STATUS[r.status]?.[0]}</span>
            </div>))}
        </>)}
      </div>
    </div>, document.body);
}
