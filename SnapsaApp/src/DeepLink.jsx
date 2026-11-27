// src/DeepLink.jsx — QR / shared-link handling: opens the app on a profile, or asks people without the app to download it.
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export const SNAPSA_WEB = 'https://snapsat.github.io/Snapsa/';
export const APK_URL = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_APK_URL) || 'https://github.com/snapsat/Snapsa/releases/latest';
export const profileLink = (u) => `${SNAPSA_WEB}?u=${encodeURIComponent(u)}`;
export const isNativeApp = () => { try { return !!window.Capacitor?.isNativePlatform?.(); } catch { return false; } };
const cleanUser = (u) => String(u || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40);

// Username asked for by the link (?u=...) or by the native side (snapsa://profile/<u>)
export const readDeepLinkUser = () => {
  try { const p = new URLSearchParams(window.location.search); const u = cleanUser(p.get('u')); if (u) return u; } catch {}
  return cleanUser(window.__snapsaDeepLink || '');
};
export const clearDeepLinkUrl = () => { try { window.__snapsaDeepLink = ''; const url = new URL(window.location.href); ['u', 'noapp'].forEach(k => url.searchParams.delete(k)); window.history.replaceState(window.history.state, '', url.toString()); } catch {} };

// Calls onOpen(username) once per link, both on start-up and while the app is open
export function useDeepLink(onOpen, ready) {
  useEffect(() => {
    if (!ready || !isNativeApp()) return undefined;
    let last = '';
    const go = (u) => { u = cleanUser(u); if (!u || u === last) return; last = u; setTimeout(() => { last = ''; }, 4000); window.__snapsaDeepLink = ''; onOpen(u); };
    const first = readDeepLinkUser(); if (first) go(first);
    const h = (e) => go(e.detail);
    window.addEventListener('snapsa:deepLink', h);
    return () => window.removeEventListener('snapsa:deepLink', h);
  }, [ready]);
}

// Shown in a normal browser when someone opens a Snapsa QR / profile link
export function DownloadPrompt() {
  const [user] = useState(() => (isNativeApp() ? '' : (() => { try { return cleanUser(new URLSearchParams(window.location.search).get('u')); } catch { return ''; } })()));
  const [open, setOpen] = useState(!!user);
  const android = /android/i.test(navigator.userAgent || '');
  const noapp = (() => { try { return new URLSearchParams(window.location.search).get('noapp') === '1'; } catch { return false; } })();
  const intentUrl = `intent://profile/${encodeURIComponent(user)}#Intent;scheme=snapsa;package=com.snapsa.app;S.browser_fallback_url=${encodeURIComponent(`${SNAPSA_WEB}?u=${encodeURIComponent(user)}&noapp=1`)};end`;
  useEffect(() => { if (open && android && !noapp) { const t = setTimeout(() => { window.location.href = intentUrl; }, 700); return () => clearTimeout(t); } return undefined; }, [open]);
  if (!open || !user) return null;
  const btn = (bg, color = '#fff') => ({ display: 'block', width: '100%', boxSizing: 'border-box', textAlign: 'center', padding: 14, borderRadius: 14, border: 'none', background: bg, color, fontWeight: 800, fontSize: 15, textDecoration: 'none', marginBottom: 10 });
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 100000, background: 'rgba(5,2,12,0.94)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ width: '100%', maxWidth: 380, background: '#150B28', border: '1px solid rgba(180,76,255,0.4)', borderRadius: 24, padding: 24, textAlign: 'center' }}>
        <img src="/SnapsaLogo.png" alt="" width={64} height={64} style={{ borderRadius: 16, marginBottom: 10 }} onError={e => { e.currentTarget.style.display = 'none'; }} />
        <p style={{ color: '#fff', fontWeight: 900, fontSize: 20, margin: '0 0 6px' }}>Connect with @{user}</p>
        <p style={{ color: '#A59BC4', fontSize: 14, lineHeight: 1.5, margin: '0 0 18px' }}>{noapp || !android ? 'Download the Snapsa app to connect with people, watch videos and chat.' : 'Opening Snapsa…'}</p>
        {android && <a href={intentUrl} style={btn('linear-gradient(90deg,#7C3AED,#FF2D95)')}>Open in Snapsa app</a>}
        <a href={APK_URL} style={btn(android ? 'rgba(255,255,255,0.1)' : 'linear-gradient(90deg,#7C3AED,#FF2D95)')}>Download the Snapsa app</a>
        <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', color: '#A59BC4', fontSize: 13, cursor: 'pointer', padding: 6 }}>Continue in browser</button>
      </div>
    </div>, document.body);
}
