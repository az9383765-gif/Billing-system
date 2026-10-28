// Local-first store (Dexie / IndexedDB).
// - cache: last data the server sent per endpoint — served ONLY when the
//   server cannot be reached, so online behaviour never changes
// - outbox: bills taken while offline — replayed automatically on reconnect.
// This is device storage, not business truth: the server always wins online.
import Dexie from 'dexie';

const db = new Dexie('martbill-offline');
db.version(1).stores({
  cache: 'key',
  outbox: '++id, ts'
});

const CACHE_MAX = 300; // keep memory/disk bounded on old shop PCs

// credentials and volatile state are never cached
export const cacheable = path => !path.startsWith('/auth/') && !path.startsWith('/sync/');

export async function cacheGet(path) {
  try {
    const row = await db.cache.get(path);
    return row ? row.data : undefined;
  } catch {
    return undefined; // IndexedDB blocked (private mode) — behave like before
  }
}

export async function cachePut(path, data) {
  try {
    await db.cache.put({ key: path, data, ts: Date.now() });
    const n = await db.cache.count();
    if (n > CACHE_MAX) {
      const oldest = await db.cache.orderBy('ts').limit(n - CACHE_MAX).primaryKeys();
      await db.cache.bulkDelete(oldest);
    }
  } catch { /* storage blocked — cache is best-effort */ }
}

// drop cached lists that an offline bill changes (they refresh on next load)
export async function cacheInvalidate(prefix) {
  try {
    await db.cache.where('key').startsWith(prefix).delete();
  } catch { /* ignore */ }
}

export async function queueWrite(entry) {
  try {
    await db.outbox.add({ ...entry, ts: Date.now(), tries: 0 });
    notifyOutbox();
    return true;
  } catch {
    return false; // storage blocked — caller falls back to the old error
  }
}

export async function outboxAll() {
  try { return await db.outbox.orderBy('ts').toArray(); } catch { return []; }
}

export async function outboxRemove(id) {
  try { await db.outbox.delete(id); notifyOutbox(); } catch { /* ignore */ }
}

export async function outboxBumpTries(id) {
  try {
    const row = await db.outbox.get(id);
    if (row) await db.outbox.update(id, { tries: (row.tries || 0) + 1 });
  } catch { /* ignore */ }
}

export async function outboxCount() {
  try { return await db.outbox.count(); } catch { return 0; }
}

export function notifyOutbox() {
  window.dispatchEvent(new CustomEvent('shopbill:outbox'));
}
