// src/native/OfflineSyncPanel.jsx
import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { isNativeApp, getSettings, saveSettings, estimateOptions, syncOffline, cancelSync, listOffline, offlineSummary, clearOffline, getSavedIds, queueSave, flushSaves } from './offlineStore';

const PINK = 'linear-gradient(135deg,#8b2cf5,#ff2d95)';
const CARD = 'linear-gradient(135deg, rgba(72,24,130,.55), rgba(14,6,28,.92))';
const BORDER = 'rgba(180,76,255,0.45)';

// Full-screen player for saved videos (separate from the main feed).
const EMBER = '#ff7a1a';
const SnapsaBadge = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ display:'block', flexShrink:0 }}>
    <path d="M12 2l2.4 1.4 2.7-.4 1.3 2.4 2.4 1.4-.4 2.7L22 12l-1.6 2.5.4 2.7-2.4 1.4-1.3 2.4-2.7-.4L12 22l-2.4-1.4-2.7.4-1.3-2.4-2.4-1.4.4-2.7L2 12l1.6-2.5-.4-2.7 2.4-1.4 1.3-2.4 2.7.4L12 2z" fill="#ff2d95"/>
    <path d="M8.4 12.4l2.4 2.4 4.8-5" stroke="white" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none"/>
  </svg>
);

function OfflineViewer({ onClose, token }) {
  const [items, setItems] = useState(null);
  const [active, setActive] = useState(0);
  const [muted, setMuted] = useState(false);
  const [savedIds, setSavedIds] = useState(new Set());
  const [toast, setToast] = useState('');
  const listRef = useRef(null);
  const videoRefs = useRef({});
  const toastTimer = useRef(null);

  useEffect(() => { listOffline().then(setItems).catch(() => setItems([])); getSavedIds().then(setSavedIds).catch(() => {}); }, []);

  // Tell the app we are in offline mode (nav glows ember, top bar hides). Any nav tap closes us.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('snapsa:offlineMode', { detail: true }));
    const close = () => onClose();
    window.addEventListener('snapsa:closeOffline', close);
    return () => {
      window.removeEventListener('snapsa:closeOffline', close);
      window.dispatchEvent(new CustomEvent('snapsa:offlineMode', { detail: false }));
      clearTimeout(toastTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!items) return;
    items.forEach((v, i) => {
      const el = videoRefs.current[i];
      if (!el) return;
      if (i === active) { el.currentTime = 0; el.play().catch(() => {}); } else { el.pause(); }
    });
  }, [active, items]);

  const onScroll = () => {
    const el = listRef.current; if (!el || !el.clientHeight) return;
    const i = Math.round(el.scrollTop / el.clientHeight);
    if (i !== active) setActive(i);
  };

  const toggle = (i) => { const el = videoRefs.current[i]; if (!el) return; el.paused ? el.play().catch(() => {}) : el.pause(); };
  const flash = (msg) => { setToast(msg); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 2200); };

  const onSave = async (v) => {
    const id = String(v.id || v._id);
    if (savedIds.has(id)) { flash('Already in your saved videos'); return; }
    setSavedIds(new Set([...savedIds, id]));
    try {
      const r = await queueSave(id, token);
      flash(r === 'sent' ? 'Saved. Find it online under Me › Saved' : 'Saved. It will sync when you are online');
    } catch { flash('Saved. It will sync when you are online'); }
  };

  const cur = items && items[active];
  return (
    <div style={{ position:'fixed', top:0, left:0, right:0, bottom:'calc(98px + env(safe-area-inset-bottom, 0px))', zIndex:900, display:'flex', flexDirection:'column', background:'#05020a' }}>
      <div style={{ flexShrink:0, paddingTop:'env(safe-area-inset-top, 0px)', background:'#000' }}>
        <img src="/OfflineHub.png" alt="Snapsa offline" style={{ width:'100%', display:'block', maxHeight:'22vh', objectFit:'cover' }} onError={e => { e.target.style.display = 'none'; }}/>
      </div>
      <div style={{ flexShrink:0, textAlign:'center', padding:'8px 12px 0' }}>
        <div style={{ color:'#ff2d95', fontWeight:800, fontSize:'clamp(14px,4.6vw,20px)', letterSpacing:0.5, textShadow:'0 0 14px rgba(255,45,149,.8)' }}>YOU ARE WATCHING OFFLINE VIDEOS</div>
        {items && items.length > 0 && (
          <div style={{ color:'white', fontFamily:'ui-monospace, Menlo, monospace', fontSize:22, letterSpacing:3, padding:'2px 0 6px' }}>{active + 1}/{items.length}</div>
        )}
      </div>

      <div style={{ flex:1, minHeight:0, position:'relative', margin:'0 6px', borderRadius:16, overflow:'hidden', border:'1px solid rgba(180,76,255,.55)', boxShadow:'0 0 16px rgba(180,76,255,.35)' }}>
        <div ref={listRef} onScroll={onScroll} style={{ height:'100%', overflowY:'scroll', scrollSnapType:'y mandatory', scrollbarWidth:'none' }}>
          {items === null && <p style={{ color:'#aaa', textAlign:'center', paddingTop:'20vh' }}>Loading…</p>}
          {items && items.length === 0 && <p style={{ color:'#aaa', textAlign:'center', paddingTop:'20vh' }}>No offline videos saved yet.</p>}
          {items && items.map((v, i) => (
            <div key={v.id} style={{ height:'100%', scrollSnapAlign:'start', scrollSnapStop:'always', position:'relative', background:'#000' }}>
              <video ref={el => { videoRefs.current[i] = el; }} src={v._localSrc} playsInline loop muted={muted} preload={Math.abs(i - active) <= 1 ? 'auto' : 'none'}
                onClick={() => toggle(i)} style={{ width:'100%', height:'100%', objectFit:'contain', background:'#000' }}/>
              <div style={{ position:'absolute', left:12, right:80, bottom:18, pointerEvents:'none' }}>
                <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                  <div style={{ width:44, height:44, borderRadius:'50%', border:'2px solid white', overflow:'hidden', background:'#ff2d95', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center', color:'white', fontWeight:800 }}>
                    {v.authorAvatarUrl ? <img src={v.authorAvatarUrl} alt="" style={{ width:'100%', height:'100%', objectFit:'cover' }} onError={e => { e.target.style.display = 'none'; }}/> : (v.authorName || 'S')[0].toUpperCase()}
                  </div>
                  <span style={{ color:'#ffd24a', fontWeight:800, fontSize:17, textShadow:'0 0 10px rgba(255,200,60,.6), 0 1px 3px #000' }}>{v.authorName || v.author?.username || 'snapsa'}</span>
                  {(v.authorSnapsaTier || v.authorTier || v.authorVerified) && <SnapsaBadge size={17}/>}
                </div>
                {(v.caption || v.content) && <p style={{ color:'rgba(255,255,255,0.9)', fontSize:13, margin:'6px 0 0', textShadow:'0 1px 3px #000' }}>{v.caption || v.content}</p>}
              </div>
            </div>
          ))}
        </div>

        {/* Only one vertical action: Save (so it can be found online later) */}
        {cur && (
          <button onClick={() => onSave(cur)} aria-label="Save"
            style={{ position:'absolute', right:10, bottom:'22%', width:52, background:'none', border:'none', cursor:'pointer', display:'flex', flexDirection:'column', alignItems:'center', gap:3, color:'white' }}>
            <svg width="34" height="34" viewBox="0 0 24 24" fill={savedIds.has(String(cur.id || cur._id)) ? EMBER : 'none'} stroke={savedIds.has(String(cur.id || cur._id)) ? EMBER : 'white'} strokeWidth="2" strokeLinejoin="round"
              style={{ filter: savedIds.has(String(cur.id || cur._id)) ? 'drop-shadow(0 0 8px rgba(255,110,20,.9))' : 'drop-shadow(0 1px 3px #000)' }}>
              <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.5L5 21V4a1 1 0 0 1 1-1z"/>
            </svg>
            <span style={{ fontSize:11, fontWeight:700, textShadow:'0 1px 3px #000' }}>{savedIds.has(String(cur.id || cur._id)) ? 'Saved' : 'Save'}</span>
          </button>
        )}
        <button onClick={() => setMuted(m => !m)} aria-label="Sound" style={{ position:'absolute', top:10, right:10, width:36, height:36, borderRadius:'50%', border:'none', background:'rgba(0,0,0,0.55)', color:'white', fontSize:16, cursor:'pointer' }}>{muted ? '🔇' : '🔊'}</button>
        {toast && <div style={{ position:'absolute', left:16, right:16, top:14, textAlign:'center', padding:'9px 12px', borderRadius:12, background:'rgba(20,8,36,.92)', border:'1px solid rgba(255,122,26,.7)', color:'white', fontSize:13, fontWeight:700, boxShadow:'0 0 14px rgba(255,100,20,.45)' }}>{toast}</div>}
      </div>
    </div>
  );
}

export default function OfflineSyncPanel({ token }) {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState(null);
  const [settings, setSettings] = useState({ count: 10, wifiOnly: true });
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [status, setStatus] = useState('');
  const [summary, setSummary] = useState({ count: 0, bytes: 0 });
  const [watching, setWatching] = useState(false);

  const refreshSummary = () => offlineSummary().then(setSummary).catch(() => {});

  useEffect(() => { if (isNativeApp) { getSettings().then(setSettings); refreshSummary(); } }, []);

  // Send any videos saved while offline as soon as we have a token / connection.
  useEffect(() => {
    if (!isNativeApp || !token) return;
    flushSaves(token);
    const on = () => flushSaves(token);
    window.addEventListener('online', on);
    return () => window.removeEventListener('online', on);
  }, [token]);

  useEffect(() => {
    if (!open || !token || !isNativeApp) return;
    setOpts(null);
    estimateOptions(token).then(setOpts).catch(() => setOpts([]));
  }, [open, token]);

  if (!isNativeApp) return null;

  const start = async (count) => {
    const next = { ...settings, count };
    setSettings(next); saveSettings(next);
    setOpen(false); setBusy(true); setStatus('Downloading. You can keep using the app.');
    try {
      const r = await syncOffline({ count, wifiOnly: next.wifiOnly, token, onProgress: (done, total) => setProgress({ done, total }) });
      if (r?.cancelled) setStatus('Download stopped.');
      else if (r?.wantedCount === 0) setStatus('The server returned no videos to save yet.');
      else if (r?.interrupted && r.downloaded === 0) setStatus('Connection lost before anything was saved. Try again when you are online.');
      else if (r?.interrupted) setStatus(`Saved ${r.downloaded}, then the connection dropped. Tap download again to continue.`);
      else if (r?.failed && r.downloaded === 0) setStatus('Could not save any video. You have lost connection. Try again in a moment.');
      else if (r?.failed) setStatus(`Saved ${r.downloaded}, ${r.failed} failed. You have lost connection. Tap download again to retry.`);
      else if (r?.downloaded === 0) setStatus('You already have the latest videos. Nothing new to download.');
      else setStatus('Offline videos are ready.');
    } catch (e) {
      setStatus(
        e.message === 'not-wifi' ? 'Waiting for Wi-Fi. Turn off Wi-Fi only to download on mobile data.'
        : e.message === 'offline' ? 'No connection. Try again when you are online.'
        : 'Could not finish the download. Try again later.'
      );
    } finally { setBusy(false); setProgress(null); refreshSummary(); }
  };

  const toggleWifi = () => { const next = { ...settings, wifiOnly: !settings.wifiOnly }; setSettings(next); saveSettings(next); };
  const mb = Math.round(summary.bytes / 1048576);

  return (
    <div style={{ margin:'12px 16px', padding:14, borderRadius:18, background:CARD, border:`1px solid ${BORDER}`, boxShadow:'0 0 16px rgba(180,76,255,.3), inset 0 0 14px rgba(180,76,255,.08)' }}>
      {!token ? (
        <p style={{ color:'#aaa', fontSize:13, margin:0 }}>Sign in to download videos for offline viewing.</p>
      ) : (
        <>
          <button onClick={() => setOpen(o => !o)} disabled={busy}
            style={{ width:'100%', padding:'12px 0', borderRadius:12, border:'none', background:PINK, boxShadow:'0 0 18px rgba(255,45,149,.6)', color:'white', fontWeight:800, letterSpacing:0.5, cursor:'pointer', opacity: busy ? 0.6 : 1 }}>
            DOWNLOAD OFFLINE VIDEOS
          </button>

                    <button onClick={async () => {
              // re-check what is really on the phone, then open the player (or explain why not)
              let s = summary; try { s = await offlineSummary(); setSummary(s); } catch {}
              if (!s.count) { setStatus('Nothing saved yet. Tap DOWNLOAD OFFLINE VIDEOS first, then watch them here.'); return; }
              setWatching(true);
            }}
            style={{ width:'100%', marginTop:8, padding:'12px 0', borderRadius:12, border:`1px solid ${BORDER}`, background:'transparent', color:'white', fontWeight:800, letterSpacing:0.5, cursor:'pointer', opacity: summary.count ? 1 : 0.7 }}>
 
            ▶ WATCH OFFLINE VIDEOS{summary.count ? ` (${summary.count})` : ''}
          </button>
          {summary.count > 0 && (
            <p style={{ color:'#999', fontSize:11, margin:'8px 0 0' }}>
              {summary.count} saved · about {mb} MB on this phone ·{' '}
              <span onClick={async () => { await clearOffline(); setStatus('Offline videos deleted.'); refreshSummary(); }} style={{ color:PINK, cursor:'pointer' }}>Delete all</span>
            </p>
          )}

          {open && !busy && (
            <div style={{ marginTop:12 }}>
              <p style={{ color:'#bbb', fontSize:12, margin:'0 0 8px' }}>Choose how many videos to save. They are picked in random order, and each video is downloaded once.</p>
              {opts === null && <p style={{ color:'#888', fontSize:12 }}>Checking sizes…</p>}
              {opts?.length === 0 && <p style={{ color:'#888', fontSize:12 }}>Could not check sizes. Try again later.</p>}
              {opts?.map(o => (
                <button key={o.count} onClick={() => start(o.count)} disabled={o.available < 1}
                  style={{ display:'flex', justifyContent:'space-between', width:'100%', padding:'10px 12px', marginBottom:6, borderRadius:10, border:`1px solid ${BORDER}`, background:'transparent', color:'white', fontSize:13, cursor:'pointer' }}>
                  <span>{o.count} videos</span><span style={{ color:'#ddd' }}>~{o.mb} MB</span>
                </button>
              ))}
              <label style={{ display:'flex', alignItems:'center', gap:8, color:'#ddd', fontSize:13, marginTop:8 }}>
                <input type="checkbox" checked={settings.wifiOnly} onChange={toggleWifi}/>
                Wi-Fi only (recommended)
              </label>
            </div>
          )}

          {progress && (
            <div style={{ marginTop:10 }}>
              <div style={{ height:6, borderRadius:3, background:'rgba(255,255,255,0.12)', overflow:'hidden' }}>
                <div style={{ width:`${progress.total ? (progress.done / progress.total) * 100 : 0}%`, height:'100%', background:PINK, transition:'width .3s' }}/>
              </div>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginTop:6 }}>
                <span style={{ color:'#ddd', fontSize:12 }}>Saving {progress.done} of {progress.total}</span>
                <span onClick={cancelSync} style={{ color:PINK, fontSize:12, cursor:'pointer', fontWeight:700 }}>Stop</span>
              </div>
            </div>
          )}
          {status && <p style={{ color:'#aaa', fontSize:12, margin:'8px 0 0' }}>{status}</p>}
        </>
      )}
            {/* Portal: a position:fixed player inside a transformed/clipped parent would stay hidden */}
      {watching && createPortal(<OfflineViewer token={token} onClose={() => { setWatching(false); refreshSummary(); }} />, document.body)}

    </div>
  );
}
