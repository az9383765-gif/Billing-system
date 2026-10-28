import { Router } from 'express';
import { db, uuid, now, getSetting, setSetting, rowOf } from '../db.js';
import { requireAuth, requireCap, checkSyncKey, badRequest } from '../lib.js';

const router = Router();

const SYNCED_TABLES = ['categories', 'products', 'customers', 'invoices', 'invoice_items', 'returns', 'return_items', 'payments', 'ledger', 'stock_movements', 'expenses', 'coupons'];
const IMMUTABLE = new Set(['invoice_items', 'return_items', 'stock_movements']); // append-only, compare created_at instead of updated_at

function columnsOf(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

// ---------- apply remote ops into local DB (idempotent, last-write-wins) ----------
export function applyOps(ops, res) {
  const summary = { applied: 0, skipped: 0, deleted: 0, errors: [] };
  for (const op of ops || []) {
    const table = op.entity;
    if (!SYNCED_TABLES.includes(table)) { summary.skipped++; continue; }
    try {
      const payload = typeof op.payload === 'string' ? JSON.parse(op.payload) : op.payload;
      const id = payload?.id || op.entity_id;
      if (!id) { summary.skipped++; continue; }

      if (op.action === 'delete') {
        const info = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
        summary.deleted += info.changes;
        continue;
      }
      if (!payload) { summary.skipped++; continue; }

      const cols = columnsOf(table).filter(c => c in payload);
      if (!cols.length) { summary.skipped++; continue; }
      const existing = rowOf(table, id);
      const incomingTime = payload.updated_at || payload.created_at || op.created_at || now();
      if (existing) {
        const existingTime = existing.updated_at || existing.created_at || '';
        if (!IMMUTABLE.has(table) && existingTime && incomingTime < existingTime) {
          summary.skipped++;
          continue;
        }
        if (IMMUTABLE.has(table)) { summary.skipped++; continue; } // append-only rows never change
        const setCols = cols.filter(c => c !== 'id');
        db.prepare(`UPDATE ${table} SET ${setCols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`).run(
          ...setCols.map(c => payload[c]), id
        );
        summary.applied++;
      } else {
        db.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
          ...cols.map(c => payload[c])
        );
        summary.applied++;
      }
    } catch (e) {
      summary.errors.push(String(e.message || e));
    }
  }
  return summary;
}

// ---------- push local queue to cloud ----------
async function pushToCloud() {
  const url = (getSetting('sync_url') || '').replace(/\/+$/, '');
  const key = getSetting('sync_key') || '';
  if (!url) return { pushed: 0, skipped: true };
  const pending = db
    .prepare('SELECT * FROM sync_queue WHERE synced_at IS NULL ORDER BY created_at LIMIT 500')
    .all();
  if (!pending.length) return { pushed: 0 };

  const res = await fetch(`${url}/api/sync/receive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-key': key },
    body: JSON.stringify({
      instance_id: getSetting('instance_id'),
      sync_key: key,
      ops: pending.map(p => ({
        id: p.id, entity: p.entity, entity_id: p.entity_id,
        action: p.action, payload: p.payload, created_at: p.created_at
      }))
    })
  });
  if (!res.ok) throw new Error(`Cloud rejected sync (HTTP ${res.status})`);
  const stamp = now();
  const mark = db.prepare('UPDATE sync_queue SET synced_at = ? WHERE id = ?');
  for (const p of pending) mark.run(stamp, p.id);
  return { pushed: pending.length };
}

// ---------- pull cloud changes ----------
async function pullFromCloud() {
  const url = (getSetting('sync_url') || '').replace(/\/+$/, '');
  const key = getSetting('sync_key') || '';
  if (!url) return { pulled: 0, skipped: true };
  const since = getSetting('sync_cursor') || '';
  const cursor = now();
  const res = await fetch(`${url}/api/sync/changes?since=${encodeURIComponent(since)}`, {
    headers: { 'x-sync-key': key }
  });
  if (!res.ok) throw new Error(`Cloud rejected pull (HTTP ${res.status})`);
  const data = await res.json();
  const summary = applyOps(data.changes || []);
  setSetting('sync_cursor', cursor);
  setSetting('last_sync', now());
  return { pulled: summary.applied, deleted: summary.deleted };
}

// ---------- routes ----------
router.get('/status', requireAuth, requireCap('sync'), async (req, res) => {
  const pending = db.prepare('SELECT COUNT(*) AS n FROM sync_queue WHERE synced_at IS NULL').get().n;
  const total = db.prepare('SELECT COUNT(*) AS n FROM sync_queue').get().n;
  res.json({
    configured: Boolean(getSetting('sync_url')),
    sync_url: getSetting('sync_url') || '',
    pending,
    total,
    last_sync: getSetting('last_sync') || '',
    instance_id: getSetting('instance_id')
  });
});

router.post('/run', requireAuth, requireCap('sync'), async (req, res) => {
  if (!getSetting('sync_url')) return badRequest(res, 'Cloud sync is not configured. Set the server URL in Settings → Sync.');
  try {
    const pushed = await pushToCloud();
    const pulled = await pullFromCloud();
    res.json({ ok: true, pushed: pushed.pushed || 0, pulled: pulled.pulled || 0, last_sync: getSetting('last_sync') });
  } catch (e) {
    setSetting('last_sync', '');
    res.status(502).json({ error: 'Sync failed: ' + e.message, hint: 'Check that you are online and the sync URL and key are correct.' });
  }
});

// cloud endpoint: receive ops from a device
router.post('/receive', checkSyncKey, (req, res) => {
  const ops = req.body?.ops;
  if (!Array.isArray(ops)) return badRequest(res, 'ops array is required');
  const summary = applyOps(ops);
  res.json(summary);
});

// cloud endpoint: serve changes since a timestamp
router.get('/changes', checkSyncKey, (req, res) => {
  const since = req.query.since || '1970-01-01T00:00:00.000Z';
  const changes = [];
  for (const table of SYNCED_TABLES) {
    const tableCols = columnsOf(table);
    const timeCandidates = IMMUTABLE.has(table)
      ? tableCols.filter(c => c === 'created_at')
      : tableCols.filter(c => c === 'updated_at' || c === 'created_at');
    const timeCol = timeCandidates.length === 2 ? 'COALESCE(updated_at, created_at)' : (timeCandidates[0] || 'rowid');
    const rows = db.prepare(`SELECT * FROM ${table} WHERE ${timeCol} > ? ORDER BY ${timeCol} LIMIT 2000`).all(since);
    for (const row of rows) {
      changes.push({
        entity: table,
        entity_id: row.id,
        action: 'upsert',
        payload: JSON.stringify(row),
        created_at: row.updated_at || row.created_at || now()
      });
    }
  }
  // deletions recorded in this instance's own queue
  const dels = db
    .prepare("SELECT * FROM sync_queue WHERE action = 'delete' AND created_at > ? LIMIT 1000")
    .all(since);
  for (const d of dels) changes.push({ entity: d.entity, entity_id: d.entity_id, action: 'delete', payload: d.payload, created_at: d.created_at });

  res.json({ changes, server_time: now() });
});

export default router;
export { pushToCloud, pullFromCloud };
