import React, { useEffect, useState } from 'react';
import { api, downloadFile } from '../api.js';
import { useApp } from '../store.jsx';
import { money, num, dateStr, timeStr } from '../format.js';
import { can } from '../rbac.js';
import Modal from '../components/Modal.jsx';

const EMPTY = { name: '', phone: '', address: '', gstin: '', credit_limit: '', notes: '' };

export default function Customers() {
  const { user, settings, toast } = useApp();
  const canDelete = can(user?.role, 'customers_delete');
  const sym = settings.currency_symbol || 'Rs';
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [statement, setStatement] = useState(null); // { customer, entries, invoices, payments }
  const [payAmount, setPayAmount] = useState('');
  const [payNote, setPayNote] = useState('');

  const load = async () => {
    setRows(await api(`/customers?search=${encodeURIComponent(search.trim())}`));
  };

  useEffect(() => {
    const t = setTimeout(() => load().catch(e => toast(e.message, 'error')), 200);
    return () => clearTimeout(t);
  }, [search]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.name.trim()) return toast('Customer name is required', 'warning');
    setBusy(true);
    try {
      if (form.id) {
        await api(`/customers/${form.id}`, { method: 'PUT', body: form });
        toast('Customer updated', 'success');
      } else {
        await api('/customers', { method: 'POST', body: form });
        toast('Customer added', 'success');
      }
      setForm(null);
      load();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async c => {
    if (!window.confirm(`Delete customer "${c.name}"?`)) return;
    try {
      await api(`/customers/${c.id}`, { method: 'DELETE' });
      toast('Customer deleted', 'success');
      load();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const openStatement = async c => {
    try {
      const data = await api(`/customers/${c.id}/statement`);
      setStatement(data);
      setPayAmount('');
      setPayNote('');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const collectPayment = async () => {
    const amount = Number(payAmount);
    if (!amount || amount <= 0) return toast('Enter an amount', 'warning');
    setBusy(true);
    try {
      const r = await api(`/customers/${statement.customer.id}/payments`, {
        method: 'POST',
        body: { amount, method: 'cash', note: payNote }
      });
      toast(`Payment recorded — balance ${money(r.balance, sym)}`, 'success');
      const data = await api(`/customers/${statement.customer.id}/statement`);
      setStatement(data);
      setPayAmount('');
      setPayNote('');
      load();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const outstanding = rows.reduce((s, c) => s + (c.balance || 0), 0);

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="search-box" style={{ flex: 1, minWidth: 220 }}>
          <span className="s-icon">⌕</span>
          <input className="input" placeholder="Search name or phone…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="sync-badge" title="Total credit outstanding">
          Total Udhaar: <b style={{ color: 'var(--danger)' }}>{money(outstanding, sym)}</b>
        </div>
        <div className="spacer" />
        <button className="btn secondary sm" onClick={() => downloadFile('/customers/export', 'customers.csv')}>⬇ CSV</button>
        <button className="btn" onClick={() => setForm({ ...EMPTY })}>＋ Add Customer</button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Customer</th><th>Phone</th><th>Address</th>
                <th className="num">Credit Limit</th><th className="num">Outstanding</th>
                {settings.loyalty_enabled !== '0' ? <th className="num">⭐ Pts</th> : null}
                <th style={{ width: 260 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={settings.loyalty_enabled !== '0' ? 7 : 6} className="empty">No customers yet. Add customers to give credit (udhaar).</td></tr>
              ) : rows.map(c => (
                <tr key={c.id}>
                  <td>
                    <div className="bold">{c.name}</div>
                    {c.gstin ? <div className="muted small">GSTIN: {c.gstin}</div> : null}
                  </td>
                  <td>{c.phone || '—'}</td>
                  <td className="small muted">{c.address || '—'}</td>
                  <td className="num">{c.credit_limit > 0 ? money(c.credit_limit, sym) : '—'}</td>
                  <td className="num">
                    {c.balance > 0
                      ? <span className="badge red">{money(c.balance, sym)}</span>
                      : c.balance < 0 ? <span className="badge blue">advance {money(-c.balance, sym)}</span>
                      : <span className="badge green">settled</span>}
                  </td>
                  {settings.loyalty_enabled !== '0' ? (
                    <td className="num">
                      {c.loyalty_points > 0
                        ? <b title="Loyalty points">⭐ {num(c.loyalty_points, 0)}</b>
                        : <span className="muted">—</span>}
                    </td>
                  ) : null}
                  <td>
                    <div className="flex" style={{ gap: 6 }}>
                      <button className="btn secondary xs" onClick={() => openStatement(c)}>Statement</button>
                      <button className="btn secondary xs" onClick={() => setForm({ ...c, credit_limit: c.credit_limit || '' })}>Edit</button>
                      {canDelete ? <button className="btn danger xs" onClick={() => remove(c)}>Delete</button> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {form ? (
        <Modal title={form.id ? 'Edit Customer' : 'Add Customer'} onClose={() => setForm(null)}
          footer={
            <>
              <button className="btn secondary" onClick={() => setForm(null)}>Cancel</button>
              <button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            </>
          }>
          <div className="form-2">
            <div className="field">
              <label>Name *</label>
              <input className="input" autoFocus value={form.name} onChange={e => set('name', e.target.value)} />
            </div>
            <div className="field">
              <label>Phone</label>
              <input className="input" value={form.phone} onChange={e => set('phone', e.target.value)} />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Address</label>
              <input className="input" value={form.address} onChange={e => set('address', e.target.value)} />
            </div>
            <div className="field">
              <label>GSTIN (optional)</label>
              <input className="input" value={form.gstin} onChange={e => set('gstin', e.target.value)} />
            </div>
            <div className="field">
              <label>Credit limit ({sym})</label>
              <input className="input" type="number" min="0" value={form.credit_limit} onChange={e => set('credit_limit', e.target.value)} />
              <span className="hint">0 = no limit. Sales beyond this are blocked.</span>
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Notes</label>
              <textarea className="input" value={form.notes} onChange={e => set('notes', e.target.value)} />
            </div>
          </div>
        </Modal>
      ) : null}

      {statement ? (
        <Modal title={`Statement — ${statement.customer.name}`} onClose={() => setStatement(null)} size="full"
          footer={<button className="btn secondary" onClick={() => setStatement(null)}>Close</button>}>
          <div className="stat-grid">
            <div className={`stat ${statement.customer.balance > 0 ? 'red' : 'green'}`}>
              <div className="accent" />
              <div className="label">Current Balance</div>
              <div className="value">{money(statement.customer.balance, sym)}</div>
              <div className="sub">{statement.customer.balance > 0 ? 'Amount to collect' : 'Nothing due'}</div>
            </div>
            <div className="stat blue">
              <div className="accent" />
              <div className="label">Credit Limit</div>
              <div className="value">{statement.customer.credit_limit > 0 ? money(statement.customer.credit_limit, sym) : 'No limit'}</div>
              <div className="sub">Total invoices: {statement.invoices.length}</div>
            </div>
            <div className="stat amber">
              <div className="accent" />
              <div className="label">Collect Payment</div>
              <div className="flex mt-8" style={{ gap: 8 }}>
                <input className="input" type="number" min="0" placeholder="Amount" value={payAmount}
                  onChange={e => setPayAmount(e.target.value)} />
                <button className="btn success sm" onClick={collectPayment} disabled={busy}>Receive</button>
              </div>
              <div className="sub">Cash received reduces the balance</div>
            </div>
          </div>

          <div className="row" style={{ gap: 18 }}>
            <div style={{ flex: 1, minWidth: 320 }}>
              <div className="card-title">Ledger</div>
              <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
                <table className="tbl">
                  <thead><tr><th>Date</th><th>Details</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr></thead>
                  <tbody>
                    {statement.entries.length === 0 ? (
                      <tr><td colSpan="5" className="empty">No credit activity</td></tr>
                    ) : statement.entries.map(e => (
                      <tr key={e.id}>
                        <td className="small">{dateStr(e.datetime)}</td>
                        <td className="small">{e.note}</td>
                        <td className="num">{e.debit > 0 ? money(e.debit, sym) : '—'}</td>
                        <td className="num">{e.credit > 0 ? money(e.credit, sym) : '—'}</td>
                        <td className="num bold">{money(e.balance_after, sym)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div style={{ flex: 1, minWidth: 320 }}>
              <div className="card-title">Invoices</div>
              <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
                <table className="tbl">
                  <thead><tr><th>Invoice</th><th>Date</th><th className="num">Total</th><th className="num">Due</th><th>Status</th></tr></thead>
                  <tbody>
                    {statement.invoices.length === 0 ? (
                      <tr><td colSpan="5" className="empty">No invoices</td></tr>
                    ) : statement.invoices.map(i => (
                      <tr key={i.id}>
                        <td className="bold small">{i.invoice_no}</td>
                        <td className="small">{dateStr(i.sale_date)}</td>
                        <td className="num">{money(i.total, sym)}</td>
                        <td className="num">{i.due_amount > 0 ? <b>{money(i.due_amount, sym)}</b> : '—'}</td>
                        <td>{i.voided ? <span className="badge gray">VOID</span>
                          : i.status === 'paid' ? <span className="badge green">PAID</span>
                          : i.status === 'partial' ? <span className="badge amber">PARTIAL</span>
                          : <span className="badge red">CREDIT</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="card-title mt-20">Payments Received</div>
              <div className="table-wrap" style={{ maxHeight: 190, overflowY: 'auto' }}>
                <table className="tbl">
                  <thead><tr><th>Date</th><th className="num">Amount</th><th>Method</th><th>Note</th></tr></thead>
                  <tbody>
                    {statement.payments.length === 0 ? (
                      <tr><td colSpan="4" className="empty">No payments</td></tr>
                    ) : statement.payments.map(p => (
                      <tr key={p.id}>
                        <td className="small">{dateStr(p.pay_date)} {timeStr(p.datetime)}</td>
                        <td className="num bold">{money(p.amount, sym)}</td>
                        <td>{p.method}</td>
                        <td className="small muted">{p.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
