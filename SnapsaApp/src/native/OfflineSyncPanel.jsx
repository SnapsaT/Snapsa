// src/native/OfflineSyncPanel.jsx
import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { isNativeApp, getSettings, saveSettings, estimateOptions, syncOffline, cancelSync, listOffline, offlineSummary, clearOffline } from './offlineStore';

const PINK = '#ff2a5f';
const CARD = 'rgba(255,255,255,0.06)';
const BORDER = 'rgba(255,255,255,0.15)';

// Full-screen player for saved videos (separate from the main feed).
function OfflineViewer({ onClose }) {
  const [items, setItems] = useState(null);
  const [active, setActive] = useState(0);
  const [muted, setMuted] = useState(false);
  const listRef = useRef(null);
  const videoRefs = useRef({});

  useEffect(() => { listOffline().then(setItems).catch(() => setItems([])); }, []);

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

  return (
    <div style={{ position:'fixed', inset:0, zIndex:900, background:'#000' }}>
      <div ref={listRef} onScroll={onScroll} style={{ height:'100%', overflowY:'scroll', scrollSnapType:'y mandatory' }}>
        {items === null && <p style={{ color:'#aaa', textAlign:'center', paddingTop:'45vh' }}>Loading…</p>}
        {items && items.length === 0 && <p style={{ color:'#aaa', textAlign:'center', paddingTop:'45vh' }}>No offline videos saved yet.</p>}
        {items && items.map((v, i) => (
          <div key={v.id} style={{ height:'100%', scrollSnapAlign:'start', scrollSnapStop:'always', position:'relative', background:'#000' }}>
            <video ref={el => { videoRefs.current[i] = el; }} src={v._localSrc} playsInline loop muted={muted} preload={Math.abs(i - active) <= 1 ? 'auto' : 'none'}
              onClick={() => toggle(i)} style={{ width:'100%', height:'100%', objectFit:'contain', background:'#000' }}/>
            <div style={{ position:'absolute', left:16, right:16, bottom:40, pointerEvents:'none' }}>
              <p style={{ color:'white', fontWeight:800, fontSize:15, margin:0 }}>@{v.authorName || v.author?.username || 'snapsa'}</p>
              {(v.caption || v.content) && <p style={{ color:'rgba(255,255,255,0.85)', fontSize:13, margin:'4px 0 0' }}>{v.caption || v.content}</p>}
            </div>
          </div>
        ))}
      </div>
      <button onClick={onClose} style={{ position:'absolute', top:40, left:16, width:40, height:40, borderRadius:'50%', border:'none', background:'rgba(0,0,0,0.6)', color:'white', fontSize:20, cursor:'pointer' }}>✕</button>
      <button onClick={() => setMuted(m => !m)} style={{ position:'absolute', top:40, right:16, width:40, height:40, borderRadius:'50%', border:'none', background:'rgba(0,0,0,0.6)', color:'white', fontSize:18, cursor:'pointer' }}>{muted ? '🔇' : '🔊'}</button>
      {items && items.length > 0 && (
        <div style={{ position:'absolute', top:48, left:0, right:0, textAlign:'center', color:'rgba(255,255,255,0.7)', fontSize:12, pointerEvents:'none' }}>{active + 1} / {items.length}</div>
      )}
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
      else if (r?.failed && r.downloaded === 0) setStatus(`Could not save any video. ${r.lastError || ''}`);
      else if (r?.failed) setStatus(`Saved ${r.downloaded}, ${r.failed} failed. ${r.lastError || ''}`);
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
    <div style={{ margin:'12px 16px', padding:14, borderRadius:14, background:CARD, border:`1px solid ${BORDER}` }}>
      {!token ? (
        <p style={{ color:'#aaa', fontSize:13, margin:0 }}>Sign in to download videos for offline viewing.</p>
      ) : (
        <>
          <button onClick={() => setOpen(o => !o)} disabled={busy}
            style={{ width:'100%', padding:'12px 0', borderRadius:12, border:'none', background:PINK, color:'white', fontWeight:800, letterSpacing:0.5, cursor:'pointer', opacity: busy ? 0.6 : 1 }}>
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
              <p style={{ color:'#bbb', fontSize:12, margin:'0 0 8px' }}>Choose how many of the newest videos to save. Each video is downloaded once.</p>
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
      {watching && createPortal(<OfflineViewer onClose={() => { setWatching(false); refreshSummary(); }} />, document.body)}

    </div>
  );
}
