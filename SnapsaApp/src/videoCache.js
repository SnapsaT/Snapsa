// src/videoCache.js — remembers videos you have watched so they still play with no connection.
// Uses the browser Cache Storage (works in the Android WebView). Keeps the most recent ~30 videos / ~350 MB.
const CACHE = 'snapsa-videos-v1', INDEX = 'snapsa_vcache_index', FEED = 'snapsa_feed_cache';
const MAX_ITEMS = 30, MAX_BYTES = 350 * 1024 * 1024, MAX_ONE = 40 * 1024 * 1024;

const readIdx = () => { try { return JSON.parse(localStorage.getItem(INDEX) || '{}'); } catch { return {}; } };
const writeIdx = (i) => { try { localStorage.setItem(INDEX, JSON.stringify(i)); } catch {} };
const supported = () => typeof caches !== 'undefined';
const inflight = new Set();

export async function cacheVideoFile(url) {
  if (!supported() || !url || url.startsWith('blob:') || inflight.has(url)) return false;
  const idx = readIdx();
  if (idx[url]) { idx[url].t = Date.now(); writeIdx(idx); return true; }
  if (navigator.connection?.saveData) return false;
  inflight.add(url);
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok || res.type === 'opaque') return false;
    const len = Number(res.headers.get('content-length')) || 0;
    if (len > MAX_ONE) return false;
    const blob = await res.blob();
    if (blob.size < 20 * 1024 || blob.size > MAX_ONE) return false;
    const c = await caches.open(CACHE);
    await c.put(url, new Response(blob, { headers: { 'Content-Type': blob.type || 'video/mp4' } }));
    const i2 = readIdx(); i2[url] = { t: Date.now(), b: blob.size }; writeIdx(i2);
    await trim();
    return true;
  } catch { return false; }
  finally { inflight.delete(url); }
}

async function trim() {
  const idx = readIdx();
  const rows = Object.entries(idx).sort((a, b) => b[1].t - a[1].t);
  let bytes = 0, keep = 0; const drop = [];
  for (const [u, m] of rows) { bytes += m.b || 0; keep++; if (keep > MAX_ITEMS || bytes > MAX_BYTES) drop.push(u); }
  if (!drop.length) return;
  const c = await caches.open(CACHE);
  for (const u of drop) { await c.delete(u).catch(() => {}); delete idx[u]; }
  writeIdx(idx);
}

export async function getCachedVideoUrl(url) {
  if (!supported() || !url || !readIdx()[url]) return null;
  try {
    const c = await caches.open(CACHE); const r = await c.match(url);
    if (!r) { const i = readIdx(); delete i[url]; writeIdx(i); return null; }
    return URL.createObjectURL(await r.blob());
  } catch { return null; }
}
export const isVideoCached = (url) => !!readIdx()[url];

// Remember the last feed so the app can still list the videos you watched when it opens offline.
export const saveFeedSnapshot = (videos) => { try { localStorage.setItem(FEED, JSON.stringify((videos || []).slice(0, 60))); } catch {} };
export const loadFeedSnapshot = () => { try { return JSON.parse(localStorage.getItem(FEED) || '[]'); } catch { return []; } };
