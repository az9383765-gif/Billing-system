// Screenshots the FIRST-RUN login variant ("Set up your shop" — the buyer creates
// their own owner account) on a fresh, empty database, plus a mobile view.
// Run with: npm run shots:login
import puppeteer from 'puppeteer-core';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const OUT = path.join(root, 'screenshots');
const PORT = 3210;
const BASE = `http://localhost:${PORT}`;

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];
const executablePath = CANDIDATES.find(p => fs.existsSync(p));
if (!executablePath) {
  console.error('No Edge/Chrome found');
  process.exit(1);
}

const wait = ms => new Promise(r => setTimeout(r, ms));
const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'shopbill-login-shot-'));
const server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: tempData },
  stdio: ['ignore', 'pipe', 'pipe']
});

let browser;
try {
  // wait for the fresh server
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      up = r.ok;
    } catch { /* not yet */ }
    if (!up) await wait(250);
  }
  if (!up) throw new Error('fresh server did not start');

  const brand = await (await fetch(`${BASE}/api/auth/brand`)).json();
  if (!brand.setup) throw new Error('expected fresh-install setup mode on an empty database');

  browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  // 1. first-run login: glowing "Create your shop's owner account" banner
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.setup-banner', { timeout: 10000 });
  await wait(500);
  await page.screenshot({ path: path.join(OUT, 'feature-login-setup.png') });
  console.log('  ✔ feature-login-setup.png');

  // 2. the setup form: shop name + owner details
  await page.click('.setup-banner');
  await page.waitForSelector('input[placeholder^="e.g. Al-Hafiz"]', { timeout: 5000 });
  await wait(300);
  await page.screenshot({ path: path.join(OUT, 'feature-register-setup.png') });
  console.log('  ✔ feature-register-setup.png');

  // 3. mobile view of the first-run login
  await page.setViewport({ width: 412, height: 900, deviceScaleFactor: 1 });
  await page.click('.ltab:not(.on)'); // back to Sign in
  await page.waitForSelector('input[autocomplete="current-password"]', { timeout: 5000 });
  await wait(300);
  await page.screenshot({ path: path.join(OUT, 'feature-login-mobile.png') });
  console.log('  ✔ feature-login-mobile.png');

  console.log('Setup login screenshots saved to', OUT);
} finally {
  await browser?.close();
  server.kill();
  await wait(500);
  try { fs.rmSync(tempData, { recursive: true, force: true }); } catch { /* best effort */ }
}
