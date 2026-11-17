import { Check, CreditCard, Printer, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { printInvoice } from '../invoice.js';
import { useSession } from '../session.jsx';
import { ErrorNote, Pager, Table, formatDay, formatRupees, useApi } from '../ui.jsx';

// Module 10: the vendor's plan, what it allows, buying or renewing it, and the GST invoices.
const LIMITS = [
  ['staff', 'Staff seats'],
  ['services', 'Active services'],
  ['products', 'Products'],
  ['customers', 'CRM customers'],
];
const rupeesShort = (p) => formatRupees(p).replace(/\.00$/, '');

// Razorpay Checkout is loaded only when a vendor pays.
let razorpayScript;
function loadRazorpay() {
  razorpayScript ??= new Promise((resolve, reject) => {
    const script = Object.assign(document.createElement('script'), { src: 'https://checkout.razorpay.com/v1/checkout.js', async: true });
    script.onload = () => resolve(window.Razorpay);
    script.onerror = () => {
      razorpayScript = undefined;
      reject(new Error('Could not load the payment page. Check the connection and try again.'));
    };
    document.head.append(script);
  });
  return razorpayScript;
}

export default function Billing() {
  const { data, error, reload } = useApi('/vendors/me/subscription');
  const { data: plans } = useApi('/plans', { audience: 'vendor' });
  const { data: catalogue } = useApi('/plans/features');
  const [term, setTerm] = useState(12);
  const [buying, setBuying] = useState(null);
  const [done, setDone] = useState(null);
  const [invoicePage, setInvoicePage] = useState(1);
  const invoices = useApi('/vendors/me/subscription/invoices', { page: invoicePage, limit: 10 });

  const features = catalogue?.features ?? [];
  const sub = data?.subscription;
  const current = !data?.onFreePlan && data?.plan;

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>Plan &amp; billing</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Pay once for 1 or 12 months; there is no automatic renewal. We remind you 7 days and 1 day before your plan ends. If it ends, you move to the free plan and keep all your data.
          </p>
        </div>
      </div>
      <ErrorNote error={error} />
      {done && (
        <div className="vp-status" style={{ background: 'var(--tint-good)', borderColor: 'transparent' }} role="status">
          <Check size={16} />
          <strong>Payment received</strong>
          <span>
            {done.plan?.name} runs until {formatDay(done.subscription?.expiresAt)}. Your GST invoice is below.
          </span>
        </div>
      )}

      {data && (
        <section className="card">
          <div className="card-head">
            <div>
              <div className="kpi-label">Your plan</div>
              <h2 style={{ margin: '2px 0 0' }}>{data.unlimited ? 'No plan needed yet' : data.plan?.name}</h2>
              <div className="small muted">
                {data.unlimited
                  ? 'Nurvia has not set up plans yet, so nothing is limited.'
                  : current
                    ? sub.expiresAt
                      ? `Active until ${formatDay(sub.expiresAt)} · ${sub.daysLeft} day${sub.daysLeft === 1 ? '' : 's'} left${sub.source === 'complimentary' ? ' · complimentary' : ''}`
                      : 'Active, with no end date'
                    : sub?.status === 'expired'
                      ? `Free plan since your ${sub.plan?.name ?? 'paid'} plan ended on ${formatDay(sub.expiresAt)}`
                      : 'Free plan'}
              </div>
            </div>
            {current && sub.expiresAt && sub.daysLeft <= 7 && (
              <button className="primary" onClick={() => setBuying({ plan: plans?.find((p) => p._id === String(data.plan._id)) ?? data.plan, months: term })}>
                Renew now
              </button>
            )}
          </div>
          {!data.unlimited && (
            <div className="vp-grid-2">
              <div className="stack" style={{ gap: 10 }}>
                {LIMITS.map(([key, label]) => (
                  <Usage key={key} label={label} used={data.usage[key]} limit={data.plan?.limits?.[key]} />
                ))}
              </div>
              <ul className="vp-feature-list">
                {features.map((f) => (
                  <li key={f.key} className={data.features[f.key] ? '' : 'off'}>
                    {data.features[f.key] ? <Check size={15} /> : <X size={15} />} {f.label}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {plans && plans.length > 0 && (
        <section className="stack" style={{ gap: 12 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>Plans</h2>
            <div className="segmented" role="group" aria-label="Billing period">
              <button aria-pressed={term === 1} onClick={() => setTerm(1)}>
                Monthly
              </button>
              <button aria-pressed={term === 12} onClick={() => setTerm(12)}>
                Yearly
              </button>
            </div>
          </div>
          <div className="vp-plans">
            {plans.map((plan) => (
              <PlanCard
                key={plan._id}
                plan={plan}
                term={term}
                features={features}
                isCurrent={data && String(data.plan?._id) === plan._id}
                onBuy={() => setBuying({ plan, months: term })}
              />
            ))}
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            Prices exclude GST at {catalogue?.gstRatePct ?? 18}%. Buying your current plan adds the time after its end date. Buying another plan starts it today and replaces the current one.
          </p>
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h2>Invoices</h2>
        </div>
        <ErrorNote error={invoices.error} />
        <Table
          rows={invoices.data?.items}
          empty="No invoices yet. You get one for every plan you buy."
          columns={[
            { label: 'Number', render: (i) => <span className="mono">{i.number}</span> },
            { label: 'Date', render: (i) => formatDay(i.issuedAt) },
            { label: 'For', render: (i) => <span className="small">{i.lines?.[0]?.description}</span> },
            { label: 'Total', num: true, render: (i) => formatRupees(i.totalPaise) },
            { label: '', render: (i) => <PrintInvoice id={i._id} /> },
          ]}
        />
        <Pager data={invoices.data} onPage={setInvoicePage} />
      </section>

      {buying && (
        <Checkout
          plan={buying.plan}
          months={buying.months}
          onClose={() => setBuying(null)}
          onPaid={(result) => {
            setDone(result);
            reload();
            invoices.reload();
          }}
        />
      )}
    </div>
  );
}

function Usage({ label, used, limit }) {
  const unlimited = limit === null || limit === undefined;
  const over = !unlimited && used > limit;
  const pct = unlimited ? 0 : limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100));
  return (
    <div>
      <div className="row small" style={{ justifyContent: 'space-between' }}>
        <span>{label}</span>
        <span className={over ? '' : 'muted'} style={over ? { color: 'var(--critical)', fontWeight: 600 } : undefined}>
          {used} of {unlimited ? 'unlimited' : limit}
        </span>
      </div>
      {!unlimited && (
        <div className="hbar-track" style={{ marginTop: 4 }}>
          <div className="hbar-fill" style={{ width: `${pct}%`, background: pct >= 100 ? 'var(--critical)' : undefined }} />
        </div>
      )}
      {over && <div className="small muted">Over the limit after a plan change: everything is kept, but you cannot add more.</div>}
    </div>
  );
}

function PlanCard({ plan, term, features, isCurrent, onBuy }) {
  const price = term === 12 ? plan.yearlyPricePaise : plan.monthlyPricePaise;
  const saving = plan.monthlyPricePaise && plan.yearlyPricePaise ? Math.round((1 - plan.yearlyPricePaise / (plan.monthlyPricePaise * 12)) * 100) : 0;
  return (
    <div className={`card vp-plan ${isCurrent ? 'current' : ''}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>{plan.name}</h3>
        {isCurrent && <span className="vp-chip">Current</span>}
      </div>
      {plan.description && <p className="small muted" style={{ margin: 0 }}>{plan.description}</p>}
      <div className="vp-plan-price">
        {plan.isFree ? (
          'Free'
        ) : price ? (
          <>
            {rupeesShort(price)}
            <span className="small muted"> / {term === 12 ? 'year' : 'month'} + GST</span>
          </>
        ) : (
          <span className="small muted">Not sold {term === 12 ? 'yearly' : 'monthly'}</span>
        )}
      </div>
      {term === 12 && saving > 0 && !plan.isFree && <div className="small" style={{ color: 'var(--good-ink)' }}>Save {saving}% compared with monthly</div>}
      <ul className="vp-feature-list">
        {plan.highlights?.map((h) => (
          <li key={h}>
            <Check size={15} /> {h}
          </li>
        ))}
        {features.map((f) => (
          <li key={f.key} className={plan.features?.includes(f.key) ? '' : 'off'}>
            {plan.features?.includes(f.key) ? <Check size={15} /> : <X size={15} />} {f.label}
          </li>
        ))}
        {LIMITS.map(([key, label]) => (
          <li key={key} className="small muted" style={{ paddingLeft: 21 }}>
            {label}: {plan.limits?.[key] ?? 'unlimited'}
          </li>
        ))}
      </ul>
      {!plan.isFree && price > 0 && (
        <button className={isCurrent ? '' : 'primary'} onClick={onBuy} style={{ marginTop: 'auto' }}>
          <CreditCard size={15} /> {isCurrent ? 'Renew' : 'Choose'} {plan.name}
        </button>
      )}
    </div>
  );
}

function Checkout({ plan, months, onClose, onPaid }) {
  const { session } = useSession();
  const dialog = useRef(null);
  const { data: quote, error: quoteError } = useApi('/vendors/me/subscription/quote', { planId: plan._id, months });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!dialog.current.open) dialog.current.showModal();
  }, []);

  const finish = (result) => {
    onPaid(result);
    dialog.current?.close();
  };

  const pay = async () => {
    setBusy(true);
    setError(null);
    try {
      const order = await api.post('/vendors/me/subscription/checkout', { planId: plan._id, months });
      // Development without Razorpay keys: the API completes the payment itself.
      if (order.keyId === 'mock') return finish(await api.post('/vendors/me/subscription/mock-pay', { orderId: order.orderId }));
      const Razorpay = await loadRazorpay();
      await new Promise((resolve, reject) => {
        const checkout = new Razorpay({
          key: order.keyId,
          order_id: order.orderId,
          amount: order.amountPaise,
          currency: order.currency,
          name: 'Nurvia',
          description: `${plan.name} plan, ${months === 12 ? '12 months' : '1 month'}`,
          prefill: { name: session.user.name, contact: session.user.phone, email: session.user.email },
          theme: { color: '#1f5c4a' },
          handler: async (response) => {
            try {
              finish(await api.post('/vendors/me/subscription/verify', { orderId: response.razorpay_order_id, paymentId: response.razorpay_payment_id, signature: response.razorpay_signature }));
              resolve();
            } catch (err) {
              reject(err);
            }
          },
          modal: { ondismiss: () => resolve() },
        });
        checkout.on('payment.failed', (response) => reject(new Error(response.error?.description ?? 'The payment failed')));
        checkout.open();
      });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const a = quote?.amounts;
  return (
    <dialog ref={dialog} onClose={onClose} style={{ width: 'min(480px, calc(100vw - 32px))' }}>
      <div className="stack">
        <h2>
          {plan.name}, {months === 12 ? '12 months' : '1 month'}
        </h2>
        <ErrorNote error={quoteError} />
        {quote && (
          <>
            <table className="vp-bill">
              <tbody>
                <tr>
                  <td>{plan.name} plan</td>
                  <td className="num">{formatRupees(a.basePaise)}</td>
                </tr>
                {quote.interState ? (
                  <tr>
                    <td>IGST {a.gstRatePct}%</td>
                    <td className="num">{formatRupees(a.igstPaise)}</td>
                  </tr>
                ) : (
                  <>
                    <tr>
                      <td>CGST {a.gstRatePct / 2}%</td>
                      <td className="num">{formatRupees(a.cgstPaise)}</td>
                    </tr>
                    <tr>
                      <td>SGST {a.gstRatePct / 2}%</td>
                      <td className="num">{formatRupees(a.sgstPaise)}</td>
                    </tr>
                  </>
                )}
                <tr className="total">
                  <td>Total</td>
                  <td className="num">{formatRupees(a.totalPaise)}</td>
                </tr>
              </tbody>
            </table>
            <p className="small muted" style={{ margin: 0 }}>
              Covers {formatDay(quote.period.from)} to {formatDay(quote.period.to)}. Add your GSTIN in KYC &amp; licence before paying to claim input tax credit.
            </p>
            {quote.replacesCurrent && (
              <div className="vp-status warn" style={{ margin: 0 }}>
                <span>This starts today and replaces your current plan. Days left on it are not carried over.</span>
              </div>
            )}
          </>
        )}
        <ErrorNote error={error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" onClick={() => dialog.current.close()} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={pay} disabled={!quote || busy}>
            {busy ? 'Waiting for payment…' : quote ? `Pay ${formatRupees(a.totalPaise)}` : 'Pay'}
          </button>
        </div>
      </div>
    </dialog>
  );
}

function PrintInvoice({ id }) {
  const [error, setError] = useState(null);
  const print = async () => {
    setError(null);
    try {
      printInvoice(await api.get(`/vendors/me/subscription/invoices/${id}`));
    } catch (err) {
      setError(err);
    }
  };
  return (
    <>
      <button onClick={print} title="Print or save as PDF">
        <Printer size={15} /> Print
      </button>
      {error && <div className="small" style={{ color: 'var(--critical)' }}>{error.message}</div>}
    </>
  );
}
