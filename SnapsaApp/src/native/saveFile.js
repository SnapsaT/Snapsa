// src/native/saveFile.js — saves a small text file so the user really keeps it.
// Browser: normal download.  Android app: writes to the app cache and opens the share sheet ("Save to Files", Drive, WhatsApp, e-mail…)
// because a plain <a download> does nothing inside the Android web view.
// returns 'saved' | 'shared' | 'failed'
export async function saveTextFile(filename, text) {
  try {
    const { Capacitor } = await import('@capacitor/core');
    if (Capacitor.isNativePlatform()) {
      const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
      const { Share } = await import('@capacitor/share');
      const path = `snapsa_save/${Date.now()}_${filename}`;
      await Filesystem.writeFile({ path, data: text, directory: Directory.Cache, encoding: Encoding.UTF8, recursive: true });
      const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
      await Share.share({ title: filename, dialogTitle: 'Save your file', files: [uri] });
      return 'shared';
    }
  } catch (e) { if (String(e?.message || e).toLowerCase().includes('cancel')) return 'shared'; }
  try {
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return 'saved';
  } catch { return 'failed'; }
}
