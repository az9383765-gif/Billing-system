import React, { useEffect, useState } from 'react';
import { api, downloadFile } from '../api.js';
import { useApp } from '../store.jsx';
import { money, num } from '../format.js';
import { can } from '../rbac.js';
import Modal from '../components/Modal.jsx';
import { printHTML, labelsHTML } from '../print.js';

const EMPTY = {
  name: '', barcode: '', category_id: '', unit: 'pcs', price: '', cost_price: '',
  stock_qty: '', low_stock: '', tax_rate: '', tax_inclusive: true, is_active: true,
  expiry_date: ''
};

const todayISO = () => new Date().toISOString().slice(0, 10);
const daysLeft = iso => Math.ceil((new Date(iso + 'T00:00:00Z') - new Date(todayISO() + 'T00:00:00Z')) / 86400000);

// expiry cell: red when the stock is already expired, amber when it is about to go
function expiryBadge(value) {
  if (!value) return <span className="muted">—</span>;
  if (value < todayISO()) return <span className="badge red">EXPIRED {value}</span>;
  if (daysLeft(value) <= 30) return <span className="badge amber">{daysLeft(value)}d left · {value}</span>;
  return <span className="small">{value}</span>;
}

export default function Products() {
  const { user, settings, toast } = useApp();
  const canManage = can(user?.role, 'products_manage');
  const sym = settings.currency_symbol || 'Rs';
  const [rows, setRows] = useState([]);
  const [categories, setCategories] = useState([]);
  const [search, setSearch] = useState('');
  const [cat, setCat] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [form, setForm] = useState(null); // null | product object
  const [newCat, setNewCat] = useState('');
  const [busy, setBusy] = useState(false);
  const [labelFor, setLabelFor] = useState(null);
  const [labelQty, setLabelQty] = useState(1);

  const load = async () => {
    const p = new URLSearchParams();
    if (search.trim()) p.set('search', search.trim());
    if (cat) p.set('category_id', cat);
    if (lowOnly) p.set('low_stock', '1');
    if (showInactive) p.set('active', 'all');
    setRows(await api(`/products?${p.toString()}`));
  };

  useEffect(() => {
    load().catch(e => toast(e.message, 'error'));
  }, [search, cat, lowOnly, showInactive]);

  useEffect(() => {
    api('/products/categories').then(setCategories).catch(() => {});
  }, []);

  const set = (key, value) => setForm(f => ({ ...f, [key]: value }));

  const generateBarcode = async () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const candidate = String(Math.floor(1000000000000 + Math.random() * 8999999999999));
      try {
        const found = await api(`/products?barcode=${candidate}`);
        if (found.length === 0) return set('barcode', candidate);
      } catch { return set('barcode', candidate); }
    }
    toast('Could not generate a free barcode, please enter one manually', 'warning');
  };

  const save = async () => {
    if (!form.name.trim()) return toast('Product name is required', 'warning');
    if (form.price === '' || Number(form.price) < 0) return toast('Enter a valid selling price', 'warning');
    setBusy(true);
    try {
      let categoryId = form.category_id || '';
      if (newCat.trim()) {
        const c = await api('/products/categories', { method: 'POST', body: { name: newCat.trim() } });
        categoryId = c.id;
        setCategories(list => [...list, c]);
        setNewCat('');
      }
      const body = { ...form, category_id: categoryId || null };
      const isNew = !form.id;
      if (isNew) {
        await api('/products', { method: 'POST', body });
        toast('Product added', 'success');
      } else {
        await api(`/products/${form.id}`, { method: 'PUT', body });
        toast('Product updated', 'success');
      }
      setForm(null);
      load();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async p => {
    if (!window.confirm(`Delete "${p.name}"? Products with sales history are only deactivated.`)) return;
    try {
      await api(`/products/${p.id}`, { method: 'DELETE' });
      toast('Product removed', 'success');
      load();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const printLabels = async () => {
    const qty = Math.max(1, Math.min(200, Number(labelQty) || 1));
    const labels = Array.from({ length: qty }, () => ({
      name: labelFor.name, barcode: labelFor.barcode || labelFor.name, price: labelFor.price
    }));
    printHTML(labelsHTML({ labels, shop: settings, symbol: sym }), { page: 'A4' });
  };

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="search-box" style={{ flex: 1, minWidth: 220 }}>
          <span className="s-icon">⌕</span>
          <input className="input" placeholder="Search name or barcode…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <select className="input" style={{ width: 170 }} value={cat} onChange={e => setCat(e.target.value)}>
          <option value="">All categories</option>
          {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button className={`btn sm ${lowOnly ? '' : 'secondary'}`} onClick={() => setLowOnly(v => !v)}>
          ⚠ Low stock
        </button>
        <button className="btn secondary sm" onClick={() => setShowInactive(v => !v)}>
          {showInactive ? 'Hide inactive' : 'Show inactive'}
        </button>
        <div className="spacer" />
        <button className="btn secondary sm" onClick={() => downloadFile('/products/export', 'products.csv')}>
          ⬇ CSV
        </button>
        {canManage ? <button className="btn" onClick={() => setForm({ ...EMPTY })}>＋ Add Product</button> : null}
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Product</th><th>Barcode</th><th>Category</th><th className="num">Price</th>
                <th className="num">Cost</th><th className="num">Stock</th><th className="num">Tax</th>
                <th>Expiry</th><th>Status</th><th style={{ width: 150 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan="10" className="empty">No products found. Add your first product to start billing.</td></tr>
              ) : rows.map(p => (
                <tr key={p.id}>
                  <td>
                    <div className="bold">{p.name}</div>
                    <div className="muted small">{p.unit}</div>
                  </td>
                  <td className="small">{p.barcode || '—'}</td>
                  <td>{p.category_name || '—'}</td>
                  <td className="num bold">{money(p.price, sym)}</td>
                  <td className="num muted">{money(p.cost_price, sym)}</td>
                  <td className="num">
                    {p.stock_qty <= p.low_stock
                      ? <span className="badge red">{num(p.stock_qty)}</span>
                      : <span>{num(p.stock_qty)}</span>}
                  </td>
                  <td className="num">{p.tax_rate > 0 ? `${p.tax_rate}% ${p.tax_inclusive ? 'incl' : 'excl'}` : '—'}</td>
                  <td>{expiryBadge(p.expiry_date)}</td>
                  <td>{p.is_active ? <span className="badge green">Active</span> : <span className="badge gray">Inactive</span>}</td>
                  <td>
                    <div className="flex" style={{ gap: 6 }}>
                      {canManage ? <button className="btn secondary xs" onClick={() => setForm({ ...EMPTY, ...p })}>Edit</button> : null}
                      <button className="btn secondary xs" onClick={() => { setLabelFor(p); setLabelQty(1); }} title="Print barcode labels">🏷</button>
                      {canManage ? <button className="btn danger xs" onClick={() => remove(p)}>Delete</button> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {form ? (
        <Modal
          title={form.id ? 'Edit Product' : 'Add Product'}
          onClose={() => setForm(null)}
          size="wide"
          footer={
            <>
              <button className="btn secondary" onClick={() => setForm(null)}>Cancel</button>
              <button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save Product'}</button>
            </>
          }
        >
          <div className="form-2">
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Product name *</label>
              <input className="input" autoFocus value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Rice 1kg" />
            </div>

            <div className="field">
              <label>Barcode / SKU</label>
              <div className="flex" style={{ gap: 7 }}>
                <input className="input" value={form.barcode} onChange={e => set('barcode', e.target.value)} placeholder="Scan or type" />
                <button className="btn secondary sm" type="button" onClick={generateBarcode} title="Generate a unique barcode">Generate</button>
              </div>
              <span className="hint">Scan with a barcode scanner in the POS search box</span>
            </div>

            <div className="field">
              <label>Category</label>
              <select className="input" value={form.category_id} onChange={e => set('category_id', e.target.value)}>
                <option value="">No category</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <input className="input" style={{ marginTop: 6 }} placeholder="…or new category name"
                value={newCat} onChange={e => setNewCat(e.target.value)} />
            </div>

            <div className="field">
              <label>Unit</label>
              <select className="input" value={form.unit} onChange={e => set('unit', e.target.value)}>
                {['pcs', 'kg', 'g', 'ltr', 'ml', 'box', 'pack', 'dozen', 'm', 'ft'].map(u => <option key={u}>{u}</option>)}
              </select>
            </div>

            <div className="field">
              <label>Selling price *</label>
              <input className="input" type="number" min="0" step="0.01" value={form.price} onChange={e => set('price', e.target.value)} />
            </div>

            <div className="field">
              <label>Cost price</label>
              <input className="input" type="number" min="0" step="0.01" value={form.cost_price} onChange={e => set('cost_price', e.target.value)} />
            </div>

            {form.id ? null : (
              <div className="field">
                <label>Opening stock</label>
                <input className="input" type="number" min="0" step="1" value={form.stock_qty} onChange={e => set('stock_qty', e.target.value)} />
              </div>
            )}

            <div className="field">
              <label>Low stock alert at</label>
              <input className="input" type="number" min="0" value={form.low_stock === '' ? settings.default_low_stock || 5 : form.low_stock}
                onChange={e => set('low_stock', e.target.value)} />
            </div>

            <div className="field">
              <label>Expiry date</label>
              <input className="input" type="date" value={form.expiry_date || ''}
                onChange={e => set('expiry_date', e.target.value)} />
              <span className="hint">Grocery batches — the POS refuses to sell expired stock</span>
            </div>

            <div className="field">
              <label>{settings.tax_label || 'Tax'} rate (%)</label>
              <input className="input" type="number" min="0" max="100" step="0.5" value={form.tax_rate} onChange={e => set('tax_rate', e.target.value)} />
            </div>

            <div className="field">
              <label>Price mode</label>
              <label className="checkbox" style={{ height: 38 }}>
                <input type="checkbox" checked={Boolean(form.tax_inclusive)}
                  onChange={e => set('tax_inclusive', e.target.checked)} />
                Price includes {settings.tax_label || 'tax'}
              </label>
            </div>
          </div>

          {form.id ? (
            <label className="checkbox">
              <input type="checkbox" checked={Boolean(form.is_active)} onChange={e => set('is_active', e.target.checked)} />
              Product active (visible in POS)
            </label>
          ) : null}
        </Modal>
      ) : null}

      {labelFor ? (
        <Modal title="Print Barcode Labels" onClose={() => setLabelFor(null)}
          footer={
            <>
              <button className="btn secondary" onClick={() => setLabelFor(null)}>Cancel</button>
              <button className="btn" onClick={printLabels}>🖨 Print</button>
            </>
          }>
          <div className="field">
            <label>Product</label>
            <div className="bold">{labelFor.name}</div>
            <div className="muted small">Barcode: {labelFor.barcode || 'not set'}</div>
          </div>
          <div className="field">
            <label>Number of labels</label>
            <input className="input" type="number" min="1" max="200" value={labelQty} onChange={e => setLabelQty(e.target.value)} />
          </div>
          <div className="alert info">
            Labels print 3 per row on A4 paper. Set your label size in the print dialog if needed.
          </div>
        </Modal>
      ) : null}
    </>
  );
}
