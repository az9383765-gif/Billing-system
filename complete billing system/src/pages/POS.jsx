import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { money, num } from '../format.js';
import { invoiceCalc, round2 as r2, discountFromPercent } from '../../shared/calc.js';
import Modal from '../components/Modal.jsx';
import { printHTML, receiptHTML, invoiceA4HTML } from '../print.js';

const todayStr = () => new Date().toISOString().slice(0, 10);
const daysLeft = iso => Math.ceil((new Date(iso + 'T00:00:00Z') - new Date(todayStr() + 'T00:00:00Z')) / 86400000);

// Exactly the same GST engine the server bills with (shared/calc.js) —
// so the total on screen, the total stored and the total printed never drift.
// discountMode 'percent' converts the typed % into rupees on the pre-discount
// bill, then the engine takes it exactly like a rupee discount.
// extra = loyalty rupees + coupon rupees; they join the manual discount and go
// through the SAME engine call, so one number can never disagree with another.
function computeTotals(cart, discount, roundOffEnabled, discountMode = 'amount', extra = null) {
  const items = cart.map(i => ({
    qty: i.qty,
    unit_price: i.price,
    tax_rate: i.tax_rate,
    tax_inclusive: i.tax_inclusive,
    discount: i.discount || 0
  }));
  const preGross = invoiceCalc({ items, discount: 0, round_off: false }).grossTotal; // before any bill-level discount
  let amount = discount;
  if (discountMode === 'percent') {
    amount = discountFromPercent(preGross, discount);
  }
  const manualDiscount = r2(Math.max(0, Number(amount) || 0));
  const loyaltyRupees = r2(Math.max(0, Number(extra?.loyalty || 0)));
  const couponRupees = r2(Math.max(0, Number(extra?.coupon || 0)));
  const combined = r2(manualDiscount + loyaltyRupees + couponRupees);
  const calc = invoiceCalc({
    items,
    discount: combined,
    round_off: roundOffEnabled
  });
  const lines = cart.map((c, i) => ({
    ...c,
    ...calc.lines[i],
    lineTotal: calc.lines[i].total_after_discount
  }));
  return {
    lines,
    subtotal: calc.subtotal,
    taxTotal: calc.taxTotal,
    discount: calc.discount, // everything the engine took off (manual + loyalty + coupon)
    manualDiscount,
    loyaltyRupees,
    couponRupees,
    grossTotal: preGross,    // the bill before any bill-level discount (coupon minimums use it)
    discountMode,
    totalDiscount: calc.totalDiscount,
    total: calc.total,
    roundOff: calc.roundOff
  };
}

export default function POS() {
  const { settings, toast } = useApp();
  const sym = settings.currency_symbol || 'Rs';
  const taxLabel = settings.tax_label || 'Tax';
  const split = settings.tax_split === '1';
  const roundOffEnabled = settings.round_off === '1';

  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [search, setSearch] = useState('');
  const [cat, setCat] = useState('');
  const [cart, setCart] = useState([]);
  const [discount, setDiscount] = useState('');
  const [discountMode, setDiscountMode] = useState('amount'); // 'amount' (Rs.) | 'percent' (%)
  const [customers, setCustomers] = useState([]);
  const [customer, setCustomer] = useState(null);
  const [method, setMethod] = useState('cash');
  const [paid, setPaid] = useState('');
  const [paidTouched, setPaidTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastSale, setLastSale] = useState(null);
  const [showCustForm, setShowCustForm] = useState(false);
  const [newCust, setNewCust] = useState({ name: '', phone: '' });
  const [low, setLow] = useState([]);
  const [showLow, setShowLow] = useState(false);
  const [held, setHeld] = useState([]);
  const [showHeld, setShowHeld] = useState(false);
  const [showHold, setShowHold] = useState(false);
  const [holdRef, setHoldRef] = useState('');
  const [holdBusy, setHoldBusy] = useState(false);
  const [redeem, setRedeem] = useState('');          // loyalty points to spend on this bill
  const [coupon, setCoupon] = useState('');          // code the cashier typed
  const [couponInfo, setCouponInfo] = useState(null); // { code, discount } once validated
  const searchRef = useRef(null);
  const debounce = useRef(null);

  const loadProducts = async (q = '', categoryId = '') => {
    const params = new URLSearchParams();
    if (q) params.set('search', q);
    if (categoryId) params.set('category_id', categoryId);
    const rows = await api(`/products?${params.toString()}`);
    setProducts(rows);
  };

  useEffect(() => {
    api('/products/categories').then(setCategories).catch(() => {});
    api('/customers').then(setCustomers).catch(() => {});
    api('/reports/low-stock').then(setLow).catch(() => {});
    api('/held').then(setHeld).catch(() => {});
    loadProducts().catch(e => toast(e.message, 'error'));
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      loadProducts(search.trim(), cat).catch(() => {});
    }, 220);
    return () => clearTimeout(debounce.current);
  }, [search, cat]);

  // loyalty & coupon feed the SAME engine as the manual discount — one source of truth
  const loyaltyOn = settings.loyalty_enabled !== '0';
  const loyaltyValue = Math.max(0, Number(settings.loyalty_value ?? 1) || 1);
  const maxPoints = customer ? Math.max(0, Math.floor(Number(customer.loyalty_points || 0))) : 0;
  const redeemPoints = loyaltyOn && customer
    ? Math.max(0, Math.min(Math.trunc(Number(redeem) || 0), maxPoints))
    : 0;
  const loyaltyRupees = r2(redeemPoints * loyaltyValue);
  const couponRupees = couponInfo ? r2(couponInfo.discount || 0) : 0;

  const totals = useMemo(
    () => computeTotals(cart, discount, roundOffEnabled, discountMode, { loyalty: loyaltyRupees, coupon: couponRupees }),
    [cart, discount, discountMode, roundOffEnabled, loyaltyRupees, couponRupees]
  );

  useEffect(() => {
    if (!paidTouched) setPaid(String(totals.total));
  }, [totals.total, paidTouched]);

  const addToCart = product => {
    // expired stock must never reach a bill — the Head has to clear the date first
    if (product.expiry_date && product.expiry_date < todayStr()) {
      toast(`${product.name} expired on ${product.expiry_date} — expired stock cannot be sold`, 'error');
      return;
    }
    if (product.stock_qty <= 0 && settings.allow_negative_stock !== '1') {
      toast(`${product.name} is out of stock`, 'warning');
      return;
    }
    setCart(c => {
      const found = c.find(i => i.id === product.id);
      const inCart = found ? found.qty : 0;
      if (settings.allow_negative_stock !== '1' && inCart + 1 > product.stock_qty) {
        toast(`Only ${num(product.stock_qty)} ${product.unit} in stock`, 'warning');
        return c;
      }
      if (found) {
        return c.map(i => (i.id === product.id ? { ...i, qty: r2(i.qty + 1) } : i));
      }
      return [...c, {
        id: product.id, name: product.name, unit: product.unit,
        qty: 1, price: product.price, tax_rate: product.tax_rate,
        tax_inclusive: product.tax_inclusive, stock: product.stock_qty
      }];
    });
  };

  const onSearchEnter = async e => {
    if (e.key !== 'Enter') return;
    const q = search.trim();
    if (!q) return;
    const exact = products.find(p => p.barcode && p.barcode === q);
    const target = exact || (products.length === 1 ? products[0] : null);
    if (target) {
      addToCart(target);
      setSearch('');
    } else if (products.length > 0) {
      addToCart(products[0]);
      setSearch('');
    } else {
      // try a direct barcode lookup
      try {
        const rows = await api(`/products?barcode=${encodeURIComponent(q)}`);
        if (rows.length) {
          addToCart(rows[0]);
          setSearch('');
        } else {
          toast('No product found', 'warning');
        }
      } catch { /* ignore */ }
    }
  };

  const setQty = (id, qty) => {
    setCart(c => c.map(i => {
      if (i.id !== id) return i;
      const q = Math.max(0, Number(qty));
      if (settings.allow_negative_stock !== '1' && q > i.stock) {
        toast(`Only ${num(i.stock)} ${i.unit} in stock`, 'warning');
        return i;
      }
      return { ...i, qty: q };
    }).filter(i => i.qty > 0));
  };

  const setLineDiscount = (id, value) => {
    const n = Number(value);
    setCart(c => c.map(i => (i.id === id
      ? { ...i, discount: Number.isFinite(n) && n > 0 ? n : 0 }
      : i)));
  };

  const clearCart = () => {
    setCart([]);
    setDiscount('');
    setDiscountMode('amount');
    setPaidTouched(false);
    setCustomer(null);
    setRedeem('');
    setCoupon('');
    setCouponInfo(null);
  };

  // ---------------- held (parked) bills ----------------
  const loadHeld = () => api('/held').then(setHeld).catch(() => {});

  const openHold = () => {
    if (cart.length === 0) return toast('Cart is empty — nothing to hold', 'warning');
    setHoldRef(customer?.name || '');
    setShowHold(true);
  };

  const holdBill = async () => {
    if (holdBusy) return;
    setHoldBusy(true);
    try {
      await api('/held', {
        method: 'POST',
        body: {
          ref: holdRef,
          cart,
          discount: discount || '0',
          discount_mode: discountMode,
          customer_id: customer?.id || null,
          loyalty_points: redeemPoints,
          coupon_code: couponInfo?.code || '',
          coupon_discount: couponInfo ? r2(couponInfo.discount || 0) : 0,
          paid,
          method,
          total: totals.total
        }
      });
      clearCart();
      setShowHold(false);
      setHoldRef('');
      loadHeld();
      toast('Bill held — resume it any time from ⏸ Held', 'success');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setHoldBusy(false);
    }
  };

  const openHeld = async () => {
    await loadHeld();
    setShowHeld(true);
  };

  const resumeHeld = async h => {
    if (cart.length > 0 && !window.confirm('Replace the current cart with the held bill?')) return;
    try {
      const full = await api(`/held/${h.id}`);
      setCart(full.cart);
      setDiscount(String(full.discount ?? '0'));
      setDiscountMode(full.discount_mode === 'percent' ? 'percent' : 'amount');
      setCustomer(customers.find(c => c.id === full.customer_id) || null);
      setMethod(full.method || 'cash');
      setPaid(String(full.paid ?? ''));
      setPaidTouched(String(full.paid ?? '') !== '');
      setRedeem(String(full.loyalty_redeemed || ''));
      setCoupon(full.coupon_code || '');
      setCouponInfo(full.coupon_code
        ? { code: full.coupon_code, discount: Number(full.coupon_discount) || 0 }
        : null);
      setShowHeld(false);
      await api(`/held/${h.id}`, { method: 'DELETE' });
      loadHeld();
      toast('Held bill resumed', 'success');
      searchRef.current?.focus();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const discardHeld = async id => {
    try {
      await api(`/held/${id}`, { method: 'DELETE' });
      setHeld(l => l.filter(x => x.id !== id));
      toast('Held bill discarded', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const applyCoupon = async () => {
    const code = coupon.trim();
    if (!code) return;
    try {
      const r = await api('/coupons/validate', { method: 'POST', body: { code, total: totals.grossTotal } });
      setCouponInfo(r);
      setCoupon(r.code);
      toast(`Coupon ${r.code} — ${money(r.discount, sym)} off`, 'success');
    } catch (e) {
      setCouponInfo(null);
      toast(e.message, 'error');
    }
  };

  const saveSale = async () => {
    if (cart.length === 0) return toast('Cart is empty', 'warning');
    const paidNum = Number(paid || 0);
    if (Number.isNaN(paidNum) || paidNum < 0) return toast('Invalid paid amount', 'warning');
    if (paidNum < totals.total && !customer) {
      return toast('Select a customer for credit (udhaar) sales', 'warning');
    }
    if (r2(totals.manualDiscount + totals.loyaltyRupees + totals.couponRupees) > totals.grossTotal + 0.009) {
      return toast('Discount is more than the invoice value', 'warning');
    }
    setBusy(true);
    try {
      const res = await api('/invoices', {
        method: 'POST',
        body: {
          customer_id: customer?.id || null,
          items: cart.map(i => ({ product_id: i.id, qty: i.qty, unit_price: i.price, discount: i.discount || 0 })),
          // always send rupees: in % mode manualDiscount is the converted amount
          discount: Number(totals.manualDiscount || 0),
          loyalty_points: redeemPoints,
          coupon_code: couponInfo?.code || '',
          paid: paidNum,
          payment_method: method
        }
      });
      if (res?.__queued) {
        // no internet — the bill is saved on this device and syncs itself later
        clearCart();
        toast(`📴 Saved offline — bill queued and will sync automatically`, 'warning');
        return;
      }
      setLastSale(res.invoice.id);
      clearCart();
      loadProducts(search.trim(), cat).catch(() => {});
      api('/customers').then(setCustomers).catch(() => {});
      toast(`Invoice ${res.invoice.invoice_no} saved`, 'success');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const printLast = async mode => {
    try {
      const d = await api(`/invoices/${lastSale}`);
      if (mode === 'a4') {
        printHTML(invoiceA4HTML({ ...d, symbol: sym, taxLabel, split }), { page: 'A4' });
      } else {
        printHTML(
          receiptHTML({
            ...d, symbol: sym, taxLabel, split,
            width: settings.receipt_width || '80'
          }),
          { page: `${settings.receipt_width === '58' ? 48 : 72}mm auto` }
        );
      }
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const quickAddCustomer = async () => {
    if (!newCust.name.trim()) return toast('Customer name is required', 'warning');
    try {
      const c = await api('/customers', { method: 'POST', body: newCust });
      setCustomers(list => [...list, c]);
      setCustomer(c);
      setShowCustForm(false);
      setNewCust({ name: '', phone: '' });
      toast('Customer added', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const lowIds = useMemo(() => new Set(low.map(p => p.id)), [low]);
  const due = r2(Math.max(0, totals.total - Number(paid || 0)));

  return (
    <div className="pos">
      {/* ---------------- product side ---------------- */}
      <div className="pos-products">
        <div className="search-box">
          <span className="s-icon">⌕</span>
          <input
            ref={searchRef}
            className="input"
            placeholder="Scan barcode or search product, then press Enter…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={onSearchEnter}
          />
        </div>

        <div className="cat-chips">
          <button className={`pill ${cat === '' ? 'active' : ''}`} onClick={() => setCat('')}>All</button>
          {categories.map(c => (
            <button
              key={c.id}
              className={`pill ${cat === c.id ? 'active' : ''}`}
              onClick={() => setCat(cat === c.id ? '' : c.id)}
            >
              {c.name}
            </button>
          ))}
          <div className="spacer" />
          {low.length > 0 ? (
            <button
              className={`pill ${showLow ? 'active' : ''}`}
              style={{ color: 'var(--danger)', fontWeight: 700 }}
              onClick={() => setShowLow(v => !v)}
              title="Products running out of stock"
            >
              ⚠ {low.length} low stock
            </button>
          ) : null}
        </div>

        {showLow && low.length > 0 ? (
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="card-title">⚠ Low Stock — tell the Head / Inventory Manager</div>
            <div className="stack" style={{ gap: 7 }}>
              {low.slice(0, 12).map(p => (
                <div key={p.id} className="row" style={{ justifyContent: 'space-between', fontSize: 13 }}>
                  <span>{p.name}</span>
                  <span className="badge red">{num(p.stock_qty)} {p.unit} left · alert at {num(p.low_stock)}</span>
                </div>
              ))}
              {low.length > 12 ? <div className="muted small">+{low.length - 12} more…</div> : null}
            </div>
          </div>
        ) : null}

        {products.length === 0 ? (
          <div className="card empty-state">
            <div className="big">🔍</div>
            <div className="bold">No products found</div>
            <div className="small">Add products from the Products page.</div>
          </div>
        ) : (
          <div className="product-grid">
            {products.map(p => (
              <button
                key={p.id}
                className={`product-tile ${p.stock_qty <= 0 ? 'out' : ''}`}
                onClick={() => addToCart(p)}
                title={p.barcode ? `Barcode: ${p.barcode}${p.expiry_date ? ` · exp: ${p.expiry_date}` : ''}` : p.name}
              >
                <div className="p-name">{p.name}</div>
                <div className="p-meta">
                  <span style={lowIds.has(p.id) && p.stock_qty > 0 ? { color: 'var(--danger)', fontWeight: 700 } : undefined}>
                    {p.stock_qty > 0 ? `${num(p.stock_qty)} ${p.unit}` : 'OUT'}
                    {lowIds.has(p.id) && p.stock_qty > 0 ? ' ⚠ LOW' : ''}
                  </span>
                  {p.expiry_date && p.expiry_date < todayStr() ? (
                    <span style={{ color: 'var(--danger)', fontWeight: 700 }} title={`Expired ${p.expiry_date}`}>EXPIRED</span>
                  ) : p.expiry_date && daysLeft(p.expiry_date) <= 30 ? (
                    <span style={{ color: '#b45309', fontWeight: 700 }} title={`Expires ${p.expiry_date}`}>{daysLeft(p.expiry_date)}d</span>
                  ) : p.tax_rate > 0 ? <span>{p.tax_rate}%</span> : null}
                </div>
                <div className="p-price">{money(p.price, sym)}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ---------------- cart side ---------------- */}
      <div className="card cart-panel">
        <div className="flex" style={{ justifyContent: 'space-between' }}>
          <div className="card-title" style={{ marginBottom: 0 }}>Current Bill</div>
          <div className="flex" style={{ gap: 6 }}>
            <button className="btn ghost xs" onClick={openHeld} title="Held bills on this till">
              ⏸ Held{held.length > 0 ? ` (${held.length})` : ''}
            </button>
            {cart.length > 0 ? (
              <button className="btn xs" onClick={openHold} title="Park this bill and come back to it later">Hold</button>
            ) : null}
            {cart.length > 0 ? (
              <button className="btn danger xs" onClick={clearCart}>Clear</button>
            ) : null}
          </div>
        </div>

        <div className="field mt-14 mb-0">
          <div className="flex" style={{ justifyContent: 'space-between' }}>
            <label>Customer</label>
            <button className="btn ghost xs" onClick={() => setShowCustForm(true)}>＋ New</button>
          </div>
          <select
            id="pos-customer"
            className="input"
            value={customer?.id || ''}
            onChange={e => {
              setCustomer(customers.find(c => c.id === e.target.value) || null);
              setRedeem(''); // points belong to the previous customer
            }}
          >
            <option value="">Walk-in Customer</option>
            {customers.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}{c.phone ? ` — ${c.phone}` : ''}{c.balance > 0 ? ` (due ${money(c.balance, sym)})` : ''}
                {loyaltyOn && c.loyalty_points > 0 ? ` ⭐${num(c.loyalty_points, 0)}` : ''}
              </option>
            ))}
          </select>
          {loyaltyOn && customer ? (
            <div className="flex small" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
              <span className="muted" title={loyaltyValue > 0 ? `1 point = ${money(loyaltyValue, sym)}` : ''}>
                ⭐ {num(maxPoints, 0)} pts{maxPoints > 0 ? ` · worth ${money(maxPoints * loyaltyValue, sym)}` : ''}
              </span>
              <span className="flex" style={{ gap: 5, alignItems: 'center' }}>
                <input
                  className="input" type="number" min="0" step="1"
                  placeholder="redeem pts" title="Redeem loyalty points on this bill"
                  style={{ width: 96, padding: '3px 6px', textAlign: 'right', fontSize: 12 }}
                  value={redeem}
                  onChange={e => setRedeem(String(Math.max(0, Math.min(
                    Math.trunc(Number(e.target.value) || 0), maxPoints
                  ))))}
                />
                {redeemPoints > 0 ? (
                  <span style={{ color: 'var(--danger)', fontWeight: 700, whiteSpace: 'nowrap' }}>
                    −{money(loyaltyRupees, sym)}
                  </span>
                ) : null}
              </span>
            </div>
          ) : null}
        </div>

        <div className="cart-lines mt-14">
          {cart.length === 0 ? (
            <div className="empty-state" style={{ padding: '28px 10px' }}>
              <div className="big">🛒</div>
              <div className="small">Tap products or scan a barcode to start billing</div>
            </div>
          ) : (
            totals.lines.map(i => (
              <div className="cart-line" key={i.id}>
                <div>
                  <div className="cl-name">{i.name}</div>
                  <div className="qty-ctrl" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                    <button onClick={() => setQty(i.id, r2(i.qty - 1))}>−</button>
                    <span className="q">{num(i.qty)}</span>
                    <button onClick={() => setQty(i.id, r2(i.qty + 1))}>＋</button>
                    <span className="cl-sub">× {money(i.price, sym)}</span>
                    {i.tax_rate > 0 ? <span className="cl-sub">+{i.tax_rate}%</span> : null}
                    <input
                      className="input" type="number" min="0" placeholder="off"
                      title="Discount on this item"
                      aria-label={`Discount on ${i.name}`}
                      style={{ width: 62, padding: '2px 5px', textAlign: 'right', fontSize: 12 }}
                      value={i.discount || ''}
                      onChange={e => setLineDiscount(i.id, e.target.value)}
                    />
                    {i.discount > 0 ? (
                      <span className="cl-sub" style={{ color: 'var(--danger)' }}>−{money(i.discount, sym)}</span>
                    ) : null}
                  </div>
                </div>
                <div>
                  <div className="cl-total">{money(i.lineTotal, sym)}</div>
                  <button className="cl-remove" title="Remove" onClick={() => setCart(c => c.filter(x => x.id !== i.id))}>×</button>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="totals">
          <div className="t-row"><span>Subtotal</span><span>{money(totals.subtotal, sym)}</span></div>
          <div className="t-row">
            <span>Discount</span>
            <span className="flex" style={{ gap: 5, justifyContent: 'flex-end', alignItems: 'center' }}>
              <button
                type="button"
                className={`btn xs ${discountMode === 'amount' ? '' : 'secondary'}`}
                onClick={() => setDiscountMode('amount')}
                title="Discount in rupees"
              >Rs.</button>
              <button
                type="button"
                className={`btn xs ${discountMode === 'percent' ? '' : 'secondary'}`}
                onClick={() => setDiscountMode('percent')}
                title="Discount as a percentage of the bill"
              >%</button>
              <input
                className="input" type="number" min="0" placeholder="0"
                style={{ width: 84, padding: '3px 7px', textAlign: 'right' }}
                value={discount}
                onChange={e => setDiscount(e.target.value)}
              />
              {discountMode === 'percent' && Number(discount) > 0 ? (
                <span style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                  = {money(totals.manualDiscount, sym)}
                </span>
              ) : null}
            </span>
          </div>
          {!couponInfo ? (
            <div className="t-row">
              <span>Coupon</span>
              <span className="flex" style={{ gap: 5, justifyContent: 'flex-end', alignItems: 'center' }}>
                <input
                  className="input" placeholder="code"
                  style={{ width: 96, padding: '3px 7px', textTransform: 'uppercase' }}
                  value={coupon}
                  onChange={e => setCoupon(e.target.value.toUpperCase())}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); applyCoupon(); } }}
                />
                <button type="button" className="btn xs secondary" onClick={applyCoupon} disabled={!coupon.trim()}>
                  Apply
                </button>
              </span>
            </div>
          ) : null}
          {redeemPoints > 0 ? (
            <div className="t-row">
              <span>⭐ Loyalty ({num(redeemPoints, 0)} pts)</span>
              <span style={{ color: 'var(--danger)' }}>−{money(totals.loyaltyRupees, sym)}</span>
            </div>
          ) : null}
          {couponInfo ? (
            <div className="t-row">
              <span>Coupon {couponInfo.code}</span>
              <span className="flex" style={{ gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
                <span style={{ color: 'var(--danger)' }}>−{money(totals.couponRupees, sym)}</span>
                <button className="cl-remove" title="Remove coupon"
                  onClick={() => { setCouponInfo(null); setCoupon(''); }}>×</button>
              </span>
            </div>
          ) : null}
          <div className="t-row">
            <span>{taxLabel}{split && totals.taxTotal > 0 ? ' (CGST + SGST)' : ''}</span>
            <span>{money(totals.taxTotal, sym)}</span>
          </div>
          {totals.roundOff ? <div className="t-row"><span>Round off</span><span>{money(totals.roundOff, sym)}</span></div> : null}
          <div className="t-row grand"><span>Total</span><span>{money(totals.total, sym)}</span></div>
          {totals.totalDiscount > 0 ? (
            <div className="t-row" style={{ opacity: 0.7, fontSize: 12 }}>
              <span>Total discount</span>
              <span>{money(totals.totalDiscount, sym)}</span>
            </div>
          ) : null}
        </div>

        <div className="pay-grid">
          {['cash', 'card', 'mobile'].map(m => (
            <button
              key={m}
              className={`btn sm ${method === m ? '' : 'secondary'}`}
              onClick={() => setMethod(m)}
              type="button"
            >
              {m === 'mobile' ? 'Mobile Pay' : m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
          <div className="field mb-0" style={{ gridColumn: '1 / -1' }}>
            <label>Amount Received</label>
            <input
              className="input" type="number" min="0"
              value={paid}
              onChange={e => { setPaid(e.target.value); setPaidTouched(true); }}
            />
            <div className="flex" style={{ justifyContent: 'space-between' }}>
              <span className="hint">
                {due > 0 ? <b style={{ color: 'var(--danger)' }}>Credit due: {money(due, sym)}</b> : 'Fully paid'}
              </span>
              <button className="btn ghost xs" type="button" onClick={() => { setPaid(String(totals.total)); setPaidTouched(false); }}>
                Exact amount
              </button>
            </div>
          </div>
        </div>

        <button
          className="btn success mt-14"
          style={{ width: '100%', padding: '13px 0', fontSize: 15.5 }}
          onClick={saveSale}
          disabled={busy || cart.length === 0}
        >
          {busy ? 'Saving…' : `Complete Sale — ${money(totals.total, sym)}`}
        </button>
      </div>

      {/* ---------------- success modal ---------------- */}
      {lastSale ? (
        <Modal title="Sale Completed" onClose={() => setLastSale(null)}
          footer={
            <>
              <button className="btn secondary" onClick={() => printLast('a4')}>🖨 A4 Invoice</button>
              <button className="btn secondary" onClick={() => printLast('thermal')}>🖨 Receipt</button>
              <button className="btn" onClick={() => { setLastSale(null); searchRef.current?.focus(); }}>New Sale</button>
            </>
          }>
          <div className="center" style={{ padding: '10px 0 4px' }}>
            <div style={{ fontSize: 44 }}>✅</div>
            <h2 style={{ marginTop: 8 }}>Payment Saved</h2>
            <div className="muted mt-8">Invoice <b>{lastSale}</b> has been recorded and stock updated.</div>
            <div className="mt-14">
              <span className="badge green">Ready to print</span>
            </div>
          </div>
        </Modal>
      ) : null}

      {/* ---------------- quick customer ---------------- */}
      {showCustForm ? (
        <Modal title="Add Customer" onClose={() => setShowCustForm(false)}
          footer={
            <>
              <button className="btn secondary" onClick={() => setShowCustForm(false)}>Cancel</button>
              <button className="btn" onClick={quickAddCustomer}>Add &amp; Select</button>
            </>
          }>
          <div className="field">
            <label>Name *</label>
            <input className="input" autoFocus value={newCust.name}
              onChange={e => setNewCust(c => ({ ...c, name: e.target.value }))} placeholder="Customer name" />
          </div>
          <div className="field">
            <label>Phone</label>
            <input className="input" value={newCust.phone}
              onChange={e => setNewCust(c => ({ ...c, phone: e.target.value }))} placeholder="0300 1234567" />
          </div>
        </Modal>
      ) : null}

      {/* ---------------- hold this bill ---------------- */}
      {showHold ? (
        <Modal title="Hold this bill" onClose={() => setShowHold(false)}
          footer={
            <>
              <button className="btn secondary" onClick={() => setShowHold(false)}>Cancel</button>
              <button className="btn" onClick={holdBill} disabled={holdBusy}>
                {holdBusy ? 'Holding…' : 'Hold bill'}
              </button>
            </>
          }>
          <div className="field">
            <label>Label (optional)</label>
            <input className="input" autoFocus value={holdRef}
              onChange={e => setHoldRef(e.target.value)}
              placeholder={customer?.name || 'e.g. Uncle at counter 2'} />
          </div>
          <div className="muted small">
            The cart is parked on this till — open <b>⏸ Held</b> any time to resume it.
          </div>
        </Modal>
      ) : null}

      {/* ---------------- held bills list ---------------- */}
      {showHeld ? (
        <Modal title={`Held bills (${held.length})`} onClose={() => setShowHeld(false)}
          footer={<button className="btn secondary" onClick={() => setShowHeld(false)}>Close</button>}>
          {held.length === 0 ? (
            <div className="empty-state" style={{ padding: '26px 10px' }}>
              <div className="big">⏸</div>
              <div className="small">No held bills — park a bill with <b>Hold</b> while you sort out the next customer.</div>
            </div>
          ) : (
            held.map(h => (
              <div className="flex" key={h.id}
                style={{ justifyContent: 'space-between', alignItems: 'center', padding: '9px 4px', borderBottom: '1px solid var(--line)' }}>
                <div>
                  <div className="bold">{h.ref || 'Held bill'}</div>
                  <div className="muted small">
                    {num(h.item_count)} item(s) · {money(h.total, sym)} ·{' '}
                    {new Date(h.created_at).toLocaleString()}
                    {h.created_by_name ? ` · ${h.created_by_name}` : ''}
                  </div>
                </div>
                <div className="flex" style={{ gap: 6 }}>
                  <button className="btn xs" onClick={() => resumeHeld(h)}>Resume</button>
                  <button className="btn danger xs" title="Discard" onClick={() => discardHeld(h.id)}>×</button>
                </div>
              </div>
            ))
          )}
        </Modal>
      ) : null}
    </div>
  );
}
