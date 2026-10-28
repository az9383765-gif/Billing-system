// ---------------------------------------------------------------------------
// MartBill GST engine — the single source of truth for money maths.
//
// Used by BOTH the billing API (server/routes/invoices.js) and the POS screen
// (src/pages/POS.jsx), so the total shown while billing is always exactly the
// total that gets stored and printed.
//
// Rules implemented here:
//   • tax_inclusive (shelf price, the retail norm in Pakistan): the GST is
//     *inside* the entered price and is extracted out of it.
//   • tax-exclusive (price before tax): the GST is added on top.
//   • a discount is money off the price the shop entered for that line, and it
//     reduces the taxable value — tax is always charged on what is really paid.
//   • the invoice-level discount is shared across lines by value (the last
//     line absorbs the rounding pennies), then GST is re-split per line.
//   • round_off (default on) rounds the bill to the nearest rupee and records
//     the difference on its own line.
// ---------------------------------------------------------------------------

export const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export function rateOf(n) {
  const r = Number(n);
  return Number.isFinite(r) && r > 0 ? r : 0;
}

function extractTax(value, rate, inclusive) {
  if (inclusive) {
    const net = round2(value / (1 + rate / 100)); // strip the GST out of the price
    return { net, tax: round2(value - net) };
  }
  const net = round2(value);
  return { net, tax: round2((net * rate) / 100) }; // add the GST on top
}

/**
 * One cart line.
 * @param {{qty?:number, unit_price?:number, tax_rate?:number, tax_inclusive?:boolean, discount?:number}} item
 * @returns {{gross:number, discount:number, net:number, tax:number, total:number}}
 *   net  = taxable value (GST-exclusive)
 *   tax  = GST contained / chargeable on the line
 *   total= what the customer pays for the line
 */
export function lineCalc(item = {}) {
  const rate = rateOf(item.tax_rate);
  const gross = round2(Number(item.qty || 0) * Number(item.unit_price || 0));
  const disc = Math.min(round2(Number(item.discount) || 0), gross);
  const value = round2(gross - disc);
  const { net, tax } = extractTax(value, rate, Boolean(item.tax_inclusive));
  return { gross, discount: disc, net, tax, total: round2(net + tax) };
}

/**
 * The whole bill.
 * @param {{items?:object[], discount?:number, round_off?:boolean}} bill
 * @returns {{lines, subtotal, discount, totalDiscount, taxTotal, grossTotal, total, roundOff}}
 *   subtotal     = GST-exclusive value of the bill
 *   discount     = the bill-level discount that was requested
 *   totalDiscount= everything taken off (line discounts + shares of discount)
 *   taxTotal     = total GST
 *   total        = what the customer pays (after round-off)
 */
export function invoiceCalc(bill = {}) {
  const items = Array.isArray(bill.items) ? bill.items : [];
  const lines = items.map(it => ({ ...it, ...lineCalc(it) }));

  const gross = round2(lines.reduce((s, l) => s + l.total, 0));
  const invDisc = Math.min(round2(Number(bill.discount) || 0), gross);

  // spread the bill discount over the lines by value; last line takes the pennies
  let allocated = 0;
  lines.forEach((l, i) => {
    const share = i === lines.length - 1
      ? round2(invDisc - allocated)
      : round2(invDisc * (gross > 0 ? l.total / gross : 0));
    allocated = round2(allocated + share);

    const value = round2(l.total - share);
    // l.total is always the tax-inclusive amount the customer pays for the line,
    // so the bill discount comes off that figure and the GST is re-split from it —
    // for exclusive lines too (otherwise the tax would be charged twice).
    const { net, tax } = extractTax(value, rateOf(l.tax_rate), true);
    l.invoice_discount = share;
    l.net = net;
    l.tax = tax;
    l.total_after_discount = round2(net + tax);
    l.total_discount = round2(l.discount + share); // line discount + share of the bill discount
  });

  const subtotal = round2(lines.reduce((s, l) => s + l.net, 0));
  const taxTotal = round2(lines.reduce((s, l) => s + l.tax, 0));
  const grossTotal = round2(subtotal + taxTotal);
  // every rupee taken off the bill: line discounts plus the shares of invDisc
  const totalDiscount = round2(lines.reduce((s, l) => s + l.total_discount, 0));

  let total = grossTotal;
  let roundOff = 0;
  if (bill.round_off !== false) {
    total = Math.round(grossTotal);
    roundOff = round2(total - grossTotal);
  }

  return { lines, subtotal, discount: invDisc, totalDiscount, taxTotal, grossTotal, total, roundOff };
}

/**
 * GST summary grouped by rate — powers the tax table on the A4 invoice and
 * the Tax report. Accepts the engine's own lines or stored invoice items
 * (which use line_subtotal / tax_amount).
 */
export function taxSummary(lines = []) {
  const byRate = new Map();
  for (const l of lines) {
    const rate = rateOf(l.tax_rate);
    const taxable = Number(l.net ?? l.line_subtotal ?? 0);
    const tax = Number(l.tax ?? l.tax_amount ?? 0);
    const entry = byRate.get(rate) || { rate, taxable: 0, tax: 0, cgst: 0, sgst: 0 };
    entry.taxable = round2(entry.taxable + taxable);
    entry.tax = round2(entry.tax + tax);
    entry.cgst = round2(entry.tax / 2);
    entry.sgst = round2(entry.tax - entry.cgst);
    byRate.set(rate, entry);
  }
  return [...byRate.values()].sort((a, b) => a.rate - b.rate);
}

/**
 * POS "%" discount: turns a percentage into rupees on the pre-discount gross
 * (the bill total before any bill-level discount). The percent is clamped to
 * 0..100 and the result can never exceed the bill — same safety as the engine.
 */
export function discountFromPercent(gross, percent) {
  const g = Math.max(0, round2(gross));
  const p = Number(percent);
  if (!Number.isFinite(p) || p <= 0) return 0;
  return Math.min(round2((g * Math.min(p, 100)) / 100), g);
}
