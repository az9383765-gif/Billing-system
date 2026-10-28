import React, { Suspense, lazy, useEffect } from 'react';
import { motion } from 'framer-motion';
import { AppProvider, useApp, useRoute, navigate } from './store.jsx';
import Layout, { Toaster } from './components/Layout.jsx';
import { can } from './rbac.js';
import Login from './pages/Login.jsx';

// Routes load on demand: a smaller first paint, and after sign-in every chunk
// is warmed in the background so the service worker has cached each screen
// before the shop ever loses its internet.
const load = {
  dashboard: () => import('./pages/Dashboard.jsx'),
  pos: () => import('./pages/POS.jsx'),
  products: () => import('./pages/Products.jsx'),
  inventory: () => import('./pages/Inventory.jsx'),
  customers: () => import('./pages/Customers.jsx'),
  invoices: () => import('./pages/Invoices.jsx'),
  expenses: () => import('./pages/Expenses.jsx'),
  reports: () => import('./pages/Reports.jsx'),
  settings: () => import('./pages/Settings.jsx')
};

const PAGES = {
  '/dashboard': { title: 'Dashboard', Component: lazy(load.dashboard) },
  '/pos': { title: 'Billing (POS)', Component: lazy(load.pos) },
  '/products': { title: 'Products', Component: lazy(load.products) },
  '/inventory': { title: 'Inventory & Stock', Component: lazy(load.inventory) },
  '/customers': { title: 'Customers & Credit', Component: lazy(load.customers) },
  '/invoices': { title: 'Invoices', Component: lazy(load.invoices) },
  '/expenses': { title: 'Expenses', Component: lazy(load.expenses), cap: 'expenses_view' },
  '/reports': { title: 'Reports', Component: lazy(load.reports), cap: 'reports_view' },
  '/settings': { title: 'Settings', Component: lazy(load.settings), cap: ['settings', 'users'] }
};

// what each role lands on after login (the Head and Inventory Manager get the overview)
function homePath(role) {
  return can(role, 'reports_view') ? '/dashboard' : '/pos';
}

function Denied({ home }) {
  return (
    <div className="card empty-state">
      <div className="big">🔒</div>
      <div className="bold">This screen is not part of your role</div>
      <div className="small">The Head decides who can open each screen — ask the Head if you need access.</div>
      <button className="btn mt-14" onClick={() => navigate(home)}>Back to my screen</button>
    </div>
  );
}

function Splash() {
  return (
    <div className="login-wrap">
      <div className="login-card center">
        <div className="logo-row" style={{ justifyContent: 'center' }}>
          <div className="brand-logo" style={{ width: 42, height: 42, fontSize: 21 }}>M</div>
        </div>
        <h2 style={{ marginTop: 14 }}>MartBill</h2>
        <div className="tag">Loading…</div>
      </div>
    </div>
  );
}

function Router() {
  const { user, booting, settings } = useApp();
  const route = useRoute();

  // warm every route chunk once someone is signed in — navigation becomes
  // instant, and the service worker stores each chunk so every screen stays
  // available even with no internet
  useEffect(() => {
    if (!user) return;
    const t = setTimeout(() => {
      Object.values(load).forEach(fn => fn().catch(() => { /* best-effort warm-up */ }));
    }, 1500);
    return () => clearTimeout(t);
  }, [user]);

  if (booting) return <Splash />;
  if (!user) return <Login />;

  const home = homePath(user.role);
  const page = PAGES[route] || PAGES[home];
  const allowed = !page.cap || can(user.role, page.cap);
  const Component = page.Component;

  return (
    <>
      <Layout title={page.title}>
        {/* keyed entrance — the new screen fades up the moment the route changes */}
        <motion.div
          key={route}
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
        >
          <Suspense fallback={<div className="card"><div className="tag">Loading…</div></div>}>
            {allowed ? <Component settings={settings} /> : <Denied home={home} />}
          </Suspense>
        </motion.div>
      </Layout>
      <Toaster />
    </>
  );
}

export default function App() {
  return (
    <AppProvider>
      <Router />
    </AppProvider>
  );
}
