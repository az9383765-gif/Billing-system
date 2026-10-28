import { Router } from 'express';
import { db, round2 } from '../db.js';
import { requireAuth, requireCap, sendCsv } from '../lib.js';

const router = Router();
router.use(requireAuth);

// sales reports: Head + Inventory Manager (the Cashier only bills and prints)
const canSeeReports = requireCap('reports_view');

function range(req) {
  const now = new Date();
  const to = req.query.to || now.toISOString().slice(0, 10);
  const fromDefault = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const from = req.query.from || fromDefault;
  return { from, to };
}

const ITEM_PROFIT = '(ii.line_subtotal - (ii.unit_cost * ii.qty))';

// ---------- overall summary ----------
router.get('/summary', canSeeReports, (req, res) => {
  const { from, to } = range(req);
  const s = db
    .prepare(
      `SELECT COUNT(i.id) AS invoices,
              COALESCE(SUM(i.total), 0) AS revenue,
              COALESCE(SUM(i.subtotal), 0) AS taxable_value,
              COALESCE(SUM(i.discount), 0) AS discount,
              COALESCE(SUM(i.tax_total), 0) AS tax,
              COALESCE(SUM(i.round_off), 0) AS round_off,
              COALESCE(SUM(i.paid_amount), 0) AS received,
              COALESCE(SUM(i.due_amount), 0) AS credit_given
       FROM invoices i WHERE i.voided = 0 AND i.sale_date BETWEEN ? AND ?`
    )
    .get(from, to);
  const p = db
    .prepare(
      `SELECT COALESCE(SUM(ii.qty), 0) AS items_sold,
              COALESCE(SUM(ii.unit_cost * ii.qty), 0) AS cost,
              COALESCE(SUM(${ITEM_PROFIT}), 0) AS profit
       FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
       WHERE i.voided = 0 AND i.sale_date BETWEEN ? AND ?`
    )
    .get(from, to);
  // returns (credit notes) reduce what the shop really sold in this period
  const rts = db
    .prepare(
      `SELECT COALESCE(SUM(ret.total), 0) AS refunds,
              COALESCE(SUM(ret.subtotal), 0) AS refund_taxable,
              COALESCE(SUM(ret.tax_total), 0) AS refund_tax
       FROM returns ret JOIN invoices i ON i.id = ret.invoice_id
       WHERE i.voided = 0 AND ret.return_date BETWEEN ? AND ?`
    )
    .get(from, to);
  const rtItems = db
    .prepare(
      `SELECT COALESCE(SUM(ri.qty), 0) AS qty,
              COALESCE(SUM(ri.unit_cost * ri.qty), 0) AS cost,
              COALESCE(SUM(ri.line_subtotal - (ri.unit_cost * ri.qty)), 0) AS profit
       FROM return_items ri JOIN returns ret ON ret.id = ri.return_id
       JOIN invoices i ON i.id = ret.invoice_id
       WHERE i.voided = 0 AND ret.return_date BETWEEN ? AND ?`
    )
    .get(from, to);
  const payments = db
    .prepare(
      `SELECT COALESCE(SUM(p.amount), 0) AS collected FROM payments p
       LEFT JOIN invoices i ON i.id = p.invoice_id
       WHERE p.type = 'received' AND p.pay_date BETWEEN ? AND ? AND COALESCE(i.voided, 0) = 0`
    )
    .get(from, to);
  // cash handed back at the counter comes out of what was collected
  const refundsPaid = db
    .prepare(
      `SELECT COALESCE(SUM(p.amount), 0) AS paid_out FROM payments p
       LEFT JOIN invoices i ON i.id = p.invoice_id
       WHERE p.type = 'refund' AND p.pay_date BETWEEN ? AND ? AND COALESCE(i.voided, 0) = 0`
    )
    .get(from, to);
  const outstanding = db
    .prepare(
      `SELECT COALESCE(SUM(debit - credit), 0) AS outstanding FROM ledger`
    )
    .get();

  const refunds = round2(rts.refunds);
  res.json({
    from, to,
    invoices: s.invoices,
    items_sold: round2(p.items_sold - rtItems.qty),
    revenue: round2(s.revenue - refunds),
    taxable_value: round2(s.taxable_value - rts.refund_taxable),
    discount: round2(s.discount),
    tax: round2(s.tax - rts.refund_tax),
    round_off: round2(s.round_off),
    cost: round2(p.cost - rtItems.cost),
    profit: round2(p.profit - rtItems.profit),
    received: round2(s.received),
    credit_given: round2(s.credit_given),
    refunds,
    refund_tax: round2(rts.refund_tax),
    collected: round2(payments.collected - refundsPaid.paid_out),
    outstanding_credit: round2(outstanding.outstanding),
    avg_invoice: s.invoices ? round2(s.revenue / s.invoices) : 0
  });
});

// ---------- daily breakdown (sales minus refunds of that day) ----------
router.get('/daily', canSeeReports, (req, res) => {
  const { from, to } = range(req);
  const rows = db
    .prepare(
      `SELECT i.sale_date AS date,
              COUNT(*) AS invoices,
              COALESCE(SUM(i.total), 0) AS revenue,
              COALESCE(SUM(i.tax_total), 0) AS tax,
              COALESCE(SUM(i.discount), 0) AS discount,
              COALESCE(SUM(i.due_amount), 0) AS credit,
              COALESCE((SELECT SUM(${ITEM_PROFIT}) FROM invoice_items ii WHERE ii.invoice_id IN
                        (SELECT id FROM invoices WHERE sale_date = i.sale_date AND voided = 0)), 0) AS profit
       FROM invoices i WHERE i.voided = 0 AND i.sale_date BETWEEN ? AND ?
       GROUP BY i.sale_date ORDER BY i.sale_date DESC`
    )
    .all(from, to);
  const credited = db
    .prepare(
      `SELECT ret.return_date AS date,
              COALESCE(SUM(ret.total), 0) AS refunds,
              COALESCE(SUM(ret.tax_total), 0) AS refund_tax,
              COALESCE(SUM(ri.line_subtotal - (ri.unit_cost * ri.qty)), 0) AS refund_profit
       FROM returns ret
       JOIN invoices i ON i.id = ret.invoice_id
       LEFT JOIN return_items ri ON ri.return_id = ret.id
       WHERE i.voided = 0 AND ret.return_date BETWEEN ? AND ?
       GROUP BY ret.return_date`
    )
    .all(from, to);

  const byDate = new Map(rows.map(r => [r.date, { ...r, refunds: 0 }]));
  for (const c of credited) {
    const row = byDate.get(c.date);
    if (row) {
      row.revenue -= c.refunds;
      row.tax -= c.refund_tax;
      row.profit -= c.refund_profit;
      row.refunds = round2(c.refunds);
    } else {
      // a refund day with no sales still belongs in the takings report
      byDate.set(c.date, {
        date: c.date, invoices: 0, discount: 0, credit: 0,
        revenue: -c.refunds, tax: -c.refund_tax, profit: -c.refund_profit, refunds: round2(c.refunds)
      });
    }
  }
  return res.json(
    [...byDate.values()]
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .map(r => ({ ...r, revenue: round2(r.revenue), tax: round2(r.tax), discount: round2(r.discount), credit: round2(r.credit), profit: round2(r.profit), refunds: round2(r.refunds || 0) }))
  );
});

// ---------- product-wise (net of returns in the period) ----------
router.get('/products', canSeeReports, (req, res) => {
  const { from, to } = range(req);
  const rows = db
    .prepare(
      `SELECT ii.product_id, ii.name,
              COALESCE(SUM(ii.qty), 0) AS qty,
              COALESCE(SUM(ii.line_total), 0) AS revenue,
              COALESCE(SUM(ii.unit_cost * ii.qty), 0) AS cost,
              COALESCE(SUM(${ITEM_PROFIT}), 0) AS profit,
              COUNT(DISTINCT i.id) AS invoices
       FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
       WHERE i.voided = 0 AND i.sale_date BETWEEN ? AND ?
       GROUP BY ii.product_id, ii.name ORDER BY revenue DESC LIMIT 500`
    )
    .all(from, to);
  const credited = db
    .prepare(
      `SELECT ri.product_id, ri.name,
              COALESCE(SUM(ri.qty), 0) AS qty,
              COALESCE(SUM(ri.line_total), 0) AS revenue,
              COALESCE(SUM(ri.unit_cost * ri.qty), 0) AS cost,
              COALESCE(SUM(ri.line_subtotal - (ri.unit_cost * ri.qty)), 0) AS profit
       FROM return_items ri
       JOIN returns ret ON ret.id = ri.return_id
       JOIN invoices i ON i.id = ret.invoice_id
       WHERE i.voided = 0 AND ret.return_date BETWEEN ? AND ?
       GROUP BY ri.product_id, ri.name`
    )
    .all(from, to);

  const byProduct = new Map(rows.map(r => [r.product_id, r]));
  for (const c of credited) {
    const row = byProduct.get(c.product_id);
    if (row) {
      row.qty -= c.qty;
      row.revenue -= c.revenue;
      row.cost -= c.cost;
      row.profit -= c.profit;
    } else {
      // sold before the window, returned inside it
      byProduct.set(c.product_id, {
        product_id: c.product_id, name: c.name, invoices: 0,
        qty: -c.qty, revenue: -c.revenue, cost: -c.cost, profit: -c.profit
      });
    }
  }
  const merged = [...byProduct.values()].sort((a, b) => b.revenue - a.revenue);
  if (req.query.format === 'csv') {
    return sendCsv(res, 'product-sales.csv',
      ['Product', 'Qty Sold', 'Revenue', 'Cost', 'Profit', 'Invoices'],
      merged.map(r => [r.name, round2(r.qty), round2(r.revenue), round2(r.cost), round2(r.profit), r.invoices]));
  }
  res.json(merged.map(r => ({ ...r, revenue: round2(r.revenue), cost: round2(r.cost), profit: round2(r.profit), qty: round2(r.qty) })));
});

// ---------- tax summary (GST actually owed — returns reverse tax) ----------
router.get('/tax', canSeeReports, (req, res) => {
  const { from, to } = range(req);
  const sales = db
    .prepare(
      `SELECT ii.tax_rate AS rate,
              COALESCE(SUM(ii.line_subtotal), 0) AS taxable,
              COALESCE(SUM(ii.tax_amount), 0) AS tax
       FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
       WHERE i.voided = 0 AND i.sale_date BETWEEN ? AND ? AND ii.tax_rate > 0
       GROUP BY ii.tax_rate`
    )
    .all(from, to);
  const credited = db
    .prepare(
      `SELECT ri.tax_rate AS rate,
              COALESCE(SUM(ri.line_subtotal), 0) AS taxable,
              COALESCE(SUM(ri.tax_amount), 0) AS tax
       FROM return_items ri
       JOIN returns ret ON ret.id = ri.return_id
       JOIN invoices i ON i.id = ret.invoice_id
       WHERE i.voided = 0 AND ret.return_date BETWEEN ? AND ? AND ri.tax_rate > 0
       GROUP BY ri.tax_rate`
    )
    .all(from, to);

  const byRate = new Map();
  for (const r of sales) byRate.set(Number(r.rate), { rate: Number(r.rate), taxable: r.taxable, tax: r.tax });
  for (const r of credited) {
    const cur = byRate.get(Number(r.rate)) || { rate: Number(r.rate), taxable: 0, tax: 0 };
    cur.taxable -= r.taxable;
    cur.tax -= r.tax;
    byRate.set(Number(r.rate), cur);
  }
  const rows = [...byRate.values()]
    .filter(r => Math.abs(r.taxable) > 0.009 || Math.abs(r.tax) > 0.009)
    .sort((a, b) => a.rate - b.rate)
    .map(r => ({
      rate: r.rate,
      taxable: round2(r.taxable),
      tax: round2(r.tax),
      cgst: round2(r.tax / 2),
      sgst: round2(r.tax / 2)
    }));
  res.json(rows);
});

// ---------- customer / credit report ----------
router.get('/customers', canSeeReports, (req, res) => {
  const { from, to } = range(req);
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT c.id, c.name, c.phone, c.credit_limit,
                COALESCE((SELECT SUM(debit - credit) FROM ledger l WHERE l.customer_id = c.id), 0) AS balance,
                COALESCE((SELECT SUM(i.total) FROM invoices i WHERE i.customer_id = c.id AND i.voided = 0 AND i.sale_date BETWEEN ? AND ?), 0) AS purchases,
                COALESCE((SELECT SUM(i.due_amount) FROM invoices i WHERE i.customer_id = c.id AND i.voided = 0), 0) AS total_due,
                (SELECT MAX(i.sale_date) FROM invoices i WHERE i.customer_id = c.id) AS last_visit
         FROM customers c
       )
       WHERE balance != 0 OR purchases > 0
       ORDER BY balance DESC, name LIMIT 500`
    )
    .all(from, to);
  res.json(rows.map(r => ({ ...r, balance: round2(r.balance), purchases: round2(r.purchases), total_due: round2(r.total_due) })));
});

// ---------- low stock ----------
router.get('/low-stock', (req, res) => {
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.barcode, p.stock_qty, p.low_stock, p.unit, p.cost_price, p.price, c.name AS category_name
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.is_active = 1 AND p.stock_qty <= p.low_stock
       ORDER BY (p.stock_qty - p.low_stock) ASC`
    )
    .all();
  if (req.query.format === 'csv') {
    return sendCsv(res, 'low-stock.csv',
      ['Product', 'Barcode', 'Category', 'Stock', 'Alert Level', 'Unit'],
      rows.map(r => [r.name, r.barcode, r.category_name, r.stock_qty, r.low_stock, r.unit]));
  }
  res.json(rows);
});

// ---------- near expiry (open to every logged-in role — old stock must not sell) ----------
router.get('/expiring', (req, res) => {
  const days = Math.max(0, Math.min(3650, Number(req.query.days ?? 30) || 0));
  const cutoff = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const todayStr = new Date().toISOString().slice(0, 10);
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.barcode, p.stock_qty, p.unit, p.price, p.expiry_date, c.name AS category_name
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.is_active = 1 AND p.expiry_date IS NOT NULL AND p.expiry_date != '' AND p.expiry_date <= ?
       ORDER BY p.expiry_date ASC`
    )
    .all(cutoff)
    .map(r => ({
      ...r,
      expired: r.expiry_date < todayStr,
      days_left: Math.round((new Date(r.expiry_date) - new Date(todayStr)) / 86400000)
    }));
  if (req.query.format === 'csv') {
    return sendCsv(res, 'expiring-stock.csv',
      ['Product', 'Barcode', 'Category', 'Stock', 'Expiry', 'Days Left', 'Status'],
      rows.map(r => [r.name, r.barcode, r.category_name, r.stock_qty, r.expiry_date, r.days_left, r.expired ? 'EXPIRED' : 'expiring']));
  }
  res.json(rows);
});

export default router;
