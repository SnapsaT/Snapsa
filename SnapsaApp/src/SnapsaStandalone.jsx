// src/SnapsaStandalone.jsx
// ─────────────────────────────────────────────────────────────────────
// Top-level component for the STANDALONE Snapsa Render service.
//
// Flow:
//   1. Show SnapsaEntry (seed login screen)
//   2. SnapsaEntry calls WernTjat backend ZK endpoints
//   3. On success → render full SnapsaApp with the returned user + token
//
// This file has ZERO dependency on WernTjat.jsx, AuthProvider, 
// BiometricGateway, or React Router.  It is intentionally thin.
// ─────────────────────────────────────────────────────────────────────

import React, { useState, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { SnapsaEntry } from './SnapsaEntry';
import { SnapsaApp, warmFeedCache } from './SnapsaApp';

// ─── Persist session across hard-refreshes (localStorage only) ───────
const SESSION_KEY = 'snapsa_standalone_session';

const loadPersistedSession = () => {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    // Honour token TTL if the server included one (exp claim)
    if (session.expiresAt && Date.now() > session.expiresAt) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return session; // { user, token, expiresAt? }
  } catch {
    return null;
  }
};

const persistSession = (user, token) => {
  try {
    // Attempt to read exp from JWT payload for TTL — graceful fallback
    let expiresAt = null;
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      if (payload.exp) expiresAt = payload.exp * 1000;
    } catch { /* non-JWT or opaque token — no TTL */ }

    localStorage.setItem(SESSION_KEY, JSON.stringify({ user, token, expiresAt }));
    // Mirror to localStorage keys SnapsaApp / snapFetch already read
    localStorage.setItem('authToken',    token);
    localStorage.setItem('wt_auth_token', token);
    localStorage.setItem('token',        token);
  } catch { /* storage quota / private mode */ }
};

const clearSession = () => {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem('authToken');
  localStorage.removeItem('wt_auth_token');
  localStorage.removeItem('token');
};

// ─────────────────────────────────────────────────────────────────────
export default function SnapsaStandalone() {
  // Restore session from localStorage on mount. Fired inside the useState
  // initializer (not a useEffect) so it runs synchronously during the very
  // first render — before SnapsaApp/FeedScreen exist at all — giving the
  // feed request a head start instead of waiting for the component tree to
  // finish mounting first.
  const [session, setSession] = useState(() => {
    const restored = loadPersistedSession();
    if (restored?.token) warmFeedCache(restored.token);
    return restored;
  });

  // When the user authenticates via SnapsaEntry
  const handleAuthenticated = (user, token) => {
    persistSession(user, token);
    warmFeedCache(token); // same head start for a fresh login
    setSession({ user, token });
  };

  // Sign-out handler — exposed to SnapsaApp via the WernTjat back button
  // (onClose in SnapsaApp).  On standalone we treat "close" as sign-out.
  const handleSignOut = () => {
    clearSession();
    setSession(null);
  };

  // Re-check session validity whenever the tab regains focus
  useEffect(() => {
    const onFocus = () => {
      const persisted = loadPersistedSession();
      if (!persisted) setSession(null);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  return (
    // Full-screen host — identical dimensions to WernTjat's shell
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden', width: '100%', height: '100%', background: '#0B0B14' }}>
      <AnimatePresence mode="wait">
        {!session ? (
          // ── Auth gate ──────────────────────────────────────────────
          <motion.div
            key="entry"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            style={{ position: 'absolute', inset: 0 }}
          >
            <SnapsaEntry
              onAuthenticated={handleAuthenticated}
              // No onBack — standalone has nowhere to go back to
            />
          </motion.div>
        ) : (
          // ── Full Snapsa app ────────────────────────────────────────
          <motion.div
            key="app"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            style={{ position: 'absolute', inset: 0 }}
          >
            <SnapsaApp
              // Pass the same props WernTjat.jsx passes when embedded
              currentUser={buildCurrentUser(session.user)}
              userData={session.user}
              authToken={session.token}
              followers={session.user?.followers  ?? []}
              following={session.user?.following  ?? []}
              timeline={[]}
              showToast={standaloneToast}
              // "Close" on standalone = sign out
              onClose={handleSignOut}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Normalise the user object returned by the WernTjat backend into the
 * shape SnapsaApp / VideoCard / OwnProfileScreen expects.
 */
function buildCurrentUser(raw) {
  if (!raw) return null;
  return {
    // Identity fields
    _id:               raw._id   || raw.userId || '',
    id:                raw._id   || raw.userId || '',
    name:              raw.fullName  || raw.name        || raw.displayName || '',
    fullName:          raw.fullName  || raw.name        || '',
    firstName:         raw.firstName || (raw.fullName || '').split(' ')[0] || '',
    lastName:          raw.lastName  || (raw.fullName || '').split(' ').slice(1).join(' ') || '',
    displayName:       raw.displayName || raw.fullName || raw.name || '',

    // Avatar / photo — SnapsaApp checks photoURL and photo
    photoURL:          raw.identityPic || raw.photoURL || raw.photo || null,
    photo:             raw.identityPic || raw.photoURL || raw.photo || null,
    identityPic:       raw.identityPic || raw.photoURL || raw.photo || null,

    // ZK / security
    zkCommitment:      raw.zkCommitment      || '',
    encryptedIdentity: raw.encryptedIdentity || null,

    // Subscription / tier
    subscriptionTier:  raw.subscriptionTier  || raw.tier || '',
    tier:              raw.tier              || raw.subscriptionTier || '',

    // Social
    followers:         raw.followers  ?? [],
    following:         raw.following  ?? [],

    // Pass-through everything else the server sent
    ...raw,
  };
}

/**
 * Lightweight toast shim — SnapsaApp calls showToast(msg, type).
 * On standalone we use the browser's notification API for non-critical
 * messages and fall back to console.  You can swap this for Sonner or
 * react-hot-toast if you add it to the standalone bundle.
 */
function standaloneToast(message, type = 'info') {
  // Mirror to console so developers see it
  const log = type === 'error' ? console.error
            : type === 'warning' ? console.warn
            : console.info;
  log(`[Snapsa ${type}]`, message);

  // Visual: inject a tiny transient banner into the DOM
  const id = `snapsa-toast-${Date.now()}`;
  const colours = {
    success: { bg: '#14532d', border: '#4ade80', text: '#bbf7d0' },
    error:   { bg: '#7f1d1d', border: '#f87171', text: '#fecaca' },
    warning: { bg: '#713f12', border: '#fbbf24', text: '#fef3c7' },
    info:    { bg: '#1e3a5f', border: '#60a5fa', text: '#bfdbfe' },
  };
  const c = colours[type] || colours.info;

  const el = document.createElement('div');
  el.id = id;
  el.style.cssText = `
    position:fixed;top:20px;left:50%;transform:translateX(-50%);
    z-index:99999;padding:10px 20px;border-radius:12px;
    background:${c.bg};border:1px solid ${c.border};color:${c.text};
    font-size:14px;font-weight:600;font-family:system-ui,sans-serif;
    box-shadow:0 4px 24px rgba(0,0,0,0.5);
    animation:snapsaToastIn .25s ease;pointer-events:none;
    max-width:90vw;text-align:center;
  `;
  el.textContent = message;

  if (!document.getElementById('snapsa-toast-style')) {
    const style = document.createElement('style');
    style.id = 'snapsa-toast-style';
    style.textContent = `
      @keyframes snapsaToastIn {
        from { opacity:0; transform:translateX(-50%) translateY(-10px); }
        to   { opacity:1; transform:translateX(-50%) translateY(0); }
      }
    `;
    document.head.appendChild(style);
  }

  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
