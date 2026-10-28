import React, { useEffect, useState } from 'react';
import { api, downloadCSV } from '../api.js';
import { useApp } from '../store.jsx';
import { money, num, dateStr, todayISO, monthStartISO } from '../format.js';
import { can } from '../rbac.js';
import Expenses from './Expenses.jsx';

const TABS = [
  { id: 'summary', label: 'Summary' },
  { id: 'daily', label: 'Day-wise' },
  { id: 'products', label: 'Product-wise' },
  { id: 'customers', label: 'Customers & Credit' },
  { id: 'tax', label: 'Tax Report' },
  { id: 'low', label: 'Low Stock' }
];

export default function Reports() {
  const { user, settings, toast } = useApp();
  const sym = settings.currency_symbol || 'Rs';
  const taxLabel = settings.tax_label || 'GST';
  const split = settings.tax_split === '1';

  const [tab, setTab] = useState('summary');
  const [from, setFrom] = useState(monthStartISO());
  const [to, setTo] = useState(todayISO());
  const [summary, setSummary] = useState(null);
  const [daily, setDaily] = useState([]);
  const [products, setProducts] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [tax, setTax] = useState([]);
  const [low, setLow] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [s, d, p, c, t, l] = await Promise.all([
        api(`/reports/summary?from=${from}&to=${to}`),
        api(`/reports/daily?from=${from}&to=${to}`),
        api(`/reports/products?from=${from}&to=${to}`),
        api(`/reports/customers?from=${from}&to=${to}`),
        api(`/reports/tax?from=${from}&to=${to}`),
        api('/reports/low-stock')
      ]);
      setSummary(s); setDaily(d); setProducts(p); setCustomers(c); setTax(t); setLow(l);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [from, to]);

  const quickRange = kind => {
    const now = new Date();
    if (kind === 'today') setFrom(todayISO());
    if (kind === 'week') {
      const d = new Date(now); d.setDate(d.getDate() - 6);
      setFrom(d.toISOString().slice(0, 10));
    }
    if (kind === 'month') setFrom(monthStartISO());
    if (kind === '30') { const d = new Date(now); d.setDate(d.getDate() - 30); setFrom(d.toISOString().slice(0, 10)); }
    setTo(todayISO());
  };

  const exportTab = () => {
    const label = `${from}_to_${to}`;
    if (tab === 'daily') {
      downloadCSV(`daily-sales-${label}.csv`,
        ['Date', 'Invoices', 'Revenue', 'Refunds', 'Tax', 'Discount', 'Profit', 'Credit'],
        daily.map(r => [r.date, r.invoices, r.revenue, r.refunds || 0, r.tax, r.discount, r.profit, r.credit]));
    } else if (tab === 'products') {
      downloadCSV(`product-sales-${label}.csv`,
        ['Product', 'Qty Sold', 'Revenue', 'Cost', 'Profit', 'Invoices'],
        products.map(r => [r.name, r.qty, r.revenue, r.cost, r.profit, r.invoices]));
    } else if (tab === 'customers') {
      downloadCSV(`customers-${label}.csv`,
        ['Customer', 'Phone', 'Outstanding', 'Purchases in range', 'Credit Limit', 'Last Visit'],
        customers.map(r => [r.name, r.phone, r.balance, r.purchases, r.credit_limit, r.last_visit]));
    } else if (tab === 'tax') {
      downloadCSV(`tax-${label}.csv`,
        [`${taxLabel} Rate`, 'Taxable Value', split ? 'CGST' : 'Tax', split ? 'SGST' : '-', 'Total Tax'],
        tax.map(r => [`${r.rate}%`, r.taxable, split ? r.cgst : r.tax, split ? r.sgst : '', r.tax]));
    } else if (tab === 'low') {
      downloadCSV('low-stock.csv',
        ['Product', 'Barcode', 'Category', 'Stock', 'Alert At', 'Unit'],
        low.map(r => [r.name, r.barcode, r.category_name, r.stock_qty, r.low_stock, r.unit]));
    } else if (tab === 'summary' && summary) {
      downloadCSV(`sales-summary-${label}.csv`,
        ['Field', 'Value'],
        Object.entries(summary).map(([k, v]) => [k, v]));
    }
  };

  const s = summary || {};
  const margin = s.revenue > 0 ? Math.round((s.profit / s.revenue) * 100) : 0;

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="field mb-0">
          <label className="small">From</label>
          <input className="input" type="date" value={from} onChange={e => setFrom(e.target.value)} />
        </div>
        <div className="field mb-0">
          <label className="small">To</label>
          <input className="input" type="date" value={to} onChange={e => setTo(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', paddingBottom: 2 }}>
          <button className="btn secondary sm" onClick={() => quickRange('today')}>Today</button>
          <button className="btn secondary sm" onClick={() => quickRange('week')}>7 days</button>
          <button className="btn secondary sm" onClick={() => quickRange('month')}>This month</button>
          <button className="btn secondary sm" onClick={() => quickRange('30')}>30 days</button>
        </div>
        <div className="spacer" />
        <button className="btn secondary sm" style={{ marginBottom: 13 }} onClick={exportTab}>⬇ Export CSV</button>
      </div>

      <div className="pill-tabs">
        {TABS.map(t => (
          <button key={t.id} className={`pill ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
        {can(user?.role, 'expenses_view') ? (
          <button className={`pill ${tab === 'expenses' ? 'active' : ''}`} onClick={() => setTab('expenses')}>
            Expenses
          </button>
        ) : null}
      </div>

      {loading ? <div className="muted center" style={{ padding: 24 }}>Loading…</div> : null}

      {tab === 'expenses' && can(user?.role, 'expenses_view') ? <Expenses /> : null}

      {tab === 'summary' && summary ? (
        <>
          <div className="stat-grid">
            <div className="stat blue"><div className="accent" />
              <div className="label">Sales Revenue</div><div className="value">{money(s.revenue, sym)}</div>
              <div className="sub">{s.invoices} invoices · avg {money(s.avg_invoice, sym)}</div></div>
            <div className="stat green"><div className="accent" />
              <div className="label">Profit</div><div className="value">{money(s.profit, sym)}</div>
              <div className="sub">Margin {margin}%</div></div>
            <div className="stat amber"><div className="accent" />
              <div className="label">{taxLabel} Collected</div><div className="value">{money(s.tax, sym)}</div>
              <div className="sub">Taxable value {money(s.taxable_value, sym)}</div></div>
            <div className="stat red"><div className="accent" />
              <div className="label">Credit Given</div><div className="value">{money(s.credit_given, sym)}</div>
              <div className="sub">Outstanding overall {money(s.outstanding_credit, sym)}</div></div>
          </div>

          <div className="card">
            <div className="card-title">Detailed Breakdown</div>
            <div className="row" style={{ gap: 0 }}>
              <div style={{ flex: 1, minWidth: 260 }}>
                {[
                  ['Period', `${dateStr(s.from)} → ${dateStr(s.to)}`],
                  ['Invoices', s.invoices],
                  ['Items sold', num(s.items_sold)],
                  ['Gross revenue', money(s.revenue, sym)],
                  ['Discounts given', money(s.discount, sym)],
                  ['Refunds (returned)', money(s.refunds, sym)],
                  ['Taxable value', money(s.taxable_value, sym)]
                ].map(([k, v]) => (
                  <div className="flex" key={k} style={{ justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid #eef2f7' }}>
                    <span className="muted">{k}</span><b>{v}</b>
                  </div>
                ))}
              </div>
              <div style={{ flex: 1, minWidth: 260 }}>
                {[
                  [`${taxLabel} collected`, money(s.tax, sym)],
                  ['Round off', money(s.round_off, sym)],
                  ['Cost of goods sold', money(s.cost, sym)],
                  ['Profit', money(s.profit, sym)],
                  ['Cash received', money(s.received, sym)],
                  ['Payments collected', money(s.collected, sym)]
                ].map(([k, v]) => (
                  <div className="flex" key={k} style={{ justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid #eef2f7' }}>
                    <span className="muted">{k}</span><b>{v}</b>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      ) : null}

      {tab === 'daily' ? (
        <div className="card">
          <div className="card-title">Day-wise Sales</div>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Date</th><th className="num">Invoices</th><th className="num">Revenue</th>
                <th className="num">Refunds</th><th className="num">Tax</th><th className="num">Discount</th>
                <th className="num">Profit</th><th className="num">Credit</th></tr></thead>
              <tbody>
                {daily.length === 0 ? <tr><td colSpan="8" className="empty">No sales in this period</td></tr>
                  : daily.map(r => (
                    <tr key={r.date}>
                      <td className="bold">{dateStr(r.date)}</td>
                      <td className="num">{r.invoices}</td>
                      <td className="num bold">{money(r.revenue, sym)}</td>
                      <td className="num">{r.refunds > 0
                        ? <span className="badge amber">-{money(r.refunds, sym)}</span>
                        : <span className="muted">—</span>}</td>
                      <td className="num">{money(r.tax, sym)}</td>
                      <td className="num">{money(r.discount, sym)}</td>
                      <td className="num" style={{ color: 'var(--success)' }}>{money(r.profit, sym)}</td>
                      <td className="num">{money(r.credit, sym)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {tab === 'products' ? (
        <div className="card">
          <div className="card-title">Product-wise Sales</div>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Product</th><th className="num">Qty Sold</th><th className="num">Revenue</th>
                <th className="num">Cost</th><th className="num">Profit</th><th className="num">Invoices</th></tr></thead>
              <tbody>
                {products.length === 0 ? <tr><td colSpan="6" className="empty">No sales in this period</td></tr>
                  : products.map(r => (
                    <tr key={r.product_id || r.name}>
                      <td className="bold">{r.name}</td>
                      <td className="num">{num(r.qty)}</td>
                      <td className="num">{money(r.revenue, sym)}</td>
                      <td className="num muted">{money(r.cost, sym)}</td>
                      <td className="num" style={{ color: r.profit >= 0 ? 'var(--success)' : 'var(--danger)' }}>{money(r.profit, sym)}</td>
                      <td className="num">{r.invoices}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {tab === 'customers' ? (
        <div className="card">
          <div className="card-title">Customer Credit Report</div>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Customer</th><th>Phone</th><th className="num">Outstanding</th>
                <th className="num">Purchases in range</th><th className="num">Credit Limit</th><th>Last Visit</th></tr></thead>
              <tbody>
                {customers.length === 0 ? <tr><td colSpan="6" className="empty">No customer activity</td></tr>
                  : customers.map(r => (
                    <tr key={r.id}>
                      <td className="bold">{r.name}</td>
                      <td>{r.phone || '—'}</td>
                      <td className="num">{r.balance > 0 ? <span className="badge red">{money(r.balance, sym)}</span> : <span className="badge green">settled</span>}</td>
                      <td className="num">{money(r.purchases, sym)}</td>
                      <td className="num">{r.credit_limit > 0 ? money(r.credit_limit, sym) : '—'}</td>
                      <td className="small">{r.last_visit ? dateStr(r.last_visit) : '—'}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {tab === 'tax' ? (
        <div className="card">
          <div className="card-title">{taxLabel} Summary {split ? '(CGST + SGST split)' : ''}</div>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Rate</th><th className="num">Taxable Value</th>
                {split ? <><th className="num">CGST</th><th className="num">SGST</th></> : <th className="num">Tax</th>}
                <th className="num">Total Tax</th></tr></thead>
              <tbody>
                {tax.length === 0 ? <tr><td colSpan="4" className="empty">No taxable sales in this period</td></tr>
                  : tax.map(r => (
                    <tr key={r.rate}>
                      <td className="bold">{r.rate}%</td>
                      <td className="num">{money(r.taxable, sym)}</td>
                      {split
                        ? <><td className="num">{money(r.cgst, sym)}</td><td className="num">{money(r.sgst, sym)}</td></>
                        : <td className="num">{money(r.tax, sym)}</td>}
                      <td className="num bold">{money(r.tax, sym)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <div className="alert info mt-14">
            File {taxLabel} returns using these figures for the selected period.
          </div>
        </div>
      ) : null}

      {tab === 'low' ? (
        <div className="card">
          <div className="card-title">Low Stock Report</div>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Product</th><th>Barcode</th><th>Category</th>
                <th className="num">Stock</th><th className="num">Alert At</th><th className="num">Buy Value</th></tr></thead>
              <tbody>
                {low.length === 0 ? <tr><td colSpan="6" className="empty">All products are properly stocked 🎉</td></tr>
                  : low.map(r => (
                    <tr key={r.id}>
                      <td className="bold">{r.name}</td>
                      <td className="small">{r.barcode || '—'}</td>
                      <td>{r.category_name || '—'}</td>
                      <td className="num"><span className="badge red">{num(r.stock_qty)} {r.unit}</span></td>
                      <td className="num">{num(r.low_stock)}</td>
                      <td className="num">{money(r.stock_qty * r.cost_price, sym)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </>
  );
}
