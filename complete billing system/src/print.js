// Printing: thermal receipt, A4 GST invoice and barcode labels
import JsBarcode from 'jsbarcode';
import { money, dateStr, timeStr, amountInWords } from './format.js';
import { taxSummary } from '../shared/calc.js';

const hasDiscount = it => Number(it.line_discount || 0) > 0;

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function barcodeSVG(value, opts = {}) {
  if (!value) return '';
  try {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    JsBarcode(svg, String(value), {
      format: 'CODE128',
      width: opts.width || 1.7,
      height: opts.height || 38,
      displayValue: true,
      fontSize: 12,
      margin: 0,
      background: '#ffffff',
      lineColor: '#000000'
    });
    return svg.outerHTML;
  } catch {
    return `<span style="font-family:monospace;font-size:13px">${esc(value)}</span>`;
  }
}

// Send HTML to the printer with the right paper size
export function printHTML(html, { page = null } = {}) {
  const area = document.getElementById('print-area');
  const styleEl = document.getElementById('page-style');
  if (!area || !styleEl) return;
  area.innerHTML = html;
  const previous = styleEl.textContent;
  styleEl.textContent = page ? `@page { size: ${page}; margin: 0; }` : '@page { size: A4; margin: 12mm; }';

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    window.removeEventListener('afterprint', cleanup);
    area.innerHTML = '';
    styleEl.textContent = previous;
  };
  window.addEventListener('afterprint', cleanup);
  window.print();
  setTimeout(cleanup, 4000);
}

const receiptCSS = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; }
  .rcpt { font-family: 'Segoe UI', Arial, sans-serif; color: #000; line-height: 1.35; padding: 2mm; }
  .rcpt .c { text-align: center; }
  .rcpt .shop { font-size: 16px; font-weight: 800; letter-spacing: .3px; }
  .rcpt .sub { font-size: 10.5px; color: #111; }
  .rcpt .dash { border-top: 1px dashed #444; margin: 6px 0; }
  .rcpt .rule { border-top: 2px solid #000; margin: 6px 0; }
  .rcpt table { width: 100%; border-collapse: collapse; font-size: 11px; }
  .rcpt th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .3px; border-bottom: 1px solid #000; padding: 3px 0; }
  .rcpt td { padding: 3px 0; vertical-align: top; }
  .rcpt .r { text-align: right; }
  .rcpt .kv { display: flex; justify-content: space-between; font-size: 11.5px; padding: 1.5px 0; }
  .rcpt .kv.total { font-size: 15px; font-weight: 800; border-top: 2px solid #000; border-bottom: 2px solid #000; padding: 5px 0; margin: 5px 0; }
  .rcpt .item-name { font-weight: 650; }
  .rcpt .item-sub { font-size: 10px; color: #333; }
  .rcpt .foot { font-size: 10.5px; margin-top: 7px; }
  .rcpt .barcode { margin-top: 7px; text-align: center; }
`;

export function receiptHTML({ invoice, items, customer, shop = {}, symbol = 'Rs.', taxLabel = 'GST', split = false, width = '80' }) {
  const mm = width === '58' ? '48mm' : '72mm';
  const lineRows = items.map((it, i) => `
    <tr>
      <td>
        <div class="item-name">${i + 1}. ${esc(it.name)}</div>
        <div class="item-sub">${num2(it.qty)} ${esc(it.unit || '')} x ${money(it.unit_price, symbol)}${it.tax_rate > 0 ? `  (${taxLabel} ${it.tax_rate}%)` : ''}${hasDiscount(it) ? `  -${money(it.line_discount, symbol)}` : ''}</div>
      </td>
      <td class="r">${money(it.line_total, symbol)}</td>
    </tr>`).join('');

  const taxLine = invoice.tax_total > 0
    ? (split
        ? `<div class="kv"><span>${taxLabel} (CGST)</span><span>${money(invoice.tax_total / 2, symbol)}</span></div>
           <div class="kv"><span>${taxLabel} (SGST)</span><span>${money(invoice.tax_total / 2, symbol)}</span></div>`
        : `<div class="kv"><span>${taxLabel}</span><span>${money(invoice.tax_total, symbol)}</span></div>`)
    : '';

  return `<!doctype html><html><head><meta charset="utf-8"><style>${receiptCSS}
    body { width: ${mm}; margin: 0 auto; }</style></head>
  <body>
    <div class="rcpt">
      <div class="c">
        <div class="shop">${esc(shop.shop_name || 'My Shop')}</div>
        ${shop.shop_address ? `<div class="sub">${esc(shop.shop_address)}</div>` : ''}
        ${shop.shop_phone ? `<div class="sub">Phone: ${esc(shop.shop_phone)}</div>` : ''}
        ${shop.gstin ? `<div class="sub">GSTIN: ${esc(shop.gstin)}</div>` : ''}
        <div class="sub" style="margin-top:2px;font-weight:700">TAX INVOICE</div>
      </div>
      <div class="dash"></div>
      <div class="kv"><span>Invoice</span><span><b>${esc(invoice.invoice_no)}</b></span></div>
      <div class="kv"><span>Date</span><span>${dateStr(invoice.datetime)} ${timeStr(invoice.datetime)}</span></div>
      ${customer ? `<div class="kv"><span>Customer</span><span>${esc(customer.name)}</span></div>` : '<div class="kv"><span>Customer</span><span>Walk-in</span></div>'}
      ${customer?.phone ? `<div class="kv"><span>Phone</span><span>${esc(customer.phone)}</span></div>` : ''}
      <div class="rule"></div>
      <table>
        <thead><tr><th>Item</th><th class="r">Amount</th></tr></thead>
        <tbody>${lineRows}</tbody>
      </table>
      <div class="rule"></div>
      <div class="kv"><span>Taxable value</span><span>${money(invoice.subtotal, symbol)}</span></div>
      ${taxLine}
      ${invoice.round_off ? `<div class="kv"><span>Round off</span><span>${money(invoice.round_off, symbol)}</span></div>` : ''}
      <div class="kv total"><span>TOTAL</span><span>${money(invoice.total, symbol)}</span></div>
      ${invoice.discount > 0 ? `<div class="kv" style="opacity:.72"><span>Discount (incl.)</span><span>${money(invoice.discount, symbol)}</span></div>` : ''}
      <div class="kv"><span>Paid (${esc(invoice.payment_method)})</span><span>${money(invoice.paid_amount, symbol)}</span></div>
      ${invoice.due_amount > 0 ? `<div class="kv" style="font-weight:800"><span>Balance Due</span><span>${money(invoice.due_amount, symbol)}</span></div>` : ''}
      <div class="foot c">${esc(shop.receipt_footer || 'Thank you!')}</div>
      <div class="barcode">${barcodeSVG(invoice.invoice_no, { width: width === '58' ? 1.4 : 1.8, height: 34 })}</div>
    </div>
  </body></html>`;
}

export function invoiceA4HTML({ invoice, items, customer, shop = {}, symbol = 'Rs.', taxLabel = 'GST', split = false }) {
  const shopName = shop.shop_name || 'My Shop';
  const rows = items.map((it, i) => `
    <tr>
      <td class="c">${i + 1}</td>
      <td>${esc(it.name)}${it.barcode ? `<div class="tiny">Barcode: ${esc(it.barcode)}</div>` : ''}${hasDiscount(it) ? `<div class="tiny" style="color:#b45309">Discount: -${money(it.line_discount, symbol)}</div>` : ''}</td>
      <td class="c">${esc(it.unit || '')}</td>
      <td class="r">${num2(it.qty)}</td>
      <td class="r">${money(it.unit_price, symbol)}</td>
      <td class="r">${it.tax_rate > 0 ? `${num2(it.tax_rate)}%` : '—'}</td>
      <td class="r">${money(it.line_subtotal, symbol)}</td>
      <td class="r">${money(it.tax_amount, symbol)}</td>
      <td class="r"><b>${money(it.line_total, symbol)}</b></td>
    </tr>`).join('');

  // tax breakdown by rate — same grouping the reports use (shared/calc.js)
  const summary = taxSummary(
    items.map(it => ({ tax_rate: it.tax_rate, line_subtotal: it.line_subtotal, tax_amount: it.tax_amount }))
  ).filter(v => v.rate > 0 && (v.taxable || v.tax));
  const taxRows = summary.map(v => `
    <tr>
      <td>${num2(v.rate)}%</td>
      <td class="r">${money(v.taxable, symbol)}</td>
      ${split
        ? `<td class="r">${money(v.cgst, symbol)}</td><td class="r">${money(v.sgst, symbol)}</td>`
        : `<td class="r">${money(v.tax, symbol)}</td>`}
      <td class="r">${money(v.tax, symbol)}</td>
    </tr>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { font-family: 'Segoe UI', Arial, sans-serif; color: #111; font-size: 12.5px; margin: 0; }
    .page { padding: 14mm; }
    .head { display: flex; justify-content: space-between; gap: 20px; border-bottom: 3px solid #0f172a; padding-bottom: 12px; }
    .head h1 { font-size: 25px; margin: 0; letter-spacing: -.5px; }
    .head .biz div { font-size: 12px; color: #334155; }
    .title { text-align: center; font-size: 16px; font-weight: 800; letter-spacing: 5px; margin: 16px 0 12px; text-transform: uppercase; }
    .meta { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
    .box { border: 1px solid #cbd5e1; border-radius: 6px; padding: 9px 12px; min-width: 230px; }
    .box h4 { font-size: 10.5px; text-transform: uppercase; letter-spacing: .7px; color: #64748b; margin: 0 0 5px; }
    .box .kv { display: flex; justify-content: space-between; gap: 18px; padding: 1.5px 0; }
    .box .kv span:first-child { color: #64748b; }
    table.items { width: 100%; border-collapse: collapse; }
    table.items th { background: #0f172a; color: #fff; font-size: 10.5px; text-transform: uppercase; padding: 7px 8px; text-align: left; }
    table.items td { border-bottom: 1px solid #e2e8f0; padding: 7px 8px; }
    table.items .r { text-align: right; } table.items .c { text-align: center; }
    .tiny { font-size: 10px; color: #64748b; }
    .totals { display: flex; justify-content: flex-end; margin-top: 12px; }
    .totals table { width: 330px; }
    .totals td { padding: 5px 8px; }
    .totals td:last-child { white-space: nowrap; }
    .totals .grand { font-size: 15.5px; font-weight: 800; border-top: 2px solid #0f172a; border-bottom: 2px solid #0f172a; }
    .words { margin-top: 12px; font-size: 12px; }
    .words b { font-weight: 700; }
    .tax-table { margin-top: 16px; width: 100%; border-collapse: collapse; }
    .tax-table th, .tax-table td { border: 1px solid #cbd5e1; padding: 6px 9px; font-size: 12px; text-align: right; }
    .tax-table th:first-child, .tax-table td:first-child { text-align: left; }
    .tax-table th { background: #f1f5f9; }
    .foot { display: flex; justify-content: space-between; gap: 20px; margin-top: 34px; }
    .sign { text-align: center; min-width: 210px; }
    .sign .line { border-top: 1px solid #64748b; margin-top: 46px; padding-top: 5px; font-size: 11.5px; color: #334155; }
    .terms { font-size: 11px; color: #475569; max-width: 400px; }
    .barcode-box { margin-top: 18px; }
  </style></head>
  <body><div class="page">
    <div class="head">
      <div class="biz">
        <h1>${esc(shopName)}</h1>
        ${shop.shop_address ? `<div>${esc(shop.shop_address)}</div>` : ''}
        ${shop.shop_phone ? `<div>Phone: ${esc(shop.shop_phone)}</div>` : ''}
        ${shop.gstin ? `<div><b>GSTIN:</b> ${esc(shop.gstin)}</div>` : ''}
      </div>
      <div class="right" style="text-align:right">
        <div class="tiny">Original for Recipient</div>
        <div class="barcode-box" style="margin-top:6px">${barcodeSVG(invoice.invoice_no, { width: 1.5, height: 34 })}</div>
      </div>
    </div>

    <div class="title">Tax Invoice</div>

    <div class="meta">
      <div class="box">
        <h4>Bill To</h4>
        <div><b>${esc(customer?.name || 'Walk-in Customer')}</b></div>
        ${customer?.phone ? `<div class="tiny">${esc(customer.phone)}</div>` : ''}
        ${customer?.address ? `<div class="tiny">${esc(customer.address)}</div>` : ''}
        ${customer?.gstin ? `<div class="tiny">GSTIN: ${esc(customer.gstin)}</div>` : ''}
      </div>
      <div class="box">
        <h4>Invoice Details</h4>
        <div class="kv"><span>Invoice No</span><b>${esc(invoice.invoice_no)}</b></div>
        <div class="kv"><span>Date</span><span>${dateStr(invoice.datetime)}</span></div>
        <div class="kv"><span>Time</span><span>${timeStr(invoice.datetime)}</span></div>
        <div class="kv"><span>Payment</span><span>${esc(invoice.payment_method)}</span></div>
        <div class="kv"><span>Status</span><b>${invoice.voided ? 'VOID' : invoice.status.toUpperCase()}</b></div>
      </div>
    </div>

    <table class="items">
      <thead>
        <tr>
          <th>#</th><th>Item</th><th class="c">Unit</th><th class="r">Qty</th><th class="r">Rate</th>
          <th class="r">${esc(taxLabel)}</th><th class="r">Taxable</th><th class="r">Tax Amt</th><th class="r">Total</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <div class="totals">
      <table>
        <tr><td>Taxable Value</td><td class="r">${money(invoice.subtotal, symbol)}</td></tr>
        <tr><td>${esc(taxLabel)}</td><td class="r">${money(invoice.tax_total, symbol)}</td></tr>
        ${invoice.round_off ? `<tr><td>Round Off</td><td class="r">${money(invoice.round_off, symbol)}</td></tr>` : ''}
        <tr class="grand"><td>Grand Total</td><td class="r">${money(invoice.total, symbol)}</td></tr>
        ${invoice.discount > 0
          ? `<tr><td style="font-size:11px;color:#64748b">Discount applied (already included above)</td><td class="r" style="font-size:11px;color:#64748b">${money(invoice.discount, symbol)}</td></tr>`
          : ''}
        <tr><td>Paid</td><td class="r">${money(invoice.paid_amount, symbol)}</td></tr>
        <tr><td><b>Balance Due</b></td><td class="r"><b>${money(invoice.due_amount, symbol)}</b></td></tr>
      </table>
    </div>

    <div class="words"><b>Amount in words:</b> ${esc(amountInWords(invoice.total))}</div>

    ${taxRows ? `
    <table class="tax-table">
      <thead><tr><th>${esc(taxLabel)} Rate</th><th>Taxable Value</th>${split ? '<th>CGST</th><th>SGST</th>' : '<th>Tax</th>'}<th>Total Tax</th></tr></thead>
      <tbody>${taxRows}</tbody>
    </table>` : ''}

    <div class="foot">
      <div class="terms">
        <b>Terms &amp; Conditions</b><br>
        ${esc(shop.terms || 'Goods once sold will not be taken back or exchanged. Subject to local jurisdiction.')}
        <div style="margin-top:8px">${esc(shop.receipt_footer || 'Thank you for your business!')}</div>
      </div>
      <div class="sign">
        <div>For <b>${esc(shopName)}</b></div>
        <div class="line">Authorised Signatory</div>
      </div>
    </div>
  </div></body></html>`;
}

export function labelsHTML({ labels, shop = {}, symbol = 'Rs.' }) {
  const cells = labels.map(l => `
    <div class="label">
      <div class="nm">${esc(l.name)}</div>
      <div class="bc">${barcodeSVG(l.barcode, { width: 1.35, height: 34 })}</div>
      <div class="pr">${money(l.price, symbol)}</div>
    </div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; }
    .sheet { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4mm; padding: 10mm; }
    .label { border: 1px dashed #94a3b8; border-radius: 4px; padding: 3mm 2mm; text-align: center; break-inside: avoid; }
    .label .nm { font-size: 11px; font-weight: 700; min-height: 26px; display: flex; align-items: center; justify-content: center; }
    .label .bc { margin: 2mm 0; }
    .label .pr { font-size: 13px; font-weight: 800; }
    .sheet-head { text-align: center; font-size: 12px; color: #64748b; padding-top: 6mm; }
  </style></head>
  <body>
    <div class="sheet-head">${esc(shop.shop_name || '')} — Barcode Labels</div>
    <div class="sheet">${cells}</div>
  </body></html>`;
}

function num2(n) {
  const v = Number(n || 0);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}
