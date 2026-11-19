// Saves the recovery seed as a .txt file. Works in the installed Android app (where the
// browser "download" trick does nothing) and falls back to the normal download in a browser.
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

export async function saveSeedFile(filename, text) {
  if (Capacitor.isNativePlatform()) {
    try { await Filesystem.requestPermissions(); } catch {} // only asks on older Android versions
    const targets = [
      { directory: Directory.Documents, path: `Snapsa/${filename}`, where: 'Documents/Snapsa' },
      { directory: Directory.ExternalStorage, path: `Download/${filename}`, where: 'Downloads' },
    ];
    for (const t of targets) {
      try {
        await Filesystem.writeFile({ path: t.path, data: text, directory: t.directory, encoding: Encoding.UTF8, recursive: true });
        return { saved: true, where: t.where };
      } catch {}
    }
    // Nothing public was writable: put the seed on the clipboard so it is not lost.
    try { await navigator.clipboard.writeText(text); return { saved: false, copied: true }; } catch {}
    return { saved: false, copied: false };
  }
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return { saved: true, where: 'Downloads' };
}
