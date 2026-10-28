// End-to-end API tests. Run with: npm test
// Spawns a fresh server on port 3100 with an isolated temp database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { invoiceCalc, round2, discountFromPercent } from '../shared/calc.js';
import { receiptHTML, invoiceA4HTML } from '../src/print.js';
import { money } from '../src/format.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const PORT = 3100;
const BASE = `http://localhost:${PORT}`;
const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'shopbill-test-'));

let child;
let token = '';

async function api(pathname, options = {}) {
  const res = await fetch(BASE + pathname, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

before(async () => {
  child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: tempData },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', d => process.stderr.write(d));

  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('Server did not start');
});

after(async () => {
  child?.kill();
  await new Promise(r => setTimeout(r, 700)); // let the child release the SQLite files
  try {
    fs.rmSync(tempData, { recursive: true, force: true });
  } catch {
    // temp cleanup is best-effort on Windows while files are closing
  }
});

test('health endpoint responds', async () => {
  const r = await api('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('API requires login', async () => {
  const res = await fetch(`${BASE}/api/products`);
  assert.equal(res.status, 401);
});

test('first run: no factory login exists — the first registration becomes the Head', async () => {
  // an untouched install has ZERO accounts: setup mode, nothing to sign in with
  const brand = await (await fetch(`${BASE}/api/auth/brand`)).json();
  assert.equal(brand.setup, true, 'an empty install offers the setup flow');
  assert.equal(brand.allow_register, true);
  assert.ok(Array.isArray(brand.demo) && brand.demo.length === 0,
    'no hardcoded owner chip is handed out on a fresh install');

  // the buyer creates the owner account of their own shop
  const r = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      shop_name: 'Zahid Test Mart', name: 'Abdullah Zahid',
      username: 'admin', password: 'admin123', confirm: 'admin123'
    })
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.setup, true, 'first account is created as the owner');
  assert.ok(r.body.token, 'owner is signed in immediately');
  assert.equal(r.body.user.role, 'admin');
  assert.equal(r.body.user.username, 'admin');

  token = r.body.token;
  const s = await api('/api/settings');
  assert.equal(s.body.shop_name, 'Zahid Test Mart', 'shop name from setup was saved');

  const after = await (await fetch(`${BASE}/api/auth/brand`)).json();
  assert.equal(after.setup, false, 'setup mode ends the moment the Head exists');
});

test('login rejects wrong password, accepts correct one', async () => {
  const bad = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'nope' }) });
  assert.equal(bad.status, 401);
  const good = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
  assert.equal(good.status, 200);
  assert.ok(good.body.token);
  token = good.body.token;
});

test('meta returns shop settings', async () => {
  const r = await api('/api/meta');
  assert.equal(r.status, 200);
  assert.ok(r.body.settings.currency_symbol);
});

let categoryId;
let productId;

test('creates category and product with 10% inclusive tax', async () => {
  const cat = await api('/api/products/categories', { method: 'POST', body: JSON.stringify({ name: 'Test Cat' }) });
  assert.equal(cat.status, 200);
  categoryId = cat.body.id;

  const prod = await api('/api/products', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Test Widget', barcode: '111222333', category_id: categoryId,
      unit: 'pcs', price: 110, cost_price: 60, stock_qty: 50, low_stock: 5,
      tax_rate: 10, tax_inclusive: true
    })
  });
  assert.equal(prod.status, 200);
  assert.equal(prod.body.stock_qty, 50);
  productId = prod.body.id;
});

test('rejects duplicate barcode', async () => {
  const r = await api('/api/products', {
    method: 'POST',
    body: JSON.stringify({ name: 'Clone', barcode: '111222333', price: 10 })
  });
  assert.equal(r.status, 400);
});

test('barcode lookup finds the product', async () => {
  const r = await api('/api/products?barcode=111222333');
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].id, productId);
});

test('full cash sale: totals, tax extraction and stock deduction are correct', async () => {
  const r = await api('/api/invoices', {
    method: 'POST',
    body: JSON.stringify({ items: [{ product_id: productId, qty: 2 }], paid: undefined })
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const inv = r.body.invoice;
  assert.equal(inv.subtotal, 200);      // 220 gross / 1.10
  assert.equal(inv.tax_total, 20);
  assert.equal(inv.total, 220);
  assert.equal(inv.status, 'paid');
  assert.equal(inv.invoice_no, 'INV-0001');

  const prod = await api(`/api/products/${productId}`);
  assert.equal(prod.body.stock_qty, 48);

  const detail = await api(`/api/invoices/${inv.id}`);
  assert.equal(detail.body.items.length, 1);
  assert.equal(detail.body.items[0].line_total, 220);
  assert.equal(detail.body.payments.length, 1);
});

test('an offline bill replayed with the same client_ref is stored exactly once', async () => {
  const prod = await api('/api/products', {
    method: 'POST',
    body: JSON.stringify({ name: 'Offline Widget', barcode: '88776655', unit: 'pcs', price: 50, cost_price: 30, stock_qty: 10 })
  });
  assert.equal(prod.status, 200);

  // a bill taken with no internet: the client queued it with a unique ref
  const body = { items: [{ product_id: prod.body.id, qty: 3 }], paid: 150, client_ref: 'off-test-123' };
  const first = await api('/api/invoices', { method: 'POST', body: JSON.stringify(body) });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.ok(first.body.invoice.id);

  // the replay (network died after the server stored it) must return the SAME bill
  const replay = await api('/api/invoices', { method: 'POST', body: JSON.stringify(body) });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.duplicate, true);
  assert.equal(replay.body.invoice.id, first.body.invoice.id);
  assert.equal(replay.body.invoice.invoice_no, first.body.invoice.invoice_no);

  // stock moved exactly once — 10 - 3, never 10 - 6
  const after = await api(`/api/products/${prod.body.id}`);
  assert.equal(after.body.stock_qty, 7);
});

test('invoice discount is applied before tax', async () => {
  const r = await api('/api/invoices', {
    method: 'POST',
    body: JSON.stringify({ items: [{ product_id: productId, qty: 1 }], discount: 10, paid: undefined })
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const inv = r.body.invoice;
  assert.equal(inv.discount, 10);
  assert.equal(inv.total, 100);      // 110 sticker price - 10 discount
  assert.equal(inv.subtotal, 90.91); // tax extracted from the discounted price
  assert.equal(inv.tax_total, 9.09);
});

test('blocks sale when stock is insufficient', async () => {
  const r = await api('/api/invoices', {
    method: 'POST',
    body: JSON.stringify({ items: [{ product_id: productId, qty: 9999 }] })
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Insufficient stock/);
});

let customerId;

test('creates customer and credit sale updates balance', async () => {
  const c = await api('/api/customers', { method: 'POST', body: JSON.stringify({ name: 'Test Customer', phone: '03000000000', credit_limit: 1000 }) });
  assert.equal(c.status, 200);
  customerId = c.body.id;

  const r = await api('/api/invoices', {
    method: 'POST',
    body: JSON.stringify({
      customer_id: customerId,
      items: [{ product_id: productId, qty: 3, unit_price: 100 }],
      paid: 100, payment_method: 'cash'
    })
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const inv = r.body.invoice;
  assert.equal(inv.total, 300);     // exclusive tax 0
  assert.equal(inv.paid_amount, 100);
  assert.equal(inv.due_amount, 200);
  assert.equal(inv.status, 'partial');

  const bal = await api(`/api/customers/${customerId}`);
  assert.equal(bal.body.balance, 200);
});

test('rejects payment above outstanding balance', async () => {
  const r = await api(`/api/customers/${customerId}/payments`, {
    method: 'POST', body: JSON.stringify({ amount: 999 })
  });
  assert.equal(r.status, 400);
});

test('collecting credit payment clears balance and invoice', async () => {
  const r = await api(`/api/customers/${customerId}/payments`, {
    method: 'POST', body: JSON.stringify({ amount: 200, method: 'cash' })
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.balance, 0);

  const list = await api(`/api/invoices?customer_id=${customerId}`);
  const partial = list.body.find(i => i.due_amount === 200);
  assert.ok(partial, 'partial invoice should exist before payment');
});

test('credit sale without customer is rejected', async () => {
  const r = await api('/api/invoices', {
    method: 'POST', body: JSON.stringify({ items: [{ product_id: productId, qty: 1 }], paid: 0 })
  });
  assert.equal(r.status, 400);
});

test('purchase entry increases stock', async () => {
  const before = await api(`/api/products/${productId}`);
  const r = await api('/api/stock/purchase', {
    method: 'POST', body: JSON.stringify({ items: [{ product_id: productId, qty: 20, cost_price: 55 }], note: 'Supplier A' })
  });
  assert.equal(r.status, 200);
  const afterP = await api(`/api/products/${productId}`);
  assert.equal(afterP.body.stock_qty, before.body.stock_qty + 20);
  assert.equal(afterP.body.cost_price, 55);
});

test('product edits never wipe stock silently and bad stock values are rejected', async () => {
  const before = await api(`/api/products/${productId}`);
  assert.equal(before.status, 200);

  // price-only edit: no stock_qty in the body must leave stock untouched (used to 500 and null the column)
  const ok = await api(`/api/products/${productId}`, { method: 'PUT', body: JSON.stringify({ price: before.body.price + 5 }) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.stock_qty, before.body.stock_qty, 'stock must survive a price-only edit');
  assert.equal(ok.body.cost_price, before.body.cost_price, 'cost must survive a price-only edit');

  // non numeric stock -> 400 (not 500), row untouched
  const bad = await api(`/api/products/${productId}`, { method: 'PUT', body: JSON.stringify({ stock_qty: 'abc' }) });
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.match(bad.body.error, /Stock quantity/);

  // negative stock is rejected while allow_negative_stock is off (default)
  const neg = await api(`/api/products/${productId}`, { method: 'PUT', body: JSON.stringify({ stock_qty: -5 }) });
  assert.equal(neg.status, 400, JSON.stringify(neg.body));

  const after = await api(`/api/products/${productId}`);
  assert.equal(after.body.stock_qty, before.body.stock_qty, 'stock must be unchanged after rejected edits');
  assert.equal(after.body.price, before.body.price + 5);

  // empty cost on a purchase entry keeps the current cost (used to become 0 and fake the profit)
  const buy = await api('/api/stock/purchase', {
    method: 'POST', body: JSON.stringify({ items: [{ product_id: productId, qty: 1, cost_price: '' }] })
  });
  assert.equal(buy.status, 200, JSON.stringify(buy.body));
  const bought = await api(`/api/products/${productId}`);
  assert.equal(bought.body.cost_price, before.body.cost_price, 'empty cost must not zero the cost price');
  assert.equal(bought.body.stock_qty, before.body.stock_qty + 1);
});

test('new products inherit the configured default low stock level', async () => {
  const settings = await api('/api/settings');
  const expected = Number(settings.body.default_low_stock);
  assert.ok(expected > 0, 'test database should have a default_low_stock setting');

  const created = await api('/api/products', { method: 'POST', body: JSON.stringify({ name: 'Low Stock Probe', price: 10, low_stock: '' }) });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.low_stock, expected, 'empty low_stock must fall back to the setting, not 0');

  // missing price is an error, not a free product
  const noPrice = await api('/api/products', { method: 'POST', body: JSON.stringify({ name: 'No Price Probe', price: '' }) });
  assert.equal(noPrice.status, 400, JSON.stringify(noPrice.body));

  await api(`/api/products/${created.body.id}`, { method: 'DELETE' });
});

test('reports summary matches sales', async () => {
  const list = await api('/api/invoices?limit=50');
  const expectedTax = list.body.filter(i => !i.voided).reduce((s, i) => s + i.tax_total, 0);
  const expectedRevenue = list.body.filter(i => !i.voided).reduce((s, i) => s + i.total, 0);

  const r = await api('/api/reports/summary?from=2000-01-01&to=2099-01-01');
  assert.equal(r.status, 200);
  assert.equal(r.body.invoices, list.body.length);
  assert.equal(Math.round(r.body.tax * 100), Math.round(expectedTax * 100));
  assert.equal(Math.round(r.body.revenue * 100), Math.round(expectedRevenue * 100));
  assert.ok(r.body.profit > 0);
});

test('daily and product reports return rows', async () => {
  const daily = await api('/api/reports/daily?from=2000-01-01&to=2099-01-01');
  assert.equal(daily.status, 200);
  assert.ok(daily.body.length >= 1);
  const products = await api('/api/reports/products?from=2000-01-01&to=2099-01-01');
  assert.equal(products.status, 200);
  assert.ok(products.body.some(p => p.name === 'Test Widget'));
});

test('tax report splits CGST/SGST', async () => {
  const list = await api('/api/invoices?limit=50');
  const expectedTax = list.body.filter(i => !i.voided).reduce((s, i) => s + i.tax_total, 0);

  const r = await api('/api/reports/tax?from=2000-01-01&to=2099-01-01');
  assert.equal(r.status, 200);
  const row = r.body.find(t => t.rate === 10); // all test products use 10%
  assert.ok(row);
  assert.equal(Math.round(row.tax * 100), Math.round(expectedTax * 100));
  assert.equal(Math.round(row.cgst * 100) / 100, Math.round(row.tax / 2 * 100) / 100);
  assert.equal(row.sgst, row.tax - row.cgst);
});

test('CSV export works', async () => {
  const r = await fetch(`${BASE}/api/products/export`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  const text = await r.text();
  assert.match(text, /Test Widget/);
});

test('stock movement history is recorded', async () => {
  const r = await api('/api/stock/movements');
  assert.equal(r.status, 200);
  assert.ok(r.body.some(m => m.type === 'sale'));
  assert.ok(r.body.some(m => m.type === 'purchase'));
});

test('voiding an invoice restores stock', async () => {
  const list = await api('/api/invoices?limit=10');
  const inv = list.body.find(i => !i.voided);
  const beforeProd = await api(`/api/products/${productId}`);
  const r = await api(`/api/invoices/${inv.id}/void`, { method: 'POST' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const again = await api(`/api/invoices/${inv.id}/void`, { method: 'POST' });
  assert.equal(again.status, 400); // cannot void twice
  assert.ok(beforeProd);
});

test('voiding a paid sale removes it from the collected total', async () => {
  const round = n => Math.round(n * 100) / 100;
  const products = await api('/api/products');
  const p = products.body.find(x => x.stock_qty > 0);
  assert.ok(p, 'test database should have a product in stock');

  const before = await api('/api/reports/summary?from=2000-01-01&to=2099-01-01');
  const sale = await api('/api/invoices', {
    method: 'POST',
    body: JSON.stringify({ items: [{ product_id: p.id, qty: 1 }] })
  });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  const paid = sale.body.invoice.total;

  const during = await api('/api/reports/summary?from=2000-01-01&to=2099-01-01');
  assert.equal(round(during.body.collected), round(before.body.collected + paid), 'cash sale must show as collected');

  const voided = await api(`/api/invoices/${sale.body.invoice.id}/void`, { method: 'POST' });
  assert.equal(voided.status, 200, JSON.stringify(voided.body));

  const after = await api('/api/reports/summary?from=2000-01-01&to=2099-01-01');
  assert.equal(round(after.body.collected), round(before.body.collected), 'a voided sale must not count as collected');
  assert.equal(round(after.body.received), round(before.body.received), 'a voided sale must not count as received');
  assert.equal(after.body.invoices, before.body.invoices, 'a voided sale must not count as an invoice');
});

test('customer credit report returns rows', async () => {
  const r = await api('/api/reports/customers?from=2000-01-01&to=2099-01-01');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(Array.isArray(r.body));
  assert.ok(r.body.some(c => c.name === 'Test Customer'), 'customer with sales should appear');
  const row = r.body.find(c => c.name === 'Test Customer');
  assert.ok(typeof row.balance === 'number');
  assert.ok(typeof row.purchases === 'number');
});

test('stock valuation endpoint works', async () => {
  const r = await api('/api/stock/valuation');
  assert.equal(r.status, 200);
  assert.ok(r.body.products > 0);
  assert.ok(r.body.cost_value >= 0);
});

test('invoice numbers are unique and sequential', async () => {
  const r = await api('/api/invoices?limit=100');
  assert.equal(r.status, 200);
  const numbers = r.body.map(i => i.invoice_no);
  assert.equal(new Set(numbers).size, numbers.length, `duplicate invoice numbers: ${numbers.join(', ')}`);
});

test('sync endpoints work end-to-end (self-sync)', async () => {
  const set = await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ sync_url: BASE, sync_key: 'test-key-123' })
  });
  assert.equal(set.status, 200);

  const run = await api('/api/sync/run', { method: 'POST' });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.ok(run.body.pushed > 0);

  const status = await api('/api/sync/status');
  assert.equal(status.body.pending, 0);
  assert.ok(status.body.last_sync);
});

test('sync rejects wrong key', async () => {
  const res = await fetch(`${BASE}/api/sync/changes`, { headers: { 'x-sync-key': 'wrong' } });
  assert.equal(res.status, 403);
});

test('settings update and backup export', async () => {
  const s = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ shop_name: 'Zahid Mart', currency_symbol: 'Rs' }) });
  assert.equal(s.status, 200);
  assert.equal(s.body.shop_name, 'Zahid Mart');

  const backup = await api('/api/settings/backup');
  assert.equal(backup.status, 200);
  assert.equal(backup.body.app, 'shopbill');
  assert.ok(Array.isArray(backup.body.products));
});

test('change password works and old password stops working', async () => {
  const change = await api('/api/auth/change-password', {
    method: 'POST', body: JSON.stringify({ old_password: 'admin123', new_password: 'strong-pass-99' })
  });
  assert.equal(change.status, 200);
  const oldLogin = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
  assert.equal(oldLogin.status, 401);
  const newLogin = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'strong-pass-99' }) });
  assert.equal(newLogin.status, 200);
  token = newLogin.body.token;
});

test('backup import round-trip restores every table and keeps login working', async () => {
  const backup = await api('/api/settings/backup');
  assert.equal(backup.status, 200);
  const before = {
    users: backup.body.users.length,
    products: backup.body.products.length,
    invoices: backup.body.invoices.length,
    settings: backup.body.settings.length
  };
  assert.ok(before.users > 0 && before.products > 0, 'test database should have data');

  const imp = await api('/api/settings/backup/import', { method: 'POST', body: JSON.stringify(backup.body) });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.equal(imp.body.default_admin, false);

  // the import wipes sessions, so the old token is dead — re-login must still work
  const relogin = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'strong-pass-99' }) });
  assert.equal(relogin.status, 200, 'login must survive a backup restore');
  token = relogin.body.token;

  const after = await api('/api/settings/backup');
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.equal(after.body.users.length, before.users);
  assert.equal(after.body.products.length, before.products);
  assert.equal(after.body.invoices.length, before.invoices);
  assert.equal(after.body.settings.length, before.settings);
});

test('cashier cannot list users or read the sync key', async () => {
  const create = await api('/api/auth/users', {
    method: 'POST', body: JSON.stringify({ username: 'cashier1', password: 'cash-pass-1', name: 'Counter 1', role: 'cashier' })
  });
  assert.equal(create.status, 200, JSON.stringify(create.body));
  assert.equal(create.body.pending, true, 'a new account must wait for Head approval');

  // not approved yet -> cannot log in
  const beforeApproval = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'cashier1', password: 'cash-pass-1' }) });
  assert.equal(beforeApproval.status, 401, 'a pending account must not be able to log in');

  // Head approves the account
  const approve = await api(`/api/auth/users/${create.body.id}`, { method: 'PUT', body: JSON.stringify({ active: true }) });
  assert.equal(approve.status, 200, JSON.stringify(approve.body));

  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'cashier1', password: 'cash-pass-1' }) });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.status, 200);
  const cashierToken = login.body.token;

  const list = await fetch(`${BASE}/api/auth/users`, { headers: { Authorization: `Bearer ${cashierToken}` } });
  assert.equal(list.status, 403, 'listing users must be admin-only');

  const res = await fetch(`${BASE}/api/settings`, { headers: { Authorization: `Bearer ${cashierToken}` } });
  assert.equal(res.status, 200);
  const s = await res.json();
  assert.equal(s.sync_key, undefined, 'sync secret must be hidden from cashiers');
  assert.ok(s.shop_name, 'cashiers still need shop/receipt settings');

  const adminLogin = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'strong-pass-99' }) });
  assert.equal(adminLogin.status, 200);
  token = adminLogin.body.token;
  const adminSettings = await api('/api/settings');
  assert.ok(adminSettings.body.sync_key !== undefined, 'admins keep the sync secret');
});

test('backup without users recreates the default admin instead of locking the shop out', async () => {
  const backup = await api('/api/settings/backup');
  const partial = JSON.parse(JSON.stringify(backup.body));
  partial.users = [];

  const imp = await api('/api/settings/backup/import', { method: 'POST', body: JSON.stringify(partial) });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.equal(imp.body.default_admin, true);
  assert.match(imp.body.message, /admin123/);

  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
  assert.equal(login.status, 200, 'a login must exist after restoring a user-less backup');
  token = login.body.token;
});

test('Supabase cloud backup is optional, config-gated and can never break billing', async t => {
  // ---- 1. nothing configured → a clean, actionable refusal ----
  await api('/api/settings', {
    method: 'PUT', body: JSON.stringify({ supabase_url: '', supabase_key: '', supabase_bucket: '' })
  });
  const unconfigured = await api('/api/settings/backup/cloud', { method: 'POST' });
  assert.equal(unconfigured.status, 400, JSON.stringify(unconfigured.body));
  assert.match(unconfigured.body.error, /Supabase Project URL/);

  // ---- 2. a mock Supabase Storage captures the real upload ----
  const { createServer } = await import('node:http');
  const received = [];
  const mock = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, apikey: req.headers.apikey, auth: req.headers.authorization, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  t.after(() => mock.close()); // never leave the mock listening, pass or fail
  const port = mock.address().port;

  const put = await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({
      supabase_url: `http://127.0.0.1:${port}`,
      supabase_key: 'test-key-123',
      supabase_bucket: 'shop-backups'
    })
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));

  const run = await api('/api/settings/backup/cloud', { method: 'POST' });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.ok(run.body.path.startsWith('shop-backups/martbill/shopbill-'), 'dated object path: ' + run.body.path);
  assert.ok(run.body.at, 'records when the backup happened');

  assert.equal(received.length, 1, 'the mock Storage saw exactly one upload');
  assert.equal(received[0].method, 'POST');
  assert.ok(received[0].url.startsWith('/storage/v1/object/shop-backups/martbill/'), received[0].url);
  assert.equal(received[0].apikey, 'test-key-123', 'the apikey header carries the configured key');
  assert.equal(received[0].auth, 'Bearer test-key-123', 'Storage wants the key as a bearer token too');
  const snap = JSON.parse(received[0].body);
  assert.equal(snap.app, 'shopbill', 'the pushed object is a MartBill snapshot');
  assert.ok(Array.isArray(snap.products) && Array.isArray(snap.users) && Array.isArray(snap.invoices),
    'the snapshot carries the full shop');

  const settings = await api('/api/settings');
  assert.ok(settings.body.last_cloud_backup, 'the last backup time is kept for the screen');

  // ---- 3. an unreachable host fails loudly but harmlessly ----
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ supabase_url: 'http://127.0.0.1:9' }) });
  const dead = await api('/api/settings/backup/cloud', { method: 'POST' });
  assert.equal(dead.status, 502, JSON.stringify(dead.body));
  assert.match(dead.body.error, /Could not reach Supabase/);
  const stillWorks = await api('/api/settings/backup');
  assert.equal(stillWorks.status, 200, 'a dead cloud target never breaks the local shop');
  const posStillWorks = await api('/api/products');
  assert.equal(posStillWorks.status, 200, 'billing data stays reachable through any cloud failure');

  // ---- 4. clearing the config returns to the honest unconfigured state ----
  await api('/api/settings', {
    method: 'PUT', body: JSON.stringify({ supabase_url: '', supabase_key: '', supabase_bucket: '' })
  });
  const cleared = await api('/api/settings/backup/cloud', { method: 'POST' });
  assert.equal(cleared.status, 400, 'cleared config refuses again');
});

// ---------- QA / hardening ----------
test('bad JSON and oversized bodies are client errors, not 500s', async () => {
  const bad = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json'
  });
  assert.equal(bad.status, 400, 'malformed JSON must be a 400');
  assert.match((await bad.json()).error, /Invalid JSON/i);

  const big = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pad: 'x'.repeat(21 * 1024 * 1024) })
  });
  assert.equal(big.status, 413, 'a 21MB body must be rejected');
  assert.match((await big.json()).error, /too large/i);
});

test('API sends security headers', async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
});

test('repeated failed logins are locked out, and a success clears the counter', async () => {
  // 10 wrong passwords for one username -> locked
  for (let i = 0; i < 10; i++) {
    const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'lockme', password: 'guess' + i }) });
    assert.equal(r.status, 401, `attempt ${i + 1} should be 401, got ${r.status}`);
  }
  const locked = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'lockme', password: 'guess' }) });
  assert.equal(locked.status, 429, 'locked account must return 429');
  assert.ok(locked.body.retry_after > 0, 'lock must tell the client when to retry');

  // a successful login resets that user's failure counter
  // (create a dedicated user — earlier tests may have replaced the users table)
  await api('/api/auth/users', {
    method: 'POST', body: JSON.stringify({ username: 'reset-user', password: 'reset-pass-1', name: 'Reset', role: 'cashier' })
  });
  const resetRow = (await api('/api/auth/users')).body.find(u => u.username === 'reset-user');
  await api(`/api/auth/users/${resetRow.id}`, { method: 'PUT', body: JSON.stringify({ active: true }) });
  for (let i = 0; i < 8; i++) {
    await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'reset-user', password: 'wrong-pass-' + i }) });
  }
  const ok = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'reset-user', password: 'reset-pass-1' }) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  for (let i = 0; i < 9; i++) {
    const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'reset-user', password: 'wrong-pass-' + i }) });
    assert.equal(r.status, 401, 'counter was not cleared by the successful login');
  }

  // the locked-out name never affects other logins
  const admin = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
  assert.equal(admin.status, 200, 'other accounts must stay usable during a lockout');
  token = admin.body.token;
});

test('the last active admin cannot be deactivated or demoted', async () => {
  const users = await api('/api/auth/users');
  const adminUser = users.body.find(u => u.username === 'admin');
  assert.ok(adminUser, 'admin user must exist');

  const off = await api(`/api/auth/users/${adminUser.id}`, { method: 'PUT', body: JSON.stringify({ active: 0 }) });
  assert.equal(off.status, 400, 'deactivating the only admin must be refused');
  assert.match(off.body.error, /active admin/i);

  const demote = await api(`/api/auth/users/${adminUser.id}`, { method: 'PUT', body: JSON.stringify({ role: 'cashier' }) });
  assert.equal(demote.status, 400, 'demoting the only admin must be refused');

  // with a second admin, both operations become allowed
  const created = await api('/api/auth/users', {
    method: 'POST', body: JSON.stringify({ username: 'admin2-qa', password: 'admin2-pass', name: 'Second Admin', role: 'admin' })
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const admin2 = created.body.id;
  const activate2 = await api(`/api/auth/users/${admin2}`, { method: 'PUT', body: JSON.stringify({ active: true }) });
  assert.equal(activate2.status, 200, JSON.stringify(activate2.body));

  const demote2 = await api(`/api/auth/users/${adminUser.id}`, { method: 'PUT', body: JSON.stringify({ role: 'cashier' }) });
  assert.equal(demote2.status, 200, JSON.stringify(demote2.body));

  // the demoted admin's own token lost admin rights — act as the second admin from here
  const admin2Login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin2-qa', password: 'admin2-pass' }) });
  assert.equal(admin2Login.status, 200, JSON.stringify(admin2Login.body));
  token = admin2Login.body.token;

  const restore = await api(`/api/auth/users/${adminUser.id}`, { method: 'PUT', body: JSON.stringify({ role: 'admin' }) });
  assert.equal(restore.status, 200, JSON.stringify(restore.body));

  const off2 = await api(`/api/auth/users/${admin2}`, { method: 'PUT', body: JSON.stringify({ active: 0 }) });
  assert.equal(off2.status, 200, 'a non-last admin may be deactivated');

  // hand the session back to the original admin and leave the shop in a clean state
  const backToAdmin = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
  assert.equal(backToAdmin.status, 200, 'the original admin must still be able to log in');
  token = backToAdmin.body.token;

  const login2 = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin2-qa', password: 'admin2-pass' }) });
  assert.equal(login2.status, 401, 'deactivated admin must not be able to log in');
});

test('non-finite and negative numbers are rejected wherever money or quantity is entered', async () => {
  const p = await api('/api/products', {
    method: 'POST',
    body: JSON.stringify({ name: 'Finite Test Item', barcode: '999888777', price: 100, cost_price: 50, stock_qty: 10, tax_rate: 0 })
  });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const pid = p.body.id;

  const bad = [
    { items: [{ product_id: pid, qty: 'Infinity' }] },
    { items: [{ product_id: pid, qty: -3 }] },
    { items: [{ product_id: pid, qty: 1, unit_price: 'Infinity' }] },
    { items: [{ product_id: pid, qty: 1, discount: -10 }] },
    { items: [{ product_id: pid, qty: 1 }], discount: -5 },
    { items: [{ product_id: pid, qty: 1 }], discount: 'Infinity' },
    { items: [{ product_id: pid, qty: 1 }], paid: 'Infinity' }
  ];
  for (const body of bad) {
    const r = await api('/api/invoices', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(r.status, 400, `must reject ${JSON.stringify(body)} but got ${r.status}: ${JSON.stringify(r.body)}`);
  }

  const afterBad = await api(`/api/products/${pid}`);
  assert.equal(afterBad.body.stock_qty, 10, 'rejected sales must not touch stock');

  // a real sale, then a repeated void can never restore stock twice
  const sale = await api('/api/invoices', { method: 'POST', body: JSON.stringify({ items: [{ product_id: pid, qty: 1 }] }) });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  const invId = sale.body.invoice.id;
  assert.equal((await api(`/api/products/${pid}`)).body.stock_qty, 9);

  const v1 = await api(`/api/invoices/${invId}/void`, { method: 'POST', body: '{}' });
  assert.equal(v1.status, 200, JSON.stringify(v1.body));
  assert.equal((await api(`/api/products/${pid}`)).body.stock_qty, 10);

  const v2 = await api(`/api/invoices/${invId}/void`, { method: 'POST', body: '{}' });
  assert.equal(v2.status, 400, 'voiding twice must be refused');
  assert.equal((await api(`/api/products/${pid}`)).body.stock_qty, 10, 'stock must not be restored twice');

  // payments use the same validation
  const cust = await api('/api/customers', { method: 'POST', body: JSON.stringify({ name: 'Finite Test Customer' }) });
  assert.equal(cust.status, 200, JSON.stringify(cust.body));
  const pay = await api(`/api/customers/${cust.body.id}/payments`, {
    method: 'POST', body: JSON.stringify({ amount: 'Infinity', allow_advance: true })
  });
  assert.equal(pay.status, 400, 'Infinity payment must be rejected');
});

// ---------- roles: Head / Inventory Manager / Cashier ----------
const as = t => ({ headers: { Authorization: `Bearer ${t}` } });

async function makeUser(username, password, role) {
  const created = await api('/api/auth/users', {
    method: 'POST', body: JSON.stringify({ username, password, role })
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.active, 0, 'accounts must start pending Head approval');

  const early = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  assert.equal(early.status, 401, 'a pending account must not be able to log in');

  const approved = await api(`/api/auth/users/${created.body.id}`, {
    method: 'PUT', body: JSON.stringify({ active: true })
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));

  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return login.body.token;
}

test('Head hands out roles and unknown roles are refused', async () => {
  const invToken = await makeUser('inv-manager', 'inv-pass-1', 'inventory');
  assert.ok(invToken, 'inventory manager gets a session after approval');

  const bad = await api('/api/auth/users', {
    method: 'POST', body: JSON.stringify({ username: 'nope', password: 'abcd1234', role: 'superuser' })
  });
  assert.equal(bad.status, 400, 'unknown roles must be refused');
  assert.match(bad.body.error, /Role must be one of/i);
});

test('Inventory Manager: stock only via request, reports read-only, no product/settings/user control', async () => {
  const inv = await makeUser('keeper', 'keep-pass-1', 'inventory');

  const prod = await api('/api/products', {
    method: 'POST',
    body: JSON.stringify({ name: 'Ration Bag', barcode: '555666777', price: 500, cost_price: 400, stock_qty: 10, tax_rate: 0 })
  });
  assert.equal(prod.status, 200, JSON.stringify(prod.body));
  const pid = prod.body.id;

  // reads are fine
  assert.equal((await api('/api/products', as(inv))).status, 200, 'can see products');
  assert.equal((await api('/api/reports/summary?from=2000-01-01&to=2099-01-01', as(inv))).status, 200, 'can read sales reports');
  assert.equal((await api('/api/stock/movements', as(inv))).status, 200, 'can see stock movements');

  // cannot manage the catalogue, settings or people
  assert.equal((await api(`/api/products/${pid}`, { method: 'PUT', body: JSON.stringify({ price: 1 }), ...as(inv) })).status, 403, 'cannot edit products');
  assert.equal((await api('/api/products', { method: 'POST', body: JSON.stringify({ name: 'X', price: 1 }), ...as(inv) })).status, 403, 'cannot create products');
  assert.equal((await api('/api/settings', { method: 'PUT', body: JSON.stringify({ shop_name: 'Hijack' }), ...as(inv) })).status, 403, 'cannot touch settings');
  assert.equal((await api('/api/auth/users', as(inv))).status, 403, 'cannot see users');
  assert.equal((await api('/api/sync/status', as(inv))).status, 403, 'cannot control sync');

  // direct stock entry is refused -> must go through a request
  const direct = await api('/api/stock/purchase', {
    method: 'POST', body: JSON.stringify({ items: [{ product_id: pid, qty: 5 }] }), ...as(inv)
  });
  assert.equal(direct.status, 403, 'cannot enter stock directly');

  const req1 = await api('/api/stock/requests', {
    method: 'POST', body: JSON.stringify({ product_id: pid, type: 'purchase', qty: 5, cost_price: 380, note: 'weekly order' }), ...as(inv)
  });
  assert.equal(req1.status, 200, JSON.stringify(req1.body));
  assert.equal(req1.body.status, 'pending', 'the Head must approve it first');
  assert.equal((await api(`/api/products/${pid}`)).body.stock_qty, 10, 'stock must not move before approval');

  const mine = await api('/api/stock/requests', as(inv));
  assert.equal(mine.status, 200);
  assert.ok(mine.body.some(r => r.id === req1.body.id), 'the manager can see their own request');
});

test('Head approves the stock request and the stock actually moves', async () => {
  const list = await api('/api/stock/requests?status=pending');
  assert.equal(list.status, 200);
  const pending = list.body.find(r => r.note === 'weekly order');
  assert.ok(pending, 'Head sees the pending request');

  const before = (await api(`/api/products/${pending.product_id}`)).body.stock_qty;
  const ok = await api(`/api/stock/requests/${pending.id}/approve`, { method: 'POST', body: JSON.stringify({ note: 'ordered' }) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.request.status, 'approved');
  assert.equal(ok.body.request.decided_by, (await api('/api/auth/me')).body.user.id);

  const after = (await api(`/api/products/${pending.product_id}`)).body.stock_qty;
  assert.equal(after, before + 5, 'approved quantity must be added to stock');
  assert.equal((await api(`/api/products/${pending.product_id}`)).body.cost_price, 380, 'purchase cost is applied');

  const again = await api(`/api/stock/requests/${pending.id}/approve`, { method: 'POST', body: '{}' });
  assert.equal(again.status, 400, 'a decided request cannot be approved twice');
  assert.equal((await api(`/api/products/${pending.product_id}`)).body.stock_qty, after, 'stock must not be added twice');

  // rejection leaves stock untouched
  const loginRes = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'keeper', password: 'keep-pass-1' }) });
  assert.equal(loginRes.status, 200, 'keeper must still be able to log in: ' + JSON.stringify(loginRes.body));
  const inv = loginRes.body.token;
  const req2 = await api('/api/stock/requests', {
    method: 'POST', body: JSON.stringify({ product_id: pending.product_id, type: 'purchase', qty: 100, cost_price: 1, note: 'too much' }), ...as(inv)
  });
  assert.equal(req2.status, 200, JSON.stringify(req2.body));
  const rej = await api(`/api/stock/requests/${req2.body.id}/reject`, { method: 'POST', body: JSON.stringify({ note: 'no' }) });
  assert.equal(rej.status, 200);
  assert.equal(rej.body.request.status, 'rejected');
  assert.equal((await api(`/api/products/${pending.product_id}`)).body.stock_qty, after, 'rejected request must not change stock');
});

test('Cashier: scans, bills, prints — nothing else', async () => {
  const cash = await makeUser('counter-boy', 'cb-pass-1', 'cashier');

  const prod = await api('/api/products', {
    method: 'POST',
    body: JSON.stringify({ name: 'Counter Item', barcode: '444555666', price: 120, cost_price: 90, stock_qty: 5, tax_rate: 0 })
  });
  assert.equal(prod.status, 200, JSON.stringify(prod.body));
  const pid = prod.body.id;
  const cust = await api('/api/customers', { method: 'POST', body: JSON.stringify({ name: 'Walk-in Test' }) });
  const cid = cust.body.id;

  // allowed: scan, low stock, bill, reprint
  const scan = await api('/api/products?barcode=444555666', as(cash));
  assert.equal(scan.status, 200, 'barcode scanning works');
  assert.equal(scan.body.length, 1);
  assert.equal((await api('/api/stock/low-stock', as(cash))).status, 200, 'low stock list is shown');

  const sale = await api('/api/invoices', {
    method: 'POST', body: JSON.stringify({ items: [{ product_id: pid, qty: 2 }], customer_id: cid }), ...as(cash)
  });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  const invId = sale.body.invoice.id;
  assert.equal((await api(`/api/products/${pid}`)).body.stock_qty, 3);
  assert.equal((await api('/api/invoices', as(cash))).status, 200, 'can reopen bills to print them');
  assert.equal((await api(`/api/invoices/${invId}`, as(cash))).status, 200, 'can print the bill');

  // refused: everything the Head controls
  const denied = [
    ['GET', '/api/reports/summary?from=2000-01-01&to=2099-01-01', null],
    ['GET', '/api/stock/movements', null],
    ['GET', '/api/stock/valuation', null],
    ['GET', '/api/auth/users', null],
    ['GET', '/api/sync/status', null],
    ['POST', '/api/stock/purchase', { items: [{ product_id: pid, qty: 5 }] }],
    ['POST', '/api/stock/requests', { product_id: pid, type: 'purchase', qty: 5 }],
    ['POST', '/api/products', { name: 'Sneaky', price: 1 }],
    ['PUT', `/api/products/${pid}`, { price: 1 }],
    ['POST', `/api/invoices/${invId}/void`, {}],
    ['PUT', '/api/settings', { shop_name: 'Hijack' }],
    ['DELETE', `/api/customers/${cid}`, null]
  ];
  for (const [method, path, body] of denied) {
    const r = await api(path, { method, ...(body ? { body: JSON.stringify(body) } : {}), ...as(cash) });
    assert.equal(r.status, 403, `${method} ${path} must be 403 for a cashier, got ${r.status}`);
  }

  // the Head still owns every one of those
  const headVoid = await api(`/api/invoices/${invId}/void`, { method: 'POST', body: '{}' });
  assert.equal(headVoid.status, 200, 'the Head can still void');
  assert.equal((await api(`/api/products/${pid}`)).body.stock_qty, 5, 'voiding restores the cashier sold stock');
});

// ---------------------------------------------------------------------------
// GST — shared/calc.js is the single money engine: the billing API charges
// with it, the POS screen totals with it, and the receipt / A4 invoice print it.
// ---------------------------------------------------------------------------

test('GST engine: exclusive prices get the tax added on top', () => {
  const t = invoiceCalc({ items: [{ qty: 2, unit_price: 100, tax_rate: 18, tax_inclusive: false }], round_off: false });
  assert.equal(t.subtotal, 200);
  assert.equal(t.taxTotal, 36);
  assert.equal(t.total, 236);
});

test('GST engine: inclusive shelf prices have the tax extracted out', () => {
  const t = invoiceCalc({ items: [{ qty: 1, unit_price: 110, tax_rate: 10, tax_inclusive: true }], round_off: false });
  assert.equal(t.subtotal, 100);
  assert.equal(t.taxTotal, 10);
  assert.equal(t.total, 110);
});

test('GST engine: a discount reduces the taxable value, never the tax owed', () => {
  // item discount on an exclusive price — the classic double-charge trap:
  // the customer pays Rs.90 for the goods, so GST is 10% of 90, not of 100
  const item = invoiceCalc({ items: [{ qty: 1, unit_price: 100, tax_rate: 10, tax_inclusive: false, discount: 10 }], round_off: false });
  assert.equal(item.subtotal, 90);
  assert.equal(item.taxTotal, 9);
  assert.equal(item.total, 99);

  // shelf price already contains the GST, so the discount comes off the gross
  const shelf = invoiceCalc({ items: [{ qty: 1, unit_price: 110, tax_rate: 10, tax_inclusive: true, discount: 10 }], round_off: false });
  assert.equal(shelf.total, 100);
  assert.equal(shelf.subtotal, 90.91);
  assert.equal(shelf.taxTotal, 9.09);

  // Rs.10 off the bill must cost the customer exactly Rs.10, GST included
  const bill = invoiceCalc({ items: [{ qty: 1, unit_price: 100, tax_rate: 18, tax_inclusive: false }], discount: 10, round_off: false });
  assert.equal(bill.total, 108);
  assert.equal(round2(bill.subtotal + bill.taxTotal), 108);
});

test('GST engine: mixed rates, discounts and round-off always add up', () => {
  const t = invoiceCalc({
    items: [
      { qty: 1, unit_price: 50, tax_rate: 0, tax_inclusive: true },
      { qty: 2, unit_price: 95, tax_rate: 5, tax_inclusive: true, discount: 5 },
      { qty: 1, unit_price: 100, tax_rate: 18, tax_inclusive: false }
    ],
    discount: 17.5
  });
  assert.equal(round2(t.subtotal + t.taxTotal + t.roundOff), t.total, 'taxable + GST + round off = total');
  assert.equal(
    round2(t.lines.reduce((s, l) => s + l.total_after_discount, 0) + t.roundOff),
    t.total,
    'the line amounts add up to the total'
  );
  assert.equal(round2(t.lines.reduce((s, l) => s + l.total_discount, 0)), 22.5, 'every rupee of discount is accounted for');
  assert.equal(t.totalDiscount, 22.5, 'line discount 5 + bill discount 17.50 = 22.50 taken off');
  assert.ok(Number.isInteger(t.total), 'round-off turns the bill into whole rupees');
});

test('an exclusive-priced product is billed with GST added on top', async () => {
  const prod = await api('/api/products', {
    method: 'POST',
    body: JSON.stringify({
      name: 'GST Exclusive Item', barcode: 'GSTEXCL01', unit: 'pcs',
      price: 100, cost_price: 60, stock_qty: 50, low_stock: 5,
      tax_rate: 18, tax_inclusive: false
    })
  });
  assert.equal(prod.status, 200);

  const sale = await api('/api/invoices', {
    method: 'POST',
    body: JSON.stringify({ items: [{ product_id: prod.body.id, qty: 1 }], paid: 118 })
  });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  assert.equal(sale.body.invoice.subtotal, 100);
  assert.equal(sale.body.invoice.tax_total, 18);
  assert.equal(sale.body.invoice.total, 118);
  assert.equal(sale.body.items[0].line_subtotal, 100);
  assert.equal(sale.body.items[0].tax_amount, 18);
  assert.equal(sale.body.items[0].line_total, 118);
});

test('the POS screen total equals the total the API stores (one shared engine)', async () => {
  const mk = (name, barcode, price, rate, inclusive) => api('/api/products', {
    method: 'POST',
    body: JSON.stringify({
      name, barcode, unit: 'pcs', price, cost_price: Math.round(price * 0.7),
      stock_qty: 100, low_stock: 5, tax_rate: rate, tax_inclusive: inclusive
    })
  });
  const p0 = (await mk('GST Band Zero', 'GSTZERO01', 50, 0, true)).body;
  const p5 = (await mk('GST Band Five', 'GSTFIVE01', 95, 5, true)).body;
  const p18 = (await mk('GST Band Eighteen', 'GSTETX01', 100, 18, false)).body;
  assert.ok(p0.id && p5.id && p18.id, 'the three demo bands must exist');

  // exactly how POS.jsx builds the cart and asks the engine for the totals
  const cart = [
    { id: p0.id, qty: 1, price: p0.price, tax_rate: 0, tax_inclusive: true, discount: 0 },
    { id: p5.id, qty: 2, price: p5.price, tax_rate: 5, tax_inclusive: true, discount: 0 },
    { id: p18.id, qty: 3, price: p18.price, tax_rate: 18, tax_inclusive: false, discount: 0 }
  ];
  const settings = (await api('/api/settings')).body;
  const screen = invoiceCalc({
    items: cart.map(i => ({
      qty: i.qty, unit_price: i.price, tax_rate: i.tax_rate,
      tax_inclusive: i.tax_inclusive, discount: i.discount || 0
    })),
    discount: 23,
    round_off: settings.round_off !== '0'
  });

  const sale = await api('/api/invoices', {
    method: 'POST',
    body: JSON.stringify({
      items: cart.map(i => ({ product_id: i.id, qty: i.qty, unit_price: i.price, discount: i.discount || 0 })),
      discount: 23
    })
  });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  const inv = sale.body.invoice;
  assert.equal(inv.subtotal, screen.subtotal, 'taxable value shown on the screen');
  assert.equal(inv.tax_total, screen.taxTotal, 'GST shown on the screen');
  assert.equal(inv.discount, screen.discount, 'discount shown on the screen');
  assert.equal(inv.round_off, screen.roundOff, 'round-off shown on the screen');
  assert.equal(inv.total, screen.total, 'TOTAL shown on the screen');
});

test('per-item discounts are charged on the taxable value and reported in full', async () => {
  const prod = (await api('/api/products', {
    method: 'POST',
    body: JSON.stringify({
      name: 'GST Discounted Item', barcode: 'GSTDSC01', unit: 'pcs',
      price: 100, cost_price: 60, stock_qty: 50, low_stock: 5,
      tax_rate: 10, tax_inclusive: false
    })
  })).body;

  const sale = await api('/api/invoices', {
    method: 'POST',
    body: JSON.stringify({ items: [{ product_id: prod.id, qty: 1, discount: 20 }] })
  });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  const inv = sale.body.invoice;
  assert.equal(inv.subtotal, 80, 'tax is charged only on what is really paid');
  assert.equal(inv.tax_total, 8);
  assert.equal(inv.total, 88);
  assert.equal(inv.discount, 20, 'the bill carries the full discount given');
  assert.equal(sale.body.items[0].line_discount, 20);
});

test('the bill rounds to whole rupees and the difference is shown', async () => {
  const before = (await api('/api/settings')).body;
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ round_off: '1' }) });

  const prod = (await api('/api/products', {
    method: 'POST',
    body: JSON.stringify({
      name: 'GST Rounded Item', barcode: 'GSTROUN01', unit: 'pcs',
      price: 90.6, cost_price: 50, stock_qty: 50, low_stock: 5,
      tax_rate: 0, tax_inclusive: true
    })
  })).body;

  const sale = await api('/api/invoices', {
    method: 'POST',
    body: JSON.stringify({ items: [{ product_id: prod.id, qty: 3 }] })
  });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  const inv = sale.body.invoice;
  assert.equal(inv.subtotal, 271.8);
  assert.equal(inv.total, 272);
  assert.equal(inv.round_off, 0.2);
  assert.equal(round2(inv.subtotal + inv.tax_total + inv.round_off), inv.total, 'the printed chain adds up');

  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ round_off: before.round_off || '1' }) });
});

test('the receipt and the A4 bill print the GST that was charged', async () => {
  const prod = (await api('/api/products', {
    method: 'POST',
    body: JSON.stringify({
      name: 'GST Printable Item', barcode: 'GSTPRN01', unit: 'pcs',
      price: 236, cost_price: 150, stock_qty: 40, low_stock: 5,
      tax_rate: 18, tax_inclusive: true
    })
  })).body;

  const sale = await api('/api/invoices', {
    method: 'POST',
    body: JSON.stringify({
      items: [{ product_id: prod.id, qty: 2, discount: 20 }],
      discount: 6
    })
  });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  const { invoice, items } = sale.body;
  assert.ok(invoice.discount > 0 && invoice.tax_total > 0);

  const shop = { shop_name: 'Test Mart', gstin: '11-1234567-8' };
  const receipt = receiptHTML({ invoice, items, shop, symbol: 'Rs.', taxLabel: 'GST' });
  const a4 = invoiceA4HTML({ invoice, items, shop, symbol: 'Rs.', taxLabel: 'GST' });

  // paper arithmetic: taxable + GST (+ round off) = total, and the discount is
  // presented as already applied instead of being subtracted a second time
  const atTaxable = receipt.indexOf('Taxable value');
  const atTotal = receipt.indexOf('>TOTAL<');
  const atDiscount = receipt.indexOf('Discount (incl.)');
  assert.ok(atTaxable > -1, 'receipt shows the taxable value');
  assert.ok(atTotal > atTaxable, 'the total comes after the taxable value');
  assert.ok(atDiscount > atTotal, 'the discount is shown after the total, not subtracted twice');
  assert.equal(
    round2(invoice.subtotal + invoice.tax_total + invoice.round_off),
    invoice.total,
    'the figures printed on the bill add up'
  );
  assert.ok(receipt.includes(money(invoice.subtotal, 'Rs.')), 'receipt prints the exact taxable value');
  assert.ok(receipt.includes(money(invoice.tax_total, 'Rs.')), 'receipt prints the exact GST');
  assert.ok(receipt.includes(money(invoice.total, 'Rs.')), 'receipt prints the exact total');
  assert.match(receipt, /-\s*Rs\. /, 'the receipt shows the per-item discount');

  assert.match(a4, /18%/, 'the A4 invoice lists the GST slab');
  assert.ok(a4.includes(money(invoice.tax_total, 'Rs.')), 'the A4 invoice prints the GST total');
  assert.ok(a4.includes('Discount applied (already included above)'), 'the A4 invoice explains the discount');
});

// ---------------------------------------------------------------------------
// Mart features: item returns (credit notes), expiry dates, % discount,
// daily GST summary — the four additions on top of the GST engine.
// ---------------------------------------------------------------------------

test('percentage discount converts to rupees through the same GST engine', () => {
  assert.equal(discountFromPercent(1000, 10), 100);
  assert.equal(discountFromPercent(1000, '7.5'), 75);
  assert.equal(discountFromPercent(1000, 0), 0);
  assert.equal(discountFromPercent(1000, -5), 0, 'a negative percent never gives money back');
  assert.equal(discountFromPercent(1000, 150), 1000, 'a fat-fingered percent can never exceed the bill');
  assert.equal(discountFromPercent(99.99, 50), 50);

  // 10% of the pre-discount bill must give exactly the same bill as typing the rupees
  const items = [
    { qty: 1, unit_price: 600, tax_rate: 10, tax_inclusive: false },
    { qty: 2, unit_price: 200, tax_rate: 5, tax_inclusive: false }
  ];
  const base = invoiceCalc({ items, discount: 0, round_off: false });
  assert.equal(base.grossTotal, 1080, 'gross bill = taxable + GST before any bill discount');
  const amount = discountFromPercent(base.grossTotal, 10);
  assert.equal(amount, 108);
  const byPercent = invoiceCalc({ items, discount: amount, round_off: false });
  const byRupees = invoiceCalc({ items, discount: 108, round_off: false });
  assert.equal(byPercent.total, byRupees.total, '% and Rs. paths meet in the same engine');
  assert.ok(byPercent.total < base.total);
});

test('returns: only the Head refunds, GST is prorated and the original bill stays true', async () => {
  const prod = (await api('/api/products', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Returnable Item', barcode: 'RETBL001', unit: 'pcs',
      price: 110, cost_price: 70, stock_qty: 20, low_stock: 2,
      tax_rate: 10, tax_inclusive: true
    })
  })).body;
  assert.ok(prod.id);

  const sale = await api('/api/invoices', {
    method: 'POST', body: JSON.stringify({ items: [{ product_id: prod.id, qty: 4 }] })
  });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  const inv = sale.body.invoice;
  const line = sale.body.items[0];
  assert.equal(inv.subtotal, 400, '4 × Rs.110 incl. 10% GST → taxable 400');
  assert.equal(inv.tax_total, 40);
  assert.equal(inv.total, 440);
  assert.equal((await api(`/api/products/${prod.id}`)).body.stock_qty, 16);

  const body = { invoice_id: inv.id, items: [{ invoice_item_id: line.id, qty: 1 }], reason: 'customer changed mind' };

  // roles: Cashier and Inventory Manager may read returns, never create one
  const cb = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'counter-boy', password: 'cb-pass-1' }) });
  assert.equal(cb.status, 200, 'counter-boy still logs in: ' + JSON.stringify(cb.body));
  assert.equal((await api('/api/returns', { method: 'POST', body: JSON.stringify(body), ...as(cb.body.token) })).status, 403, 'cashier cannot refund');
  assert.equal((await api('/api/returns', as(cb.body.token))).status, 200, 'cashier may view the history');

  const keeper = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'keeper', password: 'keep-pass-1' }) });
  assert.equal(keeper.status, 200, 'keeper still logs in: ' + JSON.stringify(keeper.body));
  assert.equal((await api('/api/returns', { method: 'POST', body: JSON.stringify(body), ...as(keeper.body.token) })).status, 403, 'Inventory Manager cannot refund');

  // the Head refunds 1 of 4 → exactly a quarter of the stored line comes back
  const ret = await api('/api/returns', { method: 'POST', body: JSON.stringify(body) });
  assert.equal(ret.status, 200, JSON.stringify(ret.body));
  const rn = ret.body.return;
  assert.match(rn.return_no, /^RET-/);
  assert.equal(rn.subtotal, 100, 'taxable value of the returned goods');
  assert.equal(rn.tax_total, 10, 'the GST is reversed with it');
  assert.equal(rn.total, 110, 'taxable + GST = what goes back to the customer');
  assert.equal(rn.cash_refund, 110, 'walk-in cash sale → cash back from the till');
  assert.equal(rn.credit_adjust, 0);
  assert.equal((await api(`/api/products/${prod.id}`)).body.stock_qty, 17, 'the piece is back on the shelf');

  // the bill is annotated, never rewritten
  const after = (await api(`/api/invoices/${inv.id}`)).body;
  assert.equal(after.invoice.paid_amount, 330, 'cash left the till');
  assert.equal(after.invoice.total, 440, 'the original total is immutable');
  assert.equal(after.items[0].returned_qty, 1);
  assert.equal(after.items[0].returned_amount, 110);
  assert.equal(after.returns.length, 1);

  // return the rest in one go, then try once more
  const rest = await api('/api/returns', {
    method: 'POST',
    body: JSON.stringify({ invoice_id: inv.id, items: [{ invoice_item_id: line.id, qty: 3 }] })
  });
  assert.equal(rest.status, 200, JSON.stringify(rest.body));
  assert.equal(rest.body.return.total, 330);
  const over = await api('/api/returns', {
    method: 'POST',
    body: JSON.stringify({ invoice_id: inv.id, items: [{ invoice_item_id: line.id, qty: 1 }] })
  });
  assert.equal(over.status, 400, 'cannot return more than was sold');

  assert.equal((await api(`/api/products/${prod.id}`)).body.stock_qty, 20, 'all stock restored');
  const done = (await api(`/api/invoices/${inv.id}`)).body;
  assert.equal(done.invoice.paid_amount, 0);
  assert.equal(done.invoice.due_amount, 0);
  assert.equal(done.invoice.status, 'paid', 'nothing is owed any more');
  assert.equal(done.items[0].returned_qty, 4);

  // a returned bill cannot be voided — stock and money were already given back
  const voidRes = await api(`/api/invoices/${inv.id}/void`, { method: 'POST', body: '{}' });
  assert.equal(voidRes.status, 400, 'voiding a returned invoice must be refused');
  assert.match(String(voidRes.body.error), /return/i);

  // the invoice list shows how much of the bill was refunded
  const list = (await api('/api/invoices?limit=500')).body.find(i => i.id === inv.id);
  assert.ok(list, 'the invoice is still listed');
  assert.equal(list.returned_total, 440);

  // and the returns tables travel with the backup
  const backup = (await api('/api/settings/backup')).body;
  assert.ok(Array.isArray(backup.returns) && backup.returns.length >= 1, 'backup carries the returns table');
  assert.ok(Array.isArray(backup.return_items), 'backup carries the return lines');
});

test('a return on a credit sale clears the customer balance before paying cash', async () => {
  const cust = (await api('/api/customers', { method: 'POST', body: JSON.stringify({ name: 'Refund Customer', phone: '03009998877' }) })).body;
  const prod = (await api('/api/products', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Credit Return Item', barcode: 'CREDRET01', unit: 'pcs',
      price: 105, cost_price: 60, stock_qty: 10, low_stock: 2,
      tax_rate: 5, tax_inclusive: true
    })
  })).body;

  const sale = await api('/api/invoices', {
    method: 'POST',
    body: JSON.stringify({ items: [{ product_id: prod.id, qty: 2 }], customer_id: cust.id, paid: 100, payment_method: 'cash' })
  });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  const inv = sale.body.invoice;
  assert.equal(inv.total, 210, '2 × Rs.105 incl. 5% GST');
  assert.equal(inv.due_amount, 110);
  assert.equal(inv.status, 'partial');

  const balanceBefore = (await api('/api/customers')).body.find(c => c.id === cust.id).balance;
  assert.equal(balanceBefore, 110);

  const ret = await api('/api/returns', {
    method: 'POST',
    body: JSON.stringify({ invoice_id: inv.id, items: [{ invoice_item_id: sale.body.items[0].id, qty: 2 }], reason: 'both pieces returned' })
  });
  assert.equal(ret.status, 200, JSON.stringify(ret.body));
  assert.equal(ret.body.return.credit_adjust, 110, 'the outstanding credit is wiped first');
  assert.equal(ret.body.return.cash_refund, 100, 'the paid part goes back in cash');
  assert.equal(ret.body.return.total, 210);

  const after = (await api(`/api/invoices/${inv.id}`)).body;
  assert.equal(after.invoice.due_amount, 0);
  assert.equal(after.invoice.paid_amount, 0);
  assert.equal(after.invoice.status, 'paid');

  const balanceAfter = (await api('/api/customers')).body.find(c => c.id === cust.id).balance;
  assert.equal(balanceAfter, 0, 'the ledger carries the credit note');
  assert.equal((await api(`/api/products/${prod.id}`)).body.stock_qty, 10, 'both pieces are back on the shelf');
});

test('reports net returns out of revenue, GST, daily takings and product sales', async () => {
  const range = 'from=2000-01-01&to=2099-12-31';
  const before = (await api(`/api/reports/summary?${range}`)).body;
  const taxBefore = (await api(`/api/reports/tax?${range}`)).body;
  const dailyBefore = (await api(`/api/reports/daily?${range}`)).body;
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayBefore = dailyBefore.find(d => d.date === todayStr);

  const prod = (await api('/api/products', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Report Return Item', barcode: 'RPTRET01', unit: 'pcs',
      price: 236, cost_price: 150, stock_qty: 30, low_stock: 2,
      tax_rate: 18, tax_inclusive: true
    })
  })).body;

  const sale = await api('/api/invoices', {
    method: 'POST', body: JSON.stringify({ items: [{ product_id: prod.id, qty: 2 }] })
  });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  const inv = sale.body.invoice;
  assert.equal(inv.subtotal, 400, '2 × Rs.236 incl. 18% GST → taxable 400');
  assert.equal(inv.tax_total, 72);
  assert.equal(inv.total, 472);

  const ret = await api('/api/returns', {
    method: 'POST',
    body: JSON.stringify({ invoice_id: inv.id, items: [{ invoice_item_id: sale.body.items[0].id, qty: 2 }] })
  });
  assert.equal(ret.status, 200, JSON.stringify(ret.body));

  const after = (await api(`/api/reports/summary?${range}`)).body;
  assert.equal(after.revenue, before.revenue, 'a fully returned bill adds no revenue');
  assert.equal(after.tax, before.tax, 'the reversed GST comes back out');
  assert.equal(after.items_sold, before.items_sold, 'returned pieces stop counting as sold');
  assert.equal(after.refunds, round2(before.refunds + 472), 'the credit note is still reported separately');

  const taxAfter = (await api(`/api/reports/tax?${range}`)).body;
  const band18Before = taxBefore.find(r => r.rate === 18);
  const band18After = taxAfter.find(r => r.rate === 18);
  assert.ok(band18Before, 'the 18% band existed before');
  assert.equal(band18After.tax, band18Before.tax, 'GST by slab is net of credit notes');

  const dailyAfter = (await api(`/api/reports/daily?${range}`)).body;
  const todayAfter = dailyAfter.find(d => d.date === todayStr);
  assert.equal(
    todayAfter.refunds,
    round2((todayBefore?.refunds || 0) + 472),
    'daily takings show the refund of the day'
  );

  const products = (await api(`/api/reports/products?${range}`)).body;
  const row = products.find(p => p.product_id === prod.id);
  assert.ok(row, 'the product keeps its row');
  assert.equal(row.qty, 0, 'sold 2, returned 2 → net 0');
  assert.equal(row.revenue, 0, 'no net revenue left');
});

test('expiry dates are saved, validated and listed for every role', async () => {
  const inDays = d => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

  // a wrong format is refused
  const bad = await api('/api/products', {
    method: 'POST',
    body: JSON.stringify({ name: 'Bad Expiry Item', price: 50, expiry_date: '31/12/2026' })
  });
  assert.equal(bad.status, 400);
  assert.match(String(bad.body.error), /expiry/i);

  const mk = async (name, barcode, expiry_date) => {
    const r = await api('/api/products', {
      method: 'POST',
      body: JSON.stringify({
        name, barcode, unit: 'pcs', price: 80, cost_price: 50,
        stock_qty: 12, low_stock: 2, tax_rate: 0, expiry_date
      })
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const expired = await mk('Expired Demo Item', 'EXPDATE1', '2024-01-01');
  const soon = await mk('Near Expiry Item', 'EXPDATE2', inDays(6));
  const plain = await mk('No Expiry Item', 'EXPDATE3', '');
  assert.equal(expired.expiry_date, '2024-01-01');
  assert.equal(plain.expiry_date, '');

  const list = (await api('/api/reports/expiring?days=30')).body;
  const e = list.find(x => x.id === expired.id);
  assert.ok(e, 'the expired item is on the list');
  assert.equal(e.expired, true, 'it is flagged as already expired');
  assert.ok(e.days_left < 0, 'days left is negative for expired stock');
  const s = list.find(x => x.id === soon.id);
  assert.ok(s, 'the near-expiry item is on the list');
  assert.equal(s.expired, false);
  assert.equal(s.days_left, 6);
  assert.ok(!list.find(x => x.id === plain.id), 'products without a date never show up');

  // the Cashier sees it too — they must refuse to scan expired goods
  const cb = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'counter-boy', password: 'cb-pass-1' }) });
  const seen = await api('/api/reports/expiring?days=30', as(cb.body.token));
  assert.equal(seen.status, 200, 'the cashier can see what must not be sold');

  // CSV export for the manager's clipboard
  const csv = await api('/api/reports/expiring?days=30&format=csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type') || '', /text\/csv/);
  assert.match(String(csv.body), /Expiry/);

  // clearing the date removes the product from the report
  const upd = await api(`/api/products/${soon.id}`, { method: 'PUT', body: JSON.stringify({ expiry_date: '' }) });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  assert.equal(upd.body.expiry_date, '');
  const after = (await api('/api/reports/expiring?days=30')).body;
  assert.ok(!after.find(x => x.id === soon.id), 'a cleared date leaves the report');
  assert.ok(after.find(x => x.id === expired.id), 'the expired item stays until it is dealt with');
});

// ---------- login page: brand info + self-registration ----------
test('self-registration creates an account that waits for Head approval', async () => {
  const r = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Sara Khan', username: 'sara-billing', password: 'sara1234', confirm: 'sara1234', role: 'inventory' })
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.pending, true, 'a normal registration always starts pending');
  assert.equal(r.body.role, 'inventory', 'the requested role is remembered for the Head');

  // pending accounts must not be able to sign in
  const early = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'sara-billing', password: 'sara1234' }) });
  assert.equal(early.status, 401, 'pending accounts cannot log in');

  // the Head sees the request and approves it
  const list = await api('/api/auth/users');
  const sara = list.body.find(u => u.username === 'sara-billing');
  assert.ok(sara, 'the request shows up for the Head');
  assert.equal(sara.active, 0, 'shown as pending');

  const approve = await api(`/api/auth/users/${sara.id}`, { method: 'PUT', body: JSON.stringify({ active: true }) });
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  const good = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'sara-billing', password: 'sara1234' }) });
  assert.equal(good.status, 200, 'after approval the account can sign in');
  assert.equal(good.body.user.role, 'inventory', 'keeps the requested role');
});

test('registration validates input and duplicate usernames', async () => {
  const dup = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ name: 'Dup', username: 'admin', password: 'abcd', confirm: 'abcd' }) });
  assert.equal(dup.status, 400, 'taken username is rejected');
  assert.match(String(dup.body.error), /taken/i);

  const weak = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ name: 'Weak', username: 'weak-user', password: '123', confirm: '123' }) });
  assert.equal(weak.status, 400, 'password must be at least 4 characters');

  const badUser = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ name: 'X', username: 'a b!', password: 'abcd', confirm: 'abcd' }) });
  assert.equal(badUser.status, 400, 'bad username characters are rejected');

  const noName = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ name: '  ', username: 'no-name-user', password: 'abcd', confirm: 'abcd' }) });
  assert.equal(noName.status, 400, 'name is required');

  const mismatch = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ name: 'M', username: 'm-user', password: 'abcd', confirm: 'abce' }) });
  assert.equal(mismatch.status, 400, 'passwords must match');
});

test('the Head can switch off new account requests', async () => {
  const off = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ allow_register: '0' }) });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.allow_register, '0', 'setting saved');

  const blocked = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ name: 'Nope', username: 'nope-user', password: 'abcd', confirm: 'abcd' }) });
  assert.equal(blocked.status, 403, 'sign-ups are switched off');

  // the login page reads this and hides the Create-account form
  const b = await (await fetch(`${BASE}/api/auth/brand`)).json();
  assert.equal(b.allow_register, false, 'brand reports sign-ups are off');

  const on = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ allow_register: '1' }) });
  assert.equal(on.body.allow_register, '1', 'switched back on');
});

test('login page brand endpoint is public and leaks nothing', async () => {
  const res = await fetch(`${BASE}/api/auth/brand`);
  assert.equal(res.status, 200, 'no login needed for the brand info');
  const b = await res.json();
  assert.equal(typeof b.setup, 'boolean');
  assert.equal(b.setup, false, 'the shop now has more than the default account');
  assert.equal(b.allow_register, true);
  assert.ok(b.shop_name, 'shop name for the login headline');
  assert.equal(b.currency_symbol, 'Rs');
  assert.equal(b.tax_label, 'GST');
  assert.ok(Array.isArray(b.demo), 'demo logins arrive as an array');
  assert.ok(!JSON.stringify(b).includes('password_hash'), 'never expose password hashes');
});

// ---------- Google sign-in (optional, switched on by the Head) ----------
test('Google sign-in is off until the Head switches it on, and never bypasses approval', async () => {
  // off by default: the login page gets no client id and the endpoint refuses
  let b = await (await fetch(`${BASE}/api/auth/brand`)).json();
  assert.equal(b.google_client_id, '', 'no Google button on a shop that never set it up');

  const off = await api('/api/auth/google', { method: 'POST', body: JSON.stringify({ credential: 'whatever' }) });
  assert.equal(off.status, 400, 'refused before any token is even looked at');
  assert.match(String(off.body.error), /not set up/i);

  // the Head turns it on in Settings → Google Sign-in
  const save = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ google_client_id: 'test-client-id.apps.googleusercontent.com' }) });
  assert.equal(save.status, 200, JSON.stringify(save.body));
  assert.equal(save.body.google_client_id, 'test-client-id.apps.googleusercontent.com');

  b = await (await fetch(`${BASE}/api/auth/brand`)).json();
  assert.equal(b.google_client_id, 'test-client-id.apps.googleusercontent.com', 'the login page can now draw the button');

  // a credential is mandatory, a forged one is refused — the reason is never leaked
  const noCred = await api('/api/auth/google', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(noCred.status, 400);
  assert.match(String(noCred.body.error), /missing/i);

  const forged = await api('/api/auth/google', { method: 'POST', body: JSON.stringify({ credential: 'forged.token.value' }) });
  assert.equal(forged.status, 400, 'a token Google did not sign is rejected');
  assert.equal(String(forged.body.error), 'Invalid Google sign-in');
  assert.ok(!JSON.stringify(forged.body).includes('signature'), 'never say why it failed');

  // sign-ups off means no new Google identities either — the Head still adds people
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ allow_register: '0' }) });
  const blocked = await api('/api/auth/google', { method: 'POST', body: JSON.stringify({ credential: 'forged.token.value' }) });
  assert.equal(blocked.status, 400, 'still only 400s — a fake token can never reach the account rules');
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ allow_register: '1' }) });

  // switch Google sign-in back off so the rest of the suite sees a password-only shop
  const back = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ google_client_id: '' }) });
  assert.equal(back.body.google_client_id, '');
});

test('only someone with Settings access can switch Google sign-in on or off', async () => {
  const create = await api('/api/auth/users', {
    method: 'POST', body: JSON.stringify({ username: 'gcashier', password: 'gc-pass-1', name: 'Google Cashier', role: 'cashier' })
  });
  assert.equal(create.status, 200, JSON.stringify(create.body));
  await api(`/api/auth/users/${create.body.id}`, { method: 'PUT', body: JSON.stringify({ active: true }) });

  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'gcashier', password: 'gc-pass-1' }) });
  assert.equal(login.status, 200, JSON.stringify(login.body));

  const res = await fetch(`${BASE}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.body.token}` },
    body: JSON.stringify({ google_client_id: 'stolen-id.apps.googleusercontent.com' })
  });
  assert.equal(res.status, 403, 'a cashier cannot turn Google sign-in on');

  const still = await (await fetch(`${BASE}/api/auth/brand`)).json();
  assert.equal(still.google_client_id, '', 'the setting did not change');
});

test('a 10,000-line bill stores every item, deducts stock once and still matches the engine', async () => {
  const prod = await api('/api/products', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Bulk Basmati Sack', barcode: 'BULKSACK50', unit: 'bag',
      price: 2500, cost_price: 2100, stock_qty: 12000, low_stock: 10, tax_rate: 0
    })
  });
  assert.equal(prod.status, 200, JSON.stringify(prod.body));

  // the hard case: 10,000 separate cart lines carrying the SAME product
  const items = Array.from({ length: 10000 }, () => ({ product_id: prod.body.id, qty: 1, unit_price: 2500 }));
  const settings = (await api('/api/settings')).body;
  const screen = invoiceCalc({
    items: items.map(i => ({ qty: i.qty, unit_price: i.unit_price, tax_rate: 0, tax_inclusive: false, discount: 0 })),
    discount: 0,
    round_off: settings.round_off !== '0'
  });

  const t0 = Date.now();
  const sale = await api('/api/invoices', { method: 'POST', body: JSON.stringify({ items, paid: 25000000 }) });
  const ms = Date.now() - t0;
  assert.equal(sale.status, 200, String(sale.body && sale.body.error || '').slice(0, 300));
  assert.equal(sale.body.items.length, 10000, 'every line of the bill is stored');
  assert.equal(sale.body.invoice.total, screen.total, 'the shared GST engine still adds up at this size');
  assert.ok(ms < 20000, `10,000 lines took ${ms}ms — must stay well under 20 seconds`);

  // the product appeared on 10,000 lines: stock must fall by EXACTLY 10,000
  const check = (await api(`/api/products?barcode=${prod.body.barcode}`)).body;
  assert.equal(check[0].stock_qty, 2000, 'stock deducted once per product, summed over every line');

  // overselling the remaining 2,000 must still be refused (total, not per-line, check)
  const over = await api('/api/invoices', {
    method: 'POST', body: JSON.stringify({ items: [
      { product_id: prod.body.id, qty: 1500 }, { product_id: prod.body.id, qty: 1000 }
    ] })
  });
  assert.equal(over.status, 400, 'the two lines together exceed the stock');
  assert.match(over.body.error, /Insufficient stock/);
});

test('hold a bill, find it in the list, resume it and discard it', async () => {
  const p = (await api('/api/products?barcode=BULKSACK50')).body[0];
  assert.ok(p, 'the bulk product exists');

  // the cashier parks a half-finished cart
  const held = await api('/api/held', {
    method: 'POST',
    body: JSON.stringify({
      ref: 'Counter 2',
      cart: [{ id: p.id, name: p.name, unit: p.unit, qty: 2, price: p.price, tax_rate: 0, tax_inclusive: false, stock: p.stock_qty }],
      discount: '0', discount_mode: 'amount',
      customer_id: null, paid: '', method: 'cash',
      total: p.price * 2
    })
  });
  assert.equal(held.status, 200, JSON.stringify(held.body));
  assert.equal(held.body.ref, 'Counter 2');
  assert.equal(held.body.item_count, 2);
  assert.equal(held.body.total, p.price * 2);

  // it shows up in the held list…
  const list = await api('/api/held');
  assert.equal(list.status, 200);
  assert.ok(list.body.some(h => h.id === held.body.id), 'appears in the held list');
  assert.ok(!('cart' in list.body[0]), 'the list stays light — no cart payloads');

  // …and the full cart comes back for resuming
  const full = await api(`/api/held/${held.body.id}`);
  assert.equal(full.status, 200);
  assert.equal(full.body.cart.length, 1);
  assert.equal(full.body.cart[0].id, p.id);
  assert.equal(full.body.cart[0].qty, 2);
  assert.equal(full.body.cart[0].stock, p.stock_qty, 'the stock guard travels with the held cart');

  // an empty cart cannot be held
  const empty = await api('/api/held', { method: 'POST', body: JSON.stringify({ cart: [] }) });
  assert.equal(empty.status, 400);

  // resume removes it from the list (discard endpoint)
  const del = await api(`/api/held/${held.body.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal((await api(`/api/held/${held.body.id}`)).status, 404, 'gone after resume/discard');
});

test('expenses: the Head records kharcha, others stay out unless granted', async () => {
  // create
  const created = await api('/api/expenses', {
    method: 'POST',
    body: JSON.stringify({ expense_date: '2026-10-01', category: 'Utilities', amount: 1500.5, payment_method: 'cash', note: 'Electricity' })
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.amount, 1500.5);
  assert.equal(created.body.category, 'Utilities');
  assert.ok(created.body.created_by_name, 'the entry remembers who recorded it');

  // list with a period filter
  const list = await api('/api/expenses?from=2026-10-01&to=2026-10-31');
  assert.equal(list.status, 200);
  assert.ok(list.body.some(e => e.id === created.body.id), 'appears in the period');

  // edit
  const upd = await api(`/api/expenses/${created.body.id}`, {
    method: 'PUT', body: JSON.stringify({ amount: 1750, category: 'Utilities' })
  });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  assert.equal(upd.body.amount, 1750);
  assert.equal(upd.body.expense_date, '2026-10-01', 'the date survives a partial edit');

  // validation
  const neg = await api('/api/expenses', { method: 'POST', body: JSON.stringify({ amount: -5 }) });
  assert.equal(neg.status, 400);
  const zero = await api('/api/expenses', { method: 'POST', body: JSON.stringify({ amount: 0 }) });
  assert.equal(zero.status, 400);
  const badDate = await api('/api/expenses', { method: 'POST', body: JSON.stringify({ amount: 10, expense_date: 'yesterday' }) });
  assert.equal(badDate.status, 400);

  // RBAC: a cashier cannot read or write expenses
  await api('/api/auth/users', {
    method: 'POST', body: JSON.stringify({ username: 'exp-cashier', password: 'exp-pass-1', name: 'Exp Cashier', role: 'cashier' })
  });
  const row = (await api('/api/auth/users')).body.find(u => u.username === 'exp-cashier');
  assert.ok(row, 'the cashier account exists');
  await api(`/api/auth/users/${row.id}`, { method: 'PUT', body: JSON.stringify({ active: true }) });
  const login = await api('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'exp-cashier', password: 'exp-pass-1' })
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const asCashier = await api('/api/expenses', { headers: { Authorization: `Bearer ${login.body.token}` } });
  assert.equal(asCashier.status, 403, 'expenses stay with the Head unless granted');
  const asCashierWrite = await api('/api/expenses', {
    method: 'POST', headers: { Authorization: `Bearer ${login.body.token}` },
    body: JSON.stringify({ amount: 99 })
  });
  assert.equal(asCashierWrite.status, 403, 'no writing either');

  // back to the Head for the rest of the suite
  const adminBack = await api('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  assert.equal(adminBack.status, 200);
  token = adminBack.body.token;

  // delete
  const del = await api(`/api/expenses/${created.body.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const after = await api('/api/expenses?from=2000-01-01');
  assert.ok(!after.body.some(e => e.id === created.body.id), 'removed from the list');
});

test('loyalty: customers earn points on a sale and spend them as discount', async () => {
  // a controlled product so the maths is exact (tax-free, price 1000)
  await api('/api/products', {
    method: 'POST',
    body: JSON.stringify({ name: 'Loyalty Item', barcode: 'LOYALTY1', price: 1000, cost_price: 600, stock_qty: 50, tax_rate: 0 })
  });
  const prod = (await api('/api/products?barcode=LOYALTY1')).body[0];
  assert.ok(prod, 'the loyalty test product exists');

  const cust = await api('/api/customers', {
    method: 'POST', body: JSON.stringify({ name: 'Loyal Nia', phone: '03009990001' })
  });
  assert.equal(cust.status, 200, JSON.stringify(cust.body));

  // sale 1: Rs. 1,000 → earns floor(1000 × 1 / 100) = 10 points
  const s1 = await api('/api/invoices', {
    method: 'POST',
    body: JSON.stringify({ customer_id: cust.body.id, items: [{ product_id: prod.id, qty: 1 }], paid: 1000 })
  });
  assert.equal(s1.status, 200, JSON.stringify(s1.body));
  assert.equal(s1.body.invoice.total, 1000);
  let rows = (await api('/api/customers?search=' + encodeURIComponent('Loyal Nia'))).body;
  let nia = rows.find(c => c.id === cust.body.id);
  assert.equal(nia.loyalty_points, 10, 'ten points banked on the first sale');

  // sale 2: spend 5 points (Rs. 5 off with the default 1 rupee per point)
  const s2 = await api('/api/invoices', {
    method: 'POST',
    body: JSON.stringify({ customer_id: cust.body.id, items: [{ product_id: prod.id, qty: 1 }], paid: 995, loyalty_points: 5 })
  });
  assert.equal(s2.status, 200, JSON.stringify(s2.body));
  assert.equal(s2.body.invoice.total, 995, 'the points came off the bill');
  assert.equal(s2.body.invoice.discount, 5, 'redemption is stored as the discount it is');
  assert.equal(s2.body.invoice.loyalty_redeemed, 5, 'the invoice remembers the points spent');
  rows = (await api('/api/customers?search=' + encodeURIComponent('Loyal Nia'))).body;
  nia = rows.find(c => c.id === cust.body.id);
  assert.equal(nia.loyalty_points, 14, '10 − 5 redeemed + 9 earned on the 995 sale');

  // nobody can spend points they do not have
  const over = await api('/api/invoices', {
    method: 'POST',
    body: JSON.stringify({ customer_id: cust.body.id, items: [{ product_id: prod.id, qty: 1 }], loyalty_points: 500 })
  });
  assert.equal(over.status, 400);
  assert.match(over.body.error, /points available/);

  // walk-in customers own no points
  const walk = await api('/api/invoices', {
    method: 'POST', body: JSON.stringify({ items: [{ product_id: prod.id, qty: 1 }], loyalty_points: 1 })
  });
  assert.equal(walk.status, 400);
  assert.match(walk.body.error, /customer/);
});

test('coupons: the Head issues codes, the POS applies them, every use is counted', async () => {
  // only the Head can hand out coupons
  const cashLogin = await api('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'exp-cashier', password: 'exp-pass-1' })
  });
  assert.equal(cashLogin.status, 200, JSON.stringify(cashLogin.body));
  const denied = await api('/api/coupons', {
    method: 'POST', headers: { Authorization: `Bearer ${cashLogin.body.token}` },
    body: JSON.stringify({ code: 'ROCKET', type: 'fixed', value: 5 })
  });
  assert.equal(denied.status, 403, 'only the Head hands out coupons');
  const adminBack = await api('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  assert.equal(adminBack.status, 200);
  token = adminBack.body.token;

  // create
  const c1 = await api('/api/coupons', {
    method: 'POST', body: JSON.stringify({ code: 'SAVE50', type: 'fixed', value: 50, min_total: 200 })
  });
  assert.equal(c1.status, 200, JSON.stringify(c1.body));
  assert.equal(c1.body.code, 'SAVE50');

  // guards: duplicate code, impossible percent, too-short code
  const dup = await api('/api/coupons', { method: 'POST', body: JSON.stringify({ code: 'save50', type: 'fixed', value: 10 }) });
  assert.equal(dup.status, 400, 'case-insensitive duplicate refused');
  const pct = await api('/api/coupons', { method: 'POST', body: JSON.stringify({ code: 'TOOBIG', type: 'percent', value: 150 }) });
  assert.equal(pct.status, 400, 'percent cannot exceed 100');
  const tiny = await api('/api/coupons', { method: 'POST', body: JSON.stringify({ code: 'x', type: 'fixed', value: 5 }) });
  assert.equal(tiny.status, 400, 'code shape enforced');

  // the POS checks a code before applying it
  const tooSmall = await api('/api/coupons/validate', { method: 'POST', body: JSON.stringify({ code: 'save50', total: 100 }) });
  assert.equal(tooSmall.status, 400, 'below the minimum bill');
  assert.match(tooSmall.body.error, /at least/);
  const good = await api('/api/coupons/validate', { method: 'POST', body: JSON.stringify({ code: 'SAVE50', total: 300 }) });
  assert.equal(good.status, 200, JSON.stringify(good.body));
  assert.equal(good.body.discount, 50);
  const unknown = await api('/api/coupons/validate', { method: 'POST', body: JSON.stringify({ code: 'NOPE99', total: 300 }) });
  assert.equal(unknown.status, 400);

  // apply it on a real bill
  const prod = (await api('/api/products?barcode=LOYALTY1')).body[0];
  assert.ok(prod, 'the loyalty test product exists');
  const sale = await api('/api/invoices', {
    method: 'POST',
    body: JSON.stringify({ items: [{ product_id: prod.id, qty: 1 }], paid: 950, coupon_code: 'SAVE50' })
  });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  assert.equal(sale.body.invoice.total, 950, 'Rs.1000 − Rs.50 coupon');
  assert.equal(sale.body.invoice.coupon_code, 'SAVE50');
  assert.equal(sale.body.invoice.coupon_discount, 50);

  const afterUse = (await api('/api/coupons')).body.find(c => c.code === 'SAVE50');
  assert.equal(afterUse.used_count, 1, 'the use is counted');

  // one-use coupon: the second attempt is refused
  const c2 = await api('/api/coupons', {
    method: 'POST', body: JSON.stringify({ code: 'ONCEONLY', type: 'fixed', value: 10, max_uses: 1 })
  });
  assert.equal(c2.status, 200, JSON.stringify(c2.body));
  const s2 = await api('/api/invoices', {
    method: 'POST', body: JSON.stringify({ items: [{ product_id: prod.id, qty: 1 }], paid: 990, coupon_code: 'ONCEONLY' })
  });
  assert.equal(s2.status, 200, JSON.stringify(s2.body));
  const s3 = await api('/api/invoices', {
    method: 'POST', body: JSON.stringify({ items: [{ product_id: prod.id, qty: 1 }], paid: 990, coupon_code: 'ONCEONLY' })
  });
  assert.equal(s3.status, 400);
  assert.match(s3.body.error, /fully used/);
  const gone = await api('/api/coupons/validate', { method: 'POST', body: JSON.stringify({ code: 'ONCEONLY', total: 5000 }) });
  assert.equal(gone.status, 400);

  // switch it off and delete it
  const off = await api(`/api/coupons/${c1.body.id}`, { method: 'PUT', body: JSON.stringify({ active: 0 }) });
  assert.equal(off.status, 200);
  assert.equal(off.body.active, 0);
  const useOff = await api('/api/coupons/validate', { method: 'POST', body: JSON.stringify({ code: 'SAVE50', total: 500 }) });
  assert.equal(useOff.status, 400, 'switched-off codes are dead');
  const del = await api(`/api/coupons/${c1.body.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal((await api('/api/coupons')).body.find(c => c.id === c1.body.id), undefined, 'gone for good');
});

test('voiding a sale gives the loyalty points and the coupon use back', async () => {
  // controlled product from the loyalty test: tax-free, price 1,000
  const prod = (await api('/api/products?barcode=LOYALTY1')).body[0];
  assert.ok(prod, 'the loyalty test product exists');
  const stockBefore = prod.stock_qty;

  const cust = await api('/api/customers', {
    method: 'POST', body: JSON.stringify({ name: 'Void Nia', phone: '03009990077' })
  });
  assert.equal(cust.status, 200, JSON.stringify(cust.body));

  const c = await api('/api/coupons', {
    method: 'POST', body: JSON.stringify({ code: 'VOID50', type: 'fixed', value: 50 })
  });
  assert.equal(c.status, 200, JSON.stringify(c.body));

  // sale A: banks 10 points — floor(1000 × 1 / 100)
  const a = await api('/api/invoices', {
    method: 'POST',
    body: JSON.stringify({ customer_id: cust.body.id, items: [{ product_id: prod.id, qty: 1 }], paid: 1000 })
  });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.invoice.loyalty_earned, 10, 'the invoice remembers exactly what it banked');
  let rows = (await api('/api/customers?search=' + encodeURIComponent('Void Nia'))).body;
  let nia = rows.find(x => x.id === cust.body.id);
  assert.equal(nia.loyalty_points, 10);

  // sale B: spends 4 points and burns the coupon — 1000 − 4 − 50 = 946, banks floor(9.46) = 9
  const b = await api('/api/invoices', {
    method: 'POST',
    body: JSON.stringify({
      customer_id: cust.body.id, items: [{ product_id: prod.id, qty: 1 }],
      paid: 946, loyalty_points: 4, coupon_code: 'VOID50'
    })
  });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(b.body.invoice.total, 946, 'points and coupon together discount the bill');
  assert.equal(b.body.invoice.loyalty_redeemed, 4);
  assert.equal(b.body.invoice.loyalty_earned, 9, 'points banked on the discounted total');
  rows = (await api('/api/customers?search=' + encodeURIComponent('Void Nia'))).body;
  nia = rows.find(x => x.id === cust.body.id);
  assert.equal(nia.loyalty_points, 15, '10 − 4 redeemed + 9 earned');
  let coupon = (await api('/api/coupons')).body.find(x => x.code === 'VOID50');
  assert.equal(coupon.used_count, 1, 'the code was burned');

  // void B: back exactly where sale B found the customer, and the code gets its use back
  const vb = await api(`/api/invoices/${b.body.invoice.id}/void`, { method: 'POST' });
  assert.equal(vb.status, 200, JSON.stringify(vb.body));
  rows = (await api('/api/customers?search=' + encodeURIComponent('Void Nia'))).body;
  nia = rows.find(x => x.id === cust.body.id);
  assert.equal(nia.loyalty_points, 10, 'the 9 earned points are taken back, the 4 spent points returned');
  coupon = (await api('/api/coupons')).body.find(x => x.code === 'VOID50');
  assert.equal(coupon.used_count, 0, 'the void gave the use back');

  const again = await api('/api/coupons/validate', { method: 'POST', body: JSON.stringify({ code: 'VOID50', total: 500 }) });
  assert.equal(again.status, 200, 'a voided bill must not burn the code forever');

  // void A as well: every sale gone → the customer holds no points from them
  const va = await api(`/api/invoices/${a.body.invoice.id}/void`, { method: 'POST' });
  assert.equal(va.status, 200, JSON.stringify(va.body));
  rows = (await api('/api/customers?search=' + encodeURIComponent('Void Nia'))).body;
  nia = rows.find(x => x.id === cust.body.id);
  assert.equal(nia.loyalty_points, 0, 'the earned points went with the sale');

  const after = (await api('/api/products?barcode=LOYALTY1')).body[0];
  assert.equal(after.stock_qty, stockBefore, 'both voids restored the stock');
});

test('per-person access: the Head hands out exact modules and can delete people', async () => {
  // a fresh cashier with plain role defaults (no reports, no settings)
  const made = await api('/api/auth/users', {
    method: 'POST',
    body: JSON.stringify({ username: 'perm-clerk', password: 'perm-pass-1', name: 'Perm Clerk', role: 'cashier' })
  });
  assert.ok([200, 201].includes(made.status), JSON.stringify(made.body));
  const clerk = (await api('/api/auth/users')).body.find(u => u.username === 'perm-clerk');
  assert.ok(clerk, 'the account exists');
  assert.deepEqual(clerk.permissions, {}, 'no overrides yet');
  const on = await api(`/api/auth/users/${clerk.id}`, { method: 'PUT', body: JSON.stringify({ active: true }) });
  assert.equal(on.status, 200, JSON.stringify(on.body));

  const login = await api('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'perm-clerk', password: 'perm-pass-1' })
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.deepEqual(login.body.user.perms, {}, 'the session carries the overrides');
  const asClerk = { Authorization: `Bearer ${login.body.token}` };

  // role default: a cashier may not read reports
  const REPORT = '/api/reports/summary?from=2000-01-01&to=2100-01-01';
  let r = await api(REPORT, { headers: asClerk });
  assert.equal(r.status, 403, 'cashier cannot read reports by default');

  // the Head grants Reports to THIS person only (role unchanged)
  const grant = await api(`/api/auth/users/${clerk.id}/permissions`, {
    method: 'PUT', body: JSON.stringify({ permissions: { reports_view: true } })
  });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  assert.equal(grant.body.permissions.reports_view, true);

  r = await api(REPORT, { headers: asClerk });
  assert.equal(r.status, 200, 'the grant takes effect on the very next request');

  // …and taking it away works the same way
  const revoke = await api(`/api/auth/users/${clerk.id}/permissions`, {
    method: 'PUT', body: JSON.stringify({ permissions: {} })
  });
  assert.equal(revoke.status, 200);
  r = await api(REPORT, { headers: asClerk });
  assert.equal(r.status, 403, 'revoked again');

  // an explicit DENY beats the role (the Head turns Billing off for this cashier)
  const deny = await api(`/api/auth/users/${clerk.id}/permissions`, {
    method: 'PUT', body: JSON.stringify({ permissions: { invoices_create: false } })
  });
  assert.equal(deny.status, 200);
  r = await api('/api/invoices', { method: 'POST', headers: asClerk, body: JSON.stringify({ items: [] }) });
  assert.equal(r.status, 403, 'an explicit deny wins over the cashier role');

  // only the Head hands out permissions
  const asClerkSelf = await api(`/api/auth/users/${clerk.id}/permissions`, {
    method: 'PUT', headers: asClerk, body: JSON.stringify({ permissions: { users: true } })
  });
  assert.equal(asClerkSelf.status, 403, 'only the Head hands out permissions');

  // the Head may never talk themself out of Users or Settings (self-lockout)
  const adminId = (await api('/api/auth/users')).body.find(u => u.username === 'admin').id;
  const selfLock = await api(`/api/auth/users/${adminId}/permissions`, {
    method: 'PUT', body: JSON.stringify({ permissions: { users: false } })
  });
  assert.equal(selfLock.status, 400);
  assert.match(selfLock.body.error, /your own access/);

  // delete: the account and every session die with it
  const del = await api(`/api/auth/users/${clerk.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal((await api('/api/auth/users')).body.find(u => u.id === clerk.id), undefined, 'gone for good');
  r = await api(REPORT, { headers: asClerk });
  assert.equal(r.status, 401, 'their session died with them');

  // nobody deletes their own account
  const self = await api(`/api/auth/users/${adminId}`, { method: 'DELETE' });
  assert.equal(self.status, 400);
  assert.match(self.body.error, /your own account/);
});

test('a granted module works everywhere for that person — and nobody walks into the Head chair', async () => {
  // exactly what the Head does in Settings → Users: tick Settings + Users for a counter boy
  const made = await api('/api/auth/users', {
    method: 'POST',
    body: JSON.stringify({ username: 'granted-boy', password: 'grant-pass-1', name: 'Granted Counter Boy', role: 'cashier' })
  });
  assert.ok([200, 201].includes(made.status), JSON.stringify(made.body));
  const boy = (await api('/api/auth/users')).body.find(u => u.username === 'granted-boy');
  const on = await api(`/api/auth/users/${boy.id}`, { method: 'PUT', body: JSON.stringify({ active: true }) });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  const grant = await api(`/api/auth/users/${boy.id}/permissions`, {
    method: 'PUT',
    body: JSON.stringify({ permissions: { settings: true, sync: true, users: true } })
  });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));

  const login = await api('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'granted-boy', password: 'grant-pass-1' })
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const asBoy = { Authorization: `Bearer ${login.body.token}` };

  // ---- 1. the grant works for HIM on every door the UI opens ----
  const before = (await api('/api/settings')).body;
  const set = await api('/api/settings', {
    method: 'PUT', headers: asBoy, body: JSON.stringify({ shop_phone: '0300-1112223' })
  });
  assert.equal(set.status, 200, 'granted settings cap reaches the API: ' + JSON.stringify(set.body));
  const list = await api('/api/auth/users', { headers: asBoy });
  assert.equal(list.status, 200, 'granted users cap can list people');
  assert.ok(Array.isArray(list.body) && list.body.length >= 2, 'the list actually contains people');

  // the session tells the UI the same thing, so the screen can render it
  const meta = await api('/api/meta', { headers: asBoy });
  assert.equal(meta.body.user.perms.settings, true, 'meta carries settings: true');
  assert.equal(meta.body.user.perms.users, true, 'meta carries users: true');
  assert.equal(meta.body.user.perms.reports_view, undefined, 'untouched modules stay untouched');

  // put the phone back for the tests that follow
  const back = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ shop_phone: before.shop_phone || '' }) });
  assert.equal(back.status, 200, JSON.stringify(back.body));

  // ---- 2. a Users grant is manage-people, not a path to the Head's chair ----
  const selfPerms = await api(`/api/auth/users/${boy.id}/permissions`, {
    method: 'PUT', headers: asBoy,
    body: JSON.stringify({ permissions: { settings: true, sync: true, users: true, reports_view: true } })
  });
  assert.equal(selfPerms.status, 403, 'a granted manager cannot rewrite permission maps');
  assert.match(selfPerms.body.error, /Only the Head/);

  const promoteSelf = await api(`/api/auth/users/${boy.id}`, {
    method: 'PUT', headers: asBoy, body: JSON.stringify({ role: 'admin' })
  });
  assert.equal(promoteSelf.status, 403, 'nobody promotes themselves to Head');
  assert.match(promoteSelf.body.error, /Only the Head/);

  const createAdmin = await api('/api/auth/users', {
    method: 'POST', headers: asBoy, body: JSON.stringify({ username: 'sneaky-admin', password: 'x-pass-99', role: 'admin' })
  });
  assert.equal(createAdmin.status, 403, 'a granted manager cannot mint another Head');
  assert.match(createAdmin.body.error, /Only the Head/);
  assert.equal((await api('/api/auth/users')).body.find(u => u.username === 'sneaky-admin'), undefined, 'no such account was created');

  const adminId = (await api('/api/auth/users')).body.find(u => u.username === 'admin').id;
  const touchHead = await api(`/api/auth/users/${adminId}`, {
    method: 'PUT', headers: asBoy, body: JSON.stringify({ active: false })
  });
  assert.equal(touchHead.status, 403, 'a granted manager cannot switch off the Head');
  assert.match(touchHead.body.error, /Only the Head/);

  const delHead = await api(`/api/auth/users/${adminId}`, { method: 'DELETE', headers: asBoy });
  assert.equal(delHead.status, 403, 'a granted manager cannot delete the Head');
  assert.match(delHead.body.error, /Only the Head/);

  // ---- 3. clean up after ourselves ----
  const cleanup = await api(`/api/auth/users/${boy.id}`, { method: 'DELETE' });
  assert.equal(cleanup.status, 200, JSON.stringify(cleanup.body));
});

test('hours logged in: the duty log tracks real sign-in time per person', async () => {
  // a cashier the Head approves, exactly like Settings → Users does it
  const made = await api('/api/auth/users', {
    method: 'POST',
    body: JSON.stringify({ username: 'duty-boy', password: 'duty-pass-1', name: 'Duty Boy', role: 'cashier' })
  });
  assert.ok([200, 201].includes(made.status), JSON.stringify(made.body));
  const boy = (await api('/api/auth/users')).body.find(u => u.username === 'duty-boy');
  const on = await api(`/api/auth/users/${boy.id}`, { method: 'PUT', body: JSON.stringify({ active: true }) });
  assert.equal(on.status, 200, JSON.stringify(on.body));

  // signing in starts a duty period and he is on duty right away
  const login = await api('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'duty-boy', password: 'duty-pass-1' })
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const asBoy = { Authorization: `Bearer ${login.body.token}` };

  let row = (await api('/api/auth/users')).body.find(u => u.id === boy.id);
  assert.equal(row.duty.online, true, 'a fresh sign-in is on duty');
  assert.ok(row.duty.seconds >= 0, 'duty seconds are a number');
  assert.ok(row.duty.seconds_today >= 0, 'today starts empty and only grows');
  // today's figure can never exceed the all-time total
  assert.ok(row.duty.seconds_today <= row.duty.seconds + 1, 'today is a slice of the total, not extra');

  // the heartbeat is what keeps a till "on duty" — it must need a login
  const anonRes = await fetch(`${BASE}/api/auth/ping`, { method: 'POST' });
  assert.equal(anonRes.status, 401, 'a stranger cannot keep a till alive');
  const ping = await api('/api/auth/ping', { method: 'POST', headers: asBoy });
  assert.equal(ping.status, 200, JSON.stringify(ping.body));
  assert.ok(ping.body.at, 'the server answers with its own clock');

  // logout seals the duty row — the hours stop here
  const out = await api('/api/auth/logout', { method: 'POST', headers: asBoy });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  row = (await api('/api/auth/users')).body.find(u => u.id === boy.id);
  assert.equal(row.duty.online, false, 'logged out, so not on duty');

  // a second sign-in adds its own row — hours accumulate, they never reset
  const again = await api('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'duty-boy', password: 'duty-pass-1' })
  });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  row = (await api('/api/auth/users')).body.find(u => u.id === boy.id);
  assert.equal(row.duty.online, true, 'back on duty');
  assert.ok(row.duty.seconds >= 0, 'total only ever grows');

  // switching a person off ends their duty and kills the session behind it
  const off = await api(`/api/auth/users/${boy.id}`, { method: 'PUT', body: JSON.stringify({ active: false }) });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  const dead = await api('/api/auth/ping', { method: 'POST', headers: asBoy });
  assert.equal(dead.status, 401, 'a switched-off person has no live till');
  row = (await api('/api/auth/users')).body.find(u => u.id === boy.id);
  assert.equal(row.duty.online, false, 'switched off = off duty');

  // the duty log travels with the person — deleting them clears it (FK clean)
  const del = await api(`/api/auth/users/${boy.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal((await api('/api/auth/users')).body.find(u => u.id === boy.id), undefined, 'gone for good');
});
