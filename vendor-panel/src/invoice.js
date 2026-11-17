// A vendor plan's GST tax invoice as a printable page. The same file is in the admin panel
// (admin-panel/src/invoice.js); keep the two in step.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (paise) => ((paise ?? 0) / 100).toLocaleString('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });
const day = (value) => (value ? new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '');

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const belowHundred = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`);
const belowThousand = (n) => [n >= 100 && `${ONES[Math.floor(n / 100)]} Hundred`, n % 100 && belowHundred(n % 100)].filter(Boolean).join(' ');

// Indian numbering: 1,18,000 is "One Lakh Eighteen Thousand".
function words(n) {
  if (!n) return 'Zero';
  const parts = [];
  for (const [size, name] of [[1e7, 'Crore'], [1e5, 'Lakh'], [1e3, 'Thousand']]) {
    if (n >= size) {
      parts.push(`${words(Math.floor(n / size))} ${name}`);
      n %= size;
    }
  }
  if (n) parts.push(belowThousand(n));
  return parts.join(' ');
}

export function amountInWords(paise) {
  const rupees = Math.floor(paise / 100);
  const rest = paise % 100;
  return `Rupees ${words(rupees)}${rest ? ` and ${belowHundred(rest)} Paise` : ''} Only`;
}

const state = (name, code) => (code ? `${esc(name ?? '')} (${esc(code)})` : '');

export function invoiceHtml(inv) {
  const half = inv.gstRatePct / 2;
  const taxRows = inv.igstPaise
    ? `<tr><td>IGST @ ${inv.gstRatePct}%</td><td class="num">${money(inv.igstPaise)}</td></tr>`
    : `<tr><td>CGST @ ${half}%</td><td class="num">${money(inv.cgstPaise)}</td></tr><tr><td>SGST @ ${half}%</td><td class="num">${money(inv.sgstPaise)}</td></tr>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Invoice ${esc(inv.number)}</title>
<style>
  * { box-sizing: border-box; }
  body { font: 13px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #17201b; margin: 0; padding: 32px; background: #fff; }
  .sheet { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0; letter-spacing: 0.02em; }
  .head { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid #1f5c4a; padding-bottom: 14px; }
  .muted { color: #5b655f; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 18px 0; }
  .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #5b655f; font-weight: 700; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e4e0d6; vertical-align: top; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #5b655f; background: #f6f3ec; }
  .num { text-align: right; white-space: nowrap; }
  .totals { width: 320px; margin-left: auto; margin-top: 8px; }
  .totals tr:last-child td { font-weight: 700; font-size: 15px; border-top: 2px solid #17201b; border-bottom: 0; }
  .foot { margin-top: 28px; font-size: 12px; }
  @media print { body { padding: 0; } @page { margin: 16mm; } }
</style></head>
<body><div class="sheet">
  <div class="head">
    <div>
      <h1>Tax invoice</h1>
      <div class="muted">Original for recipient</div>
    </div>
    <div style="text-align:right">
      <div><strong>${esc(inv.supplier?.legalName)}</strong></div>
      <div class="muted">${esc(inv.supplier?.address)}</div>
      <div>GSTIN: ${esc(inv.supplier?.gstin || 'Not registered')}</div>
      ${inv.supplier?.stateCode ? `<div>State: ${state(inv.supplier.stateName, inv.supplier.stateCode)}</div>` : ''}
      ${inv.supplier?.email ? `<div class="muted">${esc(inv.supplier.email)}</div>` : ''}
    </div>
  </div>
  <div class="grid">
    <div>
      <div class="label">Billed to</div>
      <div><strong>${esc(inv.recipient?.name)}</strong></div>
      <div class="muted">${esc(inv.recipient?.address)}</div>
      <div>GSTIN: ${esc(inv.recipient?.gstin || 'Unregistered')}</div>
      ${inv.recipient?.stateCode ? `<div>State: ${state(inv.recipient.stateName, inv.recipient.stateCode)}</div>` : ''}
    </div>
    <div>
      <div class="label">Invoice</div>
      <div>Number: <strong>${esc(inv.number)}</strong></div>
      <div>Date: ${day(inv.issuedAt)}</div>
      ${inv.placeOfSupply ? `<div>Place of supply: ${state(inv.placeOfSupplyName, inv.placeOfSupply)}</div>` : ''}
      <div>Reverse charge: No</div>
    </div>
  </div>
  <table>
    <thead><tr><th>#</th><th>Description</th><th>SAC</th><th class="num">Taxable value</th></tr></thead>
    <tbody>
      ${inv.lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.description)}</td><td>${esc(l.sac)}</td><td class="num">${money(l.taxablePaise)}</td></tr>`).join('')}
    </tbody>
  </table>
  <table class="totals">
    <tr><td>Taxable value</td><td class="num">${money(inv.taxablePaise)}</td></tr>
    ${taxRows}
    <tr><td>Total</td><td class="num">${money(inv.totalPaise)}</td></tr>
  </table>
  <p><strong>Amount in words:</strong> ${esc(amountInWords(inv.totalPaise))}</p>
  <div class="foot muted">
    Paid online${inv.payment?.paidAt ? ` on ${day(inv.payment.paidAt)}` : ''}${inv.payment?.paymentId ? ` · Payment ID ${esc(inv.payment.paymentId)}` : ''}.<br>
    This is a computer-generated invoice and needs no signature.
  </div>
</div></body></html>`;
}

// Opens the invoice in a new window and starts printing (or saving as PDF).
export function printInvoice(invoice) {
  const win = window.open('', '_blank', 'width=860,height=1000');
  if (!win) throw new Error('Allow pop-ups for this site to print the invoice');
  win.document.write(invoiceHtml(invoice));
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 250);
}
