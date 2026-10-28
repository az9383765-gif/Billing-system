import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp, navigate } from '../store.jsx';
import { money, dateStr, timeStr, todayISO, monthStartISO, num } from '../format.js';
import { can } from '../rbac.js';

export default function Dashboard() {
  const { user, settings, toast } = useApp();
  const sym = settings.currency_symbol || 'Rs';
  const seeReports = can(user?.role, 'reports_view');
  const seeStockValue = can(user?.role, 'stock_view');
  const canManageProducts = can(user?.role, 'products_manage');
  const [summary, setSummary] = useState(null);
  const [month, setMonth] = useState(null);
  const [taxRates, setTaxRates] = useState(null);
  const [recent, setRecent] = useState([]);
  const [low, setLow] = useState([]);
  const [valuation, setValuation] = useState(null);

  useEffect(() => {
    const today = todayISO();
    let alive = true;
    // the Cashier only bills — the sales figures and stock value are the Head's / manager's
    Promise.all([
      seeReports ? api(`/reports/summary?from=${today}&to=${today}`) : Promise.resolve(null),
      seeReports ? api(`/reports/summary?from=${monthStartISO()}&to=${today}`) : Promise.resolve(null),
      seeReports ? api(`/reports/tax?from=${today}&to=${today}`) : Promise.resolve(null),
      api('/invoices?limit=8'),
      api('/reports/low-stock'),
      seeStockValue ? api('/stock/valuation') : Promise.resolve(null)
    ]).then(([todayS, monthS, rates, inv, lowS, val]) => {
      if (!alive) return;
      setSummary(todayS);
      setMonth(monthS);
      setTaxRates(rates);
      setRecent(inv);
      setLow(lowS);
      setValuation(val);
    }).catch(e => toast(e.message, 'error'));
    return () => { alive = false; };
  }, [toast, seeReports, seeStockValue]);

  const s = summary || {};
  const m = month || {};

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <button className="btn" onClick={() => navigate('/pos')}>＋ New Bill</button>
        {canManageProducts ? <button className="btn secondary" onClick={() => navigate('/products')}>Add Product</button> : null}
        {seeReports ? <button className="btn secondary" onClick={() => navigate('/reports')}>View Reports</button> : null}
        <div className="spacer" />
        <span className="muted small">{dateStr(todayISO())}</span>
      </div>

      <div className="stat-grid">
        {seeReports ? (
          <>
            <div className="stat blue">
              <div className="accent" />
              <div className="label">Today's Sales</div>
              <div className="value">{money(s.revenue, sym)}</div>
              <div className="sub">{s.invoices || 0} invoice(s) · {num(s.items_sold)} items</div>
            </div>
            <div className="stat green">
              <div className="accent" />
              <div className="label">Today's Profit</div>
              <div className="value">{money(s.profit, sym)}</div>
              <div className="sub">Margin: {s.revenue > 0 ? Math.round((s.profit / s.revenue) * 100) : 0}%</div>
            </div>
            <div className="stat green">
              <div className="accent" />
              <div className="label">GST Today</div>
              <div className="value">{money(s.tax, sym)}</div>
              <div className="sub">
                on {money(s.taxable_value, sym)} taxable
                {s.refunds > 0 ? ` · net of ${money(s.refunds, sym)} refunds` : ''}
              </div>
            </div>
            <div className="stat amber">
              <div className="accent" />
              <div className="label">Credit Outstanding</div>
              <div className="value">{money(s.outstanding_credit, sym)}</div>
              <div className="sub">Collected today: {money(s.collected, sym)}</div>
            </div>
          </>
        ) : (
          <div className="stat blue">
            <div className="accent" />
            <div className="label">Ready to bill</div>
            <div className="value">Scan &amp; print</div>
            <div className="sub">Open Billing (POS) to make a bill</div>
          </div>
        )}
        <div className="stat red">
          <div className="accent" />
          <div className="label">Low Stock Items</div>
          <div className="value">{low.length}</div>
          <div className="sub">{low.length ? 'Reorder soon' : 'All stocked up'}</div>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1.6fr 1fr' }}>
        <div className="card">
          <div className="card-title">Recent Invoices</div>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Invoice</th><th>Date</th><th>Customer</th>
                  <th className="num">Total</th><th className="num">Due</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {recent.length === 0 ? (
                  <tr><td colSpan="6" className="empty">No sales yet — create your first bill</td></tr>
                ) : recent.map(inv => (
                  <tr key={inv.id} className="clickable" onClick={() => navigate('/invoices')}>
                    <td className="bold">{inv.invoice_no}</td>
                    <td>{dateStr(inv.sale_date)} <span className="muted small">{timeStr(inv.datetime)}</span></td>
                    <td>{inv.customer_name || 'Walk-in'}</td>
                    <td className="num bold">{money(inv.total, sym)}</td>
                    <td className="num">{inv.due_amount > 0 ? <span className="badge red">{money(inv.due_amount, sym)}</span> : '—'}</td>
                    <td>
                      {inv.voided ? <span className="badge gray">VOID</span>
                        : inv.status === 'paid' ? <span className="badge green">PAID</span>
                        : inv.status === 'partial' ? <span className="badge amber">PARTIAL</span>
                        : <span className="badge red">CREDIT</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="stack">
          {seeReports ? (
          <div className="card">
            <div className="card-title">This Month</div>
            <div className="stat" style={{ border: 'none', boxShadow: 'none', padding: 0 }}>
              <div className="value" style={{ color: 'var(--primary)' }}>{money(m.revenue, sym)}</div>
              <div className="sub">Sales revenue</div>
            </div>
            <div className="divider" />
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="muted">Invoices</span><b>{m.invoices || 0}</b>
            </div>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="muted">Profit</span><b>{money(m.profit, sym)}</b>
            </div>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="muted">{settings.tax_label || 'Tax'} collected</span><b>{money(m.tax, sym)}</b>
            </div>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="muted">Stock value</span><b>{money(valuation?.cost_value, sym)}</b>
            </div>
          </div>
          ) : null}

          {seeReports && taxRates?.length ? (
            <div className="card">
              <div className="card-title">{settings.tax_label || 'GST'} Today — by Rate</div>
              <div className="stack" style={{ gap: 7 }}>
                {taxRates.map(r => (
                  <div key={r.rate} className="row" style={{ justifyContent: 'space-between', fontSize: 13 }}>
                    <span>{r.rate}% on {money(r.taxable, sym)}</span>
                    <b>{money(r.tax, sym)}</b>
                  </div>
                ))}
              </div>
              <div className="divider" />
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="muted">Total {settings.tax_label || 'GST'}</span>
                <b>{money(s.tax, sym)}</b>
              </div>
              <button className="btn secondary sm mt-14" onClick={() => navigate('/reports')} style={{ width: '100%' }}>
                Tax Report
              </button>
            </div>
          ) : null}

          <div className="card">
            <div className="card-title">Low Stock Alerts</div>
            {low.length === 0 ? (
              <div className="muted small">All products are above their alert level. 🎉</div>
            ) : (
              <div className="stack" style={{ gap: 7 }}>
                {low.slice(0, 6).map(p => (
                  <div key={p.id} className="row" style={{ justifyContent: 'space-between', fontSize: 13 }}>
                    <span>{p.name}</span>
                    <span className="badge red">{num(p.stock_qty)} {p.unit} left</span>
                  </div>
                ))}
                {low.length > 6 ? <div className="muted small">+{low.length - 6} more…</div> : null}
              </div>
            )}
            <button className="btn secondary sm mt-14" onClick={() => navigate('/inventory')} style={{ width: '100%' }}>
              Manage Stock
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
