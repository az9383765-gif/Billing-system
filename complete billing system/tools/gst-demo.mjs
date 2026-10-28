// Live GST demonstration: bills a mixed-rate basket through the real API,
// proves the totals match shared/calc.js, then prints the actual receipt
// and A4 tax invoice the shopkeeper would hand the customer.
//   node tools/gst-demo.mjs
import { invoiceCalc, round2, taxSummary } from '../shared/calc.js';
import { receiptHTML, invoiceA4HTML } from '../src/print.js';
import { money } from '../src/format.js';

const BASE = 'http://localhost:3000/api';

const login = await fetch(`${BASE}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' })
}).then(r => r.json());
const auth = { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' };

const settings = await fetch(`${BASE}/settings`, { headers: auth }).then(r => r.json());
const products = await fetch(`${BASE}/products`, { headers: auth }).then(r => r.json());

// pick one product from each GST band actually in the catalogue
const bands = [0, 5, 10, 18];
const basket = [];
for (const rate of bands) {
  const p = products.find(x => Number(x.tax_rate) === rate && x.stock_qty >= 6);
  if (!p) throw new Error(`no product with stock in the ${rate}% band`);
  basket.push({ p, qty: { 0: 4, 5: 2, 10: 3, 18: 1 }[rate] });
}

const lineDiscounts = { [basket[2].p.id]: 20 }; // Rs.20 off the 10% line
const billDiscount = 25;
const roundOff = settings.round_off !== '0';

// ---- what the POS screen shows (the shared engine) ----
const cart = basket.map(({ p, qty }) => ({
  qty, unit_price: p.price, tax_rate: p.tax_rate,
  tax_inclusive: Boolean(p.tax_inclusive), discount: lineDiscounts[p.id] || 0
}));
const screen = invoiceCalc({ items: cart, discount: billDiscount, round_off: roundOff });

// ---- what the API charges ----
const sale = await fetch(`${BASE}/invoices`, {
  method: 'POST', headers: auth,
  body: JSON.stringify({
    items: basket.map(({ p, qty }) => ({
      product_id: p.id, qty, unit_price: p.price, discount: lineDiscounts[p.id] || 0
    })),
    discount: billDiscount,
    paid: screen.total
  })
}).then(async r => ({ status: r.status, body: await r.json() }));
if (sale.status !== 200) throw new Error(`billing failed: ${JSON.stringify(sale.body)}`);

const { invoice, items } = sale.body;

console.log('\n=== BASKET (catalogue GST bands) ===');
for (const { p, qty } of basket) {
  const li = items.find(i => i.product_id === p.id);
  console.log(
    `  ${p.name.padEnd(22)} ${qty} x ${money(p.price).padStart(12)}` +
    `  ${String(p.tax_rate).padStart(2)}% ${p.tax_inclusive ? 'incl' : 'excl'}` +
    `  -> taxable ${money(li.line_subtotal).padStart(11)}  GST ${money(li.tax_amount).padStart(10)}  line ${money(li.line_total).padStart(11)}` +
    (li.line_discount > 0 ? `  (less ${money(li.line_discount)})` : '')
  );
}

console.log('\n=== POS SCREEN vs STORED BILL ===');
const rows = [
  ['Taxable value (subtotal)', screen.subtotal, invoice.subtotal],
  ['GST total', screen.taxTotal, invoice.tax_total],
  ['Discount (all of it)', screen.totalDiscount, invoice.discount],
  ['Round off', screen.roundOff, invoice.round_off],
  ['TOTAL', screen.total, invoice.total],
  ['Paid', screen.total, invoice.paid_amount],
  ['Due', 0, invoice.due_amount]
];
let allOk = true;
for (const [label, onScreen, stored] of rows) {
  const ok = Math.abs(Number(onScreen) - Number(stored)) < 0.005;
  if (!ok) allOk = false;
  console.log(`  ${label.padEnd(24)} screen ${money(onScreen).padStart(12)}   bill ${money(stored).padStart(12)}   ${ok ? 'MATCH' : '*** DIFFERS ***'}`);
}
const chain = round2(invoice.subtotal + invoice.tax_total + invoice.round_off);
console.log(`  arithmetic check: taxable + GST + round off = ${money(chain)}  ${chain === invoice.total ? '= TOTAL' : '!= TOTAL ***'}`);
console.log(`  invoice ${invoice.invoice_no}  |  engine = ${allOk && chain === invoice.total ? 'IDENTICAL' : 'MISMATCH'}`);

console.log('\n=== GST SUMMARY BY RATE (what the Tax report and A4 table show) ===');
for (const row of taxSummary(items)) {
  console.log(`  ${String(row.rate).padStart(2)}%   taxable ${money(row.taxable).padStart(12)}   GST ${money(row.tax).padStart(11)}`);
}

// ---- the actual paper ----
const shop = {
  shop_name: settings.shop_name, shop_address: settings.shop_address,
  shop_phone: settings.shop_phone, gstin: settings.gstin,
  receipt_footer: settings.receipt_footer, terms: settings.terms
};
const strip = html => html
  .replace(/<style[\s\S]*?<\/style>/g, '')
  .replace(/<svg[\s\S]*?<\/svg>/g, '\n   [barcode: INV]\n')
  .replace(/<br\s*\/?>/g, '\n')
  .replace(/<\/(div|tr|p|table|thead|tbody|h1|h2|h3|h4|body)>/g, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/[ \t\u00a0]{2,}/g, ' ')
  .split('\n').map(s => s.trim()).filter(Boolean).join('\n');

const receipt = receiptHTML({
  invoice, items, customer: null, shop,
  symbol: settings.currency_symbol || 'Rs.', taxLabel: settings.tax_label || 'GST',
  split: settings.tax_split === '1', width: settings.receipt_width || '80'
});
console.log('\n=== THERMAL RECEIPT (as printed) ===\n');
console.log(strip(receipt));

const a4 = invoiceA4HTML({
  invoice, items, customer: null, shop,
  symbol: settings.currency_symbol || 'Rs.', taxLabel: settings.tax_label || 'GST',
  split: settings.tax_split === '1'
});
console.log('\n=== A4 TAX INVOICE — totals + tax table ===\n');
const a4text = strip(a4);
const lines = a4text.split('\n');
const start = lines.findIndex(l => /Taxable Value/i.test(l));
console.log(lines.slice(Math.max(0, start - 1), start + 14).join('\n'));
const slab = lines.findIndex(l => /^\s*(0|5|10|18)%/.test(l));
if (slab > -1) console.log('\n' + lines.slice(slab - 1, slab + 5).join('\n'));

process.exit(allOk ? 0 : 1);
