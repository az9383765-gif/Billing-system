import { Router } from 'express';
import { db, uuid, now } from '../db.js';
import { requireAuth, requireCap, badRequest } from '../lib.js';

// ---------- held (parked) bills ----------
// A cart the cashier parks mid-sale and resumes later. Device-local on purpose:
// it is work-in-progress for THIS till, so it never syncs and never enters backups
// (same policy as sessions and the sync queue).

const router = Router();
router.use(requireAuth);

function safeParseCart(raw) {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function shape(row) {
  return { ...row, cart: safeParseCart(row.cart) };
}

// list — light rows only (no cart payloads)
router.get('/', requireCap('invoices_create'), (req, res) => {
  const rows = db.prepare(
    `SELECT id, ref, total, item_count, customer_id, created_by_name, created_at
     FROM held_bills ORDER BY created_at DESC LIMIT 100`
  ).all();
  res.json(rows);
});

// park the current cart
router.post('/', requireCap('invoices_create'), (req, res) => {
  const b = req.body || {};
  const cart = Array.isArray(b.cart) ? b.cart : [];
  if (cart.length === 0) return badRequest(res, 'The cart is empty — nothing to hold');
  for (const l of cart) {
    if (!l || typeof l.id !== 'string' || !l.id) return badRequest(res, 'Held bill contains an invalid item');
    if (!(Number(l.qty) > 0)) return badRequest(res, 'Held bill quantities must be greater than 0');
    if (!(Number(l.price) >= 0)) return badRequest(res, 'Held bill prices cannot be negative');
  }

  const id = uuid();
  const datetime = now();
  const itemCount = cart.reduce((s, l) => s + Number(l.qty || 0), 0);
  db.prepare(
    `INSERT INTO held_bills (id, ref, cart, discount, discount_mode, customer_id, paid, method,
      total, item_count, loyalty_redeemed, coupon_code, coupon_discount,
      created_by, created_by_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    String(b.ref || '').trim().slice(0, 60),
    JSON.stringify(cart),
    String(b.discount ?? '0').slice(0, 20),
    b.discount_mode === 'percent' ? 'percent' : 'amount',
    b.customer_id || null,
    String(b.paid ?? '').slice(0, 20),
    ['cash', 'card', 'mobile'].includes(b.method) ? b.method : 'cash',
    Math.max(0, Number(b.total) || 0),
    itemCount,
    Math.max(0, Math.trunc(Number(b.loyalty_points) || 0)),
    String(b.coupon_code || '').trim().slice(0, 40),
    Math.max(0, Number(b.coupon_discount) || 0),
    req.user.id,
    req.user.name || req.user.username,
    datetime,
    datetime
  );
  const row = db.prepare('SELECT * FROM held_bills WHERE id = ?').get(id);
  res.json(shape(row));
});

// resume: the full cart
router.get('/:id', requireCap('invoices_create'), (req, res) => {
  const row = db.prepare('SELECT * FROM held_bills WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Held bill not found' });
  res.json(shape(row));
});

// discard
router.delete('/:id', requireCap('invoices_create'), (req, res) => {
  const info = db.prepare('DELETE FROM held_bills WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Held bill not found' });
  res.json({ ok: true });
});

export default router;
