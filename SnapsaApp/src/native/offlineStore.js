// src/native/offlineStore.js
// Background offline sync. Uses the watermarked copy from /snapsa/videos/:id/offline,
// which works for creator-off videos too (the server skips only the creator download check).
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';

const SNAP_URL = import.meta?.env?.VITE_SNAP_URL || 'https://snapsaserver.onrender.com';
const INDEX_KEY = 'snapsa_offline_index';
const SETTINGS_KEY = 'snapsa_offline_settings';
const DIR = 'snapsa-offline';
export const OPTIONS = [10, 20, 40, 80];

export const isNativeApp = Capacitor.isNativePlatform();

const getJSON = async (key, fallback) => {
  try {
    const { value } = await Preferences.get({ key });
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};
const setJSON = (key, value) => Preferences.set({ key, value: JSON.stringify(value) });

const readIndex = () => getJSON(INDEX_KEY, []);
const writeIndex = (list) => setJSON(INDEX_KEY, list);

export const getSettings = () => getJSON(SETTINGS_KEY, { count: 10, wifiOnly: true });
export const saveSettings = (s) => setJSON(SETTINGS_KEY, s);

const authHeaders = (token) => (token ? { Authorization: `Bearer ${token}` } : {});
const videoId = (v) => String(v.id || v._id);
const playbackUrl = (rel) =>
  !rel ? null : rel.startsWith('http') ? rel : `${SNAP_URL}/snapsa/media/${rel}`;
const offlineUrl = (v) => `${SNAP_URL}/snapsa/videos/${videoId(v)}/offline`;

const fetchFeed = async (limit, token) => {
  const res = await fetch(`${SNAP_URL}/snapsa/videos/feed?limit=${limit}&skip=0`, {
    headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error('feed');
  const d = await res.json();
  return (d?.videos || []).filter((v) => v && (v.videoUrl || v.videoFile));
};

// Size of one video in bytes, from a 1-byte range request on the playback copy.
// Close to the offline copy's size; used only for the estimates.
const videoBytes = async (v, token) => {
  const url = playbackUrl(v.videoUrl || v.videoFile);
  if (!url) return 0;
  const res = await fetch(url, { headers: { Range: 'bytes=0-0', ...authHeaders(token) } });
  const cr = res.headers.get('content-range');
  if (cr && cr.includes('/')) return Number(cr.split('/')[1]) || 0;
  return Number(res.headers.get('content-length')) || 0;
};

// The choices shown to the user, with estimated MB for each.
export async function estimateOptions(token) {
  const max = Math.max(...OPTIONS);
  const videos = await fetchFeed(max, token);
  const sizes = [];
  for (const v of videos) sizes.push(await videoBytes(v, token).catch(() => 0));
  return OPTIONS.map((count) => {
    const bytes = sizes.slice(0, count).reduce((a, b) => a + b, 0);
    return { count, mb: Math.round(bytes / 1048576), available: Math.min(count, videos.length) };
  });
}

let running = false;

// Downloads the latest `count` feed videos in the background, one at a time.
// Keeps only those videos: anything else saved earlier is removed.
export async function syncOffline({ count, wifiOnly, token, onProgress }) {
  if (running) return;
  running = true;
  try {
    if (!navigator.onLine) throw new Error('offline');
    const type = navigator.connection?.type;
    if (wifiOnly && type && type !== 'wifi') throw new Error('not-wifi');

    const videos = (await fetchFeed(count, token)).slice(0, count);
    const wanted = new Set(videos.map(videoId));
    let saved = await readIndex();

    for (const item of saved) {
      if (!wanted.has(videoId(item))) await deleteFile(videoId(item));
    }
    saved = saved.filter((item) => wanted.has(videoId(item)));
    await writeIndex(saved);

    let done = 0;
    for (const v of videos) {
      const id = videoId(v);
      if (!saved.some((s) => videoId(s) === id)) {
        if (!navigator.onLine) break;
        try {
          const path = `${DIR}/${id}.mp4`;
          await Filesystem.downloadFile({
            url: offlineUrl(v),
            path,
            directory: Directory.Data,
            recursive: true,
            headers: authHeaders(token),
          });
          saved = [{ ...v, id, localPath: path, savedAt: Date.now() }, ...saved];
          await writeIndex(saved);
        } catch {
          await deleteFile(id); // skip this one, remove any partial file, carry on
        }
      }
      done++;
      onProgress?.(done, videos.length);
    }
    return { saved: saved.length };
  } finally {
    running = false;
  }
}

const deleteFile = async (id) => {
  try {
    await Filesystem.deleteFile({ path: `${DIR}/${id}.mp4`, directory: Directory.Data });
  } catch {}
};

// Saved videos that can play now, with a local source for the player.
export async function listOffline() {
  const list = await readIndex();
  const out = [];
  for (const v of list) {
    try {
      await Filesystem.stat({ path: v.localPath, directory: Directory.Data });
      const { uri } = await Filesystem.getUri({ path: v.localPath, directory: Directory.Data });
      out.push({ ...v, _localSrc: Capacitor.convertFileSrc(uri) });
    } catch {
      // File missing (for example, cleared by Android). Skip it.
    }
  }
  return out;
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
