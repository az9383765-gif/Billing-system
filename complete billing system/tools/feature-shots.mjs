// Captures screenshots of the four new mart features for documentation.
// Run with: npm run shots:features   (server must be running on port 3000)
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const executablePath = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find(p => fs.existsSync(p));

const wait = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
page.on('pageerror', e => console.log('PAGEERROR:', e.message));

const shot = name => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const replaceInput = async (handle, text) => {
  await handle.click();
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await handle.type(text);
};
const clickByText = async (text, sel = '.modal-foot .btn, .btn') => {
  const handles = await page.$$(sel);
  for (const h of handles) {
    const t = await h.evaluate(el => el.textContent);
    if (t.includes(text)) { await h.click(); return true; }
  }
  return false;
};

// ---- login page: the sign-up flow deserves a screenshot too ----
await page.goto(BASE, { waitUntil: 'networkidle2' });
await page.waitForSelector('.login-card');
await wait(600); // brand info (tabs / quick-ID chips) finishes loading
await shot('feature-login');
await page.click('.ltab:not(.on)');
await page.waitForSelector('input[autocomplete="new-password"]');
await wait(300);
await shot('feature-register');
await page.click('.ltab:not(.on)');
await page.waitForSelector('input[autocomplete="current-password"]');
await page.type('input[autocomplete="username"]', 'admin');
await page.type('input[autocomplete="current-password"]', 'admin123');
await page.click('.login-card button');
await page.waitForSelector('.shell');

// ---- 1. dashboard: GST today + by-rate card ----
await page.waitForSelector('.stat', { timeout: 10000 });
await wait(700);
await shot('feature-dashboard-gst');
try {
  await page.waitForFunction(
    () => [...document.querySelectorAll('.card-title')].some(t => t.textContent.includes('by Rate')),
    { timeout: 8000 }
  );
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('.card-title')].find(x => x.textContent.includes('by Rate'));
    t.scrollIntoView({ block: 'center' });
  });
  await wait(300);
  await shot('feature-dashboard-gst-by-rate');
} catch {
  console.log('(GST by-rate card not rendered in time — skipped)');
}

// ---- 2. POS: % discount + near-expiry badge ----
await page.evaluate(() => { window.location.hash = '/pos'; });
await page.waitForSelector('.product-tile');
const search = await page.$('input[placeholder^="Scan"]');
await replaceInput(search, 'Tea Pack');
await page.waitForFunction(
  () => [...document.querySelectorAll('.product-tile')].some(t => t.textContent.includes('Tea Pack')),
  { timeout: 8000 }
);
const tea = await page.evaluateHandle(() =>
  [...document.querySelectorAll('.product-tile')].find(t => t.textContent.includes('Tea Pack'))
);
await tea.asElement().click();
await page.waitForSelector('.cart-line');
await page.evaluate(() => {
  const row = [...document.querySelectorAll('.t-row')].find(r => r.firstElementChild?.textContent === 'Discount');
  [...row.querySelectorAll('button')].find(b => b.textContent.trim() === '%').click();
});
const discInput = await page.evaluateHandle(() => {
  const row = [...document.querySelectorAll('.t-row')].find(r => r.firstElementChild?.textContent === 'Discount');
  return row.querySelector('input');
});
await replaceInput(discInput.asElement(), '10');
await wait(350);
await shot('feature-pos-percent-discount');

// ---- 3. POS refuses expired stock ----
await replaceInput(await page.$('input[placeholder^="Scan"]'), 'Milk Powder');
await page.waitForFunction(
  () => [...document.querySelectorAll('.product-tile')].some(t => t.textContent.includes('Milk Powder')),
  { timeout: 8000 }
);
const milk = await page.evaluateHandle(() =>
  [...document.querySelectorAll('.product-tile')].find(t => t.textContent.includes('Milk Powder'))
);
await milk.asElement().click();
await page.waitForSelector('.toast.error', { timeout: 5000 });
await shot('feature-pos-expired-refused');
await page.waitForFunction(() => !document.querySelector('.toast.error'), { timeout: 9000 });

// finish the sale so the return flow has a fresh invoice
await page.$$eval('.pay-grid .btn', els => els.find(e => e.textContent.includes('Cash'))?.click());
await page.$$eval('.btn.success', els => els.find(e => e.textContent.includes('Complete Sale'))?.click());
await page.waitForFunction(
  () => [...document.querySelectorAll('.modal-head h3')].some(h => h.textContent.includes('Sale Completed')),
  { timeout: 10000 }
);
await page.$$eval('.modal-foot .btn', els => els.find(e => e.textContent.includes('New Sale'))?.click());
await wait(400);

// ---- 4. products: expiry column ----
await page.evaluate(() => { window.location.hash = '/products'; });
await page.waitForFunction(
  () => window.location.hash === '#/products' && !!document.querySelector('.tbl tbody tr'),
  { timeout: 10000 }
);
await wait(400);
await shot('feature-products-expiry');

// ---- 5. inventory: near-expiry report ----
await page.evaluate(() => { window.location.hash = '/inventory'; });
await page.waitForFunction(
  () => window.location.hash === '#/inventory' && !!document.querySelector('.stat'),
  { timeout: 10000 }
);
await wait(500);
const expiringCard = await page.evaluateHandle(() =>
  [...document.querySelectorAll('.card-title')].find(t => t.textContent.includes('Expiring Soon'))
);
if (expiringCard) {
  await page.evaluate(el => el.scrollIntoView({ block: 'center' }), expiringCard);
  await wait(300);
}
await shot('feature-inventory-expiring');

// ---- 6. invoices: return form + credit note ----
await page.evaluate(() => { window.location.hash = '/invoices'; });
await page.waitForFunction(
  () => window.location.hash === '#/invoices' && !!document.querySelector('.tbl tbody tr'),
  { timeout: 10000 }
);
await wait(400);
await page.click('.tbl tbody tr');
await page.waitForFunction(
  () => [...document.querySelectorAll('.modal-head h3')].some(h => h.textContent.includes('Invoice INV-')),
  { timeout: 8000 }
);
await clickByText('↩ Return');
await page.waitForFunction(
  () => [...document.querySelectorAll('.modal-head h3')].some(h => h.textContent.includes('Return against')),
  { timeout: 8000 }
);
const qtyInput = await page.evaluateHandle(() => {
  const modal = [...document.querySelectorAll('.modal')].find(m => m.textContent.includes('Return against'));
  return modal.querySelector('input[type="number"]');
});
await replaceInput(qtyInput.asElement(), '1');
await wait(250);
await shot('feature-return-form');
await clickByText('Save Return & Refund');
await page.waitForFunction(
  () => [...document.querySelectorAll('.modal-head h3')].some(h => h.textContent.includes('Credit Note RET-')),
  { timeout: 10000 }
);
await wait(300);
await shot('feature-credit-note');

// ---- 7. POS: loyalty points + a coupon together on one bill ----
await page.evaluate(() => { window.location.hash = '/pos'; });
await page.waitForSelector('.product-tile', { timeout: 10000 });
// let any stale toasts from earlier flows expire so the shot is clean
await page.waitForFunction(() => !document.querySelector('.toast'), { timeout: 8000 }).catch(() => {});
await wait(400);
const custVal = await page.evaluate(() => {
  const sel = document.querySelector('#pos-customer');
  const opt = sel ? [...sel.options].find(o => o.value) : null;
  return opt ? opt.value : null;
});
if (custVal) {
  await page.select('#pos-customer', custVal);
  await page.waitForSelector('input[placeholder="redeem pts"]', { timeout: 5000 });
}
await page.click('.product-tile');
await page.waitForSelector('.cart-line', { timeout: 6000 });
const shotRedeem = await page.$('input[placeholder="redeem pts"]');
if (shotRedeem) { await replaceInput(shotRedeem, '999'); await wait(300); }
const shotCode = await page.$('input[placeholder="code"]');
if (shotCode) {
  await replaceInput(shotCode, 'WELCOME50');
  await clickByText('Apply');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.t-row')].some(r => r.textContent.includes('Coupon WELCOME50')),
    { timeout: 6000 }
  );
}
await wait(300);
await shot('feature-pos-loyalty-coupon');

// ---- 8. hold the bill (with its coupon) → the held list ----
await clickByText('Hold');
await page.waitForFunction(
  () => [...document.querySelectorAll('.modal-head h3')].some(h => h.textContent.includes('Hold this bill')),
  { timeout: 6000 }
);
await wait(250);
await shot('feature-pos-hold-modal');
await clickByText('Hold bill');
await page.waitForFunction(
  () => [...document.querySelectorAll('.btn')].some(b => /Held \(\d+\)/.test(b.textContent)),
  { timeout: 6000 }
);
await clickByText('⏸ Held');
await page.waitForFunction(
  () => [...document.querySelectorAll('.modal-head h3')].some(h => h.textContent.includes('Held bills')),
  { timeout: 6000 }
);
await wait(300);
await shot('feature-pos-held-bills');
await clickByText('Resume');
await page.waitForSelector('.cart-line', { timeout: 6000 });
await clickByText('Clear');
await wait(300);

// ---- 9. Reports → Expenses (the daily kharcha book) ----
await page.evaluate(() => { window.location.hash = '/reports'; });
await page.waitForSelector('.pill-tabs', { timeout: 10000 });
await page.evaluate(() => {
  [...document.querySelectorAll('.pill')].find(p => p.textContent.includes('Expenses'))?.click();
});
await page.waitForFunction(
  () => document.body.textContent.includes('Expenses (kharcha)'),
  { timeout: 8000 }
);
await wait(400);
await shot('feature-expenses');

// ---- 10. Settings: loyalty scheme + coupon desk ----
await page.evaluate(() => { window.location.hash = '/settings'; });
await page.waitForSelector('.card-title', { timeout: 10000 });
await wait(600);
await page.evaluate(() => {
  [...document.querySelectorAll('.card-title')].find(t => t.textContent.includes('Loyalty Points'))
    ?.scrollIntoView({ block: 'center' });
});
await wait(300);
await shot('feature-settings-loyalty');
await page.evaluate(() => {
  [...document.querySelectorAll('.card-title')].find(t => t.textContent.includes('Coupons (discount codes)'))
    ?.scrollIntoView({ block: 'center' });
});
await wait(300);
await shot('feature-settings-coupons');

// ---- 11. per-person access: module switches on a user ----
const editClicked = await page.evaluate(() => {
  const card = [...document.querySelectorAll('.card')]
    .find(c => c.textContent.includes('the Head decides who can log in'));
  const edit = card ? [...card.querySelectorAll('.btn')].find(b => b.textContent.trim() === 'Edit') : null;
  if (edit) edit.click();
  return Boolean(edit);
});
if (editClicked) {
  await page.waitForFunction(
    () => document.body.textContent.includes('Module access — beyond the role'),
    { timeout: 8000 }
  );
  await page.waitForFunction(() => !document.querySelector('.toast'), { timeout: 8000 }).catch(() => {});
  await wait(350);
  await shot('feature-users-module-access');
  await page.$$eval('.modal-foot .btn', els => els.find(e => e.textContent.trim() === 'Cancel')?.click());
} else {
  console.log('(users card not found — module-access shot skipped)');
}

await browser.close();
console.log('Feature screenshots saved to', OUT);
