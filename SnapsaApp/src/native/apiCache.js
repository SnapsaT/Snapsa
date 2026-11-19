// src/native/apiCache.js
// Offline-first cache for every GET the app makes through snapFetch (WhatsApp-style).
// While online, each successful response is saved on the phone. Offline (or when the
// server is down or slow), the last saved copy is shown, even after the app is force-
// stopped. When a connection is detected again, the screens that showed saved data are
// refetched once. Saved data is private to the logged-in user and wiped on logout.
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

const DIR = 'snapsa-cache';
const MAX_ENTRY_BYTES = 3 * 1024 * 1024;   // skip single responses bigger than this
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;  // oldest entries are removed beyond this
const native = Capacitor.isNativePlatform();

// Never cache: auth, push registration, live streams, media, downloads, one-time codes.
const NO_CACHE = /^\/snapsa\/(auth|push|live|media)\b|\/(download|offline|stream|quote|otp)\b/i;
const CACHE_BUSTERS = new Set(['seed', '_', 't', 'ts', 'cb']);

export const isCacheable = (path) => typeof path === 'string' && path.startsWith('/snapsa/') && !NO_CACHE.test(path);

// The same screen asks with a new random seed or timestamp every time; ignore those.
export function normalizePath(path) {
  const [p, qs] = path.split('?');
  if (!qs) return p;
  const kept = qs.split('&').filter((x) => x && !CACHE_BUSTERS.has(x.split('=')[0]));
  return kept.length ? `${p}?${kept.join('&')}` : p;
}

const userIdFromToken = (token) => {
  try {
    const p = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return String(p.userId || p.id || p._id || p.sub || 'u').replace(/[^a-zA-Z0-9]/g, '');
  } catch { return 'anon'; }
};
const hash = (s) => {
  let a = 5381, b = 0;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = ((a << 5) + a) ^ c; b = (c + (b << 6) + (b << 16) - b) | 0; }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
};
export const keyFor = (token, path) => `${userIdFromToken(token || '')}_${hash(normalizePath(path))}`;

// ── storage: phone files in the app's private folder; IndexedDB in a browser ──
let dbPromise = null;
const idb = () => dbPromise || (dbPromise = new Promise((resolve, reject) => {
  const req = indexedDB.open('snapsa-cache', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('kv');
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
}));
const idbDo = async (mode, fn) => {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', mode);
    const r = fn(tx.objectStore('kv'));
    tx.oncomplete = () => resolve(r && r.result);
    tx.onerror = () => reject(tx.error);
  });
};

export async function put(key, body, path) {
  try {
    if (!body || body.length > MAX_ENTRY_BYTES) return;
    const rec = JSON.stringify({ savedAt: Date.now(), path, body });
    if (native) {
      await Filesystem.writeFile({ path: `${DIR}/${key}.json`, directory: Directory.Data, data: rec, encoding: Encoding.UTF8, recursive: true });
    } else {
      await idbDo('readwrite', (s) => s.put(rec, key));
    }
  } catch {}
}

export async function get(key) {
  try {
    if (native) {
      const { data } = await Filesystem.readFile({ path: `${DIR}/${key}.json`, directory: Directory.Data, encoding: Encoding.UTF8 });
      return JSON.parse(data);
    }
    const rec = await idbDo('readonly', (s) => s.get(key));
    return rec ? JSON.parse(rec) : null;
  } catch { return null; }
}

export const toResponse = (rec) => new Response(rec.body, {
  status: 200,
  headers: { 'Content-Type': 'application/json', 'X-Snapsa-Cache': String(rec.savedAt) },
});

export async function clearAll() {
  stale.clear();
  try {
    if (native) await Filesystem.rmdir({ path: DIR, directory: Directory.Data, recursive: true });
    else await idbDo('readwrite', (s) => s.clear());
  } catch {}
}

async function prune() {
  if (!native) return;
  try {
    const { files } = await Filesystem.readdir({ path: DIR, directory: Directory.Data });
    let total = files.reduce((a, f) => a + (f.size || 0), 0);
    if (total <= MAX_TOTAL_BYTES) return;
    files.sort((a, b) => (a.mtime || 0) - (b.mtime || 0));
    for (const f of files) {
      if (total <= MAX_TOTAL_BYTES * 0.8) break;
      await Filesystem.deleteFile({ path: `${DIR}/${f.name}`, directory: Directory.Data }).catch(() => {});
      total -= f.size || 0;
    }
  } catch {}
}

// ── refetch when a connection is detected ──
// Screens that were shown from saved data are remembered, then refetched once the
// network is back (the 'online' event, or every 30 s while some are still saved copies).
const stale = new Map(); // key -> path
let refetcher = null;
let replaying = false;
export const setRefetcher = (fn) => { refetcher = fn; };
export const markStale = (key, path) => { stale.set(key, path); };

async function replayStale() {
  if (replaying || !refetcher || !stale.size || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
  replaying = true;
  let fresh = 0, freshFeed = false;
  try {
    const entries = [...stale.entries()].slice(0, 40);
    for (const [key, path] of entries) {
      stale.delete(key);
      try {
        const res = await refetcher(path);
        if (res && !res.headers.get('X-Snapsa-Cache')) {
          fresh++;
          if (path.startsWith('/snapsa/videos/feed')) freshFeed = true;
        } // still a saved copy: it was re-marked by snapFetch
      } catch {}
    }
  } finally { replaying = false; }
  if (fresh) window.dispatchEvent(new CustomEvent('snapsa:cacheRefreshed'));
  if (freshFeed) window.dispatchEvent(new CustomEvent('snapsa:refreshFeed'));
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => setTimeout(replayStale, 1500));
  window.addEventListener('snapsa:forceLogout', clearAll);
  window.addEventListener('werntjat:logout', clearAll);
  setInterval(() => { if (stale.size) replayStale(); }, 30000);
  setTimeout(prune, 15000);
}
