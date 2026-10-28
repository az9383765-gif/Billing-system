import { Router } from 'express';
import { db, uuid, now, today, recordChange, rowOf, round2 } from '../db.js';
import { requireAuth, requireCap, badRequest, sendCsv } from '../lib.js';

const router = Router();
router.use(requireAuth);

const canDeleteCustomer = requireCap('customers_delete');

function customerBalance(customerId) {
  const r = db
    .prepare('SELECT COALESCE(SUM(debit - credit), 0) AS bal FROM ledger WHERE customer_id = ?')
    .get(customerId);
  return round2(r.bal);
}

function withBalance(row) {
  return { ...row, balance: customerBalance(row.id) };
}

router.get('/', (req, res) => {
  const { search = '' } = req.query;
  const rows = db
    .prepare(
      `SELECT * FROM customers
       ${search ? 'WHERE name LIKE ? OR phone LIKE ?' : ''}
       ORDER BY name LIMIT 1000`
    )
    .all(...(search ? [`%${search}%`, `%${search}%`] : []));
  res.json(rows.map(withBalance));
});

router.get('/export', (req, res) => {
  const rows = db.prepare('SELECT * FROM customers ORDER BY name').all();
  sendCsv(res, 'customers.csv',
    ['Name', 'Phone', 'Address', 'GSTIN', 'Credit Limit', 'Outstanding', 'Notes'],
    rows.map(r => [r.name, r.phone, r.address, r.gstin, r.credit_limit, customerBalance(r.id), r.notes]));
});

router.get('/:id', (req, res) => {
  const row = rowOf('customers', req.params.id);
  if (!row) return res.status(404).json({ error: 'Customer not found' });
  res.json(withBalance(row));
});

router.get('/:id/statement', (req, res) => {
  const customer = rowOf('customers', req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const entries = db
    .prepare('SELECT * FROM ledger WHERE customer_id = ? ORDER BY datetime DESC, created_at DESC LIMIT 500')
    .all(customer.id);
  const invoices = db
    .prepare(
      `SELECT id, invoice_no, sale_date, datetime, total, paid_amount, due_amount, status, voided
       FROM invoices WHERE customer_id = ? ORDER BY datetime DESC LIMIT 200`
    )
    .all(customer.id);
  const payments = db
    .prepare('SELECT * FROM payments WHERE customer_id = ? ORDER BY datetime DESC LIMIT 200')
    .all(customer.id);
  res.json({ customer: withBalance(customer), entries, invoices, payments });
});

router.post('/', (req, res) => {
  const b = req.body || {};
  const name = (b.name || '').trim();
  if (!name) return badRequest(res, 'Customer name is required');
  const id = uuid();
  db.prepare(
    `INSERT INTO customers (id, name, phone, address, gstin, credit_limit, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, b.phone || '', b.address || '', b.gstin || '', Number(b.credit_limit || 0), b.notes || '', now(), now());
  const row = rowOf('customers', id);
  recordChange('customers', id, 'insert', row);
  res.json({ ...row, balance: 0 });
});

router.put('/:id', (req, res) => {
  const customer = rowOf('customers', req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const b = { ...customer, ...(req.body || {}) };
  if (!(b.name || '').trim()) return badRequest(res, 'Customer name is required');
  db.prepare(
    `UPDATE customers SET name = ?, phone = ?, address = ?, gstin = ?, credit_limit = ?, notes = ?, updated_at = ?
     WHERE id = ?`
  ).run(b.name.trim(), b.phone || '', b.address || '', b.gstin || '', Number(b.credit_limit || 0), b.notes || '', now(), customer.id);
  const row = rowOf('customers', customer.id);
  recordChange('customers', customer.id, 'update', row);
  res.json(withBalance(row));
});

router.delete('/:id', canDeleteCustomer, (req, res) => {
  const customer = rowOf('customers', req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const used = db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE customer_id = ?').get(customer.id).n;
  const entries = db.prepare('SELECT COUNT(*) AS n FROM ledger WHERE customer_id = ?').get(customer.id).n;
  if (used > 0 || entries > 0) {
    return badRequest(res, 'Customer has invoices or credit history and cannot be deleted');
  }
  db.prepare('DELETE FROM customers WHERE id = ?').run(customer.id);
  recordChange('customers', customer.id, 'delete', { id: customer.id });
  res.json({ ok: true });
});

// ---------- collect credit payment (udhaar) ----------
router.post('/:id/payments', (req, res) => {
  const customer = rowOf('customers', req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const b = req.body || {};
  const amount = round2(Number(b.amount));
  if (!Number.isFinite(amount) || amount <= 0) return badRequest(res, 'Amount must be greater than 0');

  const balance = customerBalance(customer.id);
  if (amount > balance + 0.009 && !b.allow_advance) {
    return badRequest(res, `Amount exceeds outstanding balance of ${balance}. Pass allow_advance to accept advance payment.`);
  }

  const invoiceId = b.invoice_id || null;
  let invoice = null;
  if (invoiceId) {
    invoice = rowOf('invoices', invoiceId);
    if (!invoice || invoice.customer_id !== customer.id) return badRequest(res, 'Invoice not found for this customer');
    if (invoice.voided) return badRequest(res, 'Invoice is voided');
    if (amount > invoice.due_amount + 0.009) return badRequest(res, 'Amount is more than the invoice due amount');
  }

  const result = db.transaction(() => {
    const payId = uuid();
    const datetime = now();
    db.prepare(
      `INSERT INTO payments (id, customer_id, invoice_id, type, amount, method, note, pay_date, datetime, created_at, updated_at)
       VALUES (?, ?, ?, 'received', ?, ?, ?, ?, ?, ?, ?)`
    ).run(payId, customer.id, invoiceId, amount, b.method || 'cash', b.note || '', today(), datetime, datetime, datetime);

    if (invoice) {
      const paid = round2(Math.min(invoice.total, invoice.paid_amount + amount));
      const due = Math.max(0, round2(invoice.total - paid));
      db.prepare('UPDATE invoices SET paid_amount = ?, due_amount = ?, status = ?, updated_at = ? WHERE id = ?').run(
        paid, due, due <= 0.009 ? 'paid' : 'partial', datetime, invoice.id
      );
      recordChange('invoices', invoice.id, 'update', rowOf('invoices', invoice.id));
    }

    const current = customerBalance(customer.id);
    const newBalance = round2(current - amount);
    db.prepare(
      `INSERT INTO ledger (id, customer_id, entry_type, invoice_id, payment_id, debit, credit, balance_after, note, datetime, created_at)
       VALUES (?, ?, 'payment', ?, ?, 0, ?, ?, ?, ?, ?)`
    ).run(uuid(), customer.id, invoiceId, payId, amount, newBalance, invoice ? `Payment for ${invoice.invoice_no}` : 'Payment received', datetime, datetime);

    const payRow = rowOf('payments', payId);
    recordChange('payments', payId, 'insert', payRow);
    const ledgerRow = db.prepare('SELECT * FROM ledger WHERE payment_id = ?').get(payId);
    recordChange('ledger', ledgerRow.id, 'insert', ledgerRow);
    return { payment: payRow, balance: newBalance, invoice_id: invoiceId };
  })();

  res.json(result);
});

export default router;
