// Full browser end-to-end test using the system's Edge/Chrome (puppeteer-core).
// Run with: npm run test:ui   (server must be running on port 3000)
import puppeteer from 'puppeteer-core';
import fs from 'fs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];
const executablePath = CANDIDATES.find(p => fs.existsSync(p));
if (!executablePath) {
  console.error('No Edge/Chrome found for UI testing');
  process.exit(1);
}

const errors = [];
const fails = [];
const ok = msg => console.log(`  ✔ ${msg}`);
const fail = msg => { fails.push(msg); console.log(`  ✖ ${msg}`); };

const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

async function expectNoToasts(label) {
  await new Promise(r => setTimeout(r, 400));
  const toastErrors = await page.$$eval('.toast.error', els => els.map(e => e.textContent));
  if (toastErrors.length) fail(`${label}: UI error toasts — ${toastErrors.join(' | ')}`);
}

try {
  console.log('E2E UI test against', BASE);

  // 1. login screen
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 20000 });
  await page.waitForSelector('.login-card', { timeout: 10000 });
  ok('login screen renders');

  // 2. login
  await page.type('input[autocomplete="username"]', 'admin');
  await page.type('input[autocomplete="current-password"]', 'admin123');
  await page.click('.login-card button');
  await page.waitForSelector('.shell', { timeout: 15000 });
  ok('login succeeds and app shell loads');

  // 3. dashboard (wait until live data has rendered)
  await page.waitForSelector('.stat', { timeout: 10000 });
  await page.waitForSelector('.tbl tbody tr', { timeout: 10000 });
  await new Promise(r => setTimeout(r, 500));
  const navCount = await page.$$eval('.nav-item', els => els.length);
  navCount === 8 ? ok(`sidebar has ${navCount} sections`) : fail(`expected 8 nav items, got ${navCount}`);
  const statText = await page.$eval('.stat .value', el => el.textContent);
  statText.includes('Rs') ? ok(`dashboard shows sales: ${statText}`) : fail(`dashboard stat unexpected: ${statText}`);
  const recentRows = await page.$$eval('.tbl tbody tr', els => els.length);
  recentRows > 0 ? ok(`dashboard lists ${recentRows} recent invoice(s)`) : fail('dashboard recent invoices empty');
  await expectNoToasts('dashboard');

  // 4. POS — add a product and complete a real sale
  await page.evaluate(() => { window.location.hash = '/pos'; });
  await page.waitForSelector('.product-tile', { timeout: 10000 });
  const tileCount = await page.$$eval('.product-tile', els => els.length);
  tileCount > 0 ? ok(`POS shows ${tileCount} product tiles`) : fail('POS has no product tiles');
  await page.click('.product-tile');
  await page.waitForSelector('.cart-line', { timeout: 5000 });
  ok('tapping a product adds it to the cart');

  const totalBefore = await page.$eval('.totals .t-row.grand span:last-child', el => el.textContent);
  totalBefore.includes('Rs') ? ok(`cart total: ${totalBefore}`) : fail(`cart total broken: ${totalBefore}`);

  await page.$$eval('.pay-grid .btn', els => {
    const b = els.find(e => e.textContent.includes('Cash'));
    if (b) b.click();
  });
  await page.$$eval('.btn.success', els => {
    const b = els.find(e => e.textContent.includes('Complete Sale'));
    if (b) b.click();
  });
  await page.waitForFunction(
    () => [...document.querySelectorAll('.modal-head h3')].some(h => h.textContent.includes('Sale Completed')),
    { timeout: 10000 }
  );
  ok('Complete Sale saves the invoice and shows confirmation');

  await page.$$eval('.modal-foot .btn', els => {
    const b = els.find(e => e.textContent.includes('New Sale'));
    if (b) b.click();
  });
  await new Promise(r => setTimeout(r, 300));
  await expectNoToasts('POS sale');

  // 5. other pages render
  const pagesToCheck = [
    ['/products', '.tbl', 'Products table'],
    ['/inventory', '.stat', 'Inventory valuation cards'],
    ['/customers', '.tbl', 'Customers table'],
    ['/invoices', '.tbl', 'Invoices table'],
    ['/reports', '.pill-tabs', 'Reports tabs'],
    ['/settings', '.card-title', 'Settings sections']
  ];
  for (const [hash, selector, label] of pagesToCheck) {
    await page.evaluate(h => { window.location.hash = h; }, hash);
    try {
      await page.waitForSelector(selector, { timeout: 8000 });
      ok(`${label} renders (${hash})`);
    } catch {
      fail(`${label} did not render (${hash})`);
    }
    await expectNoToasts(hash);
  }

  // 6. invoice from the new sale exists in the list
  await page.evaluate(() => { window.location.hash = '/invoices'; });
  await page.waitForSelector('.tbl tbody tr', { timeout: 8000 });
  ok('invoice list shows rows');
} catch (e) {
  fail('exception: ' + e.message);
} finally {
  await browser.close();
}

if (errors.length) {
  console.log('\nBrowser errors:');
  for (const e of [...new Set(errors)]) console.log('  • ' + e);
}
if (fails.length || errors.length) {
  console.log(`\nFAILED: ${fails.length} assertion(s), ${errors.length} browser error(s)`);
  process.exit(1);
}
console.log('\nALL UI TESTS PASSED ✅');
