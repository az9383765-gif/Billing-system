// Demo shop data so the app is not empty on first run:  npm run seed
import { db, uuid, now, today, getSetting, setSetting, recordChange, rowOf, round2 } from './db.js';

const RESET = process.argv.includes('--reset');

if (RESET) {
  for (const t of ['return_items', 'returns', 'invoice_items', 'invoices', 'payments', 'ledger', 'stock_movements', 'sync_queue', 'products', 'categories', 'customers']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  setSetting('next_invoice_no', '1');
  setSetting('next_return_no', '1');
}

const hasProducts = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
if (hasProducts > 0 && !RESET) {
  console.log('Products already exist — skipping seed. Use "npm run seed -- --reset" to start fresh.');
  process.exit(0);
}

const datetime = now();
const date = today();

const categories = [
  ['Grocery', ['Rice (1kg)', 'Wheat Flour (1kg)', 'Sugar (1kg)', 'Cooking Oil (1L)', 'Tea Pack (250g)', 'Milk Powder (500g)', 'Salt (1kg)', 'Basmati Rice (5kg)']],
  ['Beverages', ['Mineral Water 1.5L', 'Cola Can 330ml', 'Juice Box 200ml', 'Energy Drink 250ml']],
  ['Snacks', ['Potato Chips 50g', 'Chocolate Bar 40g', 'Biscuit Pack', 'Instant Noodles', 'Popcorn 100g']],
  ['Household', ['Dishwash Bar', 'Laundry Powder 1kg', 'Floor Cleaner 1L', 'Toilet Soap 125g', 'Shampoo Sachet']],
  ['Personal Care', ['Toothpaste 100g', 'Shampoo 180ml', 'Hand Sanitizer 100ml', 'Razor Blade Pack']]
];

const db_insert_cat = db.prepare('INSERT INTO categories (id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
const db_insert_prod = db.prepare(
  `INSERT INTO products (id, name, barcode, category_id, unit, price, cost_price, stock_qty, low_stock, tax_rate, tax_inclusive, is_active, expiry_date, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`
);

// Demo expiry dates (days from today, negative = already expired) so the
// near-expiry report and the POS expired-stock guard have something to show.
// Never the alphabetically-first product — the UI tests tap the first tile.
const EXPIRY_OFFSETS = {
  'Milk Powder (500g)': -20,   // expired
  'Juice Box 200ml': -6,       // expired
  'Tea Pack (250g)': 11,       // near expiry
  'Cola Can 330ml': 19,        // near expiry
  'Hand Sanitizer 100ml': 28    // near expiry
};
const offsetDate = days => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

let catIndex = 0;
let prodIndex = 0;

const tx = db.transaction(() => {
  for (const [catName, products] of categories) {
    const catId = uuid();
    db_insert_cat.run(catId, catName, catIndex++, datetime, datetime);
    recordChange('categories', catId, 'insert', rowOf('categories', catId));

    for (const productName of products) {
      const id = uuid();
      prodIndex++;
      const barcode = '890' + String(1000000 + prodIndex * 7919).slice(0, 10);
      const cost = round2(40 + ((prodIndex * 37) % 260));
      const price = round2(cost * 1.25);
      const stock = 10 + ((prodIndex * 13) % 60);
      const low = 8;
      // Pakistani GST bands: 0% zero-rated staples, 5% / 10% reduced, 18% standard
      const taxRate = [0, 5, 10, 18][prodIndex % 4];
      const expiry = EXPIRY_OFFSETS[productName] === undefined ? '' : offsetDate(EXPIRY_OFFSETS[productName]);
      db_insert_prod.run(id, productName, barcode, catId, 'pcs', price, cost, stock, low, taxRate, expiry, datetime, datetime);
      recordChange('products', id, 'insert', rowOf('products', id));
    }
  }

  // customers
  const custs = [
    ['Walk-in Customer', '', '', '', 0],
    ['Ahmed Khan', '03001234567', 'Main Bazaar', '', 5000],
    ['Sara Traders', '03117654329', 'Market Road, Shop 12', '1234567890123', 20000],
    ['Bilal Store', '03451122334', 'Corner Plaza', '', 10000]
  ];
  const insertCust = db.prepare(
    'INSERT INTO customers (id, name, phone, address, gstin, credit_limit, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  for (const c of custs) {
    const id = uuid();
    insertCust.run(id, c[0], c[1], c[2], c[3], c[4], '', datetime, datetime);
    recordChange('customers', id, 'insert', rowOf('customers', id));
  }

  // demo sale so reports are not empty
  const products = db.prepare('SELECT * FROM products LIMIT 6').all();
  const walkIn = db.prepare("SELECT id FROM customers WHERE name = 'Walk-in Customer'").get();
  const invId = uuid();
  const invoiceNo = 'INV-0001';
  setSetting('next_invoice_no', '2');

  let subtotal = 0, taxTotal = 0, total = 0;
  const itemRows = products.map((p, i) => {
    const qty = 1 + (i % 3);
    const rate = p.tax_rate;
    const gross = round2(p.price * qty);
    const base = p.tax_inclusive ? round2(gross / (1 + rate / 100)) : gross;
    const tax = round2(base * (rate / 100));
    const lineTotal = round2(base + tax);
    subtotal = round2(subtotal + base);
    taxTotal = round2(taxTotal + tax);
    total = round2(total + lineTotal);
    const newQty = round2(p.stock_qty - qty);
    db.prepare('UPDATE products SET stock_qty = ?, updated_at = ? WHERE id = ?').run(newQty, datetime, p.id);
    db.prepare(
      `INSERT INTO stock_movements (id, product_id, type, delta, qty_after, cost_price, ref_id, note, datetime, created_at)
       VALUES (?, ?, 'sale', ?, ?, ?, ?, ?, ?, ?)`
    ).run(uuid(), p.id, -qty, newQty, p.cost_price, invId, `Sale ${invoiceNo}`, datetime, datetime);
    return { p, qty, rate, base, tax, lineTotal };
  });

  const roundedTotal = Math.round(total);
  db.prepare(
    `INSERT INTO invoices (id, invoice_no, customer_id, sale_date, datetime, subtotal, discount, tax_total, round_off, total, paid_amount, due_amount, payment_method, status, notes, voided, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, 'cash', 'paid', 'Demo sale', 0, NULL, ?, ?)`
  ).run(invId, invoiceNo, walkIn.id, date, datetime, subtotal, taxTotal, round2(roundedTotal - total), roundedTotal, roundedTotal, datetime, datetime);
  recordChange('invoices', invId, 'insert', rowOf('invoices', invId));

  // invoice row exists now — safe to insert its items
  for (const it of itemRows) {
    db.prepare(
      `INSERT INTO invoice_items (id, invoice_id, product_id, name, barcode, unit, qty, unit_price, unit_cost, line_discount, tax_rate, tax_amount, line_subtotal, line_total, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
    ).run(uuid(), invId, it.p.id, it.p.name, it.p.barcode, it.p.unit, it.qty, it.p.price, it.p.cost_price, it.rate, it.tax, it.base, it.lineTotal, datetime);
  }

  db.prepare(
    `INSERT INTO payments (id, customer_id, invoice_id, type, amount, method, note, pay_date, datetime, created_at, updated_at)
     VALUES (?, ?, ?, 'received', ?, 'cash', 'Invoice payment', ?, ?, ?, ?)`
  ).run(uuid(), walkIn.id, invId, roundedTotal, date, datetime, datetime, datetime);
  const payRow = db.prepare('SELECT * FROM payments WHERE invoice_id = ?').get(invId);
  recordChange('payments', payRow.id, 'insert', payRow);

  // a bit of credit history
  const sara = db.prepare("SELECT id FROM customers WHERE name = 'Sara Traders'").get();
  const creditInv = uuid();
  db.prepare(
    `INSERT INTO invoices (id, invoice_no, customer_id, sale_date, datetime, subtotal, discount, tax_total, round_off, total, paid_amount, due_amount, payment_method, status, notes, voided, created_by, created_at, updated_at)
     VALUES (?, 'INV-0002', ?, ?, ?, 1200, 0, 60, 0, 1260, 400, 860, 'cash', 'partial', 'Demo credit sale', 0, NULL, ?, ?)`
  ).run(creditInv, sara.id, date, datetime, datetime, datetime);
  const bal1 = 860;
  const ledId = uuid();
  db.prepare(
    `INSERT INTO ledger (id, customer_id, entry_type, invoice_id, payment_id, debit, credit, balance_after, note, datetime, created_at)
     VALUES (?, ?, 'sale', ?, NULL, 860, 0, ?, 'Credit sale INV-0002', ?, ?)`
  ).run(ledId, sara.id, creditInv, bal1, datetime, datetime);
  recordChange('invoices', creditInv, 'insert', rowOf('invoices', creditInv));
  recordChange('ledger', ledId, 'insert', rowOf('ledger', ledId));
  // both demo invoices used: INV-0001 and INV-0002
  setSetting('next_invoice_no', '3');
});

tx();

console.log('Seed data created:');
console.log(`  - ${db.prepare('SELECT COUNT(*) AS n FROM categories').get().n} categories`);
console.log(`  - ${db.prepare('SELECT COUNT(*) AS n FROM products').get().n} products`);
console.log(`  - ${db.prepare('SELECT COUNT(*) AS n FROM customers').get().n} customers`);
console.log(`  - ${db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n} demo invoices`);

// a presentable demo shop on a fresh database — never overwrites a shop that
// has already been configured (name no longer the default "My Shop")
if (getSetting('shop_name', 'My Shop') === 'My Shop') {
  const demoShop = {
    shop_name: 'Al-Madina Karyana Store',
    shop_address: 'Shop 12, Main Bazaar, Gulberg II, Lahore',
    shop_phone: '+92 300 1234567',
    gstin: '11-1234567-8',
    receipt_footer: 'Shukriya! Thank you for shopping with us.'
  };
  for (const [key, value] of Object.entries(demoShop)) setSetting(key, value);
  console.log('  - demo shop profile (name, address, phone, GSTIN, receipt footer)');
}

// no accounts are ever created here: a fresh install has NO built-in login.
// The first person to open the app registers their own account (it becomes the Head).
const activeUsers = db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').get().n;
if (activeUsers === 0) {
  console.log('No account yet — open the app and press "Create account" to set up your shop.');
  console.log('The first account you create becomes the Head (owner).');
} else {
  console.log(`Accounts on this database: ${activeUsers} active — sign in from the login page.`);
}
