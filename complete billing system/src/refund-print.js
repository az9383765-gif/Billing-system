// Refund (credit note) printing — a return of goods against a bill.
// Kept separate from print.js so the original receipt/A4 printers stay untouched.
import { printHTML, barcodeSVG } from './print.js';
import { money, dateStr, timeStr, amountInWords } from './format.js';

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const css = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; }
  .rcpt { font-family: 'Segoe UI', Arial, sans-serif; color: #000; line-height: 1.35; padding: 2mm; }
  .rcpt .c { text-align: center; }
  .rcpt .shop { font-size: 16px; font-weight: 800; letter-spacing: .3px; }
  .rcpt .sub { font-size: 10.5px; color: #111; }
  .rcpt .kind { font-size: 13px; font-weight: 800; letter-spacing: 2px; border: 2px solid #000; display: inline-block; padding: 2px 10px; margin-top: 4px; }
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
  .rcpt .words { font-size: 10px; color: #222; margin-top: 5px; }
`;

const num2 = n => {
  const v = Number(n || 0);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
};

/**
 * Thermal credit note for a return.
 * Payload shape matches GET /api/returns/:id
 * ({ return, items, invoice, customer, shop }).
 */
export function refundReceiptHTML({
  return: ret, items = [], invoice, customer, shop = {},
  symbol = 'Rs.', taxLabel = 'GST', split = false, width = '80'
}) {
  const mm = width === '58' ? '48mm' : '72mm';

  const lineRows = items.map((it, i) => `
    <tr>
      <td>
        <div class="item-name">${i + 1}. ${esc(it.name)}</div>
        <div class="item-sub">${num2(it.qty)} ${esc(it.unit || '')} x ${money(it.unit_price, symbol)}${it.tax_rate > 0 ? `  (${taxLabel} ${it.tax_rate}%)` : ''}</div>
      </td>
      <td class="r">${money(it.line_total, symbol)}</td>
    </tr>`).join('');

  const taxLine = ret.tax_total > 0
    ? (split
        ? `<div class="kv"><span>${taxLabel} (CGST)</span><span>${money(ret.tax_total / 2, symbol)}</span></div>
           <div class="kv"><span>${taxLabel} (SGST)</span><span>${money(ret.tax_total / 2, symbol)}</span></div>`
        : `<div class="kv"><span>${taxLabel}</span><span>${money(ret.tax_total, symbol)}</span></div>`)
    : '';

  const moneyBack = `
    ${ret.cash_refund > 0 ? `<div class="kv"><span>Cash refunded</span><span>${money(ret.cash_refund, symbol)}</span></div>` : ''}
    ${ret.credit_adjust > 0 ? `<div class="kv"><span>Credit adjusted</span><span>${money(ret.credit_adjust, symbol)}</span></div>` : ''}`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}
    body { width: ${mm}; margin: 0 auto; }</style></head>
  <body>
    <div class="rcpt">
      <div class="c">
        <div class="shop">${esc(shop.shop_name || 'My Shop')}</div>
        ${shop.shop_address ? `<div class="sub">${esc(shop.shop_address)}</div>` : ''}
        ${shop.shop_phone ? `<div class="sub">Phone: ${esc(shop.shop_phone)}</div>` : ''}
        ${shop.gstin ? `<div class="sub">GSTIN: ${esc(shop.gstin)}</div>` : ''}
        <div class="kind">CREDIT NOTE</div>
      </div>
      <div class="dash"></div>
      <div class="kv"><span>Return No</span><span><b>${esc(ret.return_no)}</b></span></div>
      <div class="kv"><span>Date</span><span>${dateStr(ret.datetime)} ${timeStr(ret.datetime)}</span></div>
      <div class="kv"><span>Against Bill</span><span><b>${esc(invoice?.invoice_no || '—')}</b></span></div>
      <div class="kv"><span>Customer</span><span>${esc(customer?.name || 'Walk-in')}</span></div>
      ${customer?.phone ? `<div class="kv"><span>Phone</span><span>${esc(customer.phone)}</span></div>` : ''}
      <div class="rule"></div>
      <table>
        <thead><tr><th>Returned Item</th><th class="r">Amount</th></tr></thead>
        <tbody>${lineRows}</tbody>
      </table>
      <div class="rule"></div>
      <div class="kv"><span>Taxable value</span><span>${money(ret.subtotal, symbol)}</span></div>
      ${taxLine}
      <div class="kv total"><span>REFUND TOTAL</span><span>${money(ret.total, symbol)}</span></div>
      ${moneyBack}
      <div class="words"><b>In words:</b> ${esc(amountInWords(ret.total))}</div>
      ${ret.reason ? `<div class="foot">Reason: ${esc(ret.reason)}</div>` : ''}
      <div class="foot c">Goods received back against ${esc(invoice?.invoice_no || 'the bill')} — keep this credit note.</div>
      <div class="foot c">${esc(shop.receipt_footer || 'Thank you!')}</div>
      <div class="barcode">${barcodeSVG(ret.return_no, { width: width === '58' ? 1.4 : 1.8, height: 34 })}</div>
    </div>
  </body></html>`;
}

// Build + send the credit note to the printer
export function printRefund(payload, { width = '80' } = {}) {
  printHTML(
    refundReceiptHTML({ ...payload, width }),
    { page: `${width === '58' ? 48 : 72}mm auto` }
  );
}
