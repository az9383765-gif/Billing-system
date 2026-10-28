import React, { useEffect, useState } from 'react';
import { api, downloadFile } from '../api.js';
import { useApp } from '../store.jsx';
import { money, num, dateStr, timeStr, todayISO, monthStartISO } from '../format.js';
import { can } from '../rbac.js';
import Modal from '../components/Modal.jsx';
import { printHTML, receiptHTML, invoiceA4HTML } from '../print.js';
import { printRefund } from '../refund-print.js';

export default function Invoices() {
  const { user, settings, toast } = useApp();
  const canVoid = can(user?.role, 'invoices_void');
  const canReturn = can(user?.role, 'returns');
  const canExport = can(user?.role, 'invoices_export');
  const sym = settings.currency_symbol || 'Rs';
  const taxLabel = settings.tax_label || 'Tax';
  const split = settings.tax_split === '1';

  const [rows, setRows] = useState([]);
  const [from, setFrom] = useState(monthStartISO());
  const [to, setTo] = useState(todayISO());
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [showVoided, setShowVoided] = useState(false);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);
  // return (refund) flow
  const [returnOpen, setReturnOpen] = useState(false);
  const [retQty, setRetQty] = useState({});
  const [retReason, setRetReason] = useState('');
  const [refund, setRefund] = useState(null); // finished credit note — ready to print

  const load = async () => {
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (status) p.set('status', status);
    if (search.trim()) p.set('search', search.trim());
    p.set('voided', showVoided ? '1' : '0');
    p.set('limit', '500');
    setRows(await api(`/invoices?${p.toString()}`));
  };

  useEffect(() => {
    const t = setTimeout(() => load().catch(e => toast(e.message, 'error')), 200);
    return () => clearTimeout(t);
  }, [from, to, status, search, showVoided]);

  const open = async inv => {
    try {
      setDetail(await api(`/invoices/${inv.id}`));
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const print = mode => {
    const d = detail;
    if (mode === 'a4') {
      printHTML(invoiceA4HTML({ ...d, symbol: sym, taxLabel, split }), { page: 'A4' });
    } else {
      printHTML(
        receiptHTML({ ...d, symbol: sym, taxLabel, split, width: settings.receipt_width || '80' }),
        { page: `${settings.receipt_width === '58' ? 48 : 72}mm auto` }
      );
    }
  };

  const voidInvoice = async () => {
    const inv = detail.invoice;
    if (!window.confirm(`Void invoice ${inv.invoice_no}? Stock will be restored and credit reversed.`)) return;
    setBusy(true);
    try {
      await api(`/invoices/${inv.id}/void`, { method: 'POST' });
      toast(`${inv.invoice_no} voided`, 'success');
      setDetail(null);
      load();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  // how many of this line can still be returned
  const returnable = it => Math.max(0, Math.round((it.qty - (it.returned_qty || 0) + Number.EPSILON) * 100) / 100);

  const openReturn = () => {
    setRetQty({});
    setRetReason('');
    setReturnOpen(true);
  };

  const submitReturn = async () => {
    const items = detail.items
      .map(it => ({ invoice_item_id: it.id, qty: Number(retQty[it.id] || 0) }))
      .filter(x => Number.isFinite(x.qty) && x.qty > 0);
    if (items.length === 0) {
      toast('Enter a quantity to return', 'error');
      return;
    }
    setBusy(true);
    try {
      const r = await api('/returns', {
        method: 'POST',
        body: { invoice_id: detail.invoice.id, items, reason: retReason }
      });
      const note = await api(`/returns/${r.return.id}`);
      setRefund(note);
      setReturnOpen(false);
      toast(`Return ${r.return.return_no} saved — refunded ${money(r.return.total, sym)}`, 'success');
      setDetail(await api(`/invoices/${detail.invoice.id}`));
      load();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const showRefundNote = async id => {
    try {
      setRefund(await api(`/returns/${id}`));
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const totals = rows.reduce((s, r) => (r.voided ? s : s + r.total), 0);
  const dueTotal = rows.reduce((s, r) => (r.voided ? s : s + r.due_amount), 0);

  const statusBadge = inv => {
    if (inv.voided) return <span className="badge gray">VOID</span>;
    if (inv.status === 'paid') return <span className="badge green">PAID</span>;
    if (inv.status === 'partial') return <span className="badge amber">PARTIAL</span>;
    return <span className="badge red">CREDIT</span>;
  };

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
        <div className="field mb-0">
          <label className="small">Status</label>
          <select className="input" value={status} onChange={e => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="paid">Paid</option>
            <option value="partial">Partial</option>
            <option value="credit">Credit</option>
          </select>
        </div>
        <div className="field mb-0" style={{ flex: 1, minWidth: 180 }}>
          <label className="small">Search</label>
          <input className="input" placeholder="Invoice no / customer / phone" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="field mb-0">
          <label className="small">Voided</label>
          <label className="checkbox" style={{ height: 38 }}>
            <input type="checkbox" checked={showVoided} onChange={e => setShowVoided(e.target.checked)} /> show voided
          </label>
        </div>
        <div className="spacer" />
        {canExport ? (
          <button className="btn secondary sm" style={{ marginTop: 18 }}
            onClick={() => downloadFile(`/invoices/export?from=${from}&to=${to}`, 'invoices.csv')}>
            ⬇ CSV
          </button>
        ) : null}
      </div>

      <div className="row" style={{ marginBottom: 14 }}>
        <span className="badge blue">{rows.length} invoices</span>
        <span className="badge green">Total {money(totals, sym)}</span>
        <span className="badge red">Due {money(dueTotal, sym)}</span>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Invoice</th><th>Date</th><th>Customer</th><th className="num">Items</th>
                <th className="num">Total</th><th className="num">Paid</th><th className="num">Due</th>
                <th>Method</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan="9" className="empty">No invoices in this period</td></tr>
              ) : rows.map(inv => (
                <tr key={inv.id} className="clickable" onClick={() => open(inv)}>
                  <td className="bold">{inv.invoice_no}</td>
                  <td>{dateStr(inv.sale_date)} <span className="muted small">{timeStr(inv.datetime)}</span></td>
                  <td>{inv.customer_name || 'Walk-in'}</td>
                  <td className="num">{inv.item_count}</td>
                  <td className="num bold">
                    {money(inv.total, sym)}
                    {inv.returned_total > 0 ? (
                      <span className="badge amber" style={{ marginLeft: 6 }} title="Returned (credit notes)">
                        ↩ {money(inv.returned_total, sym)}
                      </span>
                    ) : null}
                  </td>
                  <td className="num">{money(inv.paid_amount, sym)}</td>
                  <td className="num">{inv.due_amount > 0 ? <b style={{ color: 'var(--danger)' }}>{money(inv.due_amount, sym)}</b> : '—'}</td>
                  <td className="small">{inv.payment_method}</td>
                  <td>{statusBadge(inv)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {detail ? (
        <Modal title={`Invoice ${detail.invoice.invoice_no}`} onClose={() => setDetail(null)} size="full"
          footer={
            <>
              {detail.invoice.voided ? <span className="badge gray" style={{ marginRight: 'auto' }}>VOIDED</span> : (
                canVoid ? (
                  <button className="btn danger" style={{ marginRight: 'auto' }} onClick={voidInvoice} disabled={busy}
                    title={detail.returns?.length ? 'This invoice has returns and cannot be voided' : 'Cancel this bill'}>
                    Void Invoice
                  </button>
                ) : <div className="spacer" />
              )}
              {canReturn && !detail.invoice.voided && detail.items.some(it => returnable(it) > 0) ? (
                <button className="btn secondary" onClick={openReturn} disabled={busy} title="Refund items against this bill">
                  ↩ Return
                </button>
              ) : null}
              <button className="btn secondary" onClick={() => print('thermal')}>🖨 Receipt</button>
              <button className="btn secondary" onClick={() => print('a4')}>🖨 A4 Invoice</button>
              <button className="btn" onClick={() => setDetail(null)}>Close</button>
            </>
          }>
          <div className="row" style={{ gap: 18 }}>
            <div style={{ flex: 1, minWidth: 250 }}>
              <div className="card-title">Customer</div>
              <div className="bold">{detail.customer?.name || 'Walk-in Customer'}</div>
              {detail.customer?.phone ? <div className="small muted">{detail.customer.phone}</div> : null}
              {detail.customer?.address ? <div className="small muted">{detail.customer.address}</div> : null}
              <div className="card-title mt-20">Invoice Info</div>
              <div className="flex" style={{ justifyContent: 'space-between' }}><span className="muted">Date</span><span>{dateStr(detail.invoice.datetime)} {timeStr(detail.invoice.datetime)}</span></div>
              <div className="flex" style={{ justifyContent: 'space-between' }}><span className="muted">Method</span><span>{detail.invoice.payment_method}</span></div>
              <div className="flex" style={{ justifyContent: 'space-between' }}><span className="muted">Status</span>{statusBadge(detail.invoice)}</div>

              {detail.returns?.length ? (
                <div className="mt-20">
                  <div className="card-title">Returns (credit notes)</div>
                  <div className="stack" style={{ gap: 6 }}>
                    {detail.returns.map(r => (
                      <div key={r.id} className="flex" style={{ justifyContent: 'space-between', fontSize: 13 }}>
                        <span>{r.return_no} <span className="muted small">{dateStr(r.datetime)}</span></span>
                        <span className="flex" style={{ gap: 8, alignItems: 'center' }}>
                          <b>-{money(r.total, sym)}</b>
                          <button className="btn secondary xs" onClick={() => showRefundNote(r.id)} title="Print credit note">🖨</button>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            <div style={{ flex: 2, minWidth: 320 }}>
              <div className="card-title">Items</div>
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr><th>Item</th><th className="num">Qty</th><th className="num">Rate</th>
                      <th className="num">{taxLabel}</th><th className="num">Total</th><th className="num">Returned</th></tr>
                  </thead>
                  <tbody>
                    {detail.items.map(it => (
                      <tr key={it.id}>
                        <td>
                          <div>{it.name}</div>
                          {it.tax_rate > 0 ? <div className="muted small">{it.tax_rate}% {it.tax_rate > 0 ? '(included in rate)' : ''}</div> : null}
                        </td>
                        <td className="num">{num(it.qty)} {it.unit}</td>
                        <td className="num">{money(it.unit_price, sym)}</td>
                        <td className="num">{money(it.tax_amount, sym)}</td>
                        <td className="num bold">{money(it.line_total, sym)}</td>
                        <td className="num">{it.returned_qty > 0
                          ? <span className="badge amber" title={`${money(it.returned_amount, sym)} refunded`}>{num(it.returned_qty)} ret</span>
                          : <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="totals" style={{ maxWidth: 320, marginLeft: 'auto' }}>
                <div className="t-row"><span>Subtotal</span><span>{money(detail.invoice.subtotal, sym)}</span></div>
                {detail.invoice.discount > 0 ? <div className="t-row"><span>Discount</span><span>-{money(detail.invoice.discount, sym)}</span></div> : null}
                <div className="t-row"><span>{taxLabel}</span><span>{money(detail.invoice.tax_total, sym)}</span></div>
                {detail.invoice.round_off ? <div className="t-row"><span>Round off</span><span>{money(detail.invoice.round_off, sym)}</span></div> : null}
                <div className="t-row grand"><span>Total</span><span>{money(detail.invoice.total, sym)}</span></div>
                {detail.returns?.length ? (
                  <div className="t-row" style={{ color: 'var(--warning)' }}>
                    <span>Returned</span>
                    <span>-{money(detail.returns.reduce((s, r) => s + r.total, 0), sym)}</span>
                  </div>
                ) : null}
                <div className="t-row"><span>Paid</span><span>{money(detail.invoice.paid_amount, sym)}</span></div>
                <div className="t-row"><span><b>Balance Due</b></span><span><b>{money(detail.invoice.due_amount, sym)}</b></span></div>
              </div>
            </div>
          </div>
        </Modal>
      ) : null}

      {returnOpen && detail ? (
        <Modal title={`Return against ${detail.invoice.invoice_no}`} onClose={() => setReturnOpen(false)} size="full"
          footer={
            <>
              <span className="muted small" style={{ marginRight: 'auto' }}>
                Refund = taxable value + {taxLabel} of the returned goods
              </span>
              <button className="btn secondary" onClick={() => setReturnOpen(false)}>Cancel</button>
              <button className="btn" onClick={submitReturn} disabled={busy}>Save Return &amp; Refund</button>
            </>
          }>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Item</th><th className="num">Sold</th><th className="num">Returned</th>
                  <th className="num">Returnable</th><th className="num">Return qty</th></tr>
              </thead>
              <tbody>
                {detail.items.map(it => {
                  const max = returnable(it);
                  return (
                    <tr key={it.id}>
                      <td>
                        <div className="bold">{it.name}</div>
                        <div className="muted small">{money(it.line_total, sym)} for {num(it.qty)} {it.unit} · {money(it.unit_price, sym)}/{it.unit}</div>
                      </td>
                      <td className="num">{num(it.qty)}</td>
                      <td className="num">{it.returned_qty > 0 ? <span className="badge amber">{num(it.returned_qty)}</span> : '—'}</td>
                      <td className="num">{max > 0 ? num(max) : <span className="badge gray">none</span>}</td>
                      <td className="num">
                        <input
                          className="input" type="number" min="0" max={max} step="1"
                          style={{ width: 84, textAlign: 'right' }}
                          disabled={max <= 0}
                          placeholder="0"
                          value={retQty[it.id] ?? ''}
                          onChange={e => {
                            const raw = e.target.value;
                            if (raw === '') {
                              setRetQty(q => ({ ...q, [it.id]: '' }));
                              return;
                            }
                            const v = Number(raw);
                            setRetQty(q => ({ ...q, [it.id]: Math.min(Math.max(v, 0), max) }));
                          }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="field mt-14">
            <label>Reason</label>
            <input className="input" placeholder="e.g. Customer bought the wrong size"
              value={retReason} onChange={e => setRetReason(e.target.value)} />
          </div>
          <div className="hint">
            Stock goes back automatically, the customer's outstanding credit is cleared first and any
            remainder is paid back in cash. {taxLabel} on these items is reversed in the reports.
          </div>
        </Modal>
      ) : null}

      {refund ? (
        <Modal title={`Credit Note ${refund.return.return_no}`} onClose={() => setRefund(null)}
          footer={
            <>
              <span className="badge green" style={{ marginRight: 'auto' }}>Refund saved</span>
              <button className="btn secondary" onClick={() => printRefund(refund, { width: settings.receipt_width || '80' })}>
                🖨 Print Credit Note
              </button>
              <button className="btn" onClick={() => setRefund(null)}>Close</button>
            </>
          }>
          <div className="muted small" style={{ textAlign: 'center', marginBottom: 10 }}>
            {refund.items.map(i => `${i.name} × ${num(i.qty)}`).join(' · ')}
          </div>
          <div className="totals" style={{ maxWidth: 340, margin: '0 auto' }}>
            <div className="t-row"><span>Against bill</span><span>{refund.invoice?.invoice_no || '—'}</span></div>
            <div className="t-row"><span>Date</span><span>{dateStr(refund.return.datetime)} {timeStr(refund.return.datetime)}</span></div>
            <div className="t-row"><span>Taxable value</span><span>{money(refund.return.subtotal, sym)}</span></div>
            <div className="t-row"><span>{taxLabel}</span><span>{money(refund.return.tax_total, sym)}</span></div>
            <div className="t-row grand"><span>Refund Total</span><span>{money(refund.return.total, sym)}</span></div>
            {refund.return.cash_refund > 0 ? (
              <div className="t-row"><span>Cash refunded</span><span>{money(refund.return.cash_refund, sym)}</span></div>
            ) : null}
            {refund.return.credit_adjust > 0 ? (
              <div className="t-row"><span>Credit adjusted</span><span>{money(refund.return.credit_adjust, sym)}</span></div>
            ) : null}
          </div>
          {refund.return.reason ? (
            <div className="hint" style={{ textAlign: 'center' }}>Reason: {refund.return.reason}</div>
          ) : null}
        </Modal>
      ) : null}
    </>
  );
}
