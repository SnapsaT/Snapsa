// src/ChatLock.js — per-chat PIN lock (ported from WernTjat's ZT lock). The PIN is never stored:
// we keep a random salt + an AES-GCM "verifier" encrypted with a PBKDF2-derived key. Right PIN = verifier decrypts.
const DB = 'snapsa_chat_locks', STORE = 'locks';
export const PIN_MIN = 4, PIN_MAX = 6;
const ITER = 210000;

const toHex = (b) => Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => { const o = new Uint8Array(h.length / 2); for (let i = 0; i < h.length; i += 2) o[i / 2] = parseInt(h.substr(i, 2), 16); return o; };

const openDb = () => new Promise((res, rej) => {
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = (e) => { if (!e.target.result.objectStoreNames.contains(STORE)) e.target.result.createObjectStore(STORE, { keyPath: 'chatId' }); };
  r.onsuccess = (e) => res(e.target.result); r.onerror = (e) => rej(e.target.error);
});
const getRecord = async (chatId) => { const db = await openDb(); return new Promise((res) => { const q = db.transaction(STORE).objectStore(STORE).get(chatId); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); };

async function deriveKey(pin, saltHex) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), { name: 'PBKDF2' }, false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: fromHex(saltHex), iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function isChatLocked(chatId) { try { return !!(await getRecord(String(chatId))); } catch { return false; } }

export async function setChatPin(chatId, pin, bio = false) {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pin, salt);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('SNAPSA_LOCK_OK'));
  const db = await openDb();
  await new Promise((res, rej) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put({ chatId: String(chatId), saltHex: salt, ivHex: toHex(iv), cipherHex: toHex(cipher), bio: !!bio, at: Date.now() }); tx.oncomplete = res; tx.onerror = (e) => rej(e.target.error); });
}

export async function verifyChatPin(chatId, pin) {
  const rec = await getRecord(String(chatId)); if (!rec) return false;
  try { await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromHex(rec.ivHex) }, await deriveKey(pin, rec.saltHex), fromHex(rec.cipherHex)); return true; } catch { return false; }
}

export async function removeChatLock(chatId) {
  const db = await openDb();
  await new Promise((res, rej) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).delete(String(chatId)); tx.oncomplete = res; tx.onerror = (e) => rej(e.target.error); });
}

export async function chatLockUsesBio(chatId) { try { return !!(await getRecord(String(chatId)))?.bio; } catch { return false; } }

// ── Fingerprint / face / screen-lock via the native biometric plugin (the Android APK only) ──
let _bio;
const bioPlugin = () => {
  if (_bio !== undefined) return _bio;
  try { _bio = window.Capacitor?.isNativePlatform?.() ? window.Capacitor.registerPlugin('NativeBiometric') : null; } catch { _bio = null; }
  return _bio;
};
export async function bioAvailable() { try { const r = await bioPlugin()?.isAvailable({ useFallback: true }); return !!r?.isAvailable; } catch { return false; } }
export async function bioVerify(reason = 'Unlock this chat') {
  try { await bioPlugin().verifyIdentity({ reason, title: 'Snapsa chat lock', subtitle: 'Confirm it is you', useFallback: true, maxAttempts: 3 }); return true; } catch { return false; }
}
