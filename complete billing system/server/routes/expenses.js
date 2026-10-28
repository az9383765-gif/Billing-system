import { Router } from 'express';
import { db, uuid, now, today, round2, rowOf, recordChange } from '../db.js';
import { requireAuth, requireCap, badRequest } from '../lib.js';

// ---------- shop expenses (kharcha) ----------
// The Head keeps the shop's running costs here; reports net them out of profit.

const router = Router();
router.use(requireAuth);

const METHODS = ['cash', 'card', 'mobile', 'bank'];

function cleanExpense(b, base = {}) {
  const date = String(b.expense_date ?? base.expense_date ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Date must be in YYYY-MM-DD format' };

  const amount = round2(Number(b.amount ?? base.amount));
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'Amount must be greater than 0' };
  if (amount > 999999999) return { error: 'Amount is too large' };

  const category = String(b.category ?? base.category ?? 'General').trim().slice(0, 40) || 'General';
  const note = String(b.note ?? base.note ?? '').trim().slice(0, 200);
  const method = b.payment_method ?? base.payment_method ?? 'cash';
  if (!METHODS.includes(method)) return { error: 'Payment method must be cash, card, mobile or bank' };

  return { date, amount, category, note, method };
}

// list (newest first) — ?from= ?to= ?category= ?limit=
router.get('/', requireCap('expenses_view'), (req, res) => {
  const { from = '', to = '', category = '', limit = '500' } = req.query;
  const where = [];
  const params = [];
  if (from) { where.push('expense_date >= ?'); params.push(from); }
  if (to) { where.push('expense_date <= ?'); params.push(to); }
  if (category) { where.push('category = ?'); params.push(category); }
  const rows = db.prepare(
    `SELECT * FROM expenses
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY expense_date DESC, datetime DESC LIMIT ?`
  ).all(...params, Math.min(Number(limit) || 500, 5000));
  res.json(rows);
});

// create
router.post('/', requireCap('expenses_manage'), (req, res) => {
  const v = cleanExpense(req.body || {});
  if (v.error) return badRequest(res, v.error);

  const id = uuid();
  const datetime = now();
  db.prepare(
    `INSERT INTO expenses (id, expense_date, datetime, category, amount, payment_method, note,
      created_by, created_by_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, v.date || today(), datetime, v.category, v.amount, v.method, v.note,
    req.user.id, req.user.name || req.user.username, datetime, datetime
  );
  recordChange('expenses', id, 'insert', rowOf('expenses', id));
  res.json(rowOf('expenses', id));
});

// update
router.put('/:id', requireCap('expenses_manage'), (req, res) => {
  const existing = rowOf('expenses', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Expense not found' });

  const v = cleanExpense(req.body || {}, existing);
  if (v.error) return badRequest(res, v.error);

  db.prepare(
    'UPDATE expenses SET expense_date = ?, category = ?, amount = ?, payment_method = ?, note = ?, updated_at = ? WHERE id = ?'
  ).run(v.date, v.category, v.amount, v.method, v.note, now(), existing.id);
  recordChange('expenses', existing.id, 'update', rowOf('expenses', existing.id));
  res.json(rowOf('expenses', existing.id));
});

// delete
router.delete('/:id', requireCap('expenses_manage'), (req, res) => {
  const info = db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Expense not found' });
  recordChange('expenses', req.params.id, 'delete', { id: req.params.id });
  res.json({ ok: true });
});

export default router;
