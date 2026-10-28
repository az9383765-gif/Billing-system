import { Router } from 'express';
import { db, allSettings, getSetting, setSetting, now, uuid } from '../db.js';
import { requireAuth, requireCap, allows, badRequest, hashPassword } from '../lib.js';

const router = Router();
router.use(requireAuth);

const EDITABLE = [
  'shop_name', 'shop_address', 'shop_phone', 'gstin',
  'currency_symbol', 'currency_code',
  'invoice_prefix', 'invoice_padding',
  'tax_label', 'tax_split', 'round_off',
  'receipt_width', 'receipt_footer', 'terms',
  'default_low_stock', 'allow_credit', 'allow_negative_stock',
  'allow_register',
  'loyalty_enabled', 'loyalty_earn', 'loyalty_value',
  'sync_url', 'sync_key',
  'google_client_id',
  'supabase_url', 'supabase_key', 'supabase_bucket'
];

router.get('/', (req, res) => {
  const s = allSettings();
  // shared secrets only for people allowed to manage settings
  if (!allows(req.user, 'settings')) {
    delete s.sync_key;
    delete s.supabase_key;
  }
  res.json(s);
});

router.put('/', requireCap('settings'), (req, res) => {
  const b = req.body || {};
  const errors = [];
  for (const key of EDITABLE) {
    if (b[key] === undefined) continue;
    let value = String(b[key]);
    if (key === 'invoice_prefix' && !value.trim()) errors.push('Invoice prefix cannot be empty');
    if (key === 'invoice_padding') {
      const n = Number(value);
      if (!(n >= 1 && n <= 8)) errors.push('Invoice padding must be 1-8');
    }
    if (key === 'receipt_width' && !['58', '80', 'a4'].includes(value)) errors.push('Receipt width must be 58, 80 or a4');
    if (key === 'sync_url' && value && !/^https?:\/\//i.test(value)) errors.push('Sync URL must start with http:// or https://');
    if (key === 'supabase_url' && value && !/^https?:\/\//i.test(value)) errors.push('Supabase URL must start with http:// or https://');
    if (key === 'supabase_bucket' && value && !/^[A-Za-z0-9._-]+$/.test(value)) errors.push('Bucket name may only use letters, numbers, dot, dash and underscore');
    if (key === 'loyalty_earn') {
      const n = Number(value);
      if (!(n >= 0 && n <= 100)) errors.push('Loyalty earn rate must be 0-100 points per 100 spent');
    }
    if (key === 'loyalty_value') {
      const n = Number(value);
      if (!(n >= 0 && n <= 10000)) errors.push('Loyalty point value must be 0-10000');
    }
    if (['tax_split', 'round_off', 'allow_credit', 'allow_negative_stock', 'allow_register', 'loyalty_enabled'].includes(key)) value = value === '1' || value === 'true' ? '1' : '0';
    if (errors.length) continue;
    setSetting(key, value.trim());
  }
  if (errors.length) return badRequest(res, errors.join('; '));
  res.json(allSettings());
});

// ---------- backup (full JSON export) ----------
// held_bills is device-local work-in-progress (like sessions) — never dumped;
// user_permissions must ride along so a restored shop keeps the Head's access rules
const DUMP_TABLES = [
  'settings', 'categories', 'products', 'customers', 'invoices', 'invoice_items',
  'returns', 'return_items',
  'payments', 'ledger', 'stock_movements', 'users', 'user_permissions', 'stock_requests',
  'expenses', 'coupons'
];

// one snapshot builder shared by the download button and the cloud push
function buildSnapshot() {
  const data = { app: 'shopbill', version: 1, exported_at: now() };
  for (const t of DUMP_TABLES) data[t] = db.prepare(`SELECT * FROM ${t}`).all();
  return data;
}

router.get('/backup', requireCap('settings'), (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="shopbill-backup-${now().slice(0, 10)}.json"` );
  res.send(JSON.stringify(buildSnapshot(), null, 2));
});

// ---------- optional offsite backup to Supabase Storage (never mandatory) ----------
// The Head pastes a project URL + key + bucket once; "Back up now" pushes the
// same JSON snapshot the download button produces. Offline billing never
// depends on this — it is insurance, not a requirement.
router.post('/backup/cloud', requireCap('settings'), async (req, res) => {
  const base = String(getSetting('supabase_url') || '').replace(/\/+$/, '');
  const key = String(getSetting('supabase_key') || '');
  const bucket = String(getSetting('supabase_bucket') || 'backups');
  if (!base || !key) {
    return badRequest(res, 'Enter your Supabase Project URL and API key in Settings → Cloud backup first.');
  }
  const stamp = now().slice(0, 16).replace(/[:T]/g, '-'); // 2026-10-10-21-05
  const objectPath = `${bucket}/martbill/shopbill-${stamp}.json`;
  let response;
  try {
    response = await fetch(`${base}/storage/v1/object/${objectPath}`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'x-upsert': 'true'
      },
      body: JSON.stringify(buildSnapshot()),
      signal: AbortSignal.timeout(20000)
    });
  } catch (e) {
    const why = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'it timed out' : (e.cause?.code || e.message);
    return res.status(502).json({ error: 'Could not reach Supabase — ' + why });
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return res.status(502).json({ error: `Supabase replied ${response.status}${text ? ': ' + text.slice(0, 200) : ''}` });
  }
  const at = now();
  setSetting('last_cloud_backup', at);
  res.json({ ok: true, path: objectPath, at });
});

// children before parents (invoice_items -> invoices -> customers/products, users -> sessions)
const DELETE_ORDER = ['return_items', 'invoice_items', 'returns', 'payments', 'ledger', 'stock_movements',
  'stock_requests', 'expenses', 'coupons', 'invoices', 'customers', 'products', 'categories',
  'user_permissions', 'users', 'settings'];

router.post('/backup/import', requireCap('settings'), (req, res) => {
  const data = req.body;
  if (!data || data.app !== 'shopbill') return badRequest(res, 'Not a valid MartBill backup file');
  let createdAdmin = false;
  try {
    db.transaction(() => {
      // local-only state is always cleared: sessions reference users, the queue is device state
      // (the duty log is this device's own sign-in history — it goes with the sessions)
      db.prepare('DELETE FROM sessions').run();
      db.prepare('DELETE FROM login_sessions').run();
      db.prepare('DELETE FROM sync_queue').run();
      for (const t of DELETE_ORDER) {
        // only touch tables the file actually contains, so a partial file
        // can never wipe settings (or anything else) it does not carry
        if (Array.isArray(data[t])) db.prepare(`DELETE FROM ${t}`).run();
      }
      for (const t of DUMP_TABLES) {
        const rows = Array.isArray(data[t]) ? data[t] : [];
        for (const row of rows) {
          const cols = Object.keys(row);
          if (cols.length === 0) continue;
          db.prepare(
            `INSERT OR REPLACE INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
          ).run(...cols.map(c => row[c]));
        }
      }
      // never leave the shop without a login
      if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
        db.prepare(
          'INSERT INTO users (id, username, password_hash, name, role, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)'
        ).run(uuid(), 'admin', hashPassword('admin123'), 'Administrator', 'admin', now());
        createdAdmin = true;
      }
      if (!getSetting('instance_id')) setSetting('instance_id', uuid());
    })();
  } catch (e) {
    console.error(e);
    return badRequest(res, 'Import failed: ' + e.message);
  }
  if (createdAdmin) console.log('Backup had no user accounts — recreated default login: admin / admin123');
  res.json({
    ok: true,
    default_admin: createdAdmin,
    message: createdAdmin
      ? 'Backup restored. The file contained no user accounts, so the default login was recreated: username admin, password admin123. Please login again.'
      : 'Backup restored. Please login again.'
  });
});

export default router;
