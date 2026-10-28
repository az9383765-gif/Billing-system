import { Router } from 'express';
import { db, uuid, now, today, getSetting, setSetting, recordChange, rowOf, round2 } from '../db.js';
import { invoiceCalc, lineCalc } from '../../shared/calc.js';
import { evaluateCoupon } from './coupons.js';
import { requireAuth, requireCap, badRequest, sendCsv } from '../lib.js';

const router = Router();
router.use(requireAuth);

const canCreate = requireCap('invoices_create');
const canVoid = requireCap('invoices_void');
const canExport = requireCap('invoices_export');

function nextInvoiceNumber() {
  const current = Number(getSetting('next_invoice_no', '1') || 1);
  const padding = Number(getSetting('invoice_padding', '4') || 4);
  const prefix = getSetting('invoice_prefix', 'INV-');
  setSetting('next_invoice_no', String(current + 1));
  return `${prefix}${String(current).padStart(padding, '0')}`;
}

function customerBalance(customerId) {
  const r = db.prepare('SELECT COALESCE(SUM(debit - credit), 0) AS bal FROM ledger WHERE customer_id = ?').get(customerId);
  return round2(r.bal);
}

// ---------- create sale ----------
router.post('/', canCreate, (req, res) => {
  const b = req.body || {};

  // offline billing: a bill queued on a disconnected device carries a unique
  // ref. If the network hiccuped after the server stored it, the replay (or a
  // double click) must return the SAME invoice — never bill twice.
  const clientRef = String(b.client_ref || '').trim().slice(0, 64) || null;
  if (clientRef) {
    const existing = db.prepare('SELECT id, invoice_no FROM invoices WHERE client_ref = ?').get(clientRef);
    if (existing) return res.json({ invoice: existing, duplicate: true });
  }

  const items = Array.isArray(b.items) ? b.items : [];
  if (items.length === 0) return badRequest(res, 'Cart is empty');

  const invoiceDiscount = round2(Number(b.discount || 0));
  if (!Number.isFinite(invoiceDiscount) || invoiceDiscount < 0) return badRequest(res, 'Discount cannot be negative');

  const customerId = b.customer_id || null;
  let customer = null;
  if (customerId) {
    customer = rowOf('customers', customerId);
    if (!customer) return badRequest(res, 'Customer not found');
  }

  const allowNegative = getSetting('allow_negative_stock', '0') === '1';
  const allowCredit = getSetting('allow_credit', '1') === '1';

  // ---- load products & validate (the money maths lives in shared/calc.js) ----
  const rawItems = [];
  const productCache = new Map(); // each product row is read once, however many lines carry it
  const agg = new Map();          // product id -> { product, qty } — the TOTAL this bill takes
  for (const item of items) {
    if (!productCache.has(item.product_id)) productCache.set(item.product_id, rowOf('products', item.product_id));
    const product = productCache.get(item.product_id);
    if (!product || !product.is_active) return badRequest(res, 'Product not found or inactive');
    const qty = Number(item.qty);
    if (!Number.isFinite(qty) || qty <= 0) return badRequest(res, `Quantity must be greater than 0 for ${product.name}`);
    const unitPrice = item.unit_price !== undefined && item.unit_price !== '' ? Number(item.unit_price) : product.price;
    if (!Number.isFinite(unitPrice) || unitPrice < 0) return badRequest(res, `Invalid price for ${product.name}`);
    const lineDiscount = round2(Number(item.discount || 0));
    if (!Number.isFinite(lineDiscount) || lineDiscount < 0) return badRequest(res, `Discount cannot be negative for ${product.name}`);
    if (lineDiscount > round2(qty * unitPrice)) return badRequest(res, `Discount is more than line total for ${product.name}`);
    const running = agg.get(product.id) || { product, qty: 0 };
    running.qty += qty;
    agg.set(product.id, running);
    rawItems.push({
      product, qty, unit_price: unitPrice, discount: lineDiscount,
      tax_rate: product.tax_rate, tax_inclusive: Boolean(product.tax_inclusive)
    });
  }

  // the same product can appear on many lines — stock is checked against the TOTAL,
  // so a 10,000-line bill can never oversell what a per-line check would miss
  if (!allowNegative) {
    for (const { product, qty } of agg.values()) {
      if (product.stock_qty < qty) {
        return badRequest(res, `Insufficient stock for ${product.name} (available: ${product.stock_qty}, needed: ${round2(qty)})`);
      }
    }
  }

  const totalGross = round2(rawItems.reduce((s, r) => s + lineCalc(r).total, 0));
  if (invoiceDiscount > totalGross) return badRequest(res, 'Invoice discount is more than the invoice value');

  // ---- loyalty points the customer wants to spend on this bill ----
  const loyaltyOn = getSetting('loyalty_enabled', '1') === '1';
  const loyaltyValue = Math.max(0, Number(getSetting('loyalty_value', '1')) || 0);
  const loyaltyRate = Math.max(0, Number(getSetting('loyalty_earn', '1')) || 0);

  let loyaltyRedeem = Math.trunc(Number(b.loyalty_points || 0));
  if (!Number.isFinite(loyaltyRedeem) || loyaltyRedeem < 0) return badRequest(res, 'Invalid loyalty points');
  if (loyaltyRedeem > 0) {
    if (!loyaltyOn) return badRequest(res, 'Loyalty points are switched off');
    if (!customer) return badRequest(res, 'Select the customer who owns these points');
    const balance = Math.floor(Number(customer.loyalty_points || 0));
    if (loyaltyRedeem > balance) {
      return badRequest(res, `Only ${balance} points available for ${customer.name}`);
    }
  }
  const loyaltyRupees = round2(loyaltyRedeem * loyaltyValue);

  // ---- coupon code the cashier typed (same evaluator the POS validated with) ----
  let couponRow = null;
  let couponRupees = 0;
  if (String(b.coupon_code || '').trim() !== '') {
    const ev = evaluateCoupon(b.coupon_code, totalGross);
    if (ev.error) return badRequest(res, ev.error);
    couponRow = ev.coupon;
    couponRupees = ev.discount;
  }

  // the manual discount, the points and the coupon all reduce the bill together
  const combinedDiscount = round2(invoiceDiscount + loyaltyRupees + couponRupees);
  if (combinedDiscount > totalGross) return badRequest(res, 'Discount is more than the invoice value');

  // ---- one GST engine for the API, the POS screen and the printed bill ----
  const calc = invoiceCalc({
    items: rawItems,
    discount: combinedDiscount,
    round_off: getSetting('round_off', '1') === '1'
  });
  const lines = calc.lines.map((l, i) => ({ ...l, product: rawItems[i].product }));
  const subtotal = calc.subtotal;     // GST-exclusive (taxable) value
  const taxTotal = calc.taxTotal;     // total GST
  const total = calc.total;
  const roundOff = calc.roundOff;

  let paid = round2(Number(b.paid !== undefined ? b.paid : total));
  if (!Number.isFinite(paid) || paid < 0) return badRequest(res, 'Invalid paid amount');
  if (paid > total) paid = total;
  const due = round2(total - paid);
  const paymentMethod = paid >= total ? (b.payment_method || 'cash') : (paid > 0 ? (b.payment_method || 'cash') : 'credit');

  if (due > 0) {
    if (!customer) return badRequest(res, 'Credit sale requires a customer account');
    if (!allowCredit) return badRequest(res, 'Credit sales are disabled');
    const limit = Number(customer.credit_limit || 0);
    if (limit > 0) {
      const newBal = round2(customerBalance(customer.id) + due);
      if (newBal > limit) {
        return badRequest(res, `Credit limit exceeded for ${customer.name} (limit: ${limit}, balance would be: ${newBal})`);
      }
    }
  }

  const status = due <= 0.009 ? 'paid' : paid > 0 ? 'partial' : 'credit';
  // what the customer actually saved: every line discount plus the bill discount
  // those lines are carrying (the engine already split the bill discount across them)
  const totalDiscount = round2(lines.reduce((s, l) => s + l.total_discount, 0));

  // what this bill will bank for the customer — captured now so the invoice
  // remembers it even if the earn rate changes before a void unwinds the sale
  const earnedPoints = customerId && loyaltyOn && loyaltyRate > 0
    ? Math.floor(total * loyaltyRate / 100)
    : 0;

  // ---- persist ----
  try {
    const result = db.transaction(() => {
      const id = uuid();
      const datetime = now();
      const saleDate = today();
      const invoiceNo = nextInvoiceNumber();

      db.prepare(
        `INSERT INTO invoices (id, invoice_no, customer_id, sale_date, datetime, subtotal, discount, tax_total,
          round_off, total, paid_amount, due_amount, payment_method, status, notes,
          loyalty_redeemed, loyalty_earned, coupon_code, coupon_discount, client_ref,
          voided, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
      ).run(
        id, invoiceNo, customerId, saleDate, datetime, subtotal, totalDiscount, taxTotal,
        roundOff, total, paid, due, paymentMethod, status, b.notes || '',
        loyaltyRedeem, earnedPoints, couponRow ? couponRow.code : '', couponRupees, clientRef,
        req.user.id, datetime, datetime
      );

      // ---- loyalty: points spent now, points earned on this bill ----
      if (loyaltyRedeem > 0 || earnedPoints > 0) {
        db.prepare(
          'UPDATE customers SET loyalty_points = MAX(0, COALESCE(loyalty_points, 0) - ?) + ?, updated_at = ? WHERE id = ?'
        ).run(loyaltyRedeem, earnedPoints, datetime, customerId);
        recordChange('customers', customerId, 'update', rowOf('customers', customerId));
      }

      // ---- coupon: count the use so max_uses means something ----
      if (couponRow) {
        db.prepare('UPDATE coupons SET used_count = used_count + 1, updated_at = ? WHERE id = ?')
          .run(datetime, couponRow.id);
        recordChange('coupons', couponRow.id, 'update', rowOf('coupons', couponRow.id));
      }

      for (const l of lines) {
        db.prepare(
          `INSERT INTO invoice_items (id, invoice_id, product_id, name, barcode, unit, qty, unit_price, unit_cost,
            line_discount, tax_rate, tax_amount, line_subtotal, line_total, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          uuid(), id, l.product.id, l.product.name, l.product.barcode, l.product.unit,
          l.qty, l.unit_price, l.product.cost_price, l.total_discount,
          l.tax_rate, l.tax, l.net, l.total_after_discount, datetime
        );
      }

      // ---- stock moves ONCE per product, summed over every line that carries it ----
      // (deducting per line from the pre-sale row would leave the wrong final stock
      //  whenever the same product is billed more than once in one cart)
      for (const { product, qty } of agg.values()) {
        const newQty = round2(product.stock_qty - qty);
        db.prepare('UPDATE products SET stock_qty = ?, updated_at = ? WHERE id = ?').run(newQty, datetime, product.id);
        db.prepare(
          `INSERT INTO stock_movements (id, product_id, type, delta, qty_after, cost_price, ref_id, note, datetime, created_at)
           VALUES (?, ?, 'sale', ?, ?, ?, ?, ?, ?, ?)`
        ).run(uuid(), product.id, -qty, newQty, product.cost_price, id, `Sale ${invoiceNo}`, datetime, datetime);
        recordChange('products', product.id, 'update', rowOf('products', product.id));
      }

      if (paid > 0) {
        db.prepare(
          `INSERT INTO payments (id, customer_id, invoice_id, type, amount, method, note, pay_date, datetime, created_at, updated_at)
           VALUES (?, ?, ?, 'received', ?, ?, ?, ?, ?, ?, ?)`
        ).run(uuid(), customerId, id, paid, paymentMethod, 'Invoice payment', saleDate, datetime, datetime, datetime);
        const payRow = db.prepare('SELECT * FROM payments WHERE invoice_id = ?').get(id);
        recordChange('payments', payRow.id, 'insert', payRow);
      }

      if (due > 0 && customerId) {
        const balance = customerBalance(customerId);
        const newBalance = round2(balance + due);
        const ledId = uuid();
        db.prepare(
          `INSERT INTO ledger (id, customer_id, entry_type, invoice_id, payment_id, debit, credit, balance_after, note, datetime, created_at)
           VALUES (?, ?, 'sale', ?, NULL, ?, 0, ?, ?, ?, ?)`
        ).run(ledId, customerId, id, due, newBalance, `Credit sale ${invoiceNo}`, datetime, datetime);
        recordChange('ledger', ledId, 'insert', rowOf('ledger', ledId));
      }

      recordChange('invoices', id, 'insert', rowOf('invoices', id));
      for (const item of db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(id)) {
        recordChange('invoice_items', item.id, 'insert', item);
      }
      return id;
    })();

    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(result);
    const savedItems = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(result);
    res.json({ invoice, items: savedItems });
  } catch (e) {
    console.error(e);
    return badRequest(res, 'Could not save invoice: ' + e.message);
  }
});

// ---------- list ----------
router.get('/', (req, res) => {
  const { from = '', to = '', customer_id = '', status = '', search = '', voided = '', limit = '200' } = req.query;
  const where = [];
  const params = [];
  if (from) { where.push('i.sale_date >= ?'); params.push(from); }
  if (to) { where.push('i.sale_date <= ?'); params.push(to); }
  if (customer_id) { where.push('i.customer_id = ?'); params.push(customer_id); }
  if (status) { where.push('i.status = ?'); params.push(status); }
  if (voided !== '') { where.push('i.voided = ?'); params.push(voided === '1' ? 1 : 0); }
  if (search) {
    where.push('(i.invoice_no LIKE ? OR c.name LIKE ? OR c.phone LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const rows = db
    .prepare(
      `SELECT i.*, c.name AS customer_name, c.phone AS customer_phone,
              (SELECT COUNT(*) FROM invoice_items ii WHERE ii.invoice_id = i.id) AS item_count,
              (SELECT COALESCE(SUM(r.total), 0) FROM returns r WHERE r.invoice_id = i.id) AS returned_total
       FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY i.datetime DESC LIMIT ?`
    )
    .all(...params, Math.min(Number(limit) || 200, 2000));
  res.json(rows);
});

// ---------- export ----------
router.get('/export', canExport, (req, res) => {
  const { from = '', to = '' } = req.query;
  const where = [];
  const params = [];
  if (from) { where.push('i.sale_date >= ?'); params.push(from); }
  if (to) { where.push('i.sale_date <= ?'); params.push(to); }
  const rows = db
    .prepare(
      `SELECT i.invoice_no, i.sale_date, i.datetime, c.name AS customer, i.subtotal, i.discount, i.tax_total,
              i.round_off, i.total, i.paid_amount, i.due_amount, i.payment_method, i.status, i.voided
       FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY i.datetime DESC`
    )
    .all(...params);
  sendCsv(res, 'invoices.csv',
    ['Invoice No', 'Date', 'Time', 'Customer', 'Subtotal', 'Discount', 'Tax', 'Round Off', 'Total', 'Paid', 'Due', 'Method', 'Status', 'Voided'],
    rows.map(r => [r.invoice_no, r.sale_date, r.datetime, r.customer, r.subtotal, r.discount, r.tax_total, r.round_off, r.total, r.paid_amount, r.due_amount, r.payment_method, r.voided ? 'voided' : r.status]));
});

// ---------- detail ----------
router.get('/:id', (req, res) => {
  const invoice = rowOf('invoices', req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(invoice.id);
  // how much of each line has already been refunded (drives the Return form)
  for (const item of items) {
    const r = db.prepare('SELECT COALESCE(SUM(qty), 0) AS q, COALESCE(SUM(line_total), 0) AS t FROM return_items WHERE invoice_item_id = ?').get(item.id);
    item.returned_qty = round2(r.q);
    item.returned_amount = round2(r.t);
  }
  const customer = invoice.customer_id ? rowOf('customers', invoice.customer_id) : null;
  const payments = db.prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY datetime').all(invoice.id);
  const returns = db.prepare('SELECT * FROM returns WHERE invoice_id = ? ORDER BY datetime').all(invoice.id);
  const settings = db.prepare("SELECT * FROM settings WHERE key IN ('shop_name','shop_address','shop_phone','gstin','currency_symbol','tax_label','tax_split','receipt_footer','terms','instance_id')").all();
  const shop = Object.fromEntries(settings.map(s => [s.key, s.value]));
  res.json({ invoice, items, customer, payments, returns, shop });
});

// ---------- void ----------
router.post('/:id/void', canVoid, (req, res) => {
  const invoice = rowOf('invoices', req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (invoice.voided) return badRequest(res, 'Invoice is already voided');
  // a returned (partially refunded) bill must not be voided — the stock and the
  // money were already given back once; voiding would restore them a second time
  const returnedCount = db.prepare('SELECT COUNT(*) AS n FROM returns WHERE invoice_id = ?').get(invoice.id).n;
  if (returnedCount > 0) return badRequest(res, 'This invoice has returns (credit notes) and cannot be voided');

  try {
    db.transaction(() => {
      // re-check inside the transaction: a double click / concurrent request
      // must never restore stock twice for the same invoice
      const fresh = db.prepare('SELECT voided FROM invoices WHERE id = ?').get(invoice.id);
      if (!fresh || fresh.voided) throw new Error('Invoice is already voided');

      const datetime = now();
      db.prepare('UPDATE invoices SET voided = 1, updated_at = ? WHERE id = ?').run(datetime, invoice.id);

      for (const item of db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(invoice.id)) {
        if (!item.product_id) continue;
        const product = rowOf('products', item.product_id);
        if (!product) continue;
        const newQty = round2(product.stock_qty + item.qty);
        db.prepare('UPDATE products SET stock_qty = ?, updated_at = ? WHERE id = ?').run(newQty, datetime, product.id);
        db.prepare(
          `INSERT INTO stock_movements (id, product_id, type, delta, qty_after, cost_price, ref_id, note, datetime, created_at)
           VALUES (?, ?, 'return', ?, ?, ?, ?, ?, ?, ?)`
        ).run(uuid(), product.id, item.qty, newQty, item.unit_cost, invoice.id, `Void ${invoice.invoice_no}`, datetime, datetime);
        recordChange('products', product.id, 'update', rowOf('products', product.id));
      }

      if (invoice.due_amount > 0 && invoice.customer_id) {
        const balance = customerBalance(invoice.customer_id);
        const newBalance = round2(balance - invoice.due_amount);
        const ledId = uuid();
        db.prepare(
          `INSERT INTO ledger (id, customer_id, entry_type, invoice_id, payment_id, debit, credit, balance_after, note, datetime, created_at)
           VALUES (?, ?, 'void', ?, NULL, 0, ?, ?, ?, ?, ?)`
        ).run(ledId, invoice.customer_id, invoice.id, invoice.due_amount, newBalance, `Invoice ${invoice.invoice_no} voided`, datetime, datetime);
        recordChange('ledger', ledId, 'insert', rowOf('ledger', ledId));
      }

      // ---- loyalty: unwind exactly what this bill did to the customer's points ----
      // the points it banked come off, the points it spent go back (a void means the
      // sale never happened — the customer must end up where they started)
      if (invoice.customer_id && (Number(invoice.loyalty_earned) > 0 || Number(invoice.loyalty_redeemed) > 0)) {
        const earned = Math.max(0, Math.trunc(Number(invoice.loyalty_earned) || 0));
        const redeemed = Math.max(0, Math.trunc(Number(invoice.loyalty_redeemed) || 0));
        db.prepare(
          'UPDATE customers SET loyalty_points = MAX(0, COALESCE(loyalty_points, 0) - ?) + ?, updated_at = ? WHERE id = ?'
        ).run(earned, redeemed, datetime, invoice.customer_id);
        recordChange('customers', invoice.customer_id, 'update', rowOf('customers', invoice.customer_id));
      }

      // ---- coupon: give the code its use back so max_uses stays honest ----
      if (invoice.coupon_code) {
        const coupon = db.prepare('SELECT id FROM coupons WHERE code = ? COLLATE NOCASE').get(invoice.coupon_code);
        if (coupon) {
          db.prepare('UPDATE coupons SET used_count = MAX(0, used_count - 1), updated_at = ? WHERE id = ?')
            .run(datetime, coupon.id);
          recordChange('coupons', coupon.id, 'update', rowOf('coupons', coupon.id));
        }
      }

      recordChange('invoices', invoice.id, 'update', rowOf('invoices', invoice.id));
    })();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return badRequest(res, 'Could not void invoice: ' + e.message);
  }
});

export default router;
