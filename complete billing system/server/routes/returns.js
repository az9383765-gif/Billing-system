import { Router } from 'express';
import { db, uuid, now, today, getSetting, setSetting, recordChange, rowOf, round2 } from '../db.js';
import { requireAuth, requireCap, badRequest } from '../lib.js';

// Returns (credit notes) refund money back to a customer, so only the Head can
// create one — exactly like voiding a bill. Every role may read the history.
const router = Router();
router.use(requireAuth);

const canCreate = requireCap('returns');
const canView = requireCap('invoices_view');

function nextReturnNumber() {
  const current = Number(getSetting('next_return_no', '1') || 1);
  const padding = Number(getSetting('invoice_padding', '4') || 4);
  const prefix = getSetting('return_prefix', 'RET-');
  setSetting('next_return_no', String(current + 1));
  return `${prefix}${String(current).padStart(padding, '0')}`;
}

function customerBalance(customerId) {
  const r = db.prepare('SELECT COALESCE(SUM(debit - credit), 0) AS bal FROM ledger WHERE customer_id = ?').get(customerId);
  return round2(r.bal);
}

function alreadyReturned(invoiceItemId) {
  const r = db.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM return_items WHERE invoice_item_id = ?').get(invoiceItemId);
  return round2(r.q);
}

function alreadyRefunded(invoiceItemId) {
  const r = db.prepare('SELECT COALESCE(SUM(line_total), 0) AS t FROM return_items WHERE invoice_item_id = ?').get(invoiceItemId);
  return round2(r.t);
}

// ---------- create a return (refund) ----------
router.post('/', canCreate, (req, res) => {
  const b = req.body || {};
  const rows = Array.isArray(b.items) ? b.items : [];
  if (rows.length === 0) return badRequest(res, 'Choose at least one item to return');

  const invoice = rowOf('invoices', b.invoice_id);
  if (!invoice) return badRequest(res, 'Invoice not found');
  if (invoice.voided) return badRequest(res, 'A voided invoice cannot be returned — restore it first');

  const reason = String(b.reason || '').slice(0, 300);

  // ---- validate every line & work out the proportional refund ----
  const plan = [];
  for (const row of rows) {
    const item = rowOf('invoice_items', row.invoice_item_id);
    if (!item || item.invoice_id !== invoice.id) return badRequest(res, 'Item does not belong to this invoice');
    const qty = Number(row.qty);
    if (!Number.isFinite(qty) || qty <= 0) return badRequest(res, `Return quantity must be more than 0 for ${item.name}`);

    const maxQty = round2(item.qty - alreadyReturned(item.id));
    if (qty > maxQty + 1e-9) {
      return badRequest(res, maxQty <= 0
        ? `${item.name} has already been returned`
        : `Only ${maxQty} ${item.unit || 'pcs'} of ${item.name} can still be returned`);
    }

    // proportional to what the customer actually paid for that line
    // (net + tax after every discount — the same stored values the bill was made from)
    const ratio = item.qty > 0 ? qty / item.qty : 0;
    let rSub = round2(item.line_subtotal * ratio);
    let rTax = round2(item.tax_amount * ratio);
    let rTotal = round2(rSub + rTax);

    // never refund more than what is left on that line (rounding safety net)
    const refundableRem = round2(item.line_total - alreadyRefunded(item.id));
    if (rTotal > refundableRem) {
      rTotal = Math.max(0, refundableRem);
      rSub = round2(rTotal - rTax);
    }

    plan.push({ item, qty, rSub, rTax, rTotal });
  }

  const refundTotal = round2(plan.reduce((s, p) => s + p.rTotal, 0));
  const refundTaxable = round2(plan.reduce((s, p) => s + p.rSub, 0));
  const refundTax = round2(plan.reduce((s, p) => s + p.rTax, 0));
  if (refundTotal <= 0) return badRequest(res, 'Refund amount must be more than 0');

  // ---- split the refund: clear what the customer still owes first, pay the rest in cash ----
  const duePortion = invoice.customer_id && invoice.due_amount > 0
    ? Math.min(refundTotal, invoice.due_amount)
    : 0;
  const cashPortion = round2(refundTotal - duePortion);

  try {
    const result = db.transaction(() => {
      const id = uuid();
      const datetime = now();
      const returnDate = today();
      const returnNo = nextReturnNumber();

      db.prepare(
        `INSERT INTO returns (id, return_no, invoice_id, customer_id, return_date, datetime,
          subtotal, tax_total, total, cash_refund, credit_adjust, reason, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id, returnNo, invoice.id, invoice.customer_id, returnDate, datetime,
        refundTaxable, refundTax, refundTotal, cashPortion, duePortion, reason, req.user.id, datetime, datetime
      );

      // ---- loyalty: take back the points this refund would have earned ----
      // (redeemed points are NOT clawed back here — they were spent on the bill,
      //  and the customer already paid the difference in money)
      if (invoice.customer_id && getSetting('loyalty_enabled', '1') === '1') {
        const earnRate = Math.max(0, Number(getSetting('loyalty_earn', '1')) || 0);
        const giveBack = Math.floor(refundTotal * earnRate / 100);
        if (giveBack > 0) {
          db.prepare(
            'UPDATE customers SET loyalty_points = MAX(0, COALESCE(loyalty_points, 0) - ?), updated_at = ? WHERE id = ?'
          ).run(giveBack, datetime, invoice.customer_id);
          recordChange('customers', invoice.customer_id, 'update', rowOf('customers', invoice.customer_id));
        }
      }

      for (const p of plan) {
        const riId = uuid();
        db.prepare(
          `INSERT INTO return_items (id, return_id, invoice_item_id, product_id, name, unit, qty,
            unit_price, unit_cost, tax_rate, tax_amount, line_subtotal, line_total, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          riId, id, p.item.id, p.item.product_id, p.item.name, p.item.unit,
          p.qty, p.item.unit_price, p.item.unit_cost, p.item.tax_rate, p.rTax, p.rSub, p.rTotal, datetime
        );
        const riRow = rowOf('return_items', riId);
        recordChange('return_items', riId, 'insert', riRow);

        // ---- stock comes back ----
        if (p.item.product_id) {
          const product = rowOf('products', p.item.product_id);
          if (product) {
            const newQty = round2(product.stock_qty + p.qty);
            db.prepare('UPDATE products SET stock_qty = ?, updated_at = ? WHERE id = ?').run(newQty, datetime, product.id);
            db.prepare(
              `INSERT INTO stock_movements (id, product_id, type, delta, qty_after, cost_price, ref_id, note, datetime, created_at)
               VALUES (?, ?, 'return', ?, ?, ?, ?, ?, ?, ?)`
            ).run(uuid(), product.id, p.qty, newQty, p.item.unit_cost, id, `Return ${returnNo} / ${invoice.invoice_no}`, datetime, datetime);
            recordChange('products', product.id, 'update', rowOf('products', product.id));
          }
        }
      }

      // ---- invoice: outstanding credit falls first, then cash goes back ----
      const newDue = round2(invoice.due_amount - duePortion);
      const newPaid = round2(invoice.paid_amount - cashPortion);
      const status = newDue <= 0.009 ? 'paid' : newPaid > 0 ? 'partial' : 'credit';
      db.prepare('UPDATE invoices SET due_amount = ?, paid_amount = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(newDue, newPaid, status, datetime, invoice.id);
      recordChange('invoices', invoice.id, 'update', rowOf('invoices', invoice.id));

      if (cashPortion > 0) {
        const payId = uuid();
        db.prepare(
          `INSERT INTO payments (id, customer_id, invoice_id, type, amount, method, note, pay_date, datetime, created_at, updated_at)
           VALUES (?, ?, ?, 'refund', ?, 'cash', ?, ?, ?, ?, ?)`
        ).run(payId, invoice.customer_id, invoice.id, cashPortion, `Refund ${returnNo} (${invoice.invoice_no})`, returnDate, datetime, datetime, datetime);
        recordChange('payments', payId, 'insert', rowOf('payments', payId));
      }

      if (duePortion > 0) {
        const balance = customerBalance(invoice.customer_id);
        const newBalance = round2(balance - duePortion);
        const ledId = uuid();
        db.prepare(
          `INSERT INTO ledger (id, customer_id, entry_type, invoice_id, payment_id, debit, credit, balance_after, note, datetime, created_at)
           VALUES (?, ?, 'return', ?, NULL, 0, ?, ?, ?, ?, ?)`
        ).run(ledId, invoice.customer_id, invoice.id, duePortion, newBalance, `Return ${returnNo} against ${invoice.invoice_no}`, datetime, datetime);
        recordChange('ledger', ledId, 'insert', rowOf('ledger', ledId));
      }

      const retRow = rowOf('returns', id);
      recordChange('returns', id, 'insert', retRow);
      return id;
    })();

    const ret = rowOf('returns', result);
    const items = db.prepare('SELECT * FROM return_items WHERE return_id = ?').all(result);
    const freshInvoice = rowOf('invoices', invoice.id);
    res.json({ return: ret, items, invoice: freshInvoice });
  } catch (e) {
    console.error(e);
    return badRequest(res, 'Could not save the return: ' + e.message);
  }
});

// ---------- list ----------
router.get('/', canView, (req, res) => {
  const { invoice_id = '', limit = '200' } = req.query;
  const where = [];
  const params = [];
  if (invoice_id) { where.push('r.invoice_id = ?'); params.push(invoice_id); }
  const rows = db
    .prepare(
      `SELECT r.*, i.invoice_no, c.name AS customer_name,
              (SELECT COUNT(*) FROM return_items ri WHERE ri.return_id = r.id) AS item_count
       FROM returns r
       JOIN invoices i ON i.id = r.invoice_id
       LEFT JOIN customers c ON c.id = r.customer_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY r.datetime DESC LIMIT ?`
    )
    .all(...params, Math.min(Number(limit) || 200, 2000));
  res.json(rows);
});

// ---------- detail (for the printed refund note) ----------
router.get('/:id', canView, (req, res) => {
  const ret = rowOf('returns', req.params.id);
  if (!ret) return res.status(404).json({ error: 'Return not found' });
  const items = db.prepare('SELECT * FROM return_items WHERE return_id = ?').all(ret.id);
  const invoice = rowOf('invoices', ret.invoice_id);
  const customer = ret.customer_id ? rowOf('customers', ret.customer_id) : null;
  const settings = db.prepare("SELECT * FROM settings WHERE key IN ('shop_name','shop_address','shop_phone','gstin','currency_symbol','tax_label','tax_split','receipt_footer','terms','instance_id')").all();
  const shop = Object.fromEntries(settings.map(s => [s.key, s.value]));
  res.json({ return: ret, items, invoice, customer, shop });
});

export default router;
