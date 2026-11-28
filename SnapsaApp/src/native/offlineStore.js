// src/native/offlineStore.js
// Offline videos: the user starts a download by hand, it downloads ONCE, then stops.
// Saved videos live in Directory.Data (not cache) and are played from the "Watch offline videos" screen —
// they are never mixed into the main feed.
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';

const SNAP_URL = import.meta?.env?.VITE_SNAP_URL || 'https://snapsaserver-gzs4.onrender.com';
const INDEX_KEY = 'snapsa_offline_index';
const SETTINGS_KEY = 'snapsa_offline_settings';
const DIR = 'snapsa-offline';
const FALLBACK_MB = 8;                 // used only when a size can't be measured
export const OPTIONS = [10, 20, 40, 80];

export const isNativeApp = Capacitor.isNativePlatform();

const getJSON = async (key, fallback) => {
  try { const { value } = await Preferences.get({ key }); return value ? JSON.parse(value) : fallback; }
  catch { return fallback; }
};
const setJSON = (key, value) => Preferences.set({ key, value: JSON.stringify(value) });
const readIndex = () => getJSON(INDEX_KEY, []);
const writeIndex = (list) => setJSON(INDEX_KEY, list);

export const getSettings = () => getJSON(SETTINGS_KEY, { count: 10, wifiOnly: true });
export const saveSettings = (s) => setJSON(SETTINGS_KEY, s);

const authHeaders = (token) => (token ? { Authorization: `Bearer ${token}` } : {});
const videoId = (v) => String(v.id || v._id);
const playbackUrl = (rel) => (!rel ? null : rel.startsWith('http') ? rel : `${SNAP_URL}/snapsa/media/${rel}`);
const offlineUrl = (v) => `${SNAP_URL}/snapsa/videos/${videoId(v)}/offline`;
// Prefer the ready-made watermarked file on the CDN (fast, no server work); fall back to the server route.
const sourceUrls = (v) => {
  const direct = playbackUrl(v.watermarkedUrl || v.videoUrl || v.videoFile);
  return [direct, offlineUrl(v)].filter(Boolean).filter((u, i, a) => a.indexOf(u) === i);
};
const MIN_BYTES = 50 * 1024;   // anything smaller is an error page, not a video

// Newest videos first, in a fixed order (the normal feed is shuffled, which made every run pick different videos).
const fetchLatest = async (limit, token) => {
  const res = await fetch(`${SNAP_URL}/snapsa/videos/feed?limit=${limit}&skip=0&sort=new`, {
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) }, cache: 'no-store',
  });
  if (!res.ok) throw new Error('feed');
  const d = await res.json();
  return (d?.videos || []).filter((v) => v && (v.videoUrl || v.videoFile));
};

export const shuffle = (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// A pool of up to 300 recent videos (the server caps one page at 100). Each download picks a RANDOM sample from it,
// so the same videos do not come down in the same order every time.
const fetchPool = async (token) => {
  const all = [];
  for (const skip of [0, 100, 200]) {
    const res = await fetch(`${SNAP_URL}/snapsa/videos/feed?limit=100&skip=${skip}&sort=new`, {
      headers: { 'Content-Type': 'application/json', ...authHeaders(token) }, cache: 'no-store',
    });
    if (!res.ok) { if (skip === 0) throw new Error('feed'); break; }
    const d = await res.json();
    const vids = (d?.videos || []).filter((v) => v && (v.videoUrl || v.videoFile));
    all.push(...vids);
    if ((d?.videos || []).length < 100) break;
  }
  const seen = new Set();
  return all.filter((v) => { const id = videoId(v); if (seen.has(id)) return false; seen.add(id); return true; });
};

// Size of one video from a 1-byte range request.
const videoBytes = async (v, token) => {
  const url = playbackUrl(v.videoUrl || v.videoFile);
  if (!url) return 0;
  const res = await fetch(url, { headers: { Range: 'bytes=0-0', ...authHeaders(token) } });
  const cr = res.headers.get('content-range');
  if (cr && cr.includes('/')) return Number(cr.split('/')[1]) || 0;
  return 0;   // never fall back to content-length: a server that ignores Range would send the whole file
};

let estimateCache = null;
// Estimated MB per option. Measures only 3 videos (the old version probed up to 80).
export async function estimateOptions(token) {
  if (estimateCache && Date.now() - estimateCache.at < 10 * 60 * 1000) return estimateCache.value;
  const videos = await fetchLatest(Math.max(...OPTIONS), token);
  const sample = [];
  for (const v of videos.slice(0, 3)) { const b = await videoBytes(v, token).catch(() => 0); if (b) sample.push(b); }
  const avgMB = sample.length ? sample.reduce((a, b) => a + b, 0) / sample.length / 1048576 : FALLBACK_MB;
  const value = OPTIONS.map((count) => ({
    count, mb: Math.round(avgMB * Math.min(count, videos.length)), available: Math.min(count, videos.length),
  }));
  estimateCache = { at: Date.now(), value };
  return value;
}

const deleteFile = async (id) => { try { await Filesystem.deleteFile({ path: `${DIR}/${id}.mp4`, directory: Directory.Data }); } catch {} };
const fileExists = async (path) => { try { await Filesystem.stat({ path, directory: Directory.Data }); return true; } catch { return false; } };

let running = false;
let cancelled = false;
export const isSyncRunning = () => running;
export const cancelSync = () => { cancelled = true; };

// Downloads the newest `count` videos that are not already on the phone. Each video is fetched once.
// When everything wanted is already saved it downloads nothing.
export async function syncOffline({ count, wifiOnly, token, onProgress }) {
  if (running) return { saved: 0, downloaded: 0, busy: true };
  running = true; cancelled = false;
  try {
    if (!navigator.onLine) throw new Error('offline');
    const type = navigator.connection?.type;
    if (wifiOnly && type && type !== 'wifi' && type !== 'ethernet') throw new Error('not-wifi');

    const wanted = shuffle(await fetchPool(token)).slice(0, count);
    let saved = await readIndex();
    // forget index rows whose file has disappeared
    const ok = [];
    for (const s of saved) if (await fileExists(s.localPath)) ok.push(s);
    saved = ok;

    const have = new Set(saved.map(videoId));
    const todo = wanted.filter((v) => !have.has(videoId(v)));
    let done = wanted.length - todo.length;
    onProgress?.(done, wanted.length);

    let downloaded = 0, failed = 0, lastError = '';
    // make sure the folder exists before any download (fixes ENOENT)
    try { await Filesystem.mkdir({ path: DIR, directory: Directory.Data, recursive: true }); } catch {}
    for (const v of todo) {
      if (cancelled || !navigator.onLine) break;
      const id = videoId(v);
      const path = `${DIR}/${id}.mp4`;
      let ok2 = false;
      for (const url of sourceUrls(v)) {
        try {
          const headers = url.startsWith(SNAP_URL) ? authHeaders(token) : {};
          await Filesystem.downloadFile({ url, path, directory: Directory.Data, recursive: true, headers, connectTimeout: 120000, readTimeout: 300000 });
          const st = await Filesystem.stat({ path, directory: Directory.Data });
          if ((st.size || 0) < MIN_BYTES) throw new Error(`file too small (${st.size || 0} bytes)`);
          saved = [{ ...v, id, localPath: path, bytes: st.size || 0, savedAt: Date.now() }, ...saved];
          await writeIndex(saved);
          downloaded++; ok2 = true;
          break;
        } catch (e) {
          lastError = '';   // never keep the technical text (it names the server)
          await deleteFile(id);
        }
      }
      if (!ok2) failed++;
      done++;
      onProgress?.(done, wanted.length);
    }

    // keep at most `count` videos: the ones picked this time first, then the newest older ones
    if (!cancelled && saved.length > count) {
      const picked = new Set(wanted.map(videoId));
      const sorted = [...saved].sort((a, b) => (picked.has(videoId(b)) - picked.has(videoId(a))) || ((b.savedAt || 0) - (a.savedAt || 0)));
      for (const extra of sorted.slice(count)) await deleteFile(videoId(extra));
      saved = sorted.slice(0, count);
      await writeIndex(saved);
    }
    return { saved: saved.length, downloaded, failed, lastError, cancelled };
  } finally { running = false; }
}

// Saved videos that can play now, with a local source for the player.
export async function listOffline() {
  const list = await readIndex();
  const out = [];
  for (const v of list) {
    try {
      await Filesystem.stat({ path: v.localPath, directory: Directory.Data });
      const { uri } = await Filesystem.getUri({ path: v.localPath, directory: Directory.Data });
      out.push({ ...v, _localSrc: Capacitor.convertFileSrc(uri) });
    } catch { /* file missing (cleared by Android) — skip */ }
  }
  return shuffle(out);   // watched in a random order each time
}

export async function offlineSummary() {
  const list = await readIndex();
  return { count: list.length, bytes: list.reduce((a, v) => a + (v.bytes || 0), 0) };
}

export async function clearOffline() {
  const list = await readIndex();
  for (const v of list) await deleteFile(videoId(v));
  await writeIndex([]);
}

// ── Save-while-offline: remember the tap, tell the server when we are online again ──
const SAVES_KEY = 'snapsa_offline_saves';        // waiting to be sent
const SAVED_KEY = 'snapsa_offline_saved_ids';    // what the user already saved (for the filled bookmark)
export async function getSavedIds() { return new Set(await getJSON(SAVED_KEY, [])); }
export async function flushSaves(token) {
  if (!token || !navigator.onLine) return;
  const queue = await getJSON(SAVES_KEY, []);
  const left = [];
  for (const id of queue) {
    try {
      const res = await fetch(`${SNAP_URL}/snapsa/videos/${id}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
        body: JSON.stringify({ want: true }),
      });
      if (!(res.ok || res.status === 404)) left.push(id);
    } catch { left.push(id); }
  }
  await setJSON(SAVES_KEY, left);
}
export async function queueSave(id, token) {
  id = String(id);
  const ids = await getJSON(SAVED_KEY, []);
  if (!ids.includes(id)) await setJSON(SAVED_KEY, [...ids, id]);
  const queue = await getJSON(SAVES_KEY, []);
  if (!queue.includes(id)) await setJSON(SAVES_KEY, [...queue, id]);
  await flushSaves(token);
  return (await getJSON(SAVES_KEY, [])).includes(id) ? 'queued' : 'sent';
}
