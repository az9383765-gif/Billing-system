import React, { useEffect, useState } from 'react';
import { api, downloadFile } from '../api.js';
import { useApp } from '../store.jsx';
import { money, num, dateStr, timeStr, todayISO, monthStartISO } from '../format.js';
import { can } from '../rbac.js';
import Modal from '../components/Modal.jsx';

export default function Inventory() {
  const { user, settings, toast } = useApp();
  const sym = settings.currency_symbol || 'Rs';
  const role = user?.role;
  // Head enters stock directly — the Inventory Manager asks and the Head approves
  const canAddDirect = can(role, 'stock_add');
  const canRequest = can(role, 'stock_request');
  const canApprove = can(role, 'stock_approve');
  const seeMovements = can(role, 'stock_view');
  const [low, setLow] = useState([]);
  const [expiring, setExpiring] = useState([]);
  const [valuation, setValuation] = useState(null);
  const [movements, setMovements] = useState([]);
  const [products, setProducts] = useState([]);
  const [requests, setRequests] = useState([]);
  const [filterProduct, setFilterProduct] = useState('');
  const [modal, setModal] = useState(null); // 'purchase' | 'adjust'
  const [rows, setRows] = useState([{ product_id: '', qty: '', cost_price: '' }]);
  const [adjust, setAdjust] = useState({ product_id: '', new_qty: '', delta: '', note: '', mode: 'set' });
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [l, p, x] = await Promise.all([
      api('/reports/low-stock'),
      api('/products'),
      api('/reports/expiring?days=30')
    ]);
    setLow(l); setProducts(p); setExpiring(x);
    if (seeMovements) {
      const [v, m] = await Promise.all([
        api('/stock/valuation'),
        api(`/stock/movements${filterProduct ? `?product_id=${filterProduct}` : ''}`)
      ]);
      setValuation(v); setMovements(m);
    }
    if (canRequest) setRequests(await api('/stock/requests'));
  };

  useEffect(() => {
    load().catch(e => toast(e.message, 'error'));
  }, [filterProduct]);

  const savePurchase = async () => {
    const items = rows
      .filter(r => r.product_id && Number(r.qty) > 0)
      .map(r => ({ product_id: r.product_id, qty: Number(r.qty), cost_price: r.cost_price === '' ? undefined : Number(r.cost_price) }));
    if (!items.length) return toast('Add at least one product with a quantity', 'warning');
    setBusy(true);
    try {
      if (canAddDirect) {
        await api('/stock/purchase', { method: 'POST', body: { items, note: 'Purchase entry' } });
        toast('Stock added', 'success');
      } else {
        for (const it of items) {
          await api('/stock/requests', {
            method: 'POST',
            body: { product_id: it.product_id, type: 'purchase', qty: it.qty, cost_price: it.cost_price, note: 'Purchase request' }
          });
        }
        toast('Sent to the Head for approval', 'success');
      }
      setModal(null);
      setRows([{ product_id: '', qty: '', cost_price: '' }]);
      load();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const saveAdjust = async () => {
    if (!adjust.product_id) return toast('Select a product', 'warning');
    // a request is always a +/− change: stock can move between asking and approval
    const reqDelta = Number(adjust.delta);
    if (!canAddDirect && (!Number.isFinite(reqDelta) || reqDelta === 0)) {
      return toast('Enter a change to the stock (e.g. +10 or −3)', 'warning');
    }
    setBusy(true);
    try {
      if (canAddDirect) {
        const body = adjust.mode === 'set'
          ? { product_id: adjust.product_id, new_qty: Number(adjust.new_qty), note: adjust.note }
          : { product_id: adjust.product_id, delta: Number(adjust.delta), note: adjust.note };
        await api('/stock/adjust', { method: 'POST', body });
        toast('Stock adjusted', 'success');
      } else {
        await api('/stock/requests', {
          method: 'POST',
          body: { product_id: adjust.product_id, type: 'adjust', qty: reqDelta, note: adjust.note || 'Adjustment request' }
        });
        toast('Adjustment sent to the Head for approval', 'success');
      }
      setModal(null);
      setAdjust({ product_id: '', new_qty: '', delta: '', note: '', mode: 'set' });
      load();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const decide = async (r, action) => {
    const verb = action === 'approve' ? 'Approve' : 'Reject';
    if (!window.confirm(`${verb} the ${r.type} of ${num(r.qty)} for ${r.product_name}?${action === 'approve' ? ' Stock will change.' : ''}`)) return;
    setBusy(true);
    try {
      await api(`/stock/requests/${r.id}/${action}`, { method: 'POST', body: { note: '' } });
      toast(action === 'approve' ? 'Stock request approved — stock updated' : 'Stock request rejected', action === 'approve' ? 'success' : 'info');
      load();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const statusBadge = status => status === 'approved'
    ? <span className="badge green">APPROVED</span>
    : status === 'rejected'
      ? <span className="badge red">REJECTED</span>
      : <span className="badge amber">WAITING</span>;

  const typeBadge = type => {
    const map = { sale: 'red', purchase: 'green', return: 'blue', adjustment: 'amber', opening: 'gray', damage: 'red' };
    return <span className={`badge ${map[type] || 'gray'}`}>{type.toUpperCase()}</span>;
  };

  return (
    <>
      <div className="stat-grid">
        {seeMovements ? (
          <>
            <div className="stat blue">
              <div className="accent" /><div className="label">Stock at Cost</div>
              <div className="value">{money(valuation?.cost_value, sym)}</div>
              <div className="sub">{num(valuation?.units)} units in {num(valuation?.products)} products</div>
            </div>
            <div className="stat green">
              <div className="accent" /><div className="label">Stock at Retail</div>
              <div className="value">{money(valuation?.retail_value, sym)}</div>
              <div className="sub">Potential value if all sold</div>
            </div>
          </>
        ) : null}
        <div className="stat red">
          <div className="accent" /><div className="label">Need Reorder</div>
          <div className="value">{low.length}</div>
          <div className="sub">Items at or below alert level</div>
        </div>
        {expiring.length > 0 ? (
          <div className="stat red">
            <div className="accent" /><div className="label">Expiring ≤ 30 Days</div>
            <div className="value">{expiring.length}</div>
            <div className="sub">{expiring.filter(x => x.expired).length} already expired</div>
          </div>
        ) : null}
        {seeMovements ? (
          <div className="stat amber">
            <div className="accent" /><div className="label">Recent Movements</div>
            <div className="value">{movements.length}</div>
            <div className="sub">Stock entries loaded</div>
          </div>
        ) : canRequest ? (
          <div className="stat amber">
            <div className="accent" /><div className="label">My Requests</div>
            <div className="value">{requests.length}</div>
            <div className="sub">{canApprove ? 'Stock entries sent for approval' : 'Sent to the Head for approval'}</div>
          </div>
        ) : (
          <div className="stat amber">
            <div className="accent" /><div className="label">Products</div>
            <div className="value">{products.length}</div>
            <div className="sub">Scan the barcode at the POS to bill</div>
          </div>
        )}
      </div>

      {canRequest ? (
        <div className="row" style={{ marginBottom: 14 }}>
          <button className="btn" onClick={() => setModal('purchase')}>
            {canAddDirect ? '＋ Purchase Entry (Stock In)' : '＋ Request Stock In'}
          </button>
          <button className="btn secondary" onClick={() => setModal('adjust')}>
            {canAddDirect ? '⚖ Stock Adjustment' : '⚖ Request Adjustment'}
          </button>
          <div className="spacer" />
          {seeMovements ? (
            <button className="btn secondary sm" onClick={() => downloadFile('/stock/movements/export', 'stock-movements.csv')}>
              ⬇ Export Movements
            </button>
          ) : null}
        </div>
      ) : null}

      {low.length > 0 ? (
        <div className="card">
          <div className="card-title">⚠ Low Stock — Reorder These</div>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Product</th><th>Barcode</th><th>Category</th><th className="num">In Stock</th>
                  <th className="num">Alert At</th><th className="num">Cost</th><th className="num">Buy Value</th></tr>
              </thead>
              <tbody>
                {low.map(p => (
                  <tr key={p.id}>
                    <td className="bold">{p.name}</td>
                    <td className="small">{p.barcode || '—'}</td>
                    <td>{p.category_name || '—'}</td>
                    <td className="num"><span className="badge red">{num(p.stock_qty)} {p.unit}</span></td>
                    <td className="num">{num(p.low_stock)}</td>
                    <td className="num">{money(p.cost_price, sym)}</td>
                    <td className="num">{money(p.stock_qty * p.cost_price, sym)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {expiring.length > 0 ? (
        <div className="card">
          <div className="card-title">⏳ Expiring Soon — sell or pull these first</div>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Product</th><th>Barcode</th><th>Category</th><th className="num">In Stock</th>
                  <th>Expiry</th><th>Status</th></tr>
              </thead>
              <tbody>
                {expiring.map(p => (
                  <tr key={p.id}>
                    <td className="bold">{p.name}</td>
                    <td className="small">{p.barcode || '—'}</td>
                    <td>{p.category_name || '—'}</td>
                    <td className="num">{num(p.stock_qty)} {p.unit}</td>
                    <td className="small">{p.expiry_date}</td>
                    <td>{p.expired
                      ? <span className="badge red">EXPIRED</span>
                      : <span className="badge amber">{p.days_left} day{p.days_left === 1 ? '' : 's'} left</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            The POS shows these on the product tile and refuses to bill expired stock.
          </div>
        </div>
      ) : null}

      {canRequest ? (
        <div className="card">
          <div className="card-title">
            {canApprove ? '📋 Stock Requests — waiting for your approval' : '📋 My Stock Requests'}
          </div>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Sent</th><th>Product</th><th>Type</th><th className="num">Qty</th>
                  <th className="num">Unit cost</th><th>Requested by</th><th>Note</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {requests.length === 0 ? (
                  <tr><td colSpan="9" className="empty">No stock requests yet</td></tr>
                ) : requests.map(r => (
                  <tr key={r.id}>
                    <td className="small">{dateStr(r.created_at)} {timeStr(r.created_at)}</td>
                    <td className="bold">{r.product_name}</td>
                    <td><span className={`badge ${r.type === 'purchase' ? 'green' : 'amber'}`}>{r.type.toUpperCase()}</span></td>
                    <td className="num">{r.qty > 0 && r.type === 'purchase' ? '+' : ''}{num(r.qty)}</td>
                    <td className="num">{r.type === 'purchase' ? money(r.cost_price, sym) : '—'}</td>
                    <td className="small">{r.requested_by_name || '—'}</td>
                    <td className="small muted">{r.note || '—'}</td>
                    <td>{statusBadge(r.status)}</td>
                    <td>
                      {canApprove && r.status === 'pending' ? (
                        <div className="flex" style={{ gap: 6 }}>
                          <button className="btn success xs" disabled={busy} onClick={() => decide(r, 'approve')}>Approve</button>
                          <button className="btn danger xs" disabled={busy} onClick={() => decide(r, 'reject')}>Reject</button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {seeMovements ? (
      <div className="card">
        <div className="flex" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <div className="card-title" style={{ marginBottom: 0 }}>Stock Movements</div>
          <select className="input" style={{ width: 230 }} value={filterProduct} onChange={e => setFilterProduct(e.target.value)}>
            <option value="">All products</option>
            {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr><th>Date</th><th>Product</th><th>Type</th><th className="num">Change</th>
                <th className="num">Stock After</th><th className="num">Cost</th><th>Note</th></tr>
            </thead>
            <tbody>
              {movements.length === 0 ? (
                <tr><td colSpan="7" className="empty">No stock movements yet</td></tr>
              ) : movements.slice(0, 300).map(m => (
                <tr key={m.id}>
                  <td className="small">{dateStr(m.datetime)} {timeStr(m.datetime)}</td>
                  <td>{m.product_name}</td>
                  <td>{typeBadge(m.type)}</td>
                  <td className="num" style={{ color: m.delta > 0 ? 'var(--success)' : m.delta < 0 ? 'var(--danger)' : 'inherit' }}>
                    {m.delta > 0 ? '+' : ''}{num(m.delta)}
                  </td>
                  <td className="num">{num(m.qty_after)}</td>
                  <td className="num">{money(m.cost_price, sym)}</td>
                  <td className="small muted">{m.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      ) : null}

      {modal === 'purchase' ? (
        <Modal title={canAddDirect ? 'Purchase Entry — Stock In' : 'Request Stock In — Head approval'} onClose={() => setModal(null)} size="wide"
          footer={
            <>
              <button className="btn secondary" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn success" onClick={savePurchase} disabled={busy}>
                {busy ? 'Saving…' : canAddDirect ? 'Save Purchase' : 'Send for Approval'}
              </button>
            </>
          }>
          <div className="alert info">
            {canAddDirect
              ? 'Stock you buy from suppliers is added here. Cost price is updated for profit calculation.'
              : 'The Head reviews and approves every stock entry before the stock changes.'}
          </div>
          {rows.map((r, idx) => (
            <div className="row" key={idx} style={{ alignItems: 'flex-end', marginBottom: 10 }}>
              <div className="field" style={{ flex: 2, marginBottom: 0 }}>
                <label>Product</label>
                <select className="input" value={r.product_id}
                  onChange={e => setRows(list => list.map((x, i) => i === idx ? { ...x, product_id: e.target.value } : x))}>
                  <option value="">Select product…</option>
                  {products.map(p => <option key={p.id} value={p.id}>{p.name} (stock: {num(p.stock_qty)})</option>)}
                </select>
              </div>
              <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                <label>Quantity</label>
                <input className="input" type="number" min="0" value={r.qty}
                  onChange={e => setRows(list => list.map((x, i) => i === idx ? { ...x, qty: e.target.value } : x))} />
              </div>
              <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                <label>Unit cost</label>
                <input className="input" type="number" min="0" step="0.01" value={r.cost_price}
                  onChange={e => setRows(list => list.map((x, i) => i === idx ? { ...x, cost_price: e.target.value } : x))} />
              </div>
              <button className="btn danger sm" style={{ marginBottom: 13 }}
                onClick={() => setRows(list => list.filter((_, i) => i !== idx))} disabled={rows.length === 1}>✕</button>
            </div>
          ))}
          <button className="btn secondary sm" onClick={() => setRows(list => [...list, { product_id: '', qty: '', cost_price: '' }])}>
            ＋ Add another row
          </button>
        </Modal>
      ) : null}

      {modal === 'adjust' ? (
        <Modal title={canAddDirect ? 'Stock Adjustment' : 'Request Stock Adjustment — Head approval'} onClose={() => setModal(null)}
          footer={
            <>
              <button className="btn secondary" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn" onClick={saveAdjust} disabled={busy}>
                {busy ? 'Saving…' : canAddDirect ? 'Apply Adjustment' : 'Send for Approval'}
              </button>
            </>
          }>
          <div className="field">
            <label>Product *</label>
            <select className="input" autoFocus value={adjust.product_id} onChange={e => setAdjust(a => ({ ...a, product_id: e.target.value }))}>
              <option value="">Select product…</option>
              {products.map(p => <option key={p.id} value={p.id}>{p.name} — current stock: {num(p.stock_qty)} {p.unit}</option>)}
            </select>
          </div>
          {canAddDirect ? (
          <div className="pill-tabs">
            <button className={`pill ${adjust.mode === 'set' ? 'active' : ''}`} onClick={() => setAdjust(a => ({ ...a, mode: 'set' }))}>Set exact stock</button>
            <button className={`pill ${adjust.mode === 'delta' ? 'active' : ''}`} onClick={() => setAdjust(a => ({ ...a, mode: 'delta' }))}>Add / remove quantity</button>
          </div>
          ) : null}
          {canAddDirect && adjust.mode === 'set' ? (
            <div className="field">
              <label>New stock quantity</label>
              <input className="input" type="number" min="0" value={adjust.new_qty}
                onChange={e => setAdjust(a => ({ ...a, new_qty: e.target.value }))} />
            </div>
          ) : (
            <div className="field">
              <label>Change (+ to add, − to remove)</label>
              <input className="input" type="number" value={adjust.delta}
                onChange={e => setAdjust(a => ({ ...a, delta: e.target.value }))} />
            </div>
          )}
          <div className="field">
            <label>Reason / note</label>
            <input className="input" placeholder="e.g. damaged goods, stock count correction"
              value={adjust.note} onChange={e => setAdjust(a => ({ ...a, note: e.target.value }))} />
          </div>
        </Modal>
      ) : null}
    </>
  );
}
