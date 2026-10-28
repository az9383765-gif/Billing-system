// Generates public/og-image.png (1200x630) — the card shown when MartBill
// links are shared (WhatsApp, Facebook, X, LinkedIn). Run: node tools/og-shot.mjs
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'public', 'og-image.png');
const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];
const executablePath = CANDIDATES.find(p => fs.existsSync(p));
if (!executablePath) { console.error('No Edge/Chrome found'); process.exit(1); }

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  body {
    width: 1200px; height: 630px; overflow: hidden;
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    background:
      radial-gradient(900px 500px at 85% -10%, rgba(59,130,246,.35), transparent 60%),
      radial-gradient(700px 500px at -10% 110%, rgba(14,165,233,.28), transparent 55%),
      linear-gradient(135deg, #0b1225 0%, #0f172a 55%, #111c3a 100%);
    color: #e2e8f0; position: relative;
  }
  .wrap { position: absolute; inset: 0; padding: 74px 84px; display: flex; flex-direction: column; justify-content: center; }
  .brand { display: flex; align-items: center; gap: 26px; }
  .logo {
    width: 96px; height: 96px; border-radius: 24px; flex: none;
    background: linear-gradient(135deg, #3b82f6, #6366f1);
    display: flex; align-items: center; justify-content: center;
    font-size: 54px; font-weight: 800; color: #fff;
    box-shadow: 0 18px 44px rgba(59,130,246,.45);
  }
  .name { font-size: 74px; font-weight: 800; letter-spacing: -1.5px; color: #f8fafc; line-height: 1; }
  .sub { font-size: 27px; color: #93c5fd; margin-top: 12px; font-weight: 600; }
  .tag { font-size: 31px; color: #cbd5e1; margin-top: 40px; max-width: 940px; line-height: 1.45; }
  .chips { display: flex; gap: 13px; margin-top: 46px; }
  .chip {
    font-size: 21px; font-weight: 700; color: #dbeafe; white-space: nowrap;
    background: rgba(59,130,246,.16); border: 1.5px solid rgba(147,197,253,.45);
    padding: 13px 21px; border-radius: 999px;
  }
  .foot { position: absolute; right: 84px; bottom: 64px; font-size: 22px; color: #64748b; font-weight: 600; }
</style></head><body>
  <div class="wrap">
    <div class="brand">
      <div class="logo">M</div>
      <div>
        <div class="name">MartBill</div>
        <div class="sub">Smart Billing &amp; POS</div>
      </div>
    </div>
    <div class="tag">Offline-first billing, stock &amp; reports for your shop — <b>works with or without internet</b>, bills never stop.</div>
    <div class="chips">
      <div class="chip">⚡ 100% Offline</div>
      <div class="chip">🔒 Multi-user access</div>
      <div class="chip">📱 Installable PWA</div>
      <div class="chip">☁ Optional cloud sync</div>
    </div>
  </div>
  <div class="foot">MartBill v1.0.0</div>
</body></html>`;

const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 2 });
await page.setContent(html, { waitUntil: 'networkidle0' });
await page.screenshot({ path: OUT, type: 'png' });
await browser.close();
console.log('saved', OUT);
