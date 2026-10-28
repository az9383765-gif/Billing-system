// Captures screenshots of the running app for documentation.
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

const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

const shot = name => page.screenshot({ path: path.join(OUT, `${name}.png`) });

await page.goto(BASE, { waitUntil: 'networkidle2' });
await page.waitForSelector('.login-card');
await shot('1-login');

await page.type('input[autocomplete="username"]', 'admin');
await page.type('input[autocomplete="current-password"]', 'admin123');
await page.click('.login-card button');
await page.waitForSelector('.shell');
await page.waitForSelector('.tbl tbody tr');
await new Promise(r => setTimeout(r, 600));
await shot('2-dashboard');

await page.evaluate(() => { window.location.hash = '/pos'; });
await page.waitForSelector('.product-tile');
await new Promise(r => setTimeout(r, 400));
// add a couple of products to the cart (not saved — just visual)
await page.click('.product-tile');
await new Promise(r => setTimeout(r, 200));
const tiles = await page.$$('.product-tile');
if (tiles[1]) await tiles[1].click();
await new Promise(r => setTimeout(r, 400));
await shot('3-pos');

await page.evaluate(() => { window.location.hash = '/products'; });
await page.waitForSelector('.tbl tbody tr');
await new Promise(r => setTimeout(r, 400));
await shot('4-products');

await page.evaluate(() => { window.location.hash = '/reports'; });
await page.waitForSelector('.stat');
await new Promise(r => setTimeout(r, 700));
await shot('5-reports');

await page.evaluate(() => { window.location.hash = '/customers'; });
await page.waitForSelector('.tbl tbody tr');
await new Promise(r => setTimeout(r, 400));
await shot('6-customers');

await browser.close();
console.log('Screenshots saved to', OUT);
