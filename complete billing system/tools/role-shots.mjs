// Role demo — Head / Inventory Manager / Cashier.
// Seeds two demo accounts, creates one stock request waiting for approval,
// then screenshots what each role actually sees. Safe to re-run.
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const executablePath = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find(p => fs.existsSync(p));

async function call(p, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function login(username, password) {
  const r = await call('/api/auth/login', { method: 'POST', body: { username, password } });
  if (r.status !== 200) throw new Error(`login ${username} failed: ${JSON.stringify(r.data)}`);
  return r.data.token;
}

// ---------------- demo accounts (idempotent) ----------------
const adminTok = await login('admin', 'admin123');
const users = (await call('/api/auth/users', { token: adminTok })).data;

async function ensureUser({ username, password, role, name }) {
  let row = users.find(u => u.username === username);
  if (!row) {
    const created = await call('/api/auth/users', { method: 'POST', token: adminTok, body: { username, password, role, name } });
    if (created.status !== 200) throw new Error(`create ${username}: ${JSON.stringify(created.data)}`);
    console.log(`created ${role} account "${username}" (pending)`);
    row = created.data;
    if (!row.id) {
      const fresh = (await call('/api/auth/users', { token: adminTok })).data.find(u => u.username === username);
      row = fresh;
    }
  }
  if (!row.active) {
    const ok = await call(`/api/auth/users/${row.id}`, { method: 'PUT', token: adminTok, body: { active: true } });
    if (ok.status !== 200) throw new Error(`approve ${username}: ${JSON.stringify(ok.data)}`);
    console.log(`approved ${username}`);
  }
  return row;
}

const INV = { username: 'store-keeper', password: 'store-pass-1', role: 'inventory', name: 'Stock Keeper' };
const CASH = { username: 'counter-boy', password: 'counter-pass-1', role: 'cashier', name: 'Counter Boy' };
await ensureUser(INV);
await ensureUser(CASH);

const invTok = await login(INV.username, INV.password);
const cashTok = await login(CASH.username, CASH.password);

// ---------------- one request waiting for the Head ----------------
let pending = (await call('/api/stock/requests?status=pending', { token: adminTok })).data;
if (!Array.isArray(pending) || pending.length === 0) {
  const products = (await call('/api/products', { token: invTok })).data;
  const p = products.find(x => x.stock_qty > 10) || products[0];
  const r = await call('/api/stock/requests', {
    method: 'POST', token: invTok,
    body: { product_id: p.id, type: 'purchase', qty: 5, cost_price: p.cost_price, note: 'Weekly order — awaiting Head approval' }
  });
  if (r.status !== 200) throw new Error(`stock request: ${JSON.stringify(r.data)}`);
  pending = [r.data];
  console.log(`stock request created for ${p.name} (still pending)`);
}

// ---------------- live permission matrix ----------------
// [who, token, method, path, body (null = none), expectedStatus]
const probes = [
  ['Head', adminTok, 'GET', '/api/auth/users', null, 200],
  ['Head', adminTok, 'GET', '/api/reports/summary?from=2000-01-01&to=2099-01-01', null, 200],
  ['Head', adminTok, 'POST', '/api/stock/purchase', { items: [] }, 400],
  ['Inventory', invTok, 'GET', '/api/reports/summary?from=2000-01-01&to=2099-01-01', null, 200],
  ['Inventory', invTok, 'GET', '/api/stock/requests', null, 200],
  ['Inventory', invTok, 'POST', '/api/products', { name: 'x', price: 1 }, 403],
  ['Inventory', invTok, 'POST', '/api/stock/purchase', { items: [] }, 403],
  ['Inventory', invTok, 'GET', '/api/auth/users', null, 403],
  ['Cashier', cashTok, 'GET', '/api/products', null, 200],
  ['Cashier', cashTok, 'GET', '/api/reports/low-stock', null, 200],
  ['Cashier', cashTok, 'GET', '/api/reports/summary?from=2000-01-01&to=2099-01-01', null, 403],
  ['Cashier', cashTok, 'GET', '/api/stock/movements', null, 403],
  ['Cashier', cashTok, 'POST', '/api/products', { name: 'x', price: 1 }, 403],
  ['Cashier', cashTok, 'PUT', '/api/settings', { shop_name: 'x' }, 403],
  ['Cashier', cashTok, 'GET', '/api/auth/users', null, 403],
  ['Cashier', cashTok, 'GET', '/api/sync/status', null, 403]
];

console.log('\n=== live permission matrix ===');
let fails = 0;
for (const [who, tok, method, p, body, expected] of probes) {
  const r = await call(p, { method, token: tok, body: body ?? undefined });
  const ok = r.status === expected;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${who.padEnd(9)} ${method.padEnd(6)} ${p.split('?')[0].padEnd(34)} -> ${r.status}${ok ? '' : ` (expected ${expected})`}`);
}
if (fails) throw new Error(`${fails} permission probe(s) failed`);

// ---------------- screenshots ----------------
const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

const shot = name => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const wait = ms => new Promise(r => setTimeout(r, ms));

async function signIn(username, password) {
  await page.goto(`${BASE}/#/dashboard`, { waitUntil: 'networkidle2' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('.login-card', { timeout: 15000 });
  await page.type('input[autocomplete="username"]', username);
  await page.type('input[autocomplete="current-password"]', password);
  await page.click('.login-card button');
  await page.waitForSelector('.shell', { timeout: 15000 });
  await wait(500);
}

async function go(hash) {
  await page.evaluate(h => { window.location.hash = h; }, hash);
  await wait(1100);
}

// make two products actually run low so the "low stock" option is visible
const products = (await call('/api/products', { token: adminTok })).data;
const lowered = [];
for (const p of products.filter(x => x.stock_qty > 0).slice(0, 2)) {
  const original = p.low_stock;
  if (p.stock_qty <= original) continue;
  const r = await call(`/api/products/${p.id}`, { method: 'PUT', token: adminTok, body: { low_stock: p.stock_qty } });
  if (r.status === 200) lowered.push({ id: p.id, original, name: p.name });
}

try {
  // 1. Head: people control
  await signIn('admin', 'admin123');
  await go('#/settings');
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.card-title')];
    const t = cards.find(c => c.textContent.includes('Users'));
    if (t) t.scrollIntoView({ block: 'center' });
  });
  await wait(600);
  await shot('roles-1-head-users');

  // 2. Head: approving the manager's stock request
  await go('#/inventory');
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('.card-title')].find(c => c.textContent.includes('Stock Requests'));
    if (t) t.scrollIntoView({ block: 'center' });
  });
  await wait(500);
  await shot('roles-2-head-approve');

  // 3. Inventory Manager: dashboard with sales reports
  await signIn(INV.username, INV.password);
  await go('#/dashboard');
  await shot('roles-3-manager-dashboard');

  // 4. Inventory Manager: asks for stock, sees own requests
  await go('#/inventory');
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('.card-title')].find(c => c.textContent.includes('My Stock Requests'));
    if (t) t.scrollIntoView({ block: 'center' });
  });
  await wait(500);
  await shot('roles-4-manager-stock-request');

  // 5. Cashier: POS with the low-stock option
  await signIn(CASH.username, CASH.password);
  await go('#/pos');
  await shot('roles-5-cashier-pos');

  // 6. Cashier: reports are the Head's
  await go('#/reports');
  await shot('roles-6-cashier-blocked');
} finally {
  for (const p of lowered) {
    await call(`/api/products/${p.id}`, { method: 'PUT', token: adminTok, body: { low_stock: p.original } });
  }
  await browser.close();
}

console.log('\n=== screenshots ===');
for (const f of fs.readdirSync(OUT).filter(f => f.startsWith('roles-')).sort()) console.log('  screenshots/' + f);
console.log('\nDemo logins:');
console.log(`  Head               admin          / admin123`);
console.log(`  Inventory Manager  ${INV.username} / ${INV.password}`);
console.log(`  Cashier            ${CASH.username} / ${CASH.password}`);
console.log(`\nPending stock request waiting on the Head: ${pending.length}`);
