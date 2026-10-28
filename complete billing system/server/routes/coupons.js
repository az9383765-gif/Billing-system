import { Router } from 'express';
import { db, uuid, now, today, round2, rowOf, recordChange } from '../db.js';
import { requireAuth, requireCap, badRequest } from '../lib.js';

// ---------- coupons (discount codes) ----------
// The Head creates codes on the Settings page; the POS validates and applies
// them at billing. One shared evaluator guarantees the POS preview, the API
// validation and the final invoice can never disagree about a code.

const router = Router();
router.use(requireAuth);

function cleanCode(v) {
  return String(v || '').trim().toUpperCase();
}

// shared with the invoice route (named export) — used by /validate and POST /invoices
export function evaluateCoupon(codeInput, totalGross) {
  const code = cleanCode(codeInput);
  if (!/^[A-Z0-9_-]{3,20}$/.test(code)) {
    return { error: 'Coupon code must be 3-20 letters, numbers, - or _' };
  }
  const coupon = db.prepare('SELECT * FROM coupons WHERE code = ? COLLATE NOCASE').get(code);
  if (!coupon || !coupon.active) return { error: 'That coupon does not exist or is switched off' };
  const day = today();
  if (coupon.starts_at && day < coupon.starts_at) return { error: `This coupon starts on ${coupon.starts_at}` };
  if (coupon.ends_at && day > coupon.ends_at) return { error: `This coupon expired on ${coupon.ends_at}` };
  if (coupon.max_uses > 0 && coupon.used_count >= coupon.max_uses) return { error: 'This coupon has been fully used' };
  if (coupon.min_total > 0 && round2(totalGross) < round2(coupon.min_total)) {
    return { error: `This coupon needs a bill of at least ${round2(coupon.min_total)}` };
  }
  const discount = coupon.type === 'percent'
    ? round2(totalGross * Math.min(100, coupon.value) / 100)
    : round2(Math.min(coupon.value, totalGross));
  if (!(discount > 0)) return { error: 'This coupon gives nothing on this bill' };
  return { ok: true, coupon, discount };
}

function cleanCoupon(b, base = {}) {
  const code = cleanCode(b.code ?? base.code);
  if (!/^[A-Z0-9_-]{3,20}$/.test(code)) {
    return { error: 'Coupon code must be 3-20 letters, numbers, - or _' };
  }

  const type = (b.type ?? base.type ?? 'fixed') === 'percent' ? 'percent' : 'fixed';
  const value = round2(Number(b.value ?? base.value));
  if (!Number.isFinite(value) || value <= 0) return { error: 'Coupon value must be greater than 0' };
  if (type === 'percent' && value > 100) return { error: 'A percent coupon cannot be more than 100%' };

  const minTotal = round2(Number(b.min_total ?? base.min_total ?? 0));
  if (!Number.isFinite(minTotal) || minTotal < 0) return { error: 'Minimum bill cannot be negative' };

  const maxUses = Math.trunc(Number(b.max_uses ?? base.max_uses ?? 0));
  if (!Number.isFinite(maxUses) || maxUses < 0) return { error: 'Max uses cannot be negative' };

  const startsAt = String(b.starts_at ?? base.starts_at ?? '').trim();
  const endsAt = String(b.ends_at ?? base.ends_at ?? '').trim();
  for (const [label, d] of [['Start date', startsAt], ['End date', endsAt]]) {
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return { error: `${label} must be in YYYY-MM-DD format` };
  }
  if (startsAt && endsAt && endsAt < startsAt) return { error: 'The end date cannot be before the start date' };

  return { code, type, value, minTotal, maxUses, startsAt, endsAt };
}

// ---- POS: check a code against the current bill before applying ----
router.post('/validate', requireCap('invoices_create'), (req, res) => {
  const b = req.body || {};
  const total = Number(b.total);
  if (!Number.isFinite(total) || total < 0) return badRequest(res, 'Invalid bill total');
  const out = evaluateCoupon(b.code, total);
  if (out.error) return badRequest(res, out.error);
  res.json({ ok: true, code: out.coupon.code, discount: out.discount, type: out.coupon.type, value: out.coupon.value });
});

// ---- list (Head — Settings → Coupons) ----
router.get('/', requireCap('settings'), (req, res) => {
  res.json(db.prepare('SELECT * FROM coupons ORDER BY created_at DESC').all());
});

// ---- create ----
router.post('/', requireCap('settings'), (req, res) => {
  const v = cleanCoupon(req.body || {});
  if (v.error) return badRequest(res, v.error);
  const exists = db.prepare('SELECT id FROM coupons WHERE code = ? COLLATE NOCASE').get(v.code);
  if (exists) return badRequest(res, 'That coupon code already exists');

  const id = uuid();
  const datetime = now();
  db.prepare(
    `INSERT INTO coupons (id, code, type, value, min_total, max_uses, used_count, starts_at, ends_at, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?)`
  ).run(id, v.code, v.type, v.value, v.minTotal, v.maxUses, v.startsAt, v.endsAt, datetime, datetime);
  recordChange('coupons', id, 'insert', rowOf('coupons', id));
  res.json(rowOf('coupons', id));
});

// ---- update (partial: only the keys sent are changed) ----
router.put('/:id', requireCap('settings'), (req, res) => {
  const existing = rowOf('coupons', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Coupon not found' });
  const b = req.body || {};

  const patch = { ...existing };
  if (b.active !== undefined) patch.active = b.active ? 1 : 0;
  const touchesDefinition = ['code', 'type', 'value', 'min_total', 'max_uses', 'starts_at', 'ends_at']
    .some(k => b[k] !== undefined);
  if (touchesDefinition) {
    const v = cleanCoupon(b, existing);
    if (v.error) return badRequest(res, v.error);
    if (v.code !== existing.code) {
      const clash = db.prepare('SELECT id FROM coupons WHERE code = ? COLLATE NOCASE AND id != ?').get(v.code, existing.id);
      if (clash) return badRequest(res, 'That coupon code already exists');
    }
    patch.code = v.code;
    patch.type = v.type;
    patch.value = v.value;
    patch.min_total = v.minTotal;
    patch.max_uses = v.maxUses;
    patch.starts_at = v.startsAt;
    patch.ends_at = v.endsAt;
  }

  db.prepare(
    `UPDATE coupons SET code = ?, type = ?, value = ?, min_total = ?, max_uses = ?,
      starts_at = ?, ends_at = ?, active = ?, updated_at = ? WHERE id = ?`
  ).run(
    patch.code, patch.type, patch.value, patch.min_total, patch.max_uses,
    patch.starts_at, patch.ends_at, patch.active, now(), existing.id
  );
  recordChange('coupons', existing.id, 'update', rowOf('coupons', existing.id));
  res.json(rowOf('coupons', existing.id));
});

// ---- delete ----
router.delete('/:id', requireCap('settings'), (req, res) => {
  const info = db.prepare('DELETE FROM coupons WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Coupon not found' });
  recordChange('coupons', req.params.id, 'delete', { id: req.params.id });
  res.json({ ok: true });
});

export default router;
