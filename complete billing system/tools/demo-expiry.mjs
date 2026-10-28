// Puts demo expiry dates on the live shop database so the near-expiry report
// and the POS expired-stock guard have something to show.
// Idempotent — safe to run any time. Never touches the alphabetically-first
// product (the UI tests tap the first tile on the POS grid).
//   node tools/demo-expiry.mjs
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

// find the database (data/ by default, DATA_DIR override supported)
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
const dbPath = path.join(dataDir, 'shopbill.db');
if (!fs.existsSync(dbPath)) {
  console.error('No database at ' + dbPath);
  process.exit(1);
}

const db = new Database(dbPath);

// name → days from today (negative = already expired)
const PLAN = {
  'Milk Powder (500g)': -20,   // expired
  'Juice Box 200ml': -6,       // expired
  'Tea Pack (250g)': 11,       // near expiry
  'Cola Can 330ml': 19,        // near expiry
  'Hand Sanitizer 100ml': 28    // near expiry
};

const offsetDate = days => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const first = db.prepare('SELECT name FROM products WHERE is_active = 1 ORDER BY name LIMIT 1').get()?.name;

const upd = db.prepare('UPDATE products SET expiry_date = ?, updated_at = ? WHERE name = ?');
const stamp = new Date().toISOString();
let n = 0;

const tx = db.transaction(() => {
  for (const [name, days] of Object.entries(PLAN)) {
    if (name === first) {
      console.log(`skipped (first product on the grid): ${name}`);
      continue;
    }
    const info = upd.run(offsetDate(days), stamp, name);
    if (info.changes > 0) {
      console.log(`${name} → expires ${offsetDate(days)} (${days > 0 ? '+' + days : days} days)`);
      n++;
    } else {
      console.log(`not found in this database: ${name}`);
    }
  }
});
tx();

console.log(`Done — ${n} expiry date(s) set.`);
db.close();
