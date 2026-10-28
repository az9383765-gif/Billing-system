// Offline bill replay — when the internet (or the server) comes back, every
// bill taken offline is posted with its original client_ref. The server
// dedupes on that ref, so even a crash mid-replay can never bill twice.
import { outboxAll, outboxRemove, outboxBumpTries, cacheInvalidate, notifyOutbox } from './localdb.js';
import { api, getToken } from './api.js';

const MAX_AUTO_TRIES = 8; // a bill the server keeps refusing needs human eyes
let flushing = false;

export async function flushOutbox() {
  if (flushing || !getToken()) return;
  flushing = true;
  try {
    const items = await outboxAll();
    for (const it of items) {
      if ((it.tries || 0) >= MAX_AUTO_TRIES) continue; // parked — still counted, Head decides
      try {
        await api(it.path, { method: it.method, body: it.body });
        await outboxRemove(it.id);
        await cacheInvalidate('/invoices');
        await cacheInvalidate('/reports');
        await cacheInvalidate('/meta');
        window.dispatchEvent(new CustomEvent('shopbill:offline-bill-synced', { detail: { label: it.label } }));
      } catch (e) {
        if (e.status === 0) break; // still no connection — try again later
        await outboxBumpTries(it.id);
        window.dispatchEvent(new CustomEvent('shopbill:outbox-error', {
          detail: { label: it.label, message: e.message, tries: (it.tries || 0) + 1 }
        }));
        break; // keep the queue in order — later bills wait behind this one
      }
    }
  } finally {
    flushing = false;
    notifyOutbox();
  }
}

// started once from main.jsx
export function startOutbox() {
  window.addEventListener('online', () => flushOutbox());
  window.addEventListener('shopbill:login', () => flushOutbox()); // boot catch-up after sign-in
  setInterval(() => { if (navigator.onLine) flushOutbox(); }, 60000);
  if (navigator.onLine) setTimeout(flushOutbox, 1500);
}
