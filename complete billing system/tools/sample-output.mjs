// Generates printable output samples from the running MartBill instance:
//   receipt (thermal 58/80mm) + A4 tax invoice, as HTML and PNG, plus a text preview.
//
//   node tools/sample-output.mjs [invoice_no]
//   BASE_URL=http://localhost:3000 node tools/sample-output.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';
import { receiptHTML, invoiceA4HTML } from '../src/print.js';
import { money, dateStr, timeStr, amountInWords } from '../src/format.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const out = path.join(root, 'output');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const USER = process.env.APP_USER || 'admin';
const PASS = process.env.APP_PASS || 'admin123';

fs.mkdirSync(out, { recursive: true });

const exec = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find(p => fs.existsSync(p));

async function api(p, opts = {}, token = '') {
  const res = await fetch(BASE + p, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) }
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(`${p} -> ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

const pad = (s, w) => String(s).padEnd(w);
const line = (ch = '-', w = 32) => ch.repeat(w);
const row = (label, value, w = 32) => `${pad(label, w - String(value).length)}${value}`;

// ---------- text previews ----------
function receiptText({ invoice, items, customer, shop, symbol, taxLabel, split, width }) {
  const w = width === '58' ? 28 : 32;
  const L = [];
  const c = (s, bold = false) => {
    const t = String(s);
    L.push(' '.repeat(Math.max(0, Math.floor((w - t.length) / 2))) + t);
    if (bold) L.push('');
  };
  c(shop.shop_name || 'My Shop');
  if (shop.shop_address) c(shop.shop_address);
  if (shop.shop_phone) c('Phone: ' + shop.shop_phone);
  if (shop.gstin) c('GSTIN: ' + shop.gstin);
  c('TAX INVOICE');
  L.push(line('='));
  L.push(row('Invoice', invoice.invoice_no, w));
  L.push(row('Date', `${dateStr(invoice.datetime)} ${timeStr(invoice.datetime)}`, w));
  L.push(row('Customer', customer?.name || 'Walk-in', w));
  if (customer?.phone) L.push(row('Phone', customer.phone, w));
  L.push(line());
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    L.push(`${i + 1}. ${it.name}`);
    const label = `${Number(it.qty)} ${it.unit || ''} x ${money(it.unit_price, symbol)}` +
      (it.tax_rate > 0 ? `  (${taxLabel} ${it.tax_rate}%)` : '');
    const amt = money(it.line_total, symbol);
    // keep at least one space before the amount, even when the line is long
    const gap = Math.max(1, (w - 3) - label.length - amt.length);
    L.push('   ' + label + ' '.repeat(gap) + amt);
  }
  L.push(line());
  L.push(row('Subtotal', money(invoice.subtotal, symbol), w));
  if (invoice.discount > 0) L.push(row('Discount', '-' + money(invoice.discount, symbol), w));
  if (invoice.tax_total > 0) {
    if (split) {
      L.push(row(`${taxLabel} (CGST)`, money(invoice.tax_total / 2, symbol), w));
      L.push(row(`${taxLabel} (SGST)`, money(invoice.tax_total / 2, symbol), w));
    } else {
      L.push(row(taxLabel, money(invoice.tax_total, symbol), w));
    }
  }
  if (invoice.round_off) L.push(row('Round off', money(invoice.round_off, symbol), w));
  L.push(line('='));
  L.push(row('TOTAL', money(invoice.total, symbol), w));
  L.push(line('='));
  L.push(row(`Paid (${invoice.payment_method})`, money(invoice.paid_amount, symbol), w));
  if (invoice.due_amount > 0) L.push(row('Balance Due', money(invoice.due_amount, symbol), w));
  L.push('');
  c(shop.receipt_footer || 'Thank you!');
  c(`Barcode: ${invoice.invoice_no}`);
  return L.join('\n');
}

function invoiceText({ invoice, items, customer, shop, symbol, taxLabel, split }) {
  const L = [];
  L.push(`  ${shop.shop_name || 'My Shop'}`);
  if (shop.shop_address) L.push(`  ${shop.shop_address}`);
  if (shop.shop_phone) L.push(`  Phone: ${shop.shop_phone}`);
  if (shop.gstin) L.push(`  GSTIN: ${shop.gstin}`);
  L.push('');
  L.push('                 TAX INVOICE');
  L.push(line('='));
  L.push(row('Bill To', customer?.name || 'Walk-in Customer'));
  if (customer?.phone) L.push(row('', customer.phone));
  if (customer?.address) L.push(row('', customer.address));
  L.push(row('Invoice No', invoice.invoice_no));
  L.push(row('Date / Time', `${dateStr(invoice.datetime)} ${timeStr(invoice.datetime)}`));
  L.push(row('Payment', `${invoice.payment_method} — ${invoice.status.toUpperCase()}`));
  L.push(line('='));
  L.push(`${pad('#', 3)}${pad('Item', 22)}${pad('Qty', 4)}${pad('Rate', 11)}${pad('GST', 5)}${'Total'.padStart(11)}`);
  items.forEach((it, i) => {
    L.push(`${pad(i + 1, 3)}${pad(it.name.slice(0, 21), 22)}${pad(Number(it.qty), 4)}${pad(money(it.unit_price, symbol), 11)}${pad(it.tax_rate ? it.tax_rate + '%' : '—', 5)}${money(it.line_total, symbol).padStart(11)}`);
  });
  L.push(line('='));
  L.push(row('Taxable Value', money(invoice.subtotal, symbol)));
  if (invoice.discount > 0) L.push(row('Discount', '-' + money(invoice.discount, symbol)));
  if (split && invoice.tax_total > 0) {
    L.push(row('CGST', money(invoice.tax_total / 2, symbol)));
    L.push(row('SGST', money(invoice.tax_total / 2, symbol)));
  } else {
    L.push(row(taxLabel, money(invoice.tax_total, symbol)));
  }
  if (invoice.round_off) L.push(row('Round Off', money(invoice.round_off, symbol)));
  L.push(line('='));
  L.push(row('GRAND TOTAL', money(invoice.total, symbol)));
  L.push(row('Paid', money(invoice.paid_amount, symbol)));
  L.push(row('Balance Due', money(invoice.due_amount, symbol)));
  L.push('');
  L.push(`Amount in words: ${amountInWords(invoice.total)}`);
  L.push('');
  L.push(`Terms: ${shop.terms || 'Goods once sold will not be taken back or exchanged. Subject to local jurisdiction.'}`);
  L.push(`                          For ${shop.shop_name || 'My Shop'}`);
  L.push('                          ___________________');
  L.push('                          Authorised Signatory');
  return L.join('\n');
}

// ---------- main ----------
const token = (await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: USER, password: PASS }) })).token;

const settings = await api('/api/settings', {}, token);
const symbol = settings.currency_symbol || 'Rs.';
const taxLabel = settings.tax_label || 'GST';
const split = settings.tax_split === '1';
const width = ['58', '80', 'a4'].includes(settings.receipt_width) ? settings.receipt_width : '80';

const list = await api('/api/invoices?limit=20', {}, token);
const wanted = process.argv[2];
const invoiceRow = (wanted ? list.find(i => i.invoice_no === wanted) : list.find(i => !i.voided)) || list[0];
if (!invoiceRow) throw new Error('No invoices to render — run "npm run seed" first.');

const detail = await api(`/api/invoices/${invoiceRow.id}`, {}, token);
const shop = detail.shop;

const receipt = receiptHTML({ invoice: detail.invoice, items: detail.items, customer: detail.customer, shop, symbol, taxLabel, split, width: width === 'a4' ? '80' : width });
const a4 = invoiceA4HTML({ invoice: detail.invoice, items: detail.items, customer: detail.customer, shop, symbol, taxLabel, split });

const base = detail.invoice.invoice_no;

// The HTML is built in Node (no DOM), so barcodeSVG() falls back to plain text.
// Inline JsBarcode so the sample draws the real CODE128 barcode when opened.
const jsbarcodeSrc = fs.readFileSync(path.join(root, 'node_modules/jsbarcode/dist/JsBarcode.all.min.js'), 'utf8');
const barcodeFix = `<script>${jsbarcodeSrc}</script>
<script>(function(){
  document.querySelectorAll('span[style*="monospace"]').forEach(function(span){
    var value=(span.textContent||'').trim(); if(!value) return;
    try{
      var svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
      JsBarcode(svg,value,{format:'CODE128',width:1.7,height:38,displayValue:true,fontSize:12,margin:0,background:'#ffffff',lineColor:'#000000'});
      span.replaceWith(svg);
    }catch(e){}
  });
})();</script>`;
const receiptPage = receipt.includes('</body>')
  ? receipt.replace('</body>', barcodeFix + '</body>')
  : receipt + barcodeFix;

const files = {
  receipt: path.join(out, `${base}-receipt-${width === '58' ? '58mm' : '80mm'}.html`),
  a4: path.join(out, `${base}-invoice-A4.html`)
};
fs.writeFileSync(files.receipt, receiptPage);
fs.writeFileSync(files.a4, a4);

// screenshots so the output can be looked at directly
if (exec) {
  const browser = await puppeteer.launch({ executablePath: exec, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();

  const mmWidth = width === '58' ? 48 : 72; // mm of paper
  await page.setViewport({ width: Math.round(mmWidth * 96 / 25.4), height: 900, deviceScaleFactor: 2 });
  await page.setContent(receiptPage, { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 250));
  await page.screenshot({ path: path.join(out, `${base}-receipt.png`), fullPage: true });

  await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1.5 });
  await page.setContent(a4, { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 150));
  await page.screenshot({ path: path.join(out, `${base}-invoice-A4.png`), fullPage: true });

  await browser.close();
}

// ---------- text preview ----------
const banner = t => `\n${'='.repeat(64)}\n  ${t}\n${'='.repeat(64)}\n`;

console.log(banner('THERMAL RECEIPT  (' + (width === '58' ? '58' : '80') + 'mm paper)'));
console.log(receiptText({ invoice: detail.invoice, items: detail.items, customer: detail.customer, shop, symbol, taxLabel, split, width }));
console.log(banner('A4 TAX INVOICE'));
console.log(invoiceText({ invoice: detail.invoice, items: detail.items, customer: detail.customer, shop, symbol, taxLabel, split }));

const summary = await api('/api/reports/summary?from=2000-01-01&to=2099-01-01', {}, token);
console.log(banner('BUSINESS REPORT (all time)'));
const kv = (k, v) => console.log(`  ${pad(k, 21)}${v}`);
kv('Invoices', summary.invoices);
kv('Items sold', summary.items_sold);
kv('Revenue', money(summary.revenue, symbol));
kv('Taxable value', money(summary.taxable_value, symbol));
kv(`${taxLabel} collected`, money(summary.tax, symbol));
kv('Cost', money(summary.cost, symbol));
kv('Profit', money(summary.profit, symbol));
kv('Cash collected', money(summary.collected, symbol));
kv('Credit outstanding', money(summary.outstanding_credit, symbol));
console.log(banner('FILES WRITTEN'));
for (const [k, f] of Object.entries(files)) console.log(`  ${pad(k, 8)} ${path.relative(root, f)}`);
if (exec) console.log(`  png      ${path.relative(root, path.join(out, base + '-receipt.png'))}`);
if (exec) console.log(`  png      ${path.relative(root, path.join(out, base + '-invoice-A4.png'))}`);
console.log('');
