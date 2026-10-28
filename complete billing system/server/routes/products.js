import { Router } from 'express';
import { db, uuid, now, getSetting, recordChange, rowOf, round2 } from '../db.js';
import { requireAuth, requireCap, badRequest, sendCsv } from '../lib.js';

const router = Router();
router.use(requireAuth);

// ---------- categories ----------
router.get('/categories', (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.is_active = 1) AS product_count
       FROM categories c ORDER BY c.sort_order, c.name`
    )
    .all();
  res.json(rows);
});

router.post('/categories', requireCap('products_manage'), (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return badRequest(res, 'Category name is required');
  const id = uuid();
  db.prepare('INSERT INTO categories (id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    id, name, Number(req.body.sort_order || 0), now(), now()
  );
  const row = rowOf('categories', id);
  recordChange('categories', id, 'insert', row);
  res.json(row);
});

router.put('/categories/:id', requireCap('products_manage'), (req, res) => {
  const cat = rowOf('categories', req.params.id);
  if (!cat) return res.status(404).json({ error: 'Category not found' });
  const name = (req.body?.name ?? cat.name).trim();
  if (!name) return badRequest(res, 'Category name is required');
  db.prepare('UPDATE categories SET name = ?, sort_order = ?, updated_at = ? WHERE id = ?').run(
    name, Number(req.body?.sort_order ?? cat.sort_order), now(), cat.id
  );
  const row = rowOf('categories', cat.id);
  recordChange('categories', cat.id, 'update', row);
  res.json(row);
});

router.delete('/categories/:id', requireCap('products_manage'), (req, res) => {
  const used = db.prepare('SELECT COUNT(*) AS n FROM products WHERE category_id = ?').get(req.params.id).n;
  if (used > 0) return badRequest(res, 'Category has products. Move or delete them first.');
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  recordChange('categories', req.params.id, 'delete', { id: req.params.id });
  res.json({ ok: true });
});

// ---------- products ----------
router.get('/', (req, res) => {
  const { search = '', category_id = '', low_stock = '', active = '', barcode = '' } = req.query;
  const where = [];
  const params = [];
  if (barcode) {
    where.push('p.barcode = ?');
    params.push(barcode);
  } else {
    if (active === 'all') {
      // show active and inactive together
    } else if (active !== '') {
      where.push('p.is_active = ?');
      params.push(active === '1' ? 1 : 0);
    } else {
      where.push('p.is_active = 1');
    }
    if (search) {
      where.push('(p.name LIKE ? OR p.barcode LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    if (category_id) {
      where.push('p.category_id = ?');
      params.push(category_id);
    }
    if (low_stock === '1') where.push('p.stock_qty <= p.low_stock');
  }
  const rows = db
    .prepare(
      `SELECT p.*, c.name AS category_name FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY p.name LIMIT 2000`
    )
    .all(...params);
  res.json(rows);
});

router.get('/export', (req, res) => {
  const rows = db
    .prepare(
      `SELECT p.name, p.barcode, c.name AS category, p.unit, p.price, p.cost_price, p.stock_qty,
              p.low_stock, p.tax_rate, p.expiry_date,
              CASE p.tax_inclusive WHEN 1 THEN 'inclusive' ELSE 'exclusive' END AS tax_mode
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.is_active = 1 ORDER BY p.name`
    )
    .all();
  sendCsv(res, 'products.csv',
    ['Name', 'Barcode', 'Category', 'Unit', 'Selling Price', 'Cost Price', 'Stock', 'Low Stock', 'Tax %', 'Expiry', 'Tax Mode'],
    rows.map(r => [r.name, r.barcode, r.category, r.unit, r.price, r.cost_price, r.stock_qty, r.low_stock, r.tax_rate, r.expiry_date || '', r.tax_mode]));
});

router.get('/:id', (req, res) => {
  const row = db
    .prepare('SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?')
    .get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Product not found' });
  res.json(row);
});

function validateProduct(body) {
  const name = String(body.name ?? '').trim();
  if (!name) return 'Product name is required';
  if (body.price === undefined || body.price === null || body.price === '') return 'Selling price is required';
  if (Number.isNaN(Number(body.price)) || Number(body.price) < 0) return 'Selling price must be 0 or more';
  if (body.tax_rate !== undefined && body.tax_rate !== '' &&
      (Number.isNaN(Number(body.tax_rate)) || Number(body.tax_rate) < 0 || Number(body.tax_rate) > 100)) {
    return 'Tax rate must be between 0 and 100';
  }
  const expiry = body.expiry_date;
  if (expiry !== undefined && expiry !== null && String(expiry).trim() !== '') {
    const s = String(expiry).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(new Date(s + 'T00:00:00Z').getTime())) {
      return 'Expiry date must be a valid date (YYYY-MM-DD)';
    }
  }
  return null;
}

// empty input -> '' (no expiry), anything else must already be validated
const expiryOf = value => (value === undefined || value === null ? '' : String(value).trim());

// empty / missing input -> fallback, anything else -> Number() (may be NaN)
const numberOr = (value, fallback) => (value === undefined || value === null || value === '' ? fallback : Number(value));

// accepts booleans, 0/1 and the strings a form can send ("0", "false", "off")
function flag(value, fallback = 1) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === false || value === 0 || value === '0' || value === 'false' || value === 'off' ? 0 : 1;
}

function negativeStockAllowed() {
  return getSetting('allow_negative_stock', '0') === '1';
}

router.post('/', requireCap('products_manage'), (req, res) => {
  const err = validateProduct(req.body || {});
  if (err) return badRequest(res, err);
  const b = req.body;
  const name = String(b.name).trim();
  const barcode = String(b.barcode ?? '').trim();
  if (barcode) {
    const dup = db.prepare('SELECT id FROM products WHERE barcode = ? AND is_active = 1').get(barcode);
    if (dup) return badRequest(res, 'A product with this barcode already exists');
  }

  const stockQty = numberOr(b.stock_qty, 0);
  const lowStock = numberOr(b.low_stock, Number(getSetting('default_low_stock', 5) || 5));
  const costPrice = numberOr(b.cost_price, 0);
  if (!Number.isFinite(stockQty)) return badRequest(res, 'Stock quantity must be a number');
  if (!Number.isFinite(lowStock) || lowStock < 0) return badRequest(res, 'Low stock alert level must be 0 or more');
  if (!Number.isFinite(costPrice) || costPrice < 0) return badRequest(res, 'Cost price must be 0 or more');
  if (stockQty < 0 && !negativeStockAllowed()) return badRequest(res, 'Stock quantity cannot be negative');

  const id = uuid();
  db.prepare(
    `INSERT INTO products (id, name, barcode, category_id, unit, price, cost_price, stock_qty, low_stock,
      tax_rate, tax_inclusive, is_active, expiry_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
  ).run(
    id, name, barcode, b.category_id || null, b.unit || 'pcs',
    Number(b.price || 0), costPrice, stockQty, lowStock,
    Number(b.tax_rate || 0), flag(b.tax_inclusive, 1), expiryOf(b.expiry_date), now(), now()
  );
  const row = rowOf('products', id);
  if (stockQty !== 0) {
    db.prepare(
      `INSERT INTO stock_movements (id, product_id, type, delta, qty_after, cost_price, ref_id, note, datetime, created_at)
       VALUES (?, ?, 'opening', ?, ?, ?, NULL, 'Opening stock', ?, ?)`
    ).run(uuid(), id, stockQty, stockQty, costPrice, now(), now());
  }
  recordChange('products', id, 'insert', row);
  res.json(row);
});

router.put('/:id', requireCap('products_manage'), (req, res) => {
  const product = rowOf('products', req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const b = req.body || {};
  const merged = { ...product, ...b };
  const err = validateProduct(merged);
  if (err) return badRequest(res, err);
  const barcode = String(merged.barcode ?? '').trim();
  if (barcode) {
    const dup = db.prepare('SELECT id FROM products WHERE barcode = ? AND id != ?').get(barcode, product.id);
    if (dup) return badRequest(res, 'A product with this barcode already exists');
  }

  // missing or empty stock/cost/low-stock in the body means "leave it as it is"
  const newStock = numberOr(b.stock_qty, product.stock_qty);
  const newCost = numberOr(b.cost_price, product.cost_price);
  const newLowStock = numberOr(b.low_stock, product.low_stock);
  if (!Number.isFinite(newStock)) return badRequest(res, 'Stock quantity must be a number');
  if (!Number.isFinite(newCost) || newCost < 0) return badRequest(res, 'Cost price must be 0 or more');
  if (!Number.isFinite(newLowStock) || newLowStock < 0) return badRequest(res, 'Low stock alert level must be 0 or more');
  if (newStock < 0 && !negativeStockAllowed()) return badRequest(res, 'Stock quantity cannot be negative');
  const stockChanged = newStock !== product.stock_qty;

  db.prepare(
    `UPDATE products SET name = ?, barcode = ?, category_id = ?, unit = ?, price = ?, cost_price = ?,
      low_stock = ?, tax_rate = ?, tax_inclusive = ?, is_active = ?, expiry_date = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    String(merged.name).trim(), barcode, merged.category_id || null, merged.unit || 'pcs',
    Number(merged.price), newCost, newLowStock,
    Number(merged.tax_rate || 0),
    flag(merged.tax_inclusive, product.tax_inclusive),
    flag(merged.is_active, product.is_active),
    // no expiry_date in the body = keep the one on the product
    b.expiry_date === undefined ? (product.expiry_date || '') : expiryOf(b.expiry_date),
    now(), product.id
  );
  if (stockChanged) {
    const delta = round2(newStock - product.stock_qty);
    db.prepare('UPDATE products SET stock_qty = ?, updated_at = ? WHERE id = ?').run(newStock, now(), product.id);
    db.prepare(
      `INSERT INTO stock_movements (id, product_id, type, delta, qty_after, cost_price, ref_id, note, datetime, created_at)
       VALUES (?, ?, 'adjustment', ?, ?, ?, NULL, 'Manual stock edit', ?, ?)`
    ).run(uuid(), product.id, delta, newStock, newCost, now(), now());
  }
  const row = rowOf('products', product.id);
  recordChange('products', product.id, 'update', row);
  res.json(row);
});

router.delete('/:id', requireCap('products_manage'), (req, res) => {
  const product = rowOf('products', req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const sold = db.prepare('SELECT COUNT(*) AS n FROM invoice_items WHERE product_id = ?').get(product.id).n;
  if (sold > 0) {
    // soft delete keeps sales history intact
    db.prepare('UPDATE products SET is_active = 0, updated_at = ? WHERE id = ?').run(now(), product.id);
  } else {
    db.prepare('DELETE FROM products WHERE id = ?').run(product.id);
    recordChange('products', product.id, 'delete', { id: product.id });
    return res.json({ ok: true, hard: true });
  }
  const row = rowOf('products', product.id);
  recordChange('products', product.id, 'update', row);
  res.json({ ok: true, soft: true });
});

export default router;
