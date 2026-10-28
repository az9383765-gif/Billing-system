import { Router } from 'express';
import { db, uuid, now, today, getSetting, recordChange, rowOf, round2 } from '../db.js';
import { requireAuth, requireCap, badRequest, sendCsv } from '../lib.js';

const router = Router();
router.use(requireAuth);

// ---------- stock requests (Inventory Manager asks, Head approves) ----------
function requestRow(id) {
  return db
    .prepare(
      `SELECT r.*, p.name AS product_name, p.unit, p.stock_qty, p.barcode
       FROM stock_requests r JOIN products p ON p.id = r.product_id WHERE r.id = ?`
    )
    .get(id);
}

function applyRequest(id, decidedBy) {
  const datetime = now();
  db.transaction(() => {
    const r = db.prepare('SELECT * FROM stock_requests WHERE id = ?').get(id);
    if (!r || r.status !== 'pending') throw new Error('Request is no longer waiting for approval');
    const product = rowOf('products', r.product_id);
    if (!product) throw new Error('Product no longer exists');

    const isPurchase = r.type === 'purchase';
    const newQty = round2(Number(product.stock_qty) + Number(r.qty));
    if (newQty < 0 && getSetting('allow_negative_stock', '0') !== '1') {
      throw new Error(`Not enough stock for ${product.name} (available: ${product.stock_qty})`);
    }
    const cost = isPurchase ? Number(r.cost_price) : Number(product.cost_price || 0);

    if (isPurchase) {
      db.prepare('UPDATE products SET stock_qty = ?, cost_price = ?, updated_at = ? WHERE id = ?')
        .run(newQty, cost, datetime, product.id);
    } else {
      db.prepare('UPDATE products SET stock_qty = ?, updated_at = ? WHERE id = ?').run(newQty, datetime, product.id);
    }

    db.prepare(
      `INSERT INTO stock_movements (id, product_id, type, delta, qty_after, cost_price, ref_id, note, datetime, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      uuid(), product.id, isPurchase ? 'purchase' : 'adjustment', r.qty, newQty, cost,
      r.id, (r.note ? r.note + ' — ' : '') + 'approved', datetime, datetime
    );
    recordChange('products', product.id, 'update', rowOf('products', product.id));

    db.prepare('UPDATE stock_requests SET status = ?, decided_by = ?, updated_at = ? WHERE id = ?')
      .run('approved', decidedBy, datetime, id);
  })();
  return requestRow(id);
}

// submit — Head entries apply immediately, everyone else waits for approval
router.post('/requests', requireCap('stock_request'), (req, res) => {
  const b = req.body || {};
  const product = rowOf('products', b.product_id);
  if (!product) return badRequest(res, 'Product not found');

  const type = b.type === 'adjust' ? 'adjust' : 'purchase';
  const qty = Number(b.qty);
  if (!Number.isFinite(qty) || qty === 0) return badRequest(res, 'Quantity must be a non-zero number');

  let cost = Number(product.cost_price || 0);
  if (type === 'purchase') {
    if (qty <= 0) return badRequest(res, 'Purchase quantity must be greater than 0');
    const raw = b.cost_price;
    cost = raw === undefined || raw === null || raw === '' ? Number(product.cost_price || 0) : Number(raw);
    if (!Number.isFinite(cost) || cost < 0) return badRequest(res, 'Cost price must be 0 or more');
  }

  const isHead = req.user.role === 'admin';
  const id = uuid();
  const ts = now();
  db.prepare(
    `INSERT INTO stock_requests (id, product_id, type, qty, cost_price, note, status,
       requested_by, requested_by_name, decided_by, decision_note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, product.id, type, qty, cost, String(b.note || ''),
    isHead ? 'approved' : 'pending',
    req.user.id, req.user.name || req.user.username || '',
    isHead ? req.user.id : null, isHead ? 'Entered by Head' : '', ts, ts
  );

  if (isHead) {
    try {
      applyRequest(id, req.user.id);
    } catch (e) {
      db.prepare('UPDATE stock_requests SET status = ?, decision_note = ? WHERE id = ?').run('rejected', e.message, id);
      return badRequest(res, e.message);
    }
  }
  res.json(requestRow(id));
});

// list — Head sees every request, an Inventory Manager sees their own
router.get('/requests', requireCap('stock_request'), (req, res) => {
  const { status = '' } = req.query;
  const where = [];
  const params = [];
  if (status) { where.push('r.status = ?'); params.push(status); }
  if (req.user.role !== 'admin') { where.push('r.requested_by = ?'); params.push(req.user.id); }
  const rows = db
    .prepare(
      `SELECT r.*, p.name AS product_name, p.unit, p.stock_qty, p.barcode
       FROM stock_requests r JOIN products p ON p.id = r.product_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY r.created_at DESC LIMIT 300`
    )
    .all(...params);
  res.json(rows);
});

// Head decides
router.post('/requests/:id/approve', requireCap('stock_approve'), (req, res) => {
  const r = db.prepare('SELECT * FROM stock_requests WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Stock request not found' });
  if (r.status !== 'pending') return badRequest(res, `Request is already ${r.status}`);
  try {
    const applied = applyRequest(r.id, req.user.id);
    if (req.body?.note) db.prepare('UPDATE stock_requests SET decision_note = ? WHERE id = ?').run(String(req.body.note), r.id);
    res.json({ ok: true, request: requestRow(applied.id) });
  } catch (e) {
    return badRequest(res, e.message);
  }
});

router.post('/requests/:id/reject', requireCap('stock_approve'), (req, res) => {
  const r = db.prepare('SELECT * FROM stock_requests WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Stock request not found' });
  if (r.status !== 'pending') return badRequest(res, `Request is already ${r.status}`);
  const datetime = now();
  db.prepare('UPDATE stock_requests SET status = ?, decided_by = ?, decision_note = ?, updated_at = ? WHERE id = ?')
    .run('rejected', req.user.id, String(req.body?.note || ''), datetime, r.id);
  res.json({ ok: true, request: requestRow(r.id) });
});

// ---------- purchase entry (stock in) — Head only ----------
router.post('/purchase', requireCap('stock_add'), (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (items.length === 0) return badRequest(res, 'No items supplied');
  const note = req.body?.note || '';

  const checked = [];
  for (const it of items) {
    const product = rowOf('products', it.product_id);
    if (!product) return badRequest(res, 'Product not found');
    const qty = Number(it.qty);
    if (!qty || qty <= 0) return badRequest(res, `Quantity must be greater than 0 for ${product.name}`);
    // empty cost means "keep the current cost price" — never let it silently become 0
    const rawCost = it.cost_price;
    const cost = rawCost === undefined || rawCost === null || rawCost === ''
      ? Number(product.cost_price || 0)
      : Number(rawCost);
    if (!Number.isFinite(cost) || cost < 0) return badRequest(res, `Cost price must be 0 or more for ${product.name}`);
    checked.push({ product, qty, cost });
  }

  try {
    db.transaction(() => {
      const datetime = now();
      for (const { product, qty, cost } of checked) {
        const newQty = round2(product.stock_qty + qty);
        db.prepare('UPDATE products SET stock_qty = ?, cost_price = ?, updated_at = ? WHERE id = ?').run(
          newQty, cost, datetime, product.id
        );
        db.prepare(
          `INSERT INTO stock_movements (id, product_id, type, delta, qty_after, cost_price, ref_id, note, datetime, created_at)
           VALUES (?, ?, 'purchase', ?, ?, ?, NULL, ?, ?, ?)`
        ).run(uuid(), product.id, qty, newQty, cost, note || 'Purchase entry', datetime, datetime);
        recordChange('products', product.id, 'update', rowOf('products', product.id));
      }
    })();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return badRequest(res, 'Purchase could not be saved: ' + e.message);
  }
});

// ---------- adjustment — Head only ----------
router.post('/adjust', requireCap('stock_add'), (req, res) => {
  const { product_id, note = '' } = req.body || {};
  const product = rowOf('products', product_id);
  if (!product) return badRequest(res, 'Product not found');

  let newQty;
  if (req.body.new_qty !== undefined && req.body.new_qty !== '') {
    newQty = Number(req.body.new_qty);
  } else if (req.body.delta !== undefined && req.body.delta !== '') {
    newQty = round2(product.stock_qty + Number(req.body.delta));
  } else {
    return badRequest(res, 'Provide delta or new_qty');
  }
  if (Number.isNaN(newQty)) return badRequest(res, 'Resulting stock must be a number');
  if (newQty < 0 && getSetting('allow_negative_stock', '0') !== '1') {
    return badRequest(res, 'Resulting stock cannot be negative');
  }

  const delta = round2(newQty - product.stock_qty);
  try {
    db.transaction(() => {
      const datetime = now();
      db.prepare('UPDATE products SET stock_qty = ?, updated_at = ? WHERE id = ?').run(newQty, datetime, product.id);
      db.prepare(
        `INSERT INTO stock_movements (id, product_id, type, delta, qty_after, cost_price, ref_id, note, datetime, created_at)
         VALUES (?, ?, 'adjustment', ?, ?, ?, NULL, ?, ?, ?)`
      ).run(uuid(), product.id, delta, newQty, product.cost_price, note || 'Stock adjustment', datetime, datetime);
      recordChange('products', product.id, 'update', rowOf('products', product.id));
    })();
    res.json({ ok: true, stock_qty: newQty });
  } catch (e) {
    console.error(e);
    return badRequest(res, 'Adjustment failed: ' + e.message);
  }
});

// ---------- movements — Head + Inventory Manager ----------
router.get('/movements', requireCap('stock_view'), (req, res) => {
  const { product_id = '', from = '', to = '', limit = '300' } = req.query;
  const where = [];
  const params = [];
  if (product_id) { where.push('m.product_id = ?'); params.push(product_id); }
  if (from) { where.push('m.datetime >= ?'); params.push(from); }
  if (to) { where.push('m.datetime <= ?'); params.push(to + 'T23:59:59.999'); }
  const rows = db
    .prepare(
      `SELECT m.*, p.name AS product_name, p.unit
       FROM stock_movements m JOIN products p ON p.id = m.product_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY m.datetime DESC LIMIT ?`
    )
    .all(...params, Math.min(Number(limit) || 300, 2000));
  res.json(rows);
});

// ---------- low stock ----------
router.get('/low-stock', (req, res) => {
  const rows = db
    .prepare(
      `SELECT p.*, c.name AS category_name FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.is_active = 1 AND p.stock_qty <= p.low_stock
       ORDER BY p.stock_qty ASC`
    )
    .all();
  res.json(rows);
});

// ---------- stock valuation ----------
router.get('/valuation', requireCap('stock_view'), (req, res) => {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS products,
              COALESCE(SUM(stock_qty), 0) AS units,
              COALESCE(SUM(stock_qty * cost_price), 0) AS cost_value,
              COALESCE(SUM(stock_qty * price), 0) AS retail_value
       FROM products WHERE is_active = 1`
    )
    .get();
  res.json(r);
});

router.get('/movements/export', requireCap('stock_view'), (req, res) => {
  const rows = db
    .prepare(
      `SELECT m.datetime, p.name, m.type, m.delta, m.qty_after, m.cost_price, m.note
       FROM stock_movements m JOIN products p ON p.id = m.product_id
       ORDER BY m.datetime DESC LIMIT 5000`
    )
    .all();
  sendCsv(res, 'stock-movements.csv',
    ['Date', 'Product', 'Type', 'Change', 'Stock After', 'Cost', 'Note'],
    rows.map(r => [r.datetime, r.name, r.type, r.delta, r.qty_after, r.cost_price, r.note]));
});

export default router;
