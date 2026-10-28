import React, { useEffect, useMemo, useState } from 'react';
import { api, downloadCSV } from '../api.js';
import { useApp } from '../store.jsx';
import { money, num, dateStr, todayISO, monthStartISO } from '../format.js';
import { can } from '../rbac.js';
import Modal from '../components/Modal.jsx';

// ---------- Expenses (kharcha) ----------
// The shop's running costs: rent, salaries, utilities, transport…
// Head records and edits; everyone else only if the Head granted access.

const CATEGORIES = ['Rent', 'Salaries', 'Utilities', 'Transport', 'Packaging', 'Repairs', 'Marketing', 'Cleaning', 'Other'];
const METHODS = ['cash', 'card', 'mobile', 'bank'];

export default function Expenses() {
  const { user, settings, toast } = useApp();
  const sym = settings.currency_symbol || 'Rs';
  const canManage = can(user?.role, 'expenses_manage');

  const [rows, setRows] = useState([]);
  const [from, setFrom] = useState(monthStartISO());
  const [to, setTo] = useState(todayISO());
  const [category, setCategory] = useState('');
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (category) params.set('category', category);
    setRows(await api(`/expenses?${params.toString()}`));
  };

  useEffect(() => {
    load().catch(e => toast(e.message, 'error'));
  }, [from, to, category]);

  const summary = useMemo(() => {
    const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
    const byCat = {};
    for (const r of rows) {
      byCat[r.category] = (byCat[r.category] || 0) + Number(r.amount || 0);
    }
    const top = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0];
    return { total, byCat, top, count: rows.length };
  }, [rows]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form) return;
    if (!(Number(form.amount) > 0)) return toast('Amount must be greater than 0', 'warning');
    setBusy(true);
    try {
      if (form.id) {
        await api(`/expenses/${form.id}`, { method: 'PUT', body: form });
        toast('Expense updated', 'success');
      } else {
        await api('/expenses', { method: 'POST', body: form });
        toast('Expense recorded', 'success');
      }
      setForm(null);
      load();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async row => {
    if (!window.confirm(`Delete this ${money(row.amount, sym)} expense (${row.category})?`)) return;
    try {
      await api(`/expenses/${row.id}`, { method: 'DELETE' });
      toast('Expense deleted', 'success');
      load();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const exportCsv = () => {
    downloadCSV(
      `expenses-${from || 'all'}.csv`,
      ['Date', 'Category', 'Amount', 'Method', 'Note', 'Entered by'],
      rows.map(r => [r.expense_date, r.category, r.amount, r.payment_method, r.note, r.created_by_name])
    );
  };

  return (
    <div>
      <div className="flex" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div className="card-title" style={{ margin: 0 }}>Expenses (kharcha)</div>
        <div className="flex" style={{ gap: 8 }}>
          <button className="btn secondary sm" onClick={exportCsv} disabled={rows.length === 0}>⬇ CSV</button>
          {canManage ? (
            <button
              className="btn sm"
              onClick={() => setForm({ expense_date: todayISO(), category: 'General', amount: '', payment_method: 'cash', note: '' })}
            >＋ Add Expense</button>
          ) : null}
        </div>
      </div>

      {/* period + category filters */}
      <div className="card mt-14" style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="field mb-0">
          <label>From</label>
          <input className="input" type="date" value={from} onChange={e => setFrom(e.target.value)} />
        </div>
        <div className="field mb-0">
          <label>To</label>
          <input className="input" type="date" value={to} onChange={e => setTo(e.target.value)} />
        </div>
        <div className="field mb-0">
          <label>Category</label>
          <select className="input" value={category} onChange={e => setCategory(e.target.value)}>
            <option value="">All categories</option>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <button className="btn ghost sm" onClick={() => { setFrom(monthStartISO()); setTo(todayISO()); setCategory(''); }}>
          This month
        </button>
      </div>

      {/* summary cards */}
      <div className="stat-grid mt-14">
        <div className="card stat">
          <div className="label">Spent in period</div>
          <div className="value" style={{ color: 'var(--danger)' }}>{money(summary.total, sym)}</div>
          <div className="sub">{summary.count} entr{summary.count === 1 ? 'y' : 'ies'}</div>
        </div>
        <div className="card stat">
          <div className="label">Biggest category</div>
          <div className="value" style={{ fontSize: 20 }}>{summary.top ? summary.top[0] : '—'}</div>
          <div className="sub">{summary.top ? money(summary.top[1], sym) : 'no expenses yet'}</div>
        </div>
        <div className="card stat">
          <div className="label">Average per day</div>
          <div className="value">
            {money(from && to ? Math.round(summary.total / Math.max(1, daysBetween(from, to))) : summary.total, sym)}
          </div>
          <div className="sub">{from && to ? `${daysBetween(from, to)} day(s) in range` : 'pick a range'}</div>
        </div>
      </div>

      {/* table */}
      <div className="card mt-14">
        <table className="tbl">
          <thead>
            <tr>
              <th>Date</th><th>Category</th><th style={{ textAlign: 'right' }}>Amount</th>
              <th>Method</th><th>Note</th><th>Entered by</th>{canManage ? <th style={{ textAlign: 'right' }}>Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td className="empty" colSpan={canManage ? 7 : 6}>No expenses in this period</td></tr>
            ) : rows.map(r => (
              <tr key={r.id}>
                <td>{dateStr(r.expense_date)}</td>
                <td><span className="badge">{r.category}</span></td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>{money(r.amount, sym)}</td>
                <td>{r.payment_method}</td>
                <td className="muted">{r.note || '—'}</td>
                <td className="muted">{r.created_by_name || '—'}</td>
                {canManage ? (
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn ghost xs" onClick={() => setForm({ ...r })}>Edit</button>{' '}
                    <button className="btn danger xs" onClick={() => remove(r)}>Delete</button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* add / edit modal */}
      {form ? (
        <Modal
          title={form.id ? 'Edit Expense' : 'Add Expense'}
          onClose={() => setForm(null)}
          footer={
            <>
              <button className="btn secondary" onClick={() => setForm(null)}>Cancel</button>
              <button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            </>
          }
        >
          <div className="field">
            <label>Date</label>
            <input className="input" type="date" value={form.expense_date} onChange={e => set('expense_date', e.target.value)} />
          </div>
          <div className="field">
            <label>Category</label>
            <input className="input" list="exp-cats" value={form.category} onChange={e => set('category', e.target.value)} />
            <datalist id="exp-cats">
              {CATEGORIES.map(c => <option key={c} value={c} />)}
            </datalist>
          </div>
          <div className="field">
            <label>Amount ({sym})</label>
            <input className="input" type="number" min="0" step="0.01" autoFocus
              value={form.amount} onChange={e => set('amount', e.target.value)} placeholder="0" />
          </div>
          <div className="field">
            <label>Paid by</label>
            <select className="input" value={form.payment_method} onChange={e => set('payment_method', e.target.value)}>
              {METHODS.map(m => <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Note</label>
            <input className="input" value={form.note} onChange={e => set('note', e.target.value)}
              placeholder="e.g. August rent, electricity bill" />
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function daysBetween(a, b) {
  const ms = new Date(b) - new Date(a);
  return Math.max(1, Math.round(ms / 86400000) + 1);
}
