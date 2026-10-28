import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'shopbill.db');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function uuid() {
  return crypto.randomUUID();
}

export function now() {
  return new Date().toISOString();
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT DEFAULT '',
  email TEXT,                          -- Google sign-in identity; NULL = password-only account
  role TEXT DEFAULT 'cashier',
  active INTEGER DEFAULT 1,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT,
  expires_at TEXT
);

-- duty log: one row per sign-in, summed into "hours logged in" per person.
-- last_seen only moves while that browser pings, so a till left switched on
-- overnight freezes at the moment it stopped answering instead of inventing hours
CREATE TABLE IF NOT EXISTS login_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token TEXT,                          -- the browser session this duty period belongs to
  login_at TEXT NOT NULL,
  last_seen TEXT,                      -- last heartbeat from that browser
  logout_at TEXT                       -- NULL = still signed in
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  barcode TEXT DEFAULT '',
  category_id TEXT,
  unit TEXT DEFAULT 'pcs',
  price REAL DEFAULT 0,
  cost_price REAL DEFAULT 0,
  stock_qty REAL DEFAULT 0,
  low_stock REAL DEFAULT 5,
  tax_rate REAL DEFAULT 0,
  tax_inclusive INTEGER DEFAULT 1,
  is_active INTEGER DEFAULT 1,
  expiry_date TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  address TEXT DEFAULT '',
  gstin TEXT DEFAULT '',
  credit_limit REAL DEFAULT 0,
  notes TEXT DEFAULT '',
  loyalty_points REAL DEFAULT 0,   -- star points the customer has banked
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  invoice_no TEXT NOT NULL,
  customer_id TEXT,
  sale_date TEXT NOT NULL,
  datetime TEXT NOT NULL,
  subtotal REAL DEFAULT 0,
  discount REAL DEFAULT 0,
  tax_total REAL DEFAULT 0,
  round_off REAL DEFAULT 0,
  total REAL DEFAULT 0,
  paid_amount REAL DEFAULT 0,
  due_amount REAL DEFAULT 0,
  payment_method TEXT DEFAULT 'cash',
  status TEXT DEFAULT 'paid',
  notes TEXT DEFAULT '',
  loyalty_redeemed REAL DEFAULT 0,  -- points spent on this bill
  loyalty_earned REAL DEFAULT 0,    -- points this bill banked (a void gives them back)
  coupon_code TEXT DEFAULT '',      -- discount code applied
  coupon_discount REAL DEFAULT 0,   -- rupees the coupon took off
  client_ref TEXT,                  -- offline bill replay key — never bills twice
  voided INTEGER DEFAULT 0,
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id TEXT,
  name TEXT NOT NULL,
  barcode TEXT DEFAULT '',
  unit TEXT DEFAULT 'pcs',
  qty REAL NOT NULL,
  unit_price REAL NOT NULL,
  unit_cost REAL DEFAULT 0,
  line_discount REAL DEFAULT 0,
  tax_rate REAL DEFAULT 0,
  tax_amount REAL DEFAULT 0,
  line_subtotal REAL DEFAULT 0,
  line_total REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  customer_id TEXT,
  invoice_id TEXT,
  type TEXT DEFAULT 'received',
  amount REAL NOT NULL,
  method TEXT DEFAULT 'cash',
  note TEXT DEFAULT '',
  pay_date TEXT NOT NULL,
  datetime TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  entry_type TEXT NOT NULL,
  invoice_id TEXT,
  payment_id TEXT,
  debit REAL DEFAULT 0,
  credit REAL DEFAULT 0,
  balance_after REAL DEFAULT 0,
  note TEXT DEFAULT '',
  datetime TEXT NOT NULL,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  type TEXT NOT NULL,
  delta REAL NOT NULL,
  qty_after REAL DEFAULT 0,
  cost_price REAL DEFAULT 0,
  ref_id TEXT,
  note TEXT DEFAULT '',
  datetime TEXT NOT NULL,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS sync_queue (
  id TEXT PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload TEXT,
  created_at TEXT,
  synced_at TEXT
);

-- returns = credit notes against a sold invoice (mart refunds)
CREATE TABLE IF NOT EXISTS returns (
  id TEXT PRIMARY KEY,
  return_no TEXT NOT NULL,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  customer_id TEXT,
  return_date TEXT NOT NULL,
  datetime TEXT NOT NULL,
  subtotal REAL DEFAULT 0,      -- taxable value being returned
  tax_total REAL DEFAULT 0,     -- GST reversed
  total REAL DEFAULT 0,         -- amount refunded
  cash_refund REAL DEFAULT 0,   -- money handed back
  credit_adjust REAL DEFAULT 0, -- outstanding credit reduced instead
  reason TEXT DEFAULT '',
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS return_items (
  id TEXT PRIMARY KEY,
  return_id TEXT NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  invoice_item_id TEXT NOT NULL REFERENCES invoice_items(id),
  product_id TEXT,
  name TEXT NOT NULL,
  unit TEXT DEFAULT 'pcs',
  qty REAL NOT NULL,
  unit_price REAL DEFAULT 0,
  unit_cost REAL DEFAULT 0,
  tax_rate REAL DEFAULT 0,
  tax_amount REAL DEFAULT 0,    -- GST reversed on this line
  line_subtotal REAL DEFAULT 0,
  line_total REAL DEFAULT 0,    -- money refunded for this line
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS stock_requests (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'purchase',
  qty REAL NOT NULL,
  cost_price REAL,
  note TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by TEXT,
  requested_by_name TEXT DEFAULT '',
  decided_by TEXT,
  decision_note TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

-- parked carts: a bill the cashier starts, holds, and resumes later
-- (device-local work in progress — deliberately NOT part of cloud sync or backup)
CREATE TABLE IF NOT EXISTS held_bills (
  id TEXT PRIMARY KEY,
  ref TEXT DEFAULT '',
  cart TEXT NOT NULL,
  discount TEXT DEFAULT '0',
  discount_mode TEXT DEFAULT 'amount',
  customer_id TEXT,
  paid TEXT DEFAULT '',
  method TEXT DEFAULT 'cash',
  total REAL DEFAULT 0,
  item_count REAL DEFAULT 0,
  loyalty_redeemed INTEGER DEFAULT 0,  -- star points parked with this bill
  coupon_code TEXT DEFAULT '',         -- coupon code parked with this bill
  coupon_discount REAL DEFAULT 0,      -- rupees it was worth
  created_by TEXT,
  created_by_name TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);

-- shop expenses (kharcha): rent, salaries, utilities, transport…
-- Head records them; the daily profit view nets them out of the picture
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  expense_date TEXT NOT NULL,
  datetime TEXT NOT NULL,
  category TEXT DEFAULT 'General',
  amount REAL NOT NULL,
  payment_method TEXT DEFAULT 'cash',
  note TEXT DEFAULT '',
  created_by TEXT,
  created_by_name TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);

-- discount codes the Head hands out (POS applies them at billing)
CREATE TABLE IF NOT EXISTS coupons (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  type TEXT DEFAULT 'fixed',      -- fixed = rupees off, percent = % of the bill
  value REAL NOT NULL,
  min_total REAL DEFAULT 0,
  max_uses INTEGER DEFAULT 0,     -- 0 = unlimited
  used_count INTEGER DEFAULT 0,
  starts_at TEXT DEFAULT '',
  ends_at TEXT DEFAULT '',
  active INTEGER DEFAULT 1,
  created_at TEXT,
  updated_at TEXT
);

-- per-person access rules: the Head's own overrides on top of the role defaults
-- (a row here wins over the role matrix — that is how control is handed out)
CREATE TABLE IF NOT EXISTS user_permissions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cap TEXT NOT NULL,
  allowed INTEGER NOT NULL,
  PRIMARY KEY (user_id, cap)
);

CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(sale_date);
CREATE INDEX IF NOT EXISTS idx_invoice_items_inv ON invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_ledger_customer ON ledger(customer_id);
CREATE INDEX IF NOT EXISTS idx_movements_product ON stock_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_queue_synced ON sync_queue(synced_at);
CREATE INDEX IF NOT EXISTS idx_returns_invoice ON returns(invoice_id);
CREATE INDEX IF NOT EXISTS idx_returns_date ON returns(return_date);
CREATE INDEX IF NOT EXISTS idx_return_items ON return_items(return_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
`);

// ---------- settings helpers ----------
export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

export function allSettings() {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}

// ---------- change tracking (for online sync) ----------
export function recordChange(entity, entityId, action, payload) {
  db.prepare(
    'INSERT INTO sync_queue (id, entity, entity_id, action, payload, created_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, NULL)'
  ).run(uuid(), entity, entityId, action, JSON.stringify(payload), now());
}

export function rowOf(table, id) {
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
}

// ---------- migrations for databases created by earlier versions ----------
{
  const itemCols = db.prepare('PRAGMA table_info(invoice_items)').all().map(c => c.name);
  if (!itemCols.includes('created_at')) {
    db.exec('ALTER TABLE invoice_items ADD COLUMN created_at TEXT');
    db.exec('UPDATE invoice_items SET created_at = COALESCE(created_at, (SELECT datetime FROM invoices WHERE id = invoice_items.id))');
  }
  // expiry dates for grocery stock (added after v1.0)
  const prodCols = db.prepare('PRAGMA table_info(products)').all().map(c => c.name);
  if (!prodCols.includes('expiry_date')) {
    db.exec("ALTER TABLE products ADD COLUMN expiry_date TEXT DEFAULT ''");
  }
  // loyalty points + coupon columns (added in v1.1)
  const custCols = db.prepare('PRAGMA table_info(customers)').all().map(c => c.name);
  if (!custCols.includes('loyalty_points')) {
    db.exec('ALTER TABLE customers ADD COLUMN loyalty_points REAL DEFAULT 0');
  }
  const invCols = db.prepare('PRAGMA table_info(invoices)').all().map(c => c.name);
  if (!invCols.includes('loyalty_redeemed')) db.exec('ALTER TABLE invoices ADD COLUMN loyalty_redeemed REAL DEFAULT 0');
  // no DEFAULT on purpose: rows written before this column existed read NULL and
  // are treated as "banked nothing" — a void must never invent points from today's rate
  if (!invCols.includes('loyalty_earned')) db.exec('ALTER TABLE invoices ADD COLUMN loyalty_earned REAL');
  if (!invCols.includes('coupon_code')) db.exec("ALTER TABLE invoices ADD COLUMN coupon_code TEXT DEFAULT ''");
  if (!invCols.includes('coupon_discount')) db.exec('ALTER TABLE invoices ADD COLUMN coupon_discount REAL DEFAULT 0');
  // offline bill replay key (added in v1.2) — NULL for bills taken online; the
  // unique index is what actually stops a replayed offline bill billing twice
  if (!invCols.includes('client_ref')) db.exec('ALTER TABLE invoices ADD COLUMN client_ref TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_client_ref ON invoices(client_ref)');
  // Google sign-in identity (added in v1.2) — NULL for password-only accounts,
  // so the unique index lets any number of them coexist
  const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!userCols.includes('email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)');
  // held-bill loyalty + coupon columns (added in v1.1)
  const heldCols = db.prepare('PRAGMA table_info(held_bills)').all().map(c => c.name);
  if (!heldCols.includes('loyalty_redeemed')) {
    db.exec('ALTER TABLE held_bills ADD COLUMN loyalty_redeemed INTEGER DEFAULT 0');
    db.exec("ALTER TABLE held_bills ADD COLUMN coupon_code TEXT DEFAULT ''");
    db.exec('ALTER TABLE held_bills ADD COLUMN coupon_discount REAL DEFAULT 0');
  }
}

// ---------- default settings + instance identity ----------
const defaults = {
  shop_name: 'My Shop',
  shop_address: '',
  shop_phone: '',
  gstin: '',
  currency_symbol: 'Rs.',
  currency_code: 'PKR',
  invoice_prefix: 'INV-',
  invoice_padding: '4',
  next_invoice_no: '1',
  return_prefix: 'RET-',
  next_return_no: '1',
  tax_label: 'GST',
  tax_split: '0', // Pakistan: single GST line (not CGST/SGST)
  round_off: '1',
  receipt_width: '80',
  receipt_footer: 'Thank you for your business!',
  terms: '',
  default_low_stock: '5',
  allow_credit: '1',
  allow_register: '1', // login page "Create account" requests (Settings → Users)
  loyalty_enabled: '1', // customers earn star points on every sale
  loyalty_earn: '1',    // points earned per 100 spent
  loyalty_value: '1',   // rupees each point is worth when redeemed
  instance_id: uuid(),
  sync_url: '',
  sync_key: '',
  last_sync: '',
  sync_cursor: ''
};
for (const [k, v] of Object.entries(defaults)) {
  if (getSetting(k) === null) setSetting(k, v);
}
