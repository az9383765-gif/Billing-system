// One-off visual check: logs in and captures the sidebar/topbar in both themes.
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'screenshots');
const BASE = 'http://localhost:3000';
const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];
const executablePath = CANDIDATES.find(p => fs.existsSync(p));
if (!executablePath) { console.error('No Edge/Chrome found'); process.exit(1); }

const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });

const hasShell = await page.$('.shell');
if (!hasShell) {
  await page.waitForSelector('input[autocomplete="username"]', { timeout: 10000 });
  const fill = async (sel, val) => {
    const el = await page.$(sel);
    await el.click({ clickCount: 3 });
    await el.type(val);
  };
  await fill('input[autocomplete="username"]', 'admin');
  await fill('input[autocomplete="current-password"]', 'admin123');
  await page.click('.login-card button');
  await page.waitForSelector('.shell', { timeout: 15000 });
}
await new Promise(r => setTimeout(r, 800));
await page.screenshot({ path: path.join(OUT, 'check-light.png') });

await page.evaluate(() => {
  [...document.querySelectorAll('.btn')].find(b => b.title && b.title.includes('theme'))?.click();
});
await new Promise(r => setTimeout(r, 600));
await page.screenshot({ path: path.join(OUT, 'check-dark.png') });

await browser.close();
console.log('saved to screenshots/check-light.png + check-dark.png');
