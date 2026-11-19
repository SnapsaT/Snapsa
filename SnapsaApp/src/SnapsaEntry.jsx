// src/SnapsaEntry.jsx

import React, { useState, useRef, useEffect, useCallback, createContext, useContext } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Eye, EyeOff, ArrowRight, Shield, RefreshCw,
  CheckCircle, AlertCircle, ChevronDown, ChevronUp,
  Lock, Fingerprint, Zap, KeyRound, LogIn, X, Users,
  Camera, User as UserIcon, AtSign, Copy, Check, Download, Upload,
} from 'lucide-react';
import init, { create_secure_identity, encrypt_display_field, encrypt_display_blob,
         keypair, generate_login_proof, verify_identity_proof, get_commitment,
} from './ironclad_security';
import { api } from './api';
import { saveSeedFile } from './native/seedSave';


// ─── Brand tokens ─────────────────────────────────────────────────────
const C = {
  pink:   '#FF2055',
  yellow: '#FFD600',
  dark:   '#0B0B14',
  card:   '#14141F',
  border: '#1E1E2E',
  gray:   '#8888A0',
  purple: '#7C3AED',
  green:  '#4ade80',
};

// ─── Auth Wall Context ─────────────────────────────────────────────────
export const AuthWallCtx = createContext(null);
export const useAuthWall = () => useContext(AuthWallCtx);

// ─── Seed validation ──────────────────────────────────────────────────
const normaliseSeed = (raw) => raw.replace(/\s/g, '');
const seedIsValid   = (s)   => normaliseSeed(s).length === 64;

// ─── Auth seed generation
const ZK_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*()_+-=[]{}|;:,.<>?';
const ZK_RECOVERY_LENGTH = 64;
function generateValidRecoveryString() {
  if (typeof crypto === 'undefined' || !crypto.getRandomValues) throw new Error('Secure random not available');
  const limit = Math.floor(256 / ZK_CHARSET.length) * ZK_CHARSET.length;
  const out = [];
  while (out.length < ZK_RECOVERY_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(ZK_RECOVERY_LENGTH * 2));
    for (const byte of bytes) {
      if (out.length >= ZK_RECOVERY_LENGTH) break;
      if (byte < limit) out.push(ZK_CHARSET[byte % ZK_CHARSET.length]);
    }
  }
  return out.join('');
}
function toHex(bytes) {
  if (!bytes) return '';
  return Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function normalizeAvatarFile(file) {
  
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (bitmapErr) {
    console.warn('[normalizeAvatarFile] createImageBitmap failed, falling back to <img> decode:', bitmapErr?.message);
    const objectUrl = URL.createObjectURL(file);
    try {
      bitmap = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('This photo could not be read — try a different one'));
        img.src = objectUrl;
      });
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  const naturalWidth = bitmap.width ?? bitmap.naturalWidth;
  const naturalHeight = bitmap.height ?? bitmap.naturalHeight;

  const size = 256;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  const scale = Math.max(size / naturalWidth, size / naturalHeight);
  const w = naturalWidth * scale, h = naturalHeight * scale;
  ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h);
  return new Promise((resolve, reject) => c.toBlob(async b => {
    if (!b) { reject(new Error('This photo could not be processed — try a different one')); return; }
    const bytes = new Uint8Array(await b.arrayBuffer());
    const dataUrl = c.toDataURL('image/jpeg', 0.85);
    resolve({ bytes, dataUrl });
  }, 'image/jpeg', 0.85));
}

const SNAP_URL = import.meta?.env?.VITE_SNAP_URL || 'https://snapsaserver.onrender.com';
const SNAPSA_OWN_TOKEN_KEY = 'snapsa_own_token';
const SNAPSA_LOGGED_OUT_FLAG = 'snapsa_logged_out';
const persistOwnSession = (token) => {
  try {
    localStorage.setItem(SNAPSA_OWN_TOKEN_KEY, token);
    localStorage.removeItem(SNAPSA_LOGGED_OUT_FLAG);
  } catch {}
};

// ─── Sub-components ───────────────────────────────────────────────────
const SnapsaMark = ({ size = 72 }) => (
  <div style={{ position: 'relative', width: size, height: size }}>
    <motion.div
      animate={{ rotate: [0, 8, -8, 0] }}
      transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
      style={{ width: size, height: size }}
    >
      <img
        src="/SnapsaLogo.png" alt="Snapsa"
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover' }}
        onError={e => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'flex'; }}
      />
      <div style={{
        display: 'none', width: size, height: size, borderRadius: '50%',
        background: `linear-gradient(135deg, ${C.pink}, ${C.purple})`,
        alignItems: 'center', justifyContent: 'center',
        fontWeight: 900, fontSize: size * 0.38, color: 'white',
      }}>S</div>
    </motion.div>
    <motion.div
      animate={{ scale: [1, 1.3, 1], opacity: [0.5, 0, 0.5] }}
      transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
      style={{ position: 'absolute', inset: -6, borderRadius: '50%', border: `2px solid ${C.pink}`, pointerEvents: 'none' }}
    />
  </div>
);

const StepDots = ({ total, current }) => (
  <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
    {Array.from({ length: total }).map((_, i) => (
      <motion.div key={i}
        animate={{ width: i === current ? 24 : 6, background: i <= current ? C.pink : C.border }}
        transition={{ duration: 0.3 }}
        style={{ height: 6, borderRadius: 99 }}
      />
    ))}
  </div>
);

// ─── Native Snapsa identity creation ───────────────────────────────────

const SnapsaSignupForm = ({ onBack, onCreated, showToast }) => {
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [bio, setBio] = useState('');
  const [avatarFile, setAvatarFile] = useState(null);
  const [avatarPreview, setAvatarPreview] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [stage, setStage] = useState('');
  const [recoverySeed, setRecoverySeed] = useState(null);
    const [seedCopied, setSeedCopied] = useState(false);
  const [seedFileMsg, setSeedFileMsg] = useState('');

  const fileRef = useRef(null);

  const pickAvatar = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setAvatarFile(f);
    setAvatarPreview(URL.createObjectURL(f));
  };

  const handleCreate = async () => {
    if (!fullName.trim()) { setError('Full name is required'); return; }
    const cleanUsername = username.trim().toLowerCase();
    if (!/^[a-z0-9_.]{3,30}$/.test(cleanUsername)) { setError('Username must be 3-30 characters (a-z, 0-9, _, .)'); return; }
    if (!avatarFile) { setError('A profile picture is required'); return; }
    if (submitting) return;

    setError(null);
    setSubmitting(true);
    try {
      setStage('🔐 Initializing security engine…');
      await init();

      setStage('🎲 Generating recovery seed…');
      const seed = generateValidRecoveryString();

      setStage('🔐 Encrypting your identity…');
      const identityData = {
        fullName: fullName.trim(),
        username: cleanUsername,
        bio: bio.trim(),
        id_version: '1.0-ZT',
        created_at: Date.now(),
      };

      const displayNameResult = encrypt_display_field(fullName.trim());
      if (!displayNameResult?.ciphertext || !displayNameResult?.iv) throw new Error('DISPLAY_NAME_ENCRYPTION_FAILED');

      setStage('🖼️ Encrypting your picture…');
      const { bytes: avatarBytes, dataUrl: avatarDataUrl } = await normalizeAvatarFile(avatarFile);
      const avatarEnc = encrypt_display_blob(avatarBytes);
      if (!avatarEnc?.ciphertext || !avatarEnc?.iv) throw new Error('AVATAR_ENCRYPTION_FAILED');

      setStage('⏳ Generating zero-knowledge proof…');
      let zkResult;
      try {
        zkResult = create_secure_identity(seed, JSON.stringify(identityData));
      } catch {
        zkResult = create_secure_identity(seed, JSON.stringify(identityData), new Uint8Array(0));
      }
      if (!zkResult?.proof || !zkResult?.encrypted_blob || !zkResult?.salt || !zkResult?.iv) {
        throw new Error('RECOVERY_GEN_FAILED: WASM returned an incomplete result');
      }

      const hex = typeof zkResult.bytes_to_hex === 'function' ? zkResult.bytes_to_hex : toHex;

      setStage('🔒 Creating your Snapsa identity…');
      const res = await fetch(`${SNAP_URL}/snapsa/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: cleanUsername,
          bio: bio.trim(),
          avatarDataUrl,
          encryptedIdentity: hex(zkResult.encrypted_blob),
          identitySalt: hex(zkResult.salt),
          identityIv: hex(zkResult.iv),
          zkCommitment: hex(zkResult.commitment),
          setupProof: hex(zkResult.proof),
          circuitVersion: '1.0-ZT',
          displayNameEncrypted: hex(displayNameResult.ciphertext),
          displayNameIv: hex(displayNameResult.iv),
          avatarEncrypted: hex(avatarEnc.ciphertext),
          avatarIv: hex(avatarEnc.iv),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not create your identity');
      setRecoverySeed(seed);
      setStage('');
      window.__pendingSnapsaLogin = { token: data.token, user: data.user };
    } catch (err) {
      console.error('[SnapsaSignup] error:', err);
      setError(err.message || 'Could not create your identity');
      setStage('');
    } finally {
      setSubmitting(false);
    }
  };

  if (recoverySeed) {
    return (
      <motion.div key="seed-reveal" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
        style={{ width: '100%', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: `${C.green}22`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <KeyRound size={18} style={{ color: C.green }} />
          </div>
          <h2 style={{ color: 'white', fontWeight: 800, fontSize: 20, margin: 0 }}>Save your seed</h2>
        </div>
        <p style={{ color: C.gray, fontSize: 13, lineHeight: 1.55, marginBottom: 16 }}>
          This is the only way back into your identity. Snapsa never stores it and can never
          show it to you again, recover it, or reset it if it's lost. write it down or store
          it somewhere safe.
        </p>
        <div style={{
          padding: '16px 14px', borderRadius: 12, background: 'rgba(255,255,255,0.05)',
          border: `1.5px solid ${C.pink}55`, fontFamily: 'monospace', fontSize: 13,
          color: 'white', lineHeight: 1.7, wordBreak: 'break-all', marginBottom: 12,
        }}>
          {recoverySeed}
        </div>
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 8, padding: '11px 14px', borderRadius: 12,
          marginBottom: 14, background: `${C.yellow}14`, border: `1px solid ${C.yellow}40`,
        }}>
          <AlertCircle size={15} style={{ color: C.yellow, flexShrink: 0, marginTop: 1 }} />
          <span style={{ color: 'rgba(255,255,255,0.75)', fontSize: 12, lineHeight: 1.5 }}>
            The downloaded file is a plain, unencrypted text file. Anyone who
            gets access to this file, can access your account. Once it leaves
            Snapsa, keeping it safe is entirely your responsibility.
          </span>
        </div>
        <button onClick={async () => {
          await navigator.clipboard.writeText(recoverySeed);
          setSeedCopied(true);
          setTimeout(() => setSeedCopied(false), 2000);
        }} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          width: '100%', padding: '12px 0', borderRadius: 12, marginBottom: 10,
          border: `1px solid ${C.border}`, background: 'rgba(255,255,255,0.04)',
          color: seedCopied ? C.green : 'rgba(255,255,255,0.7)', fontWeight: 700, fontSize: 13, cursor: 'pointer',
        }}>
          {seedCopied ? <><Check size={15}/> Copied</> : <><Copy size={15}/> Copy seed</>}
        </button>
        <button onClick={async () => {
          const ack = window.confirm(
            'This file will contain your seed as plain, unencrypted text. ' +
            'Anyone with access to this file, ' +
            'can access your account. Snapsa is not responsible for the security of files ' +
            'once they leave the app.'
          );
          if (!ack) return;
                    try {
            const r = await saveSeedFile(`snapsa-seed-${(username || 'account').toLowerCase()}.txt`, recoverySeed);
            setSeedFileMsg(r.saved ? `✓ Saved to ${r.where}` : r.copied ? 'Could not save a file — your seed was copied instead. Paste it somewhere safe.' : 'Could not save the file. Please use Copy seed.');
          } catch {
            setSeedFileMsg('Could not save the file. Please use Copy seed.');
          }
          setTimeout(() => setSeedFileMsg(''), 8000);
        }} style={{

          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          width: '100%', padding: '12px 0', borderRadius: 12, marginBottom: 20,
          border: `1px solid ${C.border}`, background: 'rgba(255,255,255,0.04)',
          color: 'rgba(255,255,255,0.7)', fontWeight: 700, fontSize: 13, cursor: 'pointer',
        }}>
                    <Download size={15}/> Download Auth Seed
        </button>
        {seedFileMsg && <div style={{ marginTop: -12, marginBottom: 16, fontSize: 12, textAlign: 'center', color: seedFileMsg.startsWith('✓') ? C.green : C.yellow }}>{seedFileMsg}</div>}

        <motion.button whileTap={{ scale: 0.97 }} onClick={() => {
          const pending = window.__pendingSnapsaLogin;
          window.__pendingSnapsaLogin = null;
          onCreated?.(pending?.user, pending?.token);
        }} style={{
          width: '100%', padding: '15px 0', borderRadius: 14, border: 'none', cursor: 'pointer',
          background: `linear-gradient(135deg, ${C.pink}, #FF5C7A)`, color: 'white', fontWeight: 800, fontSize: 15,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
        }}>
          Enter Snapsa <ArrowRight size={16} />
        </motion.button>
      </motion.div>
    );
  }

  return (
    <motion.div key="snapsa-signup" initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -40 }}
      style={{ width: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 22 }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.gray, fontSize: 13, padding: 0 }}>← Back</button>
        <span style={{ color: C.gray, fontSize: 12, fontWeight: 700 }}>Create Snapsa Identity</span>
        <div style={{ width: 48 }} />
      </div>

      {/* Avatar picker */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 18 }}>
        <button onClick={() => fileRef.current?.click()} style={{
          width: 88, height: 88, borderRadius: '50%', border: `2px dashed ${avatarPreview ? C.pink : C.border}`,
          background: avatarPreview ? `url(${avatarPreview}) center/cover` : 'rgba(255,255,255,0.05)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', position: 'relative',
        }}>
          {!avatarPreview && <Camera size={26} style={{ color: C.gray }} />}
          <div style={{ position: 'absolute', bottom: -2, right: -2, width: 28, height: 28, borderRadius: '50%', background: C.pink, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `2px solid ${C.dark}` }}>
            <Camera size={13} style={{ color: 'white' }} />
          </div>
        </button>
        <input ref={fileRef} type="file" accept="image/*" onChange={pickAvatar} style={{ display: 'none' }} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 6 }}>
        <div style={{ position: 'relative' }}>
          <UserIcon size={16} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: C.gray }}/>
          <input value={fullName} onChange={e => setFullName(e.target.value.slice(0, 60))} placeholder="Full name"
            style={{ width: '100%', boxSizing: 'border-box', padding: '13px 14px 13px 40px', background: 'rgba(255,255,255,0.05)', border: `1.5px solid ${C.border}`, borderRadius: 12, color: 'white', fontSize: 14, outline: 'none' }} />
        </div>
        <div style={{ position: 'relative' }}>
          <AtSign size={16} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: C.gray }}/>
          <input value={username} onChange={e => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 30))} placeholder="username"
            style={{ width: '100%', boxSizing: 'border-box', padding: '13px 14px 13px 40px', background: 'rgba(255,255,255,0.05)', border: `1.5px solid ${C.border}`, borderRadius: 12, color: 'white', fontSize: 14, outline: 'none' }} />
        </div>
        <textarea value={bio} onChange={e => setBio(e.target.value.slice(0, 150))} placeholder="Biography" rows={3}
          style={{ width: '100%', boxSizing: 'border-box', padding: '13px 14px', background: 'rgba(255,255,255,0.05)', border: `1.5px solid ${C.border}`, borderRadius: 12, color: 'white', fontSize: 14, outline: 'none', resize: 'none', fontFamily: 'inherit' }} />
      </div>

      <AnimatePresence>
        {error && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '11px 14px', borderRadius: 12, marginTop: 8, background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)' }}>
            <AlertCircle size={15} style={{ color: '#f87171', flexShrink: 0, marginTop: 1 }} />
            <span style={{ color: '#f87171', fontSize: 13, lineHeight: 1.45 }}>{error}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 14px', borderRadius: 12, marginTop: 12, background: 'rgba(124,58,237,0.1)', border: `1px solid ${C.purple}33` }}>
        <Shield size={14} style={{ color: C.purple, flexShrink: 0, marginTop: 2 }} />
        <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, lineHeight: 1.5 }}>
          All your personal data are encrypted before reaching the SNAPSA server.
        </span>
      </div>

      <motion.button whileTap={{ scale: 0.97 }} onClick={handleCreate} disabled={submitting} style={{
        width: '100%', padding: '15px 0', marginTop: 18, borderRadius: 14, border: 'none',
        cursor: submitting ? 'default' : 'pointer',
        background: submitting ? 'rgba(255,255,255,0.07)' : `linear-gradient(135deg, ${C.pink}, #FF5C7A)`,
        color: submitting ? C.gray : 'white', fontWeight: 800, fontSize: 15,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
      }}>
        {submitting ? <><RefreshCw size={16} style={{ animation: 'spin 0.8s linear infinite' }} /> {stage || 'Creating…'}</> : <>Create Identity <ArrowRight size={16} /></>}
      </motion.button>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
    </motion.div>
  );
};

// ─── Auth Wall Bottom Sheet ────────────────────────────────────────────
// Slides up when a guest taps a gated action (like, save, post, follow…)
const AuthWallSheet = ({ reason, onClose, onGoLogin }) => {
  const REASONS = {
    like:    { emoji: '❤️', title: 'Like videos',      body: 'Sign in to like and react to content.' },
    comment: { emoji: '💬', title: 'Comment',          body: 'Sign in to join the conversation.' },
    save:    { emoji: '🔖', title: 'Save videos',      body: 'Sign in to build your saved collection.' },
    share:   { emoji: '📤', title: 'Share',            body: 'Sign in to share videos with friends.' },
    follow:  { emoji: '➕', title: 'Follow creators',  body: 'Sign in to follow and support creators.' },
    post:    { emoji: '🎬', title: 'Post a video',     body: 'Sign in to share your own content.' },
    default: { emoji: '🔐', title: 'Sign in to Snapsa', body: 'Sign in with your Snapsa identity.' },
  };
  const r = REASONS[reason] || REASONS.default;

  return (
    <>
      <motion.div
        key="wall-backdrop"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
      />
      <motion.div
        key="wall-sheet"
        initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 28, stiffness: 280 }}
        style={{
          position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 301,
          background: C.card, borderTopLeftRadius: 28, borderTopRightRadius: 28,
          padding: '12px 24px 48px',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Handle */}
        <div style={{ width: 40, height: 4, borderRadius: 99, background: C.border, margin: '0 auto 20px' }} />

        {/* Close */}
        <button onClick={onClose} style={{ position: 'absolute', top: 18, right: 20, background: 'none', border: 'none', cursor: 'pointer' }}>
          <X size={20} style={{ color: C.gray }} />
        </button>

        {/* Branding */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 24 }}>
          <SnapsaMark size={36} />
          <span style={{ fontWeight: 900, fontSize: 20, color: 'white', letterSpacing: '-0.5px' }}>Snapsa</span>
        </div>

        {/* Reason */}
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: 40, marginBottom: 10 }}>{r.emoji}</div>
          <h2 style={{ color: 'white', fontWeight: 800, fontSize: 20, marginBottom: 6 }}>{r.title}</h2>
          <p style={{ color: C.gray, fontSize: 14, lineHeight: 1.5 }}>{r.body}</p>
        </div>

        {/* Sign in CTA */}
        <motion.button
          whileTap={{ scale: 0.97 }} onClick={onGoLogin}
          style={{
            width: '100%', padding: '15px 0', borderRadius: 14, border: 'none', cursor: 'pointer',
            background: `linear-gradient(135deg,${C.pink},#FF5C7A)`,
            color: 'white', fontWeight: 800, fontSize: 15,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            boxShadow: `0 6px 28px ${C.pink}44`, marginBottom: 12,
          }}
        >
          <LogIn size={17} /> Sign in with Snapsa Seed
        </motion.button>

        <button onClick={onClose} style={{
          width: '100%', padding: '13px 0', borderRadius: 14,
          border: `1px solid ${C.border}`, background: 'transparent',
          color: C.gray, fontWeight: 600, fontSize: 14, cursor: 'pointer',
        }}>
          Keep browsing as guest
        </button>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 20 }}>
          <img src="/WernTjatLogo1.jpg" alt="" style={{ width: 14, height: 14, borderRadius: '50%', opacity: 0.4 }} onError={e => e.target.style.display = 'none'} />
          <span style={{ color: 'rgba(255,255,255,0.2)', fontSize: 11 }}>Powered by Snapsa Technologies</span>
        </div>
      </motion.div>
    </>
  );
};

// ─── Guest Feed Shell ──────────────────────────────────────────────────
class GuestErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { err: null };
  }
  static getDerivedStateFromError(err) {
    return { err };
  }
  componentDidCatch(err, info) {
    console.error('[GuestFeed]', err, info);
  }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{ position: 'fixed', inset: 0, background: '#0B0B14', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24, textAlign: 'center' }}>
        <p style={{ color: 'white', fontWeight: 700, fontSize: 16 }}>The guest feed hit an error.</p>
        <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12, wordBreak: 'break-word' }}>
          {String(this.state.err?.message || this.state.err)}
        </p>
        <button onClick={() => this.props.onGoLogin?.()} style={{ padding: '12px 24px', borderRadius: 999, border: 'none', background: '#ff2a5f', color: 'white', fontWeight: 700, cursor: 'pointer' }}>
          Sign in
        </button>
      </div>
    );
  }
}

const GuestFeedShell = ({ onGoLogin, triggerAuthWall }) => {
  
  const [SnapsaApp, setSnapsaApp] = useState(null);

  useEffect(() => {
    import('./SnapsaApp').then(m => setSnapsaApp(() => m.SnapsaApp || m.default));
  }, []);

  useEffect(() => {
    const h = () => triggerAuthWall?.('feature');
    window.addEventListener('snapsa:requestAuth', h);
    return () => window.removeEventListener('snapsa:requestAuth', h);
  }, [onGoLogin]);

  const guestUser = {
    _id: null, id: null, name: 'Guest', fullName: 'Guest',
    firstName: 'Guest', photoURL: null, photo: null,
    subscriptionTier: '', tier: '', followers: [], following: [],
    isGuest: true,
  };

  if (!SnapsaApp) return (
    <div style={{ position: 'fixed', inset: 0, background: C.dark, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 14 }}>
      <SnapsaMark size={64} />
      <p style={{ color: C.gray, fontSize: 14 }}>Loading Snapsa…</p>
    </div>
  );

  return (
    <div style={{ position: 'fixed', inset: 0, background: C.dark }}>
      {/* Guest banner */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, zIndex: 250,
        background: 'linear-gradient(180deg,rgba(11,11,20,0.96) 0%,transparent 100%)',
        padding: '12px 16px 28px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        pointerEvents: 'none',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, pointerEvents: 'auto' }}>
          <SnapsaMark size={26} />
          <span style={{ fontWeight: 900, fontSize: 18, color: 'white', letterSpacing: '-0.5px' }}>Snapsa</span>
        </div>
        <motion.button
          whileTap={{ scale: 0.95 }} onClick={onGoLogin}
          style={{
            pointerEvents: 'auto',
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '7px 16px', borderRadius: 999,
            background: C.pink, border: 'none', cursor: 'pointer',
            color: 'white', fontWeight: 700, fontSize: 13,
            boxShadow: `0 2px 12px ${C.pink}66`,
          }}
        >
          <LogIn size={14} /> Sign in
        </motion.button>
      </div>

            <GuestErrorBoundary onGoLogin={onGoLogin}>
      <SnapsaApp
        currentUser={guestUser}
        userData={guestUser}
        authToken={null}
        followers={[]}
        following={[]}
        timeline={[]}
        showToast={() => {}}
                onClose={() => {}}
        isGuest={true}
        onGuestAction={triggerAuthWall}
      />
               </GuestErrorBoundary>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────
export const SnapsaEntry = ({ onAuthenticated, onBack }) => {
  const [step,         setStep]         = useState('hero');
  const [seed,         setSeed]         = useState('');
  const [revealed,     setRevealed]     = useState(false);
  const [error,        setError]        = useState(null);
  const [loading,      setLoading]      = useState(false);
  const [wasmReady,    setWasmReady]    = useState(false);
  const [verifyStage,  setVerifyStage]  = useState(0);
  const [successUser,  setSuccessUser]  = useState(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [wallReason,   setWallReason]   = useState(null);

  const canvasRef = useRef(null);
  const animRef   = useRef(null);
  const inputRef  = useRef(null);
  const seedFileInputRef = useRef(null);

  // ── Import seed from a downloaded seed file ──────────────────────────
  const handleSeedFileImport = useCallback((e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; 
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const extracted = normaliseSeed(String(reader.result || ''));
      if (!seedIsValid(extracted)) {
        setError('That file doesn\'t contain a valid 64-character seed.');
        return;
      }
      setError(null);
      setSeed(extracted.slice(0, 64));
    };
    reader.onerror = () => setError('Could not read that file.');
    reader.readAsText(file);
  }, []);

  // ── Particle canvas ────────────────────────────────────────────────
  useEffect(() => {
    if (step === 'guest') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let W = canvas.width  = window.innerWidth;
    let H = canvas.height = window.innerHeight;
    const particles = Array.from({ length: 55 }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      vx: (Math.random() - 0.5) * 0.35, vy: (Math.random() - 0.5) * 0.35,
      r: Math.random() * 1.8 + 0.4,
      hue: Math.random() > 0.5 ? C.pink : C.purple,
      alpha: Math.random() * 0.4 + 0.1,
    }));
    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      particles.forEach(p => {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
        if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = p.hue + Math.round(p.alpha * 255).toString(16).padStart(2, '0');
        ctx.fill();
      });
      animRef.current = requestAnimationFrame(draw);
    };
    draw();
    const onResize = () => { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; };
    window.addEventListener('resize', onResize);
    return () => { cancelAnimationFrame(animRef.current); window.removeEventListener('resize', onResize); };
  }, [step]);

  // ── Init WASM retry up to 3 times with backoff ──────────────────
  useEffect(() => {
    let attempts = 0;
    const tryInit = () => {
      attempts++;
      init()
        .then(() => {
          setWasmReady(true);
          setError(null);
        })
        .catch(err => {
          console.error(`[SnapsaEntry] WASM init attempt ${attempts} failed:`, err);
          if (attempts < 3) {
            setTimeout(tryInit, 800 * attempts);
          } else {
            console.warn('[SnapsaEntry] WASM failed after 3 attempts, will retry on next interaction');
          }
        });
    };
    tryInit();
  }, []);

  // ── Retry WASM  ───────────────────
  const handleSeedFocus = useCallback(() => {
    if (!wasmReady) {
      init().then(() => setWasmReady(true)).catch(() => {});
    }
  }, [wasmReady]);

  // ── Auto-focus input ───────────────────────────────────────────────
  useEffect(() => {
    if (step === 'seed') setTimeout(() => inputRef.current?.focus(), 150);
  }, [step]);

  // ── Auth wall trigger ──────
  const triggerAuthWall = useCallback((reason = 'default') => {
    setWallReason(reason);
  }, []);

  // ── Go from guest ─────────────────────────────────────
  const goToLogin = useCallback(() => {
    setWallReason(null);
    setStep('seed');
  }, []);

  // ── Core ZK auth ─────────────────────────────────────────────────────
  const handleAuth = useCallback(async () => {
    if (!wasmReady || loading) return;
    const cleanSeed = normaliseSeed(seed);
    if (!seedIsValid(cleanSeed)) { setError('Seed must be exactly 64 characters.'); return; }

    setError(null);
    setLoading(true);
    setStep('verifying');
    setVerifyStage(0);

    const makeHttpError = (data, status, fallback) => {
      const error = new Error(data?.error || data?.message || fallback);
      error.status = status;
      error.response = { status, data };
      return error;
    };
    const isIdentityNotFound = (err) => {
      const status = err?.status || err?.response?.status;
      const message = String(err?.message || err?.response?.data?.error || err?.response?.data?.message || '').toLowerCase();
      return [400, 401, 404].includes(status) ||
        /not registered|not found|no snapsa identity|identity does not exist|unknown commitment|no identity/.test(message);
    };

    const authenticateSnapsa = async (commitment) => {
      const challengeRes = await fetch(`${SNAP_URL}/snapsa/auth/challenge`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commitment }),
      });
      const challengeData = await challengeRes.json().catch(() => ({}));
      if (!challengeRes.ok) throw makeHttpError(challengeData, challengeRes.status, 'Could not start Snapsa verification');
      const { challenge: serverChallenge, domain, epoch } = challengeData;
      if (!serverChallenge || !domain || epoch == null) throw new Error('Incomplete Snapsa server challenge.');
      setVerifyStage(2);

      const proofResult = generate_login_proof(cleanSeed, serverChallenge, domain, BigInt(epoch));
      const { proof_hex: proofHex, nullifier } = proofResult;
      if (!proofHex || !nullifier) throw new Error('ZK proof generation failed.');

      const verifyRes = await fetch(`${SNAP_URL}/snapsa/auth/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commitment, challenge: serverChallenge, domain, epoch, loginProof: proofHex, nullifier }),
      });
      const verifyData = await verifyRes.json().catch(() => ({}));
      if (!verifyRes.ok || !verifyData?.success || !verifyData?.token) {
        throw makeHttpError(verifyData, verifyRes.status, 'Snapsa identity verification failed.');
      }

      const now = new Date().toISOString();
      const user = {
        ...(verifyData.user || {}), zkCommitment: commitment, identityType: 'snapsa',
        updatedAt: now, lastSeen: now, isOnline: true,
        followers: [], following: [],
      };
      return { user, token: verifyData.token };
    };

    const authenticateWernTjat = async (commitment) => {
      const challengeRes = await api.post('/api/auth/zksigninchallenge', { commitment });
      const { challenge: serverChallenge, domain, epoch } = challengeRes.data;
      if (!serverChallenge || !domain || epoch == null) throw new Error('Incomplete WernTjat server challenge.');
      setVerifyStage(2);

      const proofResult = generate_login_proof(cleanSeed, serverChallenge, domain, BigInt(epoch));
      const { proof_hex: proofHex, nullifier } = proofResult;
      if (!proofHex || !nullifier) throw new Error('ZK proof generation failed.');

      const verifyRes = await api.post('/api/auth/zksigninverify', {
        commitment, challenge: serverChallenge, domain, epoch,
        loginProof: proofHex, nullifier,
      });
      if (!verifyRes.data?.success || !verifyRes.data?.token) {
        const error = new Error(verifyRes.data?.message || verifyRes.data?.error || 'WernTjat identity verification failed.');
        error.response = { status: verifyRes.status, data: verifyRes.data };
        throw error;
      }

      const { token, user: serverUser, userId, identity } = verifyRes.data;
      const now = new Date().toISOString();
      const user = {
        ...(serverUser || {}),
        _id: userId?.toString() || serverUser?._id,
        zkCommitment: commitment,
        encryptedIdentity: identity?.encryptedIdentity ?? serverUser?.encryptedIdentity ?? null,
        identityIv: identity?.identityIv ?? serverUser?.identityIv ?? null,
        identitySalt: identity?.identitySalt ?? serverUser?.identitySalt ?? null,
        setupProof: identity?.setupProof ?? serverUser?.setupProof ?? null,
        circuitVersion: identity?.circuitVersion ?? serverUser?.circuitVersion ?? '1.0-ZT',
        identityType: 'werntjat', updatedAt: now, lastSeen: now,
        isOnline: serverUser?.isOnline ?? true,
        tier: serverUser?.tier ?? serverUser?.subscriptionTier ?? '',
        subscriptionTier: serverUser?.subscriptionTier ?? serverUser?.tier ?? '',
        followers: serverUser?.followers ?? [], following: serverUser?.following ?? [],
      };
      return { user, token };
    };

    try {
      setVerifyStage(1);
      const commitment = get_commitment(cleanSeed);
      let result;
      try {
        result = await authenticateSnapsa(commitment);
      } catch (snapsaError) {
        if (!isIdentityNotFound(snapsaError)) throw snapsaError;
        setVerifyStage(1);
        result = await authenticateWernTjat(commitment);
      }

      setSuccessUser(result.user);
      setStep('success');
      persistOwnSession(result.token);
      setTimeout(() => onAuthenticated?.(result.user, result.token), 1800);
    } catch (err) {
      console.error('[SnapsaEntry] Auth error:', err);
      const status = err?.status || err?.response?.status;
      const message = String(err?.message || err?.response?.data?.message || '').toLowerCase();
      const isNotRegistered = [400, 401, 404].includes(status) ||
        /not registered|not found|no snapsa identity|no werntjat identity|identity does not exist|unknown commitment|no identity/.test(message);
      setError(isNotRegistered
        ? 'No Snapsa  identity was found for this seed. Check the seed or create a Snapsa identity.'
        : err?.response?.data?.message || err?.response?.data?.error || err.message || 'Authentication failed.');
      setStep('seed');
    } finally {
      setLoading(false);
    }
  }, [seed, wasmReady, loading, onAuthenticated]);

  const displayLen = normaliseSeed(seed).length;
  const isReady    = seedIsValid(seed) && !loading;

  // ── GUEST MODE ─────────────────────────────────────────────────────
  if (step === 'guest') {
    return (
      <AuthWallCtx.Provider value={{ triggerAuthWall, isGuest: true }}>
        <div style={{ position: 'fixed', inset: 0, background: C.dark, overflow: 'hidden' }}>
          <GuestFeedShell onGoLogin={goToLogin} triggerAuthWall={triggerAuthWall} />

          {/* Auth wall sheet */}
          <AnimatePresence>
            {wallReason && (
              <AuthWallSheet
                reason={wallReason}
                onClose={() => setWallReason(null)}
                onGoLogin={goToLogin}
              />
            )}
          </AnimatePresence>
 
        </div>
      </AuthWallCtx.Provider>
    );
  }

  // ── AUTH SCREENS ───────────────
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9000, background: C.dark,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
    }}>
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }} />
      <div style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none',
        background: `radial-gradient(ellipse 70% 55% at 50% 40%, ${C.pink}18 0%, transparent 70%)` }} />

      <div style={{
        position: 'relative', zIndex: 1, width: '100%', maxWidth: 440,
        padding: '24px 20px', overflowY: 'auto', maxHeight: '100vh', boxSizing: 'border-box',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
      }}>
        <AnimatePresence mode="wait">

          {/* ── HERO ────────────────────────────────────────────────── */}
          {step === 'hero' && (
            <motion.div key="hero"
              initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }} transition={{ duration: 0.45 }}
              style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}
            >
              <div style={{ marginBottom: 24, marginTop: 12 }}><SnapsaMark size={80} /></div>
              <h1 style={{ fontWeight: 900, fontSize: 42, color: 'white', letterSpacing: '-2px', lineHeight: 1, margin: 0, textAlign: 'center' }}>Snapsa</h1>
              <p style={{ color: C.gray, fontSize: 14, marginTop: 8, letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 600 }}></p>
              <p style={{ color: 'rgba(255,255,255,0.55)', fontSize: 15, textAlign: 'center', lineHeight: 1.6, maxWidth: 300, margin: '20px 0 36px' }}>
                Your world, All in one place.
              </p>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginBottom: 22 }}>
                {[{ icon: <Shield size={13}/>, label: 'ZK Identity' }, { icon: <Lock size={13}/>, label: 'Seed Login' }, { icon: <Zap size={13}/>, label: 'Live Gifts' }].map(({ icon, label }) => (
                  <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 999, background: 'rgba(255,255,255,0.06)', border: `1px solid ${C.border}`, color: 'rgba(255,255,255,0.7)', fontSize: 12, fontWeight: 600 }}>
                    <span style={{ color: C.pink }}>{icon}</span>{label}
                  </div>
                ))}
              </div>

              <button
                onClick={() => setStep('snapsaSignup')}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                  padding: '10px 18px', borderRadius: 14, marginBottom: 28,
                  background: 'rgba(255,255,255,0.05)', border: `1px solid ${C.border}`,
                  cursor: 'pointer', textAlign: 'left',
                }}
              >
                <SnapsaMark size={28} />
                <div style={{ flex: 1 }}>
                  <p style={{ color: 'white', fontSize: 12, fontWeight: 700, margin: 0 }}>SNAPSA IDENTITY</p>
                  <p style={{ color: C.gray, fontSize: 11, margin: 0 }}>Don't have a Snapsa identity? Create one</p>
                </div>
                <ArrowRight size={16} style={{ color: C.gray, flexShrink: 0 }} />
              </button>

              {/* Primary CTA */}
              <motion.button whileTap={{ scale: 0.97 }} onClick={() => setStep('seed')} style={{
                width: '100%', padding: '16px 0', borderRadius: 16, border: 'none', cursor: 'pointer',
                background: `linear-gradient(135deg, ${C.pink}, #FF5C7A)`,
                color: 'white', fontWeight: 800, fontSize: 16,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                boxShadow: `0 8px 32px ${C.pink}44`,
              }}>
                AUTHENTICATE <ArrowRight size={18} />
              </motion.button>

              {/* Guest entry  */}
              <button onClick={() => setStep('guest')} style={{
                marginTop: 14, width: '100%', padding: '14px 0', borderRadius: 16,
                border: `1px solid ${C.border}`, background: 'rgba(255,255,255,0.04)',
                color: 'rgba(255,255,255,0.6)', fontWeight: 700, fontSize: 15,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                cursor: 'pointer',
              }}>
                <Users size={17} style={{ color: C.gray }}/> Continue as Guest
              </button>


              <div style={{ marginTop: 32, color: 'rgba(255,255,255,0.18)', fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
                <img src="/WernTjatLogo1.jpg" alt="" style={{ width: 14, height: 14, borderRadius: '50%', opacity: 0.4 }} onError={e => e.target.style.display = 'none'}/>
                Powered by Snapsa Technologies
              </div>
            </motion.div>
          )}

          {/* ── SEED ────────────────────────────────────────────────── */}
          {step === 'seed' && (
            <motion.div key="seed"
              initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -40 }} transition={{ duration: 0.35 }}
              style={{ width: '100%', display: 'flex', flexDirection: 'column' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
                <button onClick={() => { setStep('hero'); setError(null); setSeed(''); }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.gray, fontSize: 13, padding: 0, display: 'flex', alignItems: 'center', gap: 5 }}>
                  ← Back
                </button>
                <StepDots total={3} current={1} />
                <div style={{ width: 48 }} />
              </div>

              <div style={{ marginBottom: 22 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: `${C.pink}22`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Fingerprint size={18} style={{ color: C.pink }} />
                  </div>
                  <h2 style={{ color: 'white', fontWeight: 800, fontSize: 20, margin: 0 }}>Snapsa Seed</h2>
                </div>
                <p style={{ color: C.gray, fontSize: 13, lineHeight: 1.55, margin: 0 }}>
                
                </p>
              </div>


              {/* Input */}
              <div style={{ marginBottom: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ color: C.gray, fontSize: 12, fontWeight: 600 }}>{displayLen} / 64 characters</span>
                  <button onClick={() => setRevealed(v => !v)}
                    style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', color: C.gray, fontSize: 12, fontWeight: 600, padding: 0 }}>
                    {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
                    {revealed ? 'Hide' : 'Reveal'}
                  </button>
                </div>
                <div style={{ position: 'relative' }}>
                  <input
                    ref={inputRef}
                    type={revealed ? 'text' : 'password'}
                    value={seed}
                    onChange={e => { setSeed(e.target.value.replace(/\s/g, '').slice(0, 64)); setError(null); }}
                    onKeyDown={e => { if (e.key === 'Enter' && isReady) handleAuth(); }}
                    onFocus={handleSeedFocus}
                    placeholder=""
                    autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
                    style={{
                      width: '100%', boxSizing: 'border-box', padding: '14px 44px 14px 16px',
                      background: displayLen === 64 ? `linear-gradient(135deg,${C.pink}18,${C.purple}18)` : 'rgba(255,255,255,0.05)',
                      border: `1.5px solid ${error ? '#f87171' : displayLen === 64 ? C.pink + '88' : C.border}`,
                      borderRadius: 12, color: 'white', fontSize: 14, fontWeight: 600,
                      outline: 'none', fontFamily: 'monospace',
                      letterSpacing: revealed ? '0.04em' : '0.15em',
                      transition: 'border-color 0.2s, background 0.2s',
                    }}
                  />
                  <KeyRound size={16} style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', color: C.gray, pointerEvents: 'none' }} />
                </div>
                {/* Fill progress */}
                <div style={{ marginTop: 6, height: 3, borderRadius: 99, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                  <motion.div
                    animate={{ width: `${(displayLen / 64) * 100}%`, background: displayLen === 64 ? C.green : C.pink }}
                    transition={{ duration: 0.2 }}
                    style={{ height: '100%', borderRadius: 99 }}
                  />
                </div>

                <input
                  ref={seedFileInputRef}
                  type="file"
                  accept=".txt,text/plain"
                  onChange={handleSeedFileImport}
                  style={{ display: 'none' }}
                />
                <button onClick={() => seedFileInputRef.current?.click()} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  width: '100%', padding: '11px 0', borderRadius: 12, marginTop: 10,
                  border: `1px solid ${C.border}`, background: 'rgba(255,255,255,0.04)',
                  color: 'rgba(255,255,255,0.7)', fontWeight: 700, fontSize: 13, cursor: 'pointer',
                }}>
                  <Upload size={15}/> Import from device
                </button>
              </div>

              {/* Error */}
              <AnimatePresence>
                {error && (
                  <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                    style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '11px 14px', borderRadius: 12, marginTop: 8, marginBottom: 4, background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)' }}>
                    <AlertCircle size={15} style={{ color: '#f87171', flexShrink: 0, marginTop: 1 }} />
                    <span style={{ color: '#f87171', fontSize: 13, lineHeight: 1.45 }}>{error}</span>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Advanced / system status */}
              <button onClick={() => setShowAdvanced(v => !v)} style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', color: C.gray, fontSize: 12, fontWeight: 600, padding: '12px 0 4px', alignSelf: 'flex-start' }}>
                {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                System status
              </button>
              <AnimatePresence>
                {showAdvanced && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} style={{ overflow: 'hidden' }}>
                    <div style={{ padding: '10px 14px', borderRadius: 12, background: 'rgba(255,255,255,0.04)', border: `1px solid ${C.border}`, marginBottom: 4 }}>
                      {[
                        { label: 'ZK Engine (WASM)',  ok: wasmReady        },
                        { label: 'Identity lookup (Snapsa + WernTjat)', ok: true },
                        { label: 'Seed format',       ok: displayLen === 64 },
                      ].map(({ label, ok }) => (
                        <div key={label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0', fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>
                          <span>{label}</span>
                          <span style={{ color: ok ? C.green : '#f87171', fontWeight: 700 }}>{ok ? '✓ Ready' : '✗ Not ready'}</span>
                        </div>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Security note */}
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 14px', borderRadius: 12, marginTop: 12, background: 'rgba(124,58,237,0.1)', border: `1px solid ${C.purple}33` }}>
                <Shield size={14} style={{ color: C.purple, flexShrink: 0, marginTop: 2 }} />
                <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, lineHeight: 1.5 }}>
                  Your seed never leaves this device. A Zero-Knowledge proof is generated locally and only the proof is sent to the server.
                </span>
              </div>

              {/* Primary CTA — Enter Snapsa */}
              <motion.button whileTap={{ scale: 0.97 }} onClick={async () => {
                if (!wasmReady) {
                  try { await init(); setWasmReady(true); } catch {}
                }
                handleAuth();
              }} disabled={!seedIsValid(seed) || loading} style={{
                width: '100%', padding: '15px 0', marginTop: 18, borderRadius: 14, border: 'none',
                cursor: isReady ? 'pointer' : 'not-allowed',
                background: isReady ? `linear-gradient(135deg, ${C.pink}, #FF5C7A)` : 'rgba(255,255,255,0.07)',
                color: isReady ? 'white' : C.gray, fontWeight: 800, fontSize: 15,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                boxShadow: isReady ? `0 6px 28px ${C.pink}44` : 'none', transition: 'all 0.3s',
              }}>
                {loading
                  ? <><RefreshCw size={16} style={{ animation: 'spin 0.8s linear infinite' }} /> Verifying…</>
                  : <>Enter Snapsa <ArrowRight size={16} /></>
                }
              </motion.button>

              {/* ── Guest shortcut — below the main CTA ── */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '16px 0 4px' }}>
                <div style={{ flex: 1, height: 1, background: C.border }} />
                <span style={{ color: C.gray, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>or</span>
                <div style={{ flex: 1, height: 1, background: C.border }} />
              </div>

              <button onClick={() => setStep('guest')} style={{
                width: '100%', padding: '13px 0', borderRadius: 14,
                border: `1px solid ${C.border}`, background: 'rgba(255,255,255,0.04)',
                color: 'rgba(255,255,255,0.55)', fontWeight: 700, fontSize: 14,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
                cursor: 'pointer',
              }}>
                <Users size={16} style={{ color: C.gray }}/> Continue as Guest
              </button>

              <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
            </motion.div>
          )}

          {/* ── SNAPSA SIGNUP ──────────────────────────────────────── */}
          {step === 'snapsaSignup' && (
            <SnapsaSignupForm
              onBack={() => setStep('hero')}
              onCreated={(user, token) => {
                const now = new Date().toISOString();
                const fullUser = { ...(user || {}), updatedAt: now, lastSeen: now, isOnline: true, followers: [], following: [] };
                setSuccessUser(fullUser);
                setStep('success');
                persistOwnSession(token);
                setTimeout(() => onAuthenticated?.(fullUser, token), 1800);
              }}
            />
          )}

          {/* ── VERIFYING ───────────────────────────────────────────── */}
          {step === 'verifying' && (
            <motion.div key="verifying"
              initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }} transition={{ duration: 0.35 }}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24, padding: '48px 0' }}
            >
              <StepDots total={3} current={2} />
              <div style={{ position: 'relative', width: 80, height: 80 }}>
                <motion.div animate={{ rotate: 360 }} transition={{ duration: 1.4, repeat: Infinity, ease: 'linear' }}
                  style={{ position: 'absolute', inset: -8, border: `3px solid transparent`, borderTopColor: C.pink, borderRadius: '50%' }}/>
                <motion.div animate={{ rotate: -360 }} transition={{ duration: 2.2, repeat: Infinity, ease: 'linear' }}
                  style={{ position: 'absolute', inset: -16, border: `2px solid transparent`, borderTopColor: C.purple + '66', borderRadius: '50%' }}/>
                <img src="/SnapsaLogo.png" alt="Snapsa" style={{ width: 80, height: 80, borderRadius: '50%' }} onError={e => e.target.style.display = 'none'}/>
              </div>
              <div style={{ textAlign: 'center' }}>
                <h2 style={{ color: 'white', fontWeight: 800, fontSize: 20, marginBottom: 8 }}>Verifying Identity</h2>
                <p style={{ color: C.gray, fontSize: 14 }}>Generating Zero-Knowledge proof…</p>
              </div>
              {['Deriving ZK commitment from seed', 'Fetching server challenge', 'Generating & transmitting ZK proof'].map((label, i) => (
                <motion.div key={label} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.6 }}
                  style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <motion.div animate={{ backgroundColor: verifyStage >= i ? C.pink : C.border }} transition={{ delay: i * 0.6 + 0.3, duration: 0.4 }}
                    style={{ width: 8, height: 8, borderRadius: '50%', background: C.border, flexShrink: 0 }}/>
                  <span style={{ color: verifyStage >= i ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.35)', fontSize: 13, transition: 'color 0.3s' }}>{label}</span>
                </motion.div>
              ))}
            </motion.div>
          )}

          {/* ── SUCCESS ─────────────────────────────────────────────── */}
          {step === 'success' && (
            <motion.div key="success"
              initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }} transition={{ type: 'spring', damping: 18, stiffness: 200 }}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, padding: '40px 0' }}
            >
              <StepDots total={3} current={3} />
              <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', damping: 14, stiffness: 220, delay: 0.1 }}
                style={{ width: 90, height: 90, borderRadius: '50%', background: 'rgba(74,222,128,0.15)', border: `3px solid ${C.green}`, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 40px rgba(74,222,128,0.25)' }}>
                <CheckCircle size={44} style={{ color: C.green }} />
              </motion.div>
              <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }} style={{ textAlign: 'center' }}>
                <h2 style={{ color: 'white', fontWeight: 900, fontSize: 24, marginBottom: 6 }}>Identity Verified ✓</h2>
                {successUser && <p style={{ color: C.pink, fontSize: 15, fontWeight: 700, marginBottom: 4 }}>@{successUser.username || successUser.name || successUser.fullName || 'Snapsa User'}</p>}
                <p style={{ color: C.gray, fontSize: 13 }}>Entering Snapsa…</p>
              </motion.div>
              <motion.div style={{ width: 200, height: 4, borderRadius: 99, background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
                <motion.div initial={{ width: '0%' }} animate={{ width: '100%' }} transition={{ duration: 1.6, ease: 'easeInOut' }}
                  style={{ height: '100%', background: `linear-gradient(90deg, ${C.pink}, ${C.yellow})`, borderRadius: 99 }}/>
              </motion.div>
            </motion.div>
          )}

        </AnimatePresence>
      </div>
    </div>
  );
};

export default SnapsaEntry;
