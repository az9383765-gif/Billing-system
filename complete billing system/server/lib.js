import crypto from 'crypto';
import { db, uuid, now, getSetting } from './db.js';

// ---------- password hashing (scrypt) ----------
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  try {
    const [salt, hash] = String(stored).split(':');
    const test = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
  } catch {
    return false;
  }
}

// ---------- sessions ----------
export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const at = now();
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(); // 30 days
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    token, userId, at, expires
  );
  // open this sign-in's duty row — "hours logged in" is counted from here
  db.prepare('INSERT INTO login_sessions (id, user_id, token, login_at, last_seen) VALUES (?, ?, ?, ?, ?)').run(
    uuid(), userId, token, at, at
  );
  return { token, expires_at: expires };
}

export function destroySession(token) {
  // seal the duty row so the hours stop here, then drop the session
  db.prepare('UPDATE login_sessions SET logout_at = ? WHERE token = ? AND logout_at IS NULL').run(now(), token);
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function cleanSessions() {
  const t = now();
  // a session that expired without a logout (browser closed, machine off) —
  // close its duty row at the last time that browser answered, not at expiry,
  // so an abandoned till never banks hours nobody worked
  db.prepare(
    `UPDATE login_sessions SET logout_at = COALESCE(last_seen, login_at)
     WHERE logout_at IS NULL AND token IN (SELECT token FROM sessions WHERE expires_at < ?)`
  ).run(t);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);
}

// ---------- duty log: how long each person has really been signed in ----------
// The app pings once a minute while a till is open; every ping moves last_seen.
// Time counts login_at -> logout_at, and for a session still open, up to its
// last heartbeat (plus the ping interval) — never to "now", so a tab left open
// overnight on a dead machine does not become 9 hours of "work".
export const PING_INTERVAL_MS = 60 * 1000;
const HEARTBEAT_GRACE_MS = PING_INTERVAL_MS * 2;

export function touchDuty(token) {
  db.prepare('UPDATE login_sessions SET last_seen = ? WHERE token = ? AND logout_at IS NULL').run(now(), token);
}

// per-user totals: { user_id: { online, seconds, seconds_today, last_seen } }
export function dutyTotals() {
  const nowMs = Date.now();
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const dayStartMs = todayStart.getTime();
  const out = {};
  for (const r of db.prepare('SELECT user_id, login_at, last_seen, logout_at FROM login_sessions').all()) {
    const startMs = Date.parse(r.login_at);
    if (!Number.isFinite(startMs)) continue;
    const seenMs = Date.parse(r.last_seen || r.login_at);
    const endMs = r.logout_at
      ? Date.parse(r.logout_at)
      : Math.min(nowMs, Number.isFinite(seenMs) ? seenMs + HEARTBEAT_GRACE_MS : startMs);
    const online = !r.logout_at && Number.isFinite(seenMs) && (nowMs - seenMs) <= HEARTBEAT_GRACE_MS;
    const seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
    const secondsToday = Math.max(0, Math.round((Math.max(startMs, dayStartMs) <= endMs
      ? Math.min(endMs, nowMs) - Math.max(startMs, dayStartMs)
      : 0) / 1000));
    const e = out[r.user_id] || { online: false, seconds: 0, seconds_today: 0, last_seen: null };
    e.seconds += seconds;
    e.seconds_today += secondsToday;
    e.online = e.online || online;
    if (Number.isFinite(seenMs) && (!e.last_seen || seenMs > Date.parse(e.last_seen))) e.last_seen = r.last_seen;
    out[r.user_id] = e;
  }
  return out;
}

// ---------- login brute-force protection (in-memory) ----------
// key -> { fails, lockedUntil }. A key is "username|..." and/or "ip|..." so both
// dictionary attacks on one account and password spraying from one machine stop.
const LOCK_MS = 5 * 60 * 1000;
const attempts = new Map();

function entryOf(key) {
  let e = attempts.get(key);
  if (!e) { e = { fails: 0, lockedUntil: 0 }; attempts.set(key, e); }
  if (attempts.size > 5000) attempts.clear(); // safety valve, never grow without bound
  return e;
}

// keys: [[key, maxFailedAttempts], ...] -> seconds to wait (0 = not locked)
export function throttleWait(keys) {
  const nowMs = Date.now();
  for (const [key] of keys) {
    const e = attempts.get(key);
    if (e && e.lockedUntil > nowMs) return Math.ceil((e.lockedUntil - nowMs) / 1000);
  }
  return 0;
}

export function noteLoginFailure(keys) {
  for (const [key, max] of keys) {
    const e = entryOf(key);
    e.fails += 1;
    if (e.fails >= max) { e.lockedUntil = Date.now() + LOCK_MS; e.fails = 0; }
  }
}

export function clearLoginFailures(keys) {
  for (const [key] of keys) attempts.delete(key);
}

// ---------- express middleware ----------
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token || '');
  if (!token) return res.status(401).json({ error: 'Login required' });
  const row = db
    .prepare(
      `SELECT s.token, s.expires_at, u.id, u.username, u.name, u.role, u.active
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .get(token);
  if (!row || row.expires_at < now() || !row.active) {
    return res.status(401).json({ error: 'Session expired, please login again' });
  }
  req.user = { id: row.id, username: row.username, name: row.name, role: row.role };
  req.user.perms = permsFor(row.id); // this account's overrides over the role matrix
  req.token = token;
  next();
}

// ---------- per-person access rules (the Head's own hand-outs) ----------
// A row in user_permissions beats the role default — for the API (requireCap)
// and for the signed-in UI (login/me carry the same map as user.perms).
export function permsFor(userId) {
  const out = {};
  for (const r of db.prepare('SELECT cap, allowed FROM user_permissions WHERE user_id = ?').all(userId)) {
    out[r.cap] = r.allowed === 1;
  }
  return out;
}

export function allows(user, cap) {
  const p = user && user.perms;
  if (p && Object.prototype.hasOwnProperty.call(p, cap)) return Boolean(p[cap]);
  return can(user.role, cap);
}

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin permission required' });
  }
  next();
}

// ---------- roles & permissions (Head / Inventory Manager / Cashier) ----------
export const ROLES = ['admin', 'inventory', 'cashier'];
export const ROLE_LABELS = { admin: 'Head', inventory: 'Inventory Manager', cashier: 'Cashier' };

export const ALL_CAPS = [
  'products_manage',   // create / edit / delete products and categories
  'stock_add',         // enter stock directly (purchase / adjustment)
  'stock_request',     // submit a stock entry that waits for approval
  'stock_approve',     // approve or reject stock requests
  'stock_view',        // movements, valuation, CSV
  'lowstock_view',     // see what is running out (everyone — POS shows it)
  'reports_view',      // sales reports
  'invoices_create',   // make a bill at the POS
  'invoices_view',     // list / open / reprint bills
  'invoices_void',     // cancel a bill
  'returns',           // refund a sold item (money leaves the till — Head only)
  'invoices_export',   // invoice CSV
  'customers_manage',  // add / edit customers, collect udhaar
  'customers_delete',  // remove a customer
  'settings',          // shop settings + backup
  'users',             // decide who may log in (Head only)
  'expenses_view',     // read the shop's expenses (kharcha)
  'expenses_manage',   // add / edit / delete expenses
  'sync'               // cloud sync
];

const MATRIX = {
  // Head controls everything and every person
  admin: new Set(ALL_CAPS),

  // Inventory Manager: adds stock (pending Head approval) + reads sales reports
  inventory: new Set([
    'stock_request', 'stock_view', 'lowstock_view', 'reports_view',
    'invoices_create', 'invoices_view', 'invoices_export',
    'customers_manage'
  ]),

  // Cashier: scans, bills, prints, sees low stock
  cashier: new Set([
    'lowstock_view', 'invoices_create', 'invoices_view', 'customers_manage'
  ])
};

export function can(role, cap) {
  const set = MATRIX[role];
  return Boolean(set && set.has(cap));
}

// middleware factory — must run after requireAuth (it reads req.user)
export function requireCap(cap) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Login required' });
    if (!allows(req.user, cap)) {
      const who = ROLE_LABELS[req.user.role] || req.user.role;
      return res.status(403).json({ error: `Not allowed for your role (${who})` });
    }
    next();
  };
}

// ---------- sync key check (device -> cloud) ----------
export function checkSyncKey(req, res, next) {
  const key = req.headers['x-sync-key'] || req.body?.sync_key || '';
  const expected = getSetting('sync_key');
  if (!expected) return res.status(403).json({ error: 'Cloud sync is not enabled' });
  if (String(key) !== expected) return res.status(403).json({ error: 'Invalid sync key' });
  next();
}

// ---------- helpers ----------
export function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

export function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function sendCsv(res, filename, headers, rows) {
  const lines = [headers.map(csvEscape).join(',')];
  for (const r of rows) lines.push(r.map(csvEscape).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + lines.join('\n'));
}

export function newId() {
  return uuid();
}
