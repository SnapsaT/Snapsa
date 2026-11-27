// src/native/seedSave.js — saves the auth seed as a text file.
// Returns { saved: bool, where: string, copied: bool }
// Android app: writes the file, then opens the phone's share sheet (Save to Files / Drive / Downloads / WhatsApp / e-mail…)
//   because <a download> does nothing inside the Android web view.
// Browser: normal download, then share-API, then clipboard.
const copyText = async (t) => { try { await navigator.clipboard.writeText(t); return true; } catch { return false; } };

export async function saveSeedFile(filename, text) {
  // 1) Native app
  try {
    const { Capacitor } = await import('@capacitor/core');
    if (Capacitor.isNativePlatform()) {
      const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
      const { Share } = await import('@capacitor/share');
      const path = `snapsa_seed/${filename}`;
      await Filesystem.writeFile({ path, data: text, directory: Directory.Cache, encoding: Encoding.UTF8, recursive: true });
      const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
      try {
        await Share.share({ title: filename, dialogTitle: 'Save your seed file', files: [uri] });
        return { saved: true, where: 'the place you picked — check it is there before continuing', copied: false };
      } catch (e) {
        if (String(e?.message || e).toLowerCase().includes('cancel')) return { saved: false, where: '', copied: await copyText(text) };
        throw e;
      }
    }
  } catch { /* fall through */ }
  // 2) Browser download
  try {
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return { saved: true, where: 'your Downloads folder', copied: false };
  } catch { /* fall through */ }
  // 3) Web Share with a file
  try {
    const f = new File([text], filename, { type: 'text/plain' });
    if (navigator.canShare?.({ files: [f] })) { await navigator.share({ files: [f], title: filename }); return { saved: true, where: 'the app you chose', copied: false }; }
  } catch {}
  // 4) Clipboard
  return { saved: false, where: '', copied: await copyText(text) };
}
