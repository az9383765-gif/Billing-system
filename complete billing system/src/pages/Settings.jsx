import React, { useEffect, useState } from 'react';
import { api, downloadFile, getToken } from '../api.js';
import { useApp } from '../store.jsx';
import { money, durationStr } from '../format.js';
import { ROLE_LABELS, roleCan, can } from '../rbac.js';
import Modal from '../components/Modal.jsx';
import { Button, Card, CardTitle, Alert } from '../components/ui/index.js';
import { currentTheme, applyTheme } from '../theme.js';

// module switches → the capabilities they hand out (Settings → Users → Edit).
// On = grant that whole module to THIS person; off = take it away, whatever
// their role would say. Only the differences from the role get stored.
const MODULES = [
  { label: 'Billing (POS)', caps: ['invoices_create', 'invoices_view', 'invoices_export'] },
  { label: 'Void & returns', caps: ['invoices_void', 'returns'] },
  { label: 'Products', caps: ['products_manage'] },
  { label: 'Stock & inventory', caps: ['stock_add', 'stock_request', 'stock_approve', 'stock_view'] },
  { label: 'Reports', caps: ['reports_view'] },
  { label: 'Customers & udhaar', caps: ['customers_manage', 'customers_delete'] },
  { label: 'Expenses', caps: ['expenses_view', 'expenses_manage'] },
  { label: 'Settings & backup', caps: ['settings', 'sync'] },
  { label: 'Users', caps: ['users'] }
];

// effective access for the person being edited (their overrides, else role default)
function effective(form, cap) {
  const p = form.permissions || {};
  return Object.prototype.hasOwnProperty.call(p, cap) ? Boolean(p[cap]) : roleCan(form.role, cap);
}

export default function Settings() {
  const { user, settings, refreshSettings, setSettings, toast } = useApp();
  // Per-person module grants drive this screen — the very switches the Head
  // ticks in Settings → Users. Never the bare role: whoever was granted a
  // module must see it work here, exactly like the Head would.
  const canSettings = can(user?.role, 'settings');
  const canUsersMgmt = can(user?.role, 'users');
  const canSyncCap = can(user?.role, 'sync');
  const isAdmin = user?.role === 'admin'; // the Head alone hands out roles/modules
  const sym = settings.currency_symbol || 'Rs.';
  const [form, setForm] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [sync, setSync] = useState({ configured: false, pending: 0, last_sync: '' });
  const [users, setUsers] = useState([]);
  const [userForm, setUserForm] = useState(null);
  const [pw, setPw] = useState({ old_password: '', new_password: '' });
  const [backupMsg, setBackupMsg] = useState('');
  const [coupons, setCoupons] = useState([]);
  const [cpn, setCpn] = useState(null); // working copy for the coupon add/edit form
  const [themeNow, setThemeNow] = useState(currentTheme());

  useEffect(() => { setForm(settings); }, [settings]);
  useEffect(() => {
    if (canSyncCap) api('/sync/status').then(setSync).catch(() => {});
    if (canUsersMgmt) api('/auth/users').then(setUsers).catch(() => {});
    if (canSettings) api('/coupons').then(setCoupons).catch(() => {});
  }, [canSyncCap, canUsersMgmt, canSettings]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async (label = 'Settings') => {
    setBusy(true);
    try {
      const updated = await api('/settings', { method: 'PUT', body: form });
      setSettings(updated);
      await refreshSettings();
      toast(`${label} saved`, 'success');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  // ---------- optional offsite backup (Supabase Storage) ----------
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudAt, setCloudAt] = useState(settings.last_cloud_backup || '');
  const backUpCloud = async () => {
    setCloudBusy(true);
    try {
      // save the keys first so the server can use them in the same press
      const updated = await api('/settings', { method: 'PUT', body: form });
      setSettings(updated);
      const r = await api('/settings/backup/cloud', { method: 'POST' });
      setCloudAt(r.at || '');
      await refreshSettings();
      toast(`Offsite backup stored — ${r.path}`, 'success');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setCloudBusy(false);
    }
  };

  const runSync = async () => {
    setBusy(true);
    try {
      await save('Sync settings');
      const r = await api('/sync/run', { method: 'POST' });
      toast(`Sync complete — ${r.pushed} pushed, ${r.pulled} pulled`, 'success');
      setSync(await api('/sync/status'));
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const importBackup = e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (!window.confirm('Restore this backup? ALL current data will be replaced.')) return;
      api('/settings/backup/import', { method: 'POST', body: JSON.parse(reader.result) })
        .then(() => {
          setBackupMsg('Backup restored. The app will reload.');
          setTimeout(() => window.location.reload(), 1200);
        })
        .catch(err => toast(err.message, 'error'));
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const changePassword = async () => {
    if (!pw.new_password || pw.new_password.length < 4) return toast('New password must be at least 4 characters', 'warning');
    try {
      await api('/auth/change-password', { method: 'POST', body: pw });
      toast('Password changed', 'success');
      setPw({ old_password: '', new_password: '' });
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const saveUser = async () => {
    if (!userForm.username?.trim() || (!userForm.id && !userForm.password)) {
      return toast('Username and password are required', 'warning');
    }
    try {
      if (userForm.id) {
        await api(`/auth/users/${userForm.id}`, { method: 'PUT', body: userForm });
        // hand out (or take back) the modules the Head ticked for this person
        if (userForm.permissions) {
          await api(`/auth/users/${userForm.id}/permissions`, {
            method: 'PUT', body: { permissions: userForm.permissions }
          });
        }
        toast('User saved', 'success');
      } else {
        await api('/auth/users', { method: 'POST', body: userForm });
        toast('User created — approve them below before they can log in', 'success');
      }
      setUsers(await api('/auth/users'));
      setUserForm(null);
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  // remove a person for good — their sessions die with them
  const removeUser = async u => {
    if (u.id === user.id) return toast('You cannot delete your own account', 'warning');
    if (!window.confirm(`Delete ${u.username} permanently? Their sessions end immediately.`)) return;
    try {
      await api(`/auth/users/${u.id}`, { method: 'DELETE' });
      setUsers(await api('/auth/users'));
      toast(`${u.username} deleted`, 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  // the Head turns a pending account on (approve) or off
  const setUserActive = async (u, active) => {
    try {
      await api(`/auth/users/${u.id}`, { method: 'PUT', body: { active } });
      setUsers(await api('/auth/users'));
      toast(active ? `${u.username} approved — they can log in now` : `${u.username} turned off`, 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  // show/hide the "Create account" form on the login page
  const toggleRegister = async on => {
    const value = on ? '1' : '0';
    set('allow_register', value);
    try {
      const updated = await api('/settings', { method: 'PUT', body: { allow_register: value } });
      setSettings(updated);
      await refreshSettings();
      toast(on
        ? 'New account requests are ON — visitors can send a request from the login page'
        : 'New account requests are OFF — nobody can sign up from the login page', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  // ---- coupon desk (Head only — the cashier just types the code at billing) ----
  const saveCoupon = async () => {
    if (!cpn?.code?.trim()) return toast('Coupon code is required', 'warning');
    try {
      if (cpn.id) {
        await api(`/coupons/${cpn.id}`, { method: 'PUT', body: cpn });
        toast('Coupon updated', 'success');
      } else {
        await api('/coupons', { method: 'POST', body: cpn });
        toast('Coupon created', 'success');
      }
      setCpn(null);
      setCoupons(await api('/coupons'));
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const removeCoupon = async c => {
    if (!window.confirm(`Delete coupon ${c.code}? Bills that already used it keep their history.`)) return;
    try {
      await api(`/coupons/${c.id}`, { method: 'DELETE' });
      setCoupons(list => list.filter(x => x.id !== c.id));
      toast('Coupon deleted', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const toggleCoupon = async c => {
    try {
      await api(`/coupons/${c.id}`, { method: 'PUT', body: { active: c.active ? 0 : 1 } });
      setCoupons(await api('/coupons'));
      toast(c.active ? `${c.code} switched off` : `${c.code} switched on`, 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const disabled = !canSettings;

  return (
    <>
      {!canSettings && !canUsersMgmt ? (
        <Alert variant="warn">You don't have access to shop settings — ask the Head to grant your modules (Settings → Users).</Alert>
      ) : null}
      {!canSettings && canUsersMgmt ? (
        <Alert variant="info">You manage people here. Shop settings stay with the Head.</Alert>
      ) : null}

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', alignItems: 'start' }}>
        {/* -------- appearance (per device, no server involved) -------- */}
        <Card>
          <CardTitle>Appearance (this device)</CardTitle>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {['light', 'dark'].map(t => (
              <button
                key={t} className={`theme-opt ${themeNow === t ? 'on' : ''}`}
                onClick={() => { applyTheme(t); setThemeNow(t); }}
              >
                <span className={`swatch ${t}`} />
                {t === 'light' ? 'Light' : 'Dark premium'}
              </button>
            ))}
          </div>
          <div className="muted small" style={{ marginTop: 9 }}>
            Remembered on this device only — each person picks their own look.
          </div>
        </Card>

        {/* -------- shop info -------- */}
        <div className="card">
          <div className="card-title">Shop Information</div>
          <div className="field">
            <label>Shop name</label>
            <input className="input" disabled={disabled} value={form.shop_name || ''} onChange={e => set('shop_name', e.target.value)} />
          </div>
          <div className="field">
            <label>Address</label>
            <textarea className="input" disabled={disabled} value={form.shop_address || ''} onChange={e => set('shop_address', e.target.value)} />
          </div>
          <div className="form-2">
            <div className="field">
              <label>Phone</label>
              <input className="input" disabled={disabled} value={form.shop_phone || ''} onChange={e => set('shop_phone', e.target.value)} />
            </div>
            <div className="field">
              <label>GSTIN / Tax number</label>
              <input className="input" disabled={disabled} value={form.gstin || ''} onChange={e => set('gstin', e.target.value)} />
            </div>
          </div>
          <div className="form-2">
            <div className="field">
              <label>Currency symbol</label>
              <input className="input" disabled={disabled} value={form.currency_symbol || ''} onChange={e => set('currency_symbol', e.target.value)} />
            </div>
            <div className="field">
              <label>Currency code</label>
              <input className="input" disabled={disabled} value={form.currency_code || ''} onChange={e => set('currency_code', e.target.value)} />
            </div>
          </div>
          <button className="btn" onClick={() => save('Shop info')} disabled={busy || disabled}>Save</button>
        </div>

        {/* -------- invoice & receipt -------- */}
        <div className="card">
          <div className="card-title">Invoice &amp; Receipt</div>
          <div className="form-2">
            <div className="field">
              <label>Invoice prefix</label>
              <input className="input" disabled={disabled} value={form.invoice_prefix || ''} onChange={e => set('invoice_prefix', e.target.value)} />
            </div>
            <div className="field">
              <label>Number padding</label>
              <input className="input" type="number" min="1" max="8" disabled={disabled}
                value={form.invoice_padding || '4'} onChange={e => set('invoice_padding', e.target.value)} />
              <span className="hint">Next invoice: {form.invoice_prefix}{String(form.next_invoice_no || 1).padStart(Number(form.invoice_padding || 4), '0')}</span>
            </div>
            <div className="field">
              <label>Receipt paper</label>
              <select className="input" disabled={disabled} value={form.receipt_width || '80'} onChange={e => set('receipt_width', e.target.value)}>
                <option value="58">58 mm thermal</option>
                <option value="80">80 mm thermal</option>
                <option value="a4">A4 (full page)</option>
              </select>
            </div>
            <div className="field">
              <label>Round off total</label>
              <label className="checkbox" style={{ height: 38 }}>
                <input type="checkbox" disabled={disabled} checked={form.round_off === '1'}
                  onChange={e => set('round_off', e.target.checked ? '1' : '0')} />
                Round to nearest whole amount
              </label>
            </div>
          </div>
          <div className="field">
            <label>Receipt footer message</label>
            <input className="input" disabled={disabled} value={form.receipt_footer || ''} onChange={e => set('receipt_footer', e.target.value)} />
          </div>
          <div className="field">
            <label>Terms (printed on A4 invoice)</label>
            <textarea className="input" disabled={disabled} value={form.terms || ''} onChange={e => set('terms', e.target.value)} />
          </div>
          <button className="btn" onClick={() => save('Invoice settings')} disabled={busy || disabled}>Save</button>
        </div>

        {/* -------- tax & rules -------- */}
        <div className="card">
          <div className="card-title">Tax &amp; Business Rules</div>
          <div className="form-2">
            <div className="field">
              <label>Tax label</label>
              <select className="input" disabled={disabled} value={form.tax_label || 'GST'} onChange={e => set('tax_label', e.target.value)}>
                <option value="GST">GST</option>
                <option value="VAT">VAT</option>
                <option value="Sales Tax">Sales Tax</option>
                <option value="Tax">Tax</option>
              </select>
            </div>
            <div className="field">
              <label>Split tax (CGST + SGST)</label>
              <label className="checkbox" style={{ height: 38 }}>
                <input type="checkbox" disabled={disabled} checked={form.tax_split === '1'}
                  onChange={e => set('tax_split', e.target.checked ? '1' : '0')} />
                Show as CGST + SGST halves
              </label>
            </div>
            <div className="field">
              <label>Default low-stock alert</label>
              <input className="input" type="number" min="0" disabled={disabled}
                value={form.default_low_stock || 5} onChange={e => set('default_low_stock', e.target.value)} />
            </div>
            <div className="field">
              <label>Allow credit (udhaar) sales</label>
              <label className="checkbox" style={{ height: 38 }}>
                <input type="checkbox" disabled={disabled} checked={form.allow_credit !== '0'}
                  onChange={e => set('allow_credit', e.target.checked ? '1' : '0')} />
                Customers can buy on credit
              </label>
            </div>
          </div>
          <div className="field">
            <label>Allow stock to go negative</label>
            <label className="checkbox">
              <input type="checkbox" disabled={disabled} checked={form.allow_negative_stock === '1'}
                onChange={e => set('allow_negative_stock', e.target.checked ? '1' : '0')} />
              Not recommended — off means sales are blocked when stock runs out
            </label>
          </div>
          <button className="btn" onClick={() => save('Tax rules')} disabled={busy || disabled}>Save</button>
        </div>

        {/* -------- loyalty -------- */}
        <div className="card">
          <div className="card-title">Loyalty Points</div>
          <div className="field">
            <label className="checkbox">
              <input type="checkbox" disabled={disabled} checked={form.loyalty_enabled === '1'}
                onChange={e => set('loyalty_enabled', e.target.checked ? '1' : '0')} />
              Give customers points on every sale
            </label>
          </div>
          <div className="form-2">
            <div className="field">
              <label>Points per {sym}100 spent</label>
              <input className="input" type="number" min="0" max="100" disabled={disabled}
                value={form.loyalty_earn ?? '1'} onChange={e => set('loyalty_earn', e.target.value)} />
            </div>
            <div className="field">
              <label>Value of 1 point ({sym})</label>
              <input className="input" type="number" min="0" step="0.5" disabled={disabled}
                value={form.loyalty_value ?? '1'} onChange={e => set('loyalty_value', e.target.value)} />
            </div>
          </div>
          <span className="hint">
            Example: earn 1 point per {sym}100 → a {sym}1,000 bill earns 10 points, and 10 points are worth {sym}10 off the next bill.
          </span>
          <button className="btn mt-14" onClick={() => save('Loyalty')} disabled={busy || disabled}>Save</button>
        </div>

        {/* -------- coupons -------- */}
        {canSettings ? <div className="card">
          <div className="card-title">Coupons (discount codes)</div>
          {coupons.length === 0 && !cpn ? (
            <p className="muted small">
              No coupons yet — create a code and the cashier can apply it right on the billing screen.
            </p>
          ) : (
            <table className="tbl">
              <thead>
                <tr><th>Code</th><th>Value</th><th className="num">Min bill</th><th className="num">Used</th><th></th></tr>
              </thead>
              <tbody>
                {coupons.map(c => (
                  <tr key={c.id} style={{ opacity: c.active ? 1 : 0.55 }}>
                    <td>
                      <b>{c.code}</b>
                      {c.ends_at ? <div className="muted small">till {c.ends_at}</div> : null}
                    </td>
                    <td>{c.type === 'percent' ? `${c.value}% off` : money(c.value, sym)}</td>
                    <td className="num">{c.min_total > 0 ? money(c.min_total, sym) : '—'}</td>
                    <td className="num">{c.used_count}{c.max_uses > 0 ? ` / ${c.max_uses}` : ''}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="btn ghost xs" onClick={() => toggleCoupon(c)}>
                        {c.active ? 'On' : 'Off'}
                      </button>{' '}
                      <button className="btn secondary xs" onClick={() => setCpn({ ...c })}>Edit</button>{' '}
                      <button className="btn danger xs" title="Delete" onClick={() => removeCoupon(c)}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {cpn ? (
            <>
              <div className="divider" />
              <div className="card-title" style={{ fontSize: 13 }}>
                {cpn.id ? `Edit coupon — ${cpn.code}` : 'New coupon'}
              </div>
              <div className="form-2">
                <div className="field">
                  <label>Code</label>
                  <input className="input" disabled={disabled || !!cpn.id}
                    style={{ textTransform: 'uppercase' }} placeholder="SAVE50"
                    value={cpn.code || ''} onChange={e => setCpn(c => ({ ...c, code: e.target.value.toUpperCase() }))} />
                </div>
                <div className="field">
                  <label>Type</label>
                  <select className="input" disabled={disabled || !!cpn.id}
                    value={cpn.type || 'fixed'} onChange={e => setCpn(c => ({ ...c, type: e.target.value }))}>
                    <option value="fixed">Fixed amount off</option>
                    <option value="percent">Percent off</option>
                  </select>
                </div>
                <div className="field">
                  <label>{cpn.type === 'percent' ? 'Percent off' : `Amount off (${sym})`}</label>
                  <input className="input" type="number" min="0" disabled={disabled}
                    value={cpn.value ?? ''} onChange={e => setCpn(c => ({ ...c, value: e.target.value }))} />
                </div>
                <div className="field">
                  <label>Min bill ({sym})</label>
                  <input className="input" type="number" min="0" disabled={disabled}
                    value={cpn.min_total ?? ''} onChange={e => setCpn(c => ({ ...c, min_total: e.target.value }))} />
                </div>
                <div className="field">
                  <label>Max uses (0 = unlimited)</label>
                  <input className="input" type="number" min="0" disabled={disabled}
                    value={cpn.max_uses ?? ''} onChange={e => setCpn(c => ({ ...c, max_uses: e.target.value }))} />
                </div>
                <div className="field">
                  <label>Valid till (optional)</label>
                  <input className="input" type="date" disabled={disabled}
                    value={cpn.ends_at || ''} onChange={e => setCpn(c => ({ ...c, ends_at: e.target.value }))} />
                </div>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn" onClick={saveCoupon} disabled={busy || disabled}>
                  {cpn.id ? 'Update coupon' : 'Create coupon'}
                </button>
                <button className="btn secondary" onClick={() => setCpn(null)}>Cancel</button>
              </div>
            </>
          ) : (
            <button className="btn secondary sm mt-14" disabled={disabled}
              onClick={() => setCpn({ code: '', type: 'fixed', value: '', min_total: '', max_uses: '', starts_at: '', ends_at: '', active: 1 })}>
              ＋ New coupon
            </button>
          )}
        </div> : null}

        {/* -------- sync -------- */}
        {canSyncCap ? <div className="card">
          <div className="card-title">Online Sync (Cloud Backup)</div>
          <div className="alert info">
            MartBill always works offline on this device. Enter your cloud server address here to back up changes
            automatically and access the same data from other devices.
          </div>
          <div className="field">
            <label>Cloud server URL</label>
            <input className="input" disabled={disabled} placeholder="https://your-server.com" value={form.sync_url || ''}
              onChange={e => set('sync_url', e.target.value)} />
            <span className="hint">Host this same app on any server — it becomes your cloud. Leave empty to run offline only.</span>
          </div>
          <div className="field">
            <label>Sync key</label>
            <input className="input" disabled={disabled} placeholder="Shared secret between devices" value={form.sync_key || ''}
              onChange={e => set('sync_key', e.target.value)} />
          </div>
          <div className="row" style={{ gap: 8 }}>
            <span className="badge blue">Queued changes: {sync.pending}</span>
            <span className="badge gray">Last sync: {sync.last_sync ? new Date(sync.last_sync).toLocaleString() : 'never'}</span>
          </div>
          <button className="btn mt-14" onClick={runSync} disabled={busy || disabled || !form.sync_url}>
            {busy ? 'Working…' : 'Save & Sync Now'}
          </button>
        </div> : null}

        {/* -------- cloud backup (Supabase — optional insurance) -------- */}
        {canSettings ? <Card>
          <CardTitle>Cloud backup — Supabase (optional)</CardTitle>
          <p className="muted small">
            Push a full JSON snapshot of this shop into a private Supabase Storage bucket —
            kept off this computer and ready when you need it. Billing never depends on it.
          </p>
          <div className="field">
            <label>Project URL</label>
            <input className="input" disabled={disabled} placeholder="https://abcdefgh.supabase.co"
              value={form.supabase_url || ''} onChange={e => set('supabase_url', e.target.value)} />
          </div>
          <div className="form-2">
            <div className="field">
              <label>API key</label>
              <input className="input" disabled={disabled} type="password" placeholder="eyJhbGciOi…"
                value={form.supabase_key || ''} onChange={e => set('supabase_key', e.target.value)} />
            </div>
            <div className="field">
              <label>Storage bucket</label>
              <input className="input" disabled={disabled} placeholder="backups"
                value={form.supabase_bucket || ''} onChange={e => set('supabase_bucket', e.target.value)} />
            </div>
          </div>
          <Alert variant="info">
            Create a <b>private</b> bucket in Supabase → Storage first, and keep the key on this server only.
            {cloudAt ? ` Last backup: ${new Date(cloudAt).toLocaleString()}.` : ' No offsite backup yet.'}
          </Alert>
          <Button onClick={backUpCloud} disabled={cloudBusy || disabled || !form.supabase_url || !form.supabase_key}>
            {cloudBusy ? 'Backing up…' : '☁ Back up now'}
          </Button>
        </Card> : null}

        {/* -------- backup -------- */}
        <div className="card">
          <div className="card-title">Backup &amp; Restore</div>
          <p className="muted small">
            Download a full backup of every product, sale and customer. Restore it on this or another device.
          </p>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn secondary" disabled={!canSettings}
              onClick={() => downloadFile('/settings/backup', `shopbill-backup-${new Date().toISOString().slice(0, 10)}.json`)}>
              ⬇ Download Backup
            </button>
            <label className={`btn ${canSettings ? '' : 'secondary'}`} style={{ opacity: canSettings ? 1 : .5, cursor: canSettings ? 'pointer' : 'not-allowed' }}>
              ⬆ Restore Backup
              {canSettings ? <input type="file" accept="application/json" style={{ display: 'none' }} onChange={importBackup} /> : null}
            </label>
          </div>
          {backupMsg ? <div className="alert success mt-14">{backupMsg}</div> : null}
          <div className="divider" />
          <div className="card-title">Change My Password</div>
          <div className="form-2">
            <div className="field">
              <label>Current password</label>
              <input className="input" type="password" value={pw.old_password}
                onChange={e => setPw(p => ({ ...p, old_password: e.target.value }))} />
            </div>
            <div className="field">
              <label>New password</label>
              <input className="input" type="password" value={pw.new_password}
                onChange={e => setPw(p => ({ ...p, new_password: e.target.value }))} />
            </div>
          </div>
          <button className="btn" onClick={changePassword}>Change Password</button>
        </div>

        {/* -------- Google sign-in -------- */}
        {canSettings ? <Card>
          <CardTitle>Google Sign-in (optional)</CardTitle>
          <p className="muted small">
            Let people sign in with their Google account instead of a password. Paste the
            <b> OAuth 2.0 Client ID</b> from Google Cloud Console → Credentials (Web application),
            with this page's address under <b>Authorized JavaScript origins</b>.
          </p>
          <div className="field">
            <label>Google Client ID</label>
            <input className="input" disabled={disabled}
              placeholder="1234567890-abc.apps.googleusercontent.com"
              value={form.google_client_id || ''} onChange={e => set('google_client_id', e.target.value)} />
            <span className="hint">
              {form.google_client_id
                ? 'On — the login page shows a “Sign in with Google” button.'
                : 'Leave empty for password sign-in only. Clearing this switches the button off on every device.'}
            </span>
          </div>
          <Alert variant="info">
            Google only proves <b>who</b> someone is. A Google address seen here for the first time becomes a
            <b> pending</b> account like any sign-up — you approve it in <b>Users</b> below and pick its role.
          </Alert>
          <Button onClick={() => save('Google sign-in')} disabled={busy || disabled}>Save</Button>
        </Card> : null}

        {/* -------- users -------- */}
        {canUsersMgmt ? <div className="card">
          <div className="card-title">Users — the Head decides who can log in</div>
          <p className="muted small">
            New accounts stay <b>pending</b> until you approve them. Cashiers only scan and bill,
            Inventory Managers ask for stock and read the reports, the Head does everything.
          </p>
          <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', margin: '4px 0 14px', cursor: 'pointer' }}>
            <input type="checkbox" style={{ marginTop: 2 }} disabled={disabled}
              checked={form.allow_register !== '0'}
              onChange={e => toggleRegister(e.target.checked)} />
            <span className="small">
              <b>Allow new account requests</b> from the login page
              <span className="muted"> — visitors press “Create account”, you approve them here.</span>
            </span>
          </label>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Status</th><th>Hours</th><th></th></tr></thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id}>
                    <td className="bold">{u.username}</td>
                    <td>{u.name || '—'}</td>
                    <td>
                      <span className={`badge ${u.role === 'admin' ? 'blue' : u.role === 'inventory' ? 'amber' : 'gray'}`}>
                        {ROLE_LABELS[u.role] || u.role}
                      </span>
                    </td>
                    <td>
                      {u.active ? <span className="badge green">active</span> : <span className="badge amber">pending</span>}
                    </td>
                    <td>
                      <div className="flex" style={{ gap: 6, alignItems: 'center' }}>
                        {u.duty?.online ? <span className="badge green">on duty</span> : null}
                        <span>{durationStr(u.duty?.seconds)}</span>
                        <span className="muted small">({durationStr(u.duty?.seconds_today)} today)</span>
                      </div>
                    </td>
                    <td>
                      <div className="flex" style={{ gap: 6 }}>
                        {!u.active ? (
                          <button className="btn success xs" disabled={!canUsersMgmt} onClick={() => setUserActive(u, true)}>Approve</button>
                        ) : (
                          <button className="btn secondary xs" disabled={!canUsersMgmt} onClick={() => setUserActive(u, false)}>Turn off</button>
                        )}
                        <button className="btn secondary xs" disabled={!canUsersMgmt}
                          onClick={() => setUserForm({ id: u.id, username: u.username, name: u.name, role: u.role, active: u.active, password: '', permissions: u.permissions || {} })}>
                          Edit
                        </button>
                        <button className="btn danger xs" disabled={!canUsersMgmt || u.id === user.id}
                          title={u.id === user.id ? 'You cannot delete yourself' : 'Delete this person'}
                          onClick={() => removeUser(u)}>
                          ×
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="btn mt-14" disabled={!canUsersMgmt} onClick={() => setUserForm({ username: '', name: '', role: 'cashier', password: '' })}>
            ＋ Add User
          </button>
        </div> : null}
      </div>

      {userForm ? (
        <Modal title={userForm.id ? 'Edit User' : 'Add User'} onClose={() => setUserForm(null)}
          footer={
            <>
              <button className="btn secondary" onClick={() => setUserForm(null)}>Cancel</button>
              <button className="btn" onClick={saveUser}>Save User</button>
            </>
          }>
          <div className="form-2">
            <div className="field">
              <label>Username *</label>
              <input className="input" autoFocus value={userForm.username} disabled={Boolean(userForm.id)}
                onChange={e => setUserForm(f => ({ ...f, username: e.target.value }))} />
            </div>
            <div className="field">
              <label>Full name</label>
              <input className="input" value={userForm.name || ''} onChange={e => setUserForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="field">
              <label>Role</label>
              <select className="input" value={userForm.role} onChange={e => setUserForm(f => ({ ...f, role: e.target.value }))}>
                <option value="cashier">Cashier — scans, bills, prints</option>
                <option value="inventory">Inventory Manager — stock requests + reports</option>
                {isAdmin ? <option value="admin">Head (Admin) — full control</option> : null}
              </select>
            </div>
            <div className="field">
              <label>{userForm.id ? 'New password (blank = keep)' : 'Password *'}</label>
              <input className="input" type="password" value={userForm.password || ''}
                onChange={e => setUserForm(f => ({ ...f, password: e.target.value }))} />
            </div>
          </div>
          {!userForm.id ? (
            <div className="alert info">The account stays <b>pending</b> — approve it from the list before this person can log in.</div>
          ) : null}
          {userForm.id ? (
            <label className="checkbox">
              <input type="checkbox" checked={userForm.active !== false}
                onChange={e => setUserForm(f => ({ ...f, active: e.target.checked }))} />
              Account active (approved by the Head)
            </label>
          ) : null}
          {userForm.id && userForm.permissions && isAdmin ? (
            <>
              <div className="divider" />
              <div className="card-title" style={{ fontSize: 13 }}>Module access — beyond the role</div>
              <p className="muted small" style={{ marginTop: 0 }}>
                Hand this person <b>exactly</b> the modules you want: on = allowed, off = refused —
                whatever their role says. Saved for this person only.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 14px' }}>
                {MODULES.map(m => {
                  const on = m.caps.some(c => effective(userForm, c));
                  return (
                    <label key={m.label} className="checkbox" style={{ minHeight: 24 }}>
                      <input type="checkbox" checked={on}
                        onChange={e => setUserForm(f => {
                          const permissions = { ...(f.permissions || {}) };
                          for (const c of m.caps) permissions[c] = e.target.checked;
                          return { ...f, permissions };
                        })} />
                      {m.label}
                    </label>
                  );
                })}
              </div>
              <p className="muted small" style={{ marginBottom: 0 }}>
                e.g. switch <b>Reports</b> on for a cashier without making them an Inventory Manager.
              </p>
            </>
          ) : null}
        </Modal>
      ) : null}
    </>
  );
}
