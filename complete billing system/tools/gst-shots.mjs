// Screenshots the GST experience: the POS totals panel, the thermal receipt
// and the A4 tax invoice — rendered by the real app in a real browser.
//   node tools/gst-shots.mjs   (server must be running on :3000)
import puppeteer from 'puppeteer-core';
import fs from 'fs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const OUT = 'screenshots';
const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];
const executablePath = CANDIDATES.find(p => fs.existsSync(p));
if (!executablePath) throw new Error('No Edge/Chrome found');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

const BASE_API = `${BASE}/api`;
const login = await fetch(`${BASE_API}/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' })
}).then(r => r.json());
const auth = { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' };
const settings = await fetch(`${BASE_API}/settings`, { headers: auth }).then(r => r.json());

// a real bill that carries every GST band, a line discount and a bill discount
const invoices = await fetch(`${BASE_API}/invoices?limit=50`, { headers: auth }).then(r => r.json());
const pick = invoices.find(i => !i.voided && i.tax_total > 0 && i.discount > 0)
  || invoices.find(i => !i.voided && i.tax_total > 0)
  || invoices[0];
const { invoice, items, customer, shop } = await fetch(`${BASE_API}/invoices/${pick.id}`, { headers: auth }).then(r => r.json());

const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();

// print.js builds its barcode in the page (the Node-rendered HTML falls back to
// plain text), so draw it here exactly the way the app does when printing
async function drawBarcode(selector, value, width, height) {
  await page.addScriptTag({ path: 'node_modules/jsbarcode/dist/JsBarcode.all.min.js' });
  await page.evaluate(({ selector, value, width, height }) => {
    const host = document.querySelector(selector);
    if (!host || typeof JsBarcode === 'undefined') return;
    host.innerHTML = '';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    host.appendChild(svg);
    try {
      JsBarcode(svg, value, { format: 'CODE128', width, height, displayValue: true, fontSize: 12, margin: 0, background: '#ffffff', lineColor: '#000000' });
    } catch { host.textContent = value; }
  }, { selector, value, width, height });
}

// ---- 1. POS with GST totals on screen ----
await page.setViewport({ width: 1440, height: 940, deviceScaleFactor: 1 });
await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });
await page.waitForSelector('.login-card', { timeout: 15000 });
await page.type('input[autocomplete="username"]', 'admin');
await page.type('input[autocomplete="current-password"]', 'admin123');
await page.click('.login-card button');
await page.waitForSelector('.shell', { timeout: 15000 });

await page.evaluate(() => { window.location.hash = '/pos'; });
await page.waitForSelector('.product-tile', { timeout: 20000 });

const products = await fetch(`${BASE_API}/products`, { headers: auth }).then(r => r.json());
const bands = [0, 5, 10, 18];
const chosen = bands
  .map(rate => products.find(p => Number(p.tax_rate) === rate && p.stock_qty >= 6))
  .filter(Boolean);

for (const p of chosen) {
  const tiles = await page.$$('.product-tile');
  const idx = await page.$$eval('.product-tile', (list, name) => list.findIndex(t => t.textContent.includes(name)), p.name);
  if (idx < 0) { console.log(`  (tile not visible: ${p.name})`); continue; }
  await tiles[idx].click();
  await new Promise(r => setTimeout(r, 150));
}
await page.waitForSelector('.cart-line', { timeout: 5000 });

// Rs.20 off one item, Rs.25 off the bill — both must reduce the taxable value
const lineDisc = await page.$('input[title^="Discount on this item"]');
if (lineDisc) { await lineDisc.click({ clickCount: 3 }); await lineDisc.type('20'); }
const billDisc = await page.$('.totals input');
if (billDisc) { await billDisc.click({ clickCount: 3 }); await billDisc.type('25'); }
await new Promise(r => setTimeout(r, 400));

const totalsText = await page.$eval('.totals', el => el.innerText.replace(/\s+/g, ' ').trim());
console.log('POS totals panel:', totalsText);

await page.screenshot({ path: `${OUT}/gst-1-pos-gst-totals.png` });
const panel = await page.$('.cart-panel');
if (panel) await panel.screenshot({ path: `${OUT}/gst-2-pos-cart-gst.png` });

// ---- 2. the thermal receipt for that bill ----
const { receiptHTML, invoiceA4HTML } = await import('../src/print.js');
const symbol = settings.currency_symbol || 'Rs.';
const taxLabel = settings.tax_label || 'GST';
const split = settings.tax_split === '1';

await page.setViewport({ width: 460, height: 900, deviceScaleFactor: 2 });
await page.setContent(receiptHTML({
  invoice, items, customer, shop, symbol, taxLabel, split, width: settings.receipt_width === '58' ? '58' : '80'
}), { waitUntil: 'load' });
await drawBarcode('.barcode', invoice.invoice_no, 1.8, 34);
await new Promise(r => setTimeout(r, 250));
const rcpt = await page.$('.rcpt');
await (rcpt || page).screenshot({ path: `${OUT}/gst-3-receipt.png` });

// ---- 3. the A4 GST tax invoice ----
await page.setViewport({ width: 1120, height: 1400, deviceScaleFactor: 2 });
await page.setContent(invoiceA4HTML({ invoice, items, customer, shop, symbol, taxLabel, split }), { waitUntil: 'load' });
await drawBarcode('.barcode-box', invoice.invoice_no, 1.5, 34);
await new Promise(r => setTimeout(r, 250));
await page.screenshot({ path: `${OUT}/gst-4-a4-tax-invoice.png`, fullPage: true });

await browser.close();
console.log(`\nsaved: ${OUT}/gst-1-pos-gst-totals.png, ${OUT}/gst-2-pos-cart-gst.png, ${OUT}/gst-3-receipt.png, ${OUT}/gst-4-a4-tax-invoice.png`);
console.log(`source bill: ${invoice.invoice_no}  taxable ${invoice.subtotal}  GST ${invoice.tax_total}  discount ${invoice.discount}  total ${invoice.total}`);
