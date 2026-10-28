import React, { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  LayoutDashboard, ScanBarcode, Tag, Package, UsersRound, ReceiptText,
  BarChart3, Settings as SettingsIcon, Wifi, WifiOff, RefreshCw, Sun, Moon, LogOut
} from 'lucide-react';
import { Button } from './ui/index.js';
import { useApp, useRoute, navigate } from '../store.jsx';
import { api } from '../api.js';
import { can, ROLE_LABELS } from '../rbac.js';
import { currentTheme, toggleTheme } from '../theme.js';
import { outboxCount } from '../localdb.js';

const NAV = [
  { path: '/dashboard', Icon: LayoutDashboard, label: 'Dashboard' },
  { path: '/pos', Icon: ScanBarcode, label: 'Billing (POS)' },
  { path: '/products', Icon: Tag, label: 'Products' },
  { path: '/inventory', Icon: Package, label: 'Inventory' },
  { path: '/customers', Icon: UsersRound, label: 'Customers' },
  { path: '/invoices', Icon: ReceiptText, label: 'Invoices' },
  { path: '/reports', Icon: BarChart3, label: 'Reports', cap: 'reports_view' },
  { path: '/settings', Icon: SettingsIcon, label: 'Settings', cap: ['settings', 'users'] }
];

function useSyncStatus(enabled) {
  const [status, setStatus] = useState({ pending: 0, last_sync: '', online: navigator.onLine });

  const refresh = useCallback(async () => {
    setStatus(s => ({ ...s, online: navigator.onLine }));
    if (!enabled) return;
    try {
      const data = await api('/sync/status');
      setStatus(s => ({ ...s, ...data, online: navigator.onLine }));
    } catch { /* offline */ }
  }, [enabled]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30000);
    const on = () => refresh();
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    return () => {
      clearInterval(t);
      window.removeEventListener('online', on);
      window.removeEventListener('offline', on);
    };
  }, [refresh]);

  return [status, refresh];
}

// Online/Offline pill — the shop always knows whether the internet is up and
// how many offline changes are waiting to sync. Animated so a drop is obvious
// at a glance.
function NetPill({ online, label, busy, onClick }) {
  const Icon = !online ? WifiOff : busy ? RefreshCw : Wifi;
  return (
    <motion.span
      className={`sync-badge ${online ? 'net-on' : 'net-off'}`}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? e => { if (e.key === 'Enter') onClick(); } : undefined}
      title={online ? 'Internet is up' : 'No internet — MartBill keeps billing and syncs later'}
      animate={{ scale: 1 }}
      initial={false}
    >
      <motion.span
        className={`sync-dot ${online ? 'on' : 'off'}`}
        animate={online ? { opacity: 1 } : { opacity: [1, 0.3, 1] }}
        transition={online ? { duration: 0.2 } : { duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
      />
      <Icon size={14} className={busy ? 'spin' : ''} style={{ flex: 'none' }} />
      <motion.span key={label} initial={{ opacity: 0, y: -3 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}>
        {label}
      </motion.span>
    </motion.span>
  );
}

export default function Layout({ children, title }) {
  const { user, settings, logout, toast } = useApp();
  const route = useRoute();
  const canSync = can(user?.role, 'sync');
  const [status, refreshStatus] = useSyncStatus(canSync);
  const navItems = NAV.filter(item => !item.cap || can(user?.role, item.cap));
  const [lowCount, setLowCount] = useState(0);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    let alive = true;
    api('/reports/low-stock')
      .then(rows => alive && setLowCount(rows.length))
      .catch(() => {});
    return () => { alive = false; };
  }, [route]);

  const runSync = async () => {
    setSyncing(true);
    try {
      const r = await api('/sync/run', { method: 'POST' });
      toast(`Sync complete — ${r.pushed} pushed, ${r.pulled} pulled`, 'success');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setSyncing(false);
      refreshStatus();
    }
  };

  // offline bills queued on this device — shown in the pill, synced automatically
  const [outbox, setOutbox] = useState(0);
  useEffect(() => {
    let alive = true;
    const refresh = () => outboxCount().then(n => { if (alive) setOutbox(n); }).catch(() => {});
    refresh();
    window.addEventListener('shopbill:outbox', refresh);
    return () => { alive = false; window.removeEventListener('shopbill:outbox', refresh); };
  }, []);

  // tell the shop when a queued bill makes it through, or needs a human
  useEffect(() => {
    const synced = e => toast(`✅ Offline bill synced — ${e.detail.label || 'saved'}`, 'success');
    const failed = e => toast(`⚠ Offline bill needs attention: ${e.detail.message}`, 'error');
    window.addEventListener('shopbill:offline-bill-synced', synced);
    window.addEventListener('shopbill:outbox-error', failed);
    return () => {
      window.removeEventListener('shopbill:offline-bill-synced', synced);
      window.removeEventListener('shopbill:outbox-error', failed);
    };
  }, [toast]);

  const billWord = n => `offline bill${n > 1 ? 's' : ''}`;
  // offline always reads as offline, whatever the sync state is
  const syncLabel = !status.online
    ? (outbox > 0
      ? `${outbox} ${billWord(outbox)} queued`
      : status.pending > 0 ? `Offline · ${status.pending} waiting` : 'Working offline — data safe')
    : outbox > 0
      ? `${outbox} ${billWord(outbox)} to sync`
      : !status.configured
        ? 'Online'
        : status.pending > 0
          ? `${status.pending} change${status.pending > 1 ? 's' : ''} waiting`
          : 'Synced';

  const [theme, setTheme] = useState(currentTheme());
  useEffect(() => {
    const on = e => setTheme(e.detail);
    window.addEventListener('shopbill:theme', on);
    return () => window.removeEventListener('shopbill:theme', on);
  }, []);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">M</div>
          <span>
            MartBill
            <div className="brand-sub">{settings.shop_name || 'Billing System'}</div>
          </span>
        </div>
        <nav className="nav">
          {navItems.map(item => {
            const active = route.startsWith(item.path);
            const badge = item.path === '/inventory' && lowCount > 0 ? lowCount : 0;
            const Ico = item.Icon;
            return (
              <button
                key={item.path}
                className={`nav-item ${active ? 'active' : ''}`}
                onClick={() => navigate(item.path)}
              >
                <span className="icon"><Ico size={17} /></span>
                <span className="txt">{item.label}</span>
                {badge > 0 ? <span className="nav-badge">{badge}</span> : null}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          {settings.currency_symbol || 'Rs'} · {settings.tax_label || 'Tax'} enabled
          <div style={{ marginTop: 4 }}>v1.0.0</div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <h1>{title}</h1>
          <div className="spacer" />

          <NetPill
            online={status.online}
            busy={syncing}
            label={syncing ? 'Syncing…' : syncLabel}
            onClick={status.configured ? runSync : undefined}
          />

          <div className="flex" style={{ gap: 9 }}>
            <Button
              variant="secondary" size="sm" className="icon-btn"
              title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              onClick={() => toggleTheme()}
            >
              {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
            </Button>
            <div className="avatar">{(user?.name || user?.username || '?').slice(0, 1).toUpperCase()}</div>
            <div className="small">
              <div className="bold">{user?.name || user?.username}</div>
              <div className="muted" style={{ fontSize: 11 }}>{ROLE_LABELS[user?.role] || user?.role}</div>
            </div>
            <Button variant="secondary" size="sm" onClick={() => logout()}>
              <LogOut size={13} style={{ marginRight: 6, verticalAlign: -2 }} />Logout
            </Button>
          </div>
        </header>

        <main className="content">{children}</main>
      </div>
    </div>
  );
}

export function Toaster() {
  const { toasts } = useApp();
  return (
    <div className="toasts">
      {toasts.map(t => (
        <motion.div
          key={t.id} className={`toast ${t.type}`}
          initial={{ opacity: 0, x: 26, scale: 0.97 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          transition={{ duration: 0.24, ease: 'easeOut' }}
        >
          {t.message}
        </motion.div>
      ))}
    </div>
  );
}
