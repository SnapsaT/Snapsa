// src/native/saveMedia.js — really saves photos / videos / files onto the phone.
// Android app: the file goes into the Gallery (Pictures/Snapsa, Movies/Snapsa) or Downloads/Snapsa through our own native plugin.
//   If that plugin is not in this build yet, the Android share sheet opens instead ("Save to device", Drive, Files…) so the file is never lost.
// Browser: normal download.
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';

const SnapsaMedia = registerPlugin('SnapsaMedia');
const isNative = () => { try { return Capacitor.isNativePlatform(); } catch { return false; } };

export const mimeFor = (name = '') => {
  const e = String(name).toLowerCase().split('.').pop();
  return ({ mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', pdf: 'application/pdf', txt: 'text/plain' })[e] || 'application/octet-stream';
};
const folderFor = (mime) => (mime.startsWith('video/') ? 'Movies' : mime.startsWith('image/') ? 'Pictures' : 'Downloads') + '/Snapsa';
const safeName = (n) => String(n || 'snapsa_file').replace(/[\\/:*?"<>|]+/g, '_');

const blobToBase64 = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onloadend = () => res(String(r.result).split(',')[1] || '');
  r.onerror = rej; r.readAsDataURL(blob);
});

// A file now sits in the app cache at `uri` — move it to a place the person can see.
async function publish(uri, name, mime) {
  try {
    const r = await SnapsaMedia.saveToGallery({ path: uri, name, mime, folder: 'Snapsa' });
    return { where: r?.where || folderFor(mime) };
  } catch {
    try {
      const { Share } = await import('@capacitor/share');
      await Share.share({ title: name, dialogTitle: 'Save to your phone', files: [uri] });
      return { where: 'the place you chose in the share sheet' };
    } catch (e) {
      if (String(e?.message || e).toLowerCase().includes('cancel')) return { where: '', cancelled: true };
      throw e;
    }
  }
}

const browserDownload = (blob, name) => {
  const u = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 30000);
};

/** Save a Blob (e.g. a canvas picture, a downloaded file). */
export async function saveBlobToDevice(blob, filename) {
  const name = safeName(filename), mime = blob.type && blob.type !== 'application/octet-stream' ? blob.type : mimeFor(name);
  if (!isNative()) { browserDownload(blob, name); return { where: 'Downloads' }; }
  const path = `snapsa_save/${Date.now()}_${name}`;
  await Filesystem.writeFile({ path, data: await blobToBase64(blob), directory: Directory.Cache, recursive: true });
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
  const r = await publish(uri, name, mime);
  try { await Filesystem.deleteFile({ path, directory: Directory.Cache }); } catch {}
  return r;
}

/** Download a URL (with optional headers) and save it. onProgress gets 0-100. */
export async function saveUrlToDevice(url, filename, { headers, onProgress } = {}) {
  const name = safeName(filename), mime = mimeFor(name);
  if (!isNative()) {
    const res = await fetch(url, { headers }); if (!res.ok) throw new Error('Download failed');
    browserDownload(await res.blob(), name); return { where: 'Downloads' };
  }
  const path = `snapsa_save/${Date.now()}_${name}`;
  let listener = null;
  try { listener = await Filesystem.addListener('progress', (p) => { if (p?.url === url && p.contentLength) onProgress?.(Math.min(90, 10 + Math.round((p.bytes / p.contentLength) * 80))); }); } catch {}
  try {
    onProgress?.(10);
    await Filesystem.downloadFile({ url, path, directory: Directory.Cache, recursive: true, headers, progress: true });
    onProgress?.(92);
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
    const r = await publish(uri, name, mime);
    onProgress?.(98);
    try { await Filesystem.deleteFile({ path, directory: Directory.Cache }); } catch {}
    return r;
  } finally { try { await listener?.remove(); } catch {} }
}
