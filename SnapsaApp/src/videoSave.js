// Saves a (watermarked) Snapsa video onto the phone. Works in the installed Android app and in a browser.
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';

export async function saveVideoToDevice({ videoId, authorName, snapUrl, authToken, onProgress }) {
  const url = `${snapUrl}/snapsa/videos/${videoId}/download`;
  const safe = String(authorName || 'snapsa').replace(/[^a-z0-9_-]/gi, '');
  const name = `snapsa_${safe}_${videoId}.mp4`;
  const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};

  if (Capacitor.isNativePlatform()) {
    let listener = null;
    try {
      listener = await Filesystem.addListener('progress', (p) => {
        if (p?.url === url && p.contentLength) onProgress?.(Math.min(90, 10 + Math.round((p.bytes / p.contentLength) * 80)));
      });
    } catch {}
    try {
      onProgress?.(10);
      // Try the public folders first (visible to the user), then fall back to the app's own storage.
      const targets = [
        { directory: Directory.ExternalStorage, path: `Movies/Snapsa/${name}`, where: 'Movies/Snapsa' },
        { directory: Directory.Documents, path: `Snapsa/${name}`, where: 'Documents/Snapsa' },
        { directory: Directory.Data, path: `downloads/${name}`, where: 'app storage' },
      ];
      let lastErr = null;
      for (const t of targets) {
        try {
          // the downloader does not create folders on its own (ENOENT), so make the folder first
          try { await Filesystem.mkdir({ path: t.path.split('/').slice(0, -1).join('/'), directory: t.directory, recursive: true }); } catch {}
          await Filesystem.downloadFile({ url, path: t.path, directory: t.directory, recursive: true, headers, progress: true });
          onProgress?.(98);
          return { where: t.where, path: t.path };
        } catch (e) { lastErr = e; }
      }
      throw new Error(lastErr?.message || 'Could not save the video');
    } finally {
      try { await listener?.remove(); } catch {}
    }
  }

  // Browser fallback
  onProgress?.(10);
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error('Download failed');
  onProgress?.(60);
  const blob = await res.blob();
  onProgress?.(90);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  return { where: 'Downloads', path: name };
}
