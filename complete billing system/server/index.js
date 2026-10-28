import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { db, now, getSetting } from './db.js';
import { requireAuth, cleanSessions } from './lib.js';
import authRoutes from './routes/auth.js';
import productRoutes from './routes/products.js';
import customerRoutes from './routes/customers.js';
import invoiceRoutes from './routes/invoices.js';
import returnRoutes from './routes/returns.js';
import stockRoutes from './routes/stock.js';
import reportRoutes from './routes/reports.js';
import settingsRoutes from './routes/settings.js';
import syncRoutes, { pushToCloud, pullFromCloud } from './routes/sync.js';
import heldRoutes from './routes/held.js';
import expenseRoutes from './routes/expenses.js';
import couponRoutes from './routes/coupons.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({ limit: '20mb' }));

// basic hardening headers (safe for the SPA and the print windows)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  next();
});

// ---------- API ----------
// Note: there is NO factory/admin password anywhere. A fresh install has zero
// accounts — the first registration on the login page becomes the Head.
app.get('/api/health', (req, res) => res.json({ ok: true, app: 'MartBill', time: now() }));
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/returns', returnRoutes);
app.use('/api/stock', stockRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/held', heldRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/coupons', couponRoutes);

app.get('/api/meta', requireAuth, (req, res) => {
  res.json({
    user: req.user,
    settings: db
      .prepare(
        `SELECT key, value FROM settings WHERE key IN
         ('shop_name','shop_address','shop_phone','gstin','currency_symbol','currency_code','invoice_prefix',
          'invoice_padding','next_invoice_no','tax_label','tax_split','round_off','receipt_width','receipt_footer',
          'terms','allow_credit','allow_negative_stock','default_low_stock','allow_register')`
      )
      .all()
      .reduce((acc, r) => ({ ...acc, [r.key]: r.value }), {})
  });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found' }));

// ---------- static client (production build) ----------
const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(path.join(distDir, 'index.html'))) {
  app.use(express.static(distDir));
  app.get('*', (req, res) => res.sendFile(path.join(distDir, 'index.html')));
} else {
  app.get('/', (req, res) =>
    res
      .status(200)
      .send('MartBill API is running. Frontend not built yet — run "npm run build" or use "npm run dev" (http://localhost:5173).')
  );
}

// ---------- error handler ----------
app.use((err, req, res, next) => {
  const status = Number(err.status || err.statusCode) || 500;
  if (status >= 500) console.error(err);
  // body-parser problems are client errors, not server crashes
  const message =
    err.type === 'entity.parse.failed' ? 'Invalid JSON in request body'
    : err.type === 'entity.too.large' ? 'Request body is too large'
    : status < 500 ? (err.message || 'Bad request')
    : 'Internal server error';
  res.status(status).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`MartBill server running at http://localhost:${PORT}`);
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    console.log('Frontend not built. For development run:  npm run dev');
  }
});

// ---------- background sync (online mode) ----------
setInterval(() => {
  cleanSessions();
  if (!getSetting('sync_url')) return;
  pushToCloud()
    .then(r => (r.pushed ? pullFromCloud() : null))
    .catch(err => console.log('Auto-sync skipped:', err.message));
}, 60000);

export default app;
