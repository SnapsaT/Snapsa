// src/outbox.js — messages and stories made while offline wait here (IndexedDB, so photos/videos survive app restarts)
const DB = 'snapsa_outbox', STORE = 'items';

const openDb = () => new Promise((resolve, reject) => {
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

const run = async (mode, fn) => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error); };
  });
};

const emit = (name, detail) => { try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch {} };

export const isNetworkError = (e) =>
  !!e && e.name !== 'AbortError' && (e instanceof TypeError || /network|failed to fetch|load failed|timeout/i.test(String(e.message || '')));

// item: { kind:'dm'|'story', target?:userId, fields:{...form fields}, file?:File|Blob }
export async function outboxAdd(item) {
  const rec = { ...item, id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, createdAt: Date.now() };
  await run('readwrite', (s) => s.put(rec));
  emit('snapsa:outboxChanged', { added: rec.id });
  return rec;
}

export async function outboxList(kind) {
  const all = (await run('readonly', (s) => s.getAll())) || [];
  return all.filter((x) => !kind || x.kind === kind).sort((a, b) => a.createdAt - b.createdAt);
}

export const outboxRemove = (id) => run('readwrite', (s) => s.delete(id));

// Sends everything waiting, oldest first. `send(item)` must return a fetch Response.
let flushing = false;
export async function flushOutbox(send) {
  if (flushing || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
  flushing = true;
  try {
    const items = await outboxList();
    for (const it of items) {
      let res;
      try { res = await send(it); } catch { break; }           // still offline / server asleep: try again later
      if (res.ok) {
        await outboxRemove(it.id);
        emit('snapsa:outboxSent', { item: it });
      } else if (res.status >= 400 && res.status < 500 && ![401, 408, 429].includes(res.status)) {
        await outboxRemove(it.id);                              // the server refused it (blocked, too big...): do not retry forever
        emit('snapsa:outboxDropped', { item: it, status: res.status });
      } else break;                                             // 5xx / expired login / rate limit: keep it, retry later
    }
  } finally {
    flushing = false;
    emit('snapsa:outboxChanged', {});
  }
}
