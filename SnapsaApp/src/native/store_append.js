
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
