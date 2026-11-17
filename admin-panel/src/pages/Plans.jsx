import { Download, Plus, Printer } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { printInvoice } from '../invoice.js';
import { Badge, ErrorNote, Pager, Table, formatDate, formatDay, formatRupees, useApi } from '../ui.jsx';
import { useFilters } from '../useFilters.js';

// Module 10, vendor SaaS: plans with prices, limits and features; where each vendor's plan stands;
// the GST invoices for plans vendors bought; and Nurvia's details printed on those invoices.
const TABS = { plans: 'Plans', subscriptions: 'Vendor subscriptions', invoices: 'Invoices', billing: 'Invoice details' };
const LIMITS = [
  ['staff', 'Staff seats'],
  ['services', 'Active services'],
  ['products', 'Products'],
  ['customers', 'CRM customers'],
];
const rupees = (paise) => (paise ? String(paise / 100) : '');
const toPaise = (value) => Math.round(Number(value || 0) * 100);
const rupeesShort = (p) => formatRupees(p).replace(/\.00$/, '');

export default function Plans() {
  const [filters, setFilter] = useFilters({ tab: 'plans' });
  const { data: catalogue } = useApi('/plans/features');
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Plans &amp; subscriptions</h1>
          <p className="muted small" style={{ margin: '6px 0 0' }}>
            Vendors buy a plan for 1 or 12 months through Razorpay; GST at {catalogue?.gstRatePct ?? 18}% is added at checkout. Every vendor without a running plan is on the free plan. A lower plan never deletes data: it only stops new staff, services, products or features beyond the plan.
          </p>
        </div>
      </div>
      <section className="card">
        <div className="tabs" role="tablist">
          {Object.entries(TABS).map(([key, label]) => (
            <button key={key} role="tab" aria-selected={key === filters.tab} className={`tab ${key === filters.tab ? 'active' : ''}`} onClick={() => setFilter({ tab: key, status: '', q: '' })}>
              {label}
            </button>
          ))}
        </div>
        {filters.tab === 'plans' && <PlanList features={catalogue?.features ?? []} />}
        {filters.tab === 'subscriptions' && <Subscriptions filters={filters} setFilter={setFilter} />}
        {filters.tab === 'invoices' && <Invoices filters={filters} setFilter={setFilter} />}
        {filters.tab === 'billing' && <BillingProfile />}
      </section>
    </div>
  );
}

/* ───────────── Plans ───────────── */

function PlanList({ features }) {
  const { data, error, reload } = useApi('/admin/plans');
  const [editing, setEditing] = useState(null);
  const label = (key) => features.find((f) => f.key === key)?.label ?? key;
  const vendorPlans = data?.filter((p) => p.audience === 'vendor');
  const hasFree = vendorPlans?.some((p) => p.isFree);

  return (
    <div className="stack" style={{ marginTop: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="small muted">{hasFree === false ? 'No free plan yet: vendors without a paid plan have no limits until you add one.' : 'Vendor plans, in the order vendors see them.'}</span>
        <button className="primary" onClick={() => setEditing({})}>
          <Plus size={16} /> New plan
        </button>
      </div>
      <ErrorNote error={error} />
      <Table
        rows={vendorPlans}
        empty="No vendor plans yet"
        columns={[
          {
            label: 'Plan',
            render: (p) => (
              <>
                <div className="row" style={{ gap: 6 }}>
                  <strong>{p.name}</strong>
                  {p.isFree && <span className="ov-chip">Free plan</span>}
                </div>
                <div className="small muted mono">{p.code}</div>
              </>
            ),
          },
          {
            label: 'Price (excl. GST)',
            render: (p) =>
              p.isFree ? (
                'Free'
              ) : (
                <>
                  {p.monthlyPricePaise ? `${rupeesShort(p.monthlyPricePaise)}/month` : '—'}
                  <div className="small muted">{p.yearlyPricePaise ? `${rupeesShort(p.yearlyPricePaise)}/year` : 'No yearly price'}</div>
                </>
              ),
          },
          {
            label: 'Limits',
            render: (p) => (
              <span className="small">
                {LIMITS.map(([key, name]) => `${name}: ${p.limits?.[key] ?? '∞'}`).join(' · ')}
              </span>
            ),
          },
          { label: 'Features', render: (p) => (p.features?.length ? <span className="small">{p.features.map(label).join(', ')}</span> : <span className="small muted">None</span>) },
          { label: 'Vendors', num: true, render: (p) => (p.isFree ? <span className="small muted">everyone else</span> : p.subscribers) },
          { label: 'Status', render: (p) => <Badge value={p.active ? 'active' : 'hidden'} /> },
          { label: '', render: (p) => <button onClick={() => setEditing(p)}>Edit</button> },
        ]}
      />
      {editing && <PlanEditor plan={editing} features={features} onClose={() => setEditing(null)} onSaved={reload} />}
    </div>
  );
}

function PlanEditor({ plan, features, onClose, onSaved }) {
  const isNew = !plan._id;
  const [form, setForm] = useState(() => ({
    code: plan.code ?? '',
    name: plan.name ?? '',
    description: plan.description ?? '',
    isFree: Boolean(plan.isFree),
    monthly: rupees(plan.monthlyPricePaise),
    yearly: rupees(plan.yearlyPricePaise),
    highlights: (plan.highlights ?? []).join('\n'),
    features: plan.features ?? [],
    limits: Object.fromEntries(LIMITS.map(([k]) => [k, plan.limits?.[k] ?? ''])),
    active: plan.active ?? true,
    sortOrder: plan.sortOrder ?? 0,
  }));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const dialog = useRef(null);
  useEffect(() => {
    if (!dialog.current.open) dialog.current.showModal();
  }, []);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const toggleFeature = (key) => setForm((f) => ({ ...f, features: f.features.includes(key) ? f.features.filter((k) => k !== key) : [...f.features, key] }));
  const monthly = toPaise(form.monthly);
  const yearly = toPaise(form.yearly);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      ...(isNew && { code: form.code.trim().toLowerCase(), audience: 'vendor' }),
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      isFree: form.isFree,
      monthlyPricePaise: form.isFree ? 0 : monthly,
      yearlyPricePaise: form.isFree ? 0 : yearly,
      highlights: form.highlights.split('\n').map((s) => s.trim()).filter(Boolean),
      features: form.features,
      limits: Object.fromEntries(LIMITS.map(([k]) => [k, form.limits[k] === '' ? null : Number(form.limits[k])])),
      active: form.isFree ? true : form.active,
      sortOrder: Number(form.sortOrder) || 0,
    };
    try {
      if (isNew) await api.post('/admin/plans', body);
      else await api.patch(`/admin/plans/${plan._id}`, body);
      onSaved();
      dialog.current.close();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={dialog} onClose={onClose} style={{ width: 'min(620px, calc(100vw - 32px))' }}>
      <form className="stack" onSubmit={save}>
        <h2>{isNew ? 'New vendor plan' : `Edit ${plan.name}`}</h2>
        <div className="grid-fields">
          <label className="field">
            Name
            <input value={form.name} onChange={set('name')} required minLength={2} maxLength={80} placeholder="Pro" autoFocus />
          </label>
          <label className="field">
            Code
            <input className="mono" value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') }))} required minLength={2} maxLength={40} disabled={!isNew} placeholder="vendor-pro" />
          </label>
        </div>
        <label className="field">
          Description
          <input value={form.description} onChange={set('description')} maxLength={500} placeholder="For clinics with a team" />
        </label>
        <label className="choice" style={{ alignSelf: 'flex-start' }}>
          <input type="checkbox" checked={form.isFree} onChange={set('isFree')} /> This is the free plan (vendors fall back to it when a paid plan ends)
        </label>
        {!form.isFree && (
          <div className="grid-fields">
            <label className="field">
              Monthly price (₹, excl. GST)
              <input type="number" min={0} step={0.01} value={form.monthly} onChange={set('monthly')} placeholder="1499" />
            </label>
            <label className="field">
              Yearly price (₹, excl. GST)
              <input type="number" min={0} step={0.01} value={form.yearly} onChange={set('yearly')} placeholder="14990" />
            </label>
          </div>
        )}
        {!form.isFree && monthly > 0 && yearly > 0 && (
          <div className="notice small">
            Twelve months cost {rupeesShort(monthly * 12)} paid monthly, or {rupeesShort(yearly)} paid yearly{yearly < monthly * 12 ? ` (${Math.round((1 - yearly / (monthly * 12)) * 100)}% less)` : ''}. With GST: {rupeesShort(Math.round(monthly * 1.18))} and {rupeesShort(Math.round(yearly * 1.18))}.
          </div>
        )}
        <fieldset className="choices">
          <legend>Limits (empty: unlimited, 0: none)</legend>
          <div className="grid-fields" style={{ width: '100%', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
            {LIMITS.map(([key, name]) => (
              <label key={key} className="field">
                {name}
                <input type="number" min={0} step={1} value={form.limits[key]} placeholder="∞" onChange={(e) => setForm((f) => ({ ...f, limits: { ...f.limits, [key]: e.target.value } }))} />
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="choices">
          <legend>Features</legend>
          {features.map((f) => (
            <label key={f.key} className="choice" title={f.description}>
              <input type="checkbox" checked={form.features.includes(f.key)} onChange={() => toggleFeature(f.key)} /> {f.label}
            </label>
          ))}
        </fieldset>
        <label className="field">
          Selling points, one per line (shown on the plan card)
          <textarea rows={3} value={form.highlights} onChange={set('highlights')} placeholder={'Unlimited staff\nVisit records shared with pet owners'} />
        </label>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <label className="field" style={{ width: 140 }}>
            Order
            <input type="number" value={form.sortOrder} onChange={set('sortOrder')} />
          </label>
          {!form.isFree && (
            <label className="choice">
              <input type="checkbox" checked={form.active} onChange={set('active')} /> Vendors can buy it
            </label>
          )}
        </div>
        <ErrorNote error={error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" onClick={() => dialog.current.close()}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Saving…' : isNew ? 'Create plan' : 'Save changes'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/* ───────────── Vendor subscriptions ───────────── */

const STATUS = { '': 'All vendors', paid: 'On a paid plan', expiring: 'Ending in 7 days', expired: 'Expired', free: 'On the free plan' };

function Subscriptions({ filters, setFilter }) {
  const params = { status: filters.status, q: filters.q, page: filters.page };
  const { data, error, reload } = useApi('/admin/subscriptions', params);
  const [managing, setManaging] = useState(null);

  return (
    <div className="stack" style={{ marginTop: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="segmented" role="group" aria-label="Plan status">
          {Object.entries(STATUS).map(([key, label]) => (
            <button key={key} aria-pressed={(filters.status ?? '') === key} onClick={() => setFilter('status', key)}>
              {label}
            </button>
          ))}
        </div>
        <input type="search" placeholder="Search business name" defaultValue={filters.q ?? ''} onChange={(e) => setFilter('q', e.target.value)} style={{ minWidth: 220 }} />
      </div>
      <ErrorNote error={error} />
      <Table
        rows={data?.items}
        empty="No vendors match"
        columns={[
          {
            label: 'Business',
            render: (v) => (
              <>
                <Link to={`/vendors/${v._id}`}>{v.businessName}</Link>
                <div className="small muted">{v.city}</div>
              </>
            ),
          },
          { label: 'Plan', render: (v) => (v.subscription?.plan ? v.subscription.plan.name : <span className="muted">Free</span>) },
          {
            label: 'Status',
            render: (v) =>
              v.subscription ? (
                <>
                  <Badge value={v.subscription.state} />
                  {v.subscription.source && <div className="small muted">{v.subscription.source === 'purchase' ? 'Bought' : v.subscription.source === 'complimentary' ? 'Complimentary' : 'Assigned by staff'}</div>}
                </>
              ) : (
                <span className="small muted">—</span>
              ),
          },
          {
            label: 'Ends',
            render: (v) =>
              !v.subscription ? (
                '—'
              ) : !v.subscription.expiresAt ? (
                <span className="small">No end date</span>
              ) : (
                <>
                  {formatDay(v.subscription.expiresAt)}
                  {v.subscription.daysLeft !== null && <div className={`small ${v.subscription.daysLeft <= 7 ? '' : 'muted'}`}>{v.subscription.daysLeft} days left</div>}
                </>
              ),
          },
          { label: '', render: (v) => <button onClick={() => setManaging(v)}>Manage</button> },
        ]}
      />
      <Pager data={data} onPage={(page) => setFilter('page', page)} />
      {managing && <ManageSubscription vendor={managing} onClose={() => setManaging(null)} onSaved={reload} />}
    </div>
  );
}

function ManageSubscription({ vendor, onClose, onSaved }) {
  const { data, error, reload } = useApi(`/admin/vendors/${vendor._id}/subscription`);
  const { data: plans } = useApi('/admin/plans');
  const paidPlans = plans?.filter((p) => p.audience === 'vendor' && !p.isFree) ?? [];
  const [assign, setAssign] = useState({ planId: '', duration: 'months', months: 1, days: 30, until: '', complimentary: false, reason: '' });
  const [extend, setExtend] = useState({ days: 30, complimentary: false, reason: '' });
  const [actionError, setActionError] = useState(null);
  const [busy, setBusy] = useState(false);
  const dialog = useRef(null);
  useEffect(() => {
    if (!dialog.current.open) dialog.current.showModal();
  }, []);

  const run = async (fn) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      reload();
      onSaved();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
    }
  };

  const submitAssign = (e) => {
    e.preventDefault();
    const planId = assign.planId || null;
    const length =
      !planId || assign.duration === 'open'
        ? {}
        : assign.duration === 'months'
          ? { months: Number(assign.months) }
          : assign.duration === 'days'
            ? { days: Number(assign.days) }
            : { expiresAt: new Date(`${assign.until}T23:59:59+05:30`).toISOString() };
    run(() => api.put(`/admin/vendors/${vendor._id}/subscription`, { planId, ...length, complimentary: assign.complimentary, reason: assign.reason.trim() }));
  };
  const submitExtend = (e) => {
    e.preventDefault();
    run(() => api.post(`/admin/vendors/${vendor._id}/subscription/extend`, { days: Number(extend.days), complimentary: extend.complimentary, reason: extend.reason.trim() }));
  };

  const sub = data?.subscription;
  return (
    <dialog ref={dialog} onClose={onClose} className="wide">
      <div className="stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>{vendor.businessName}</h2>
          <button onClick={() => dialog.current.close()}>Close</button>
        </div>
        <ErrorNote error={error ?? actionError} />
        {data && (
          <div className="notice">
            {data.onFreePlan ? (
              <>
                On the <strong>{data.plan?.name ?? 'free'}</strong> plan{sub?.status === 'expired' ? `, after ${sub.plan?.name ?? 'a paid plan'} ended ${formatDay(sub.expiresAt)}` : ''}.
              </>
            ) : (
              <>
                On <strong>{data.plan.name}</strong> {sub.expiresAt ? `until ${formatDay(sub.expiresAt)} (${sub.daysLeft} days left)` : 'with no end date'} ·{' '}
                {sub.source === 'purchase' ? 'bought by the vendor' : sub.source === 'complimentary' ? 'complimentary' : 'assigned by staff'}.
              </>
            )}{' '}
            Using {data.usage.staff} staff, {data.usage.services} services, {data.usage.products} products, {data.usage.customers} customers.
          </div>
        )}
        <div className="grid-2" style={{ alignItems: 'start' }}>
          <form className="card stack" onSubmit={submitAssign}>
            <h3 style={{ margin: 0 }}>Assign a plan</h3>
            <label className="field">
              Plan
              <select value={assign.planId} onChange={(e) => setAssign((a) => ({ ...a, planId: e.target.value }))}>
                <option value="">Free plan (end the current plan)</option>
                {paidPlans.map((p) => (
                  <option key={p._id} value={p._id}>
                    {p.name}
                    {p.active ? '' : ' (not on sale)'}
                  </option>
                ))}
              </select>
            </label>
            {assign.planId && (
              <>
                <div className="segmented" role="group" aria-label="Length">
                  {[
                    ['months', 'Months'],
                    ['days', 'Days'],
                    ['until', 'Until a date'],
                    ['open', 'No end'],
                  ].map(([key, label]) => (
                    <button type="button" key={key} aria-pressed={assign.duration === key} onClick={() => setAssign((a) => ({ ...a, duration: key }))}>
                      {label}
                    </button>
                  ))}
                </div>
                {assign.duration === 'months' && <input type="number" min={1} max={36} value={assign.months} onChange={(e) => setAssign((a) => ({ ...a, months: e.target.value }))} aria-label="Months" />}
                {assign.duration === 'days' && <input type="number" min={1} max={1095} value={assign.days} onChange={(e) => setAssign((a) => ({ ...a, days: e.target.value }))} aria-label="Days" />}
                {assign.duration === 'until' && <input type="date" value={assign.until} onChange={(e) => setAssign((a) => ({ ...a, until: e.target.value }))} required aria-label="End date" />}
                <label className="choice" style={{ alignSelf: 'flex-start' }}>
                  <input type="checkbox" checked={assign.complimentary} onChange={(e) => setAssign((a) => ({ ...a, complimentary: e.target.checked }))} /> Complimentary
                </label>
              </>
            )}
            <label className="field">
              Reason (audit log)
              <input value={assign.reason} onChange={(e) => setAssign((a) => ({ ...a, reason: e.target.value }))} required minLength={3} maxLength={300} placeholder="Launch offer for early partners" />
            </label>
            <p className="small muted" style={{ margin: 0 }}>Replaces the current plan from today. No invoice is issued for plans staff assign.</p>
            <button type="submit" className="primary" disabled={busy}>
              {assign.planId ? 'Assign plan' : 'Move to the free plan'}
            </button>
          </form>
          <form className="card stack" onSubmit={submitExtend}>
            <h3 style={{ margin: 0 }}>Extend the current plan</h3>
            <p className="small muted" style={{ margin: 0 }}>
              {sub?.plan ? `Adds days to ${sub.plan.name}${sub.status === 'expired' ? ', starting today because it has ended' : ' after its end date'}.` : 'This vendor has no paid plan to extend.'}
            </p>
            <label className="field">
              Days
              <input type="number" min={1} max={1095} value={extend.days} onChange={(e) => setExtend((x) => ({ ...x, days: e.target.value }))} required />
            </label>
            <label className="choice" style={{ alignSelf: 'flex-start' }}>
              <input type="checkbox" checked={extend.complimentary} onChange={(e) => setExtend((x) => ({ ...x, complimentary: e.target.checked }))} /> Complimentary
            </label>
            <label className="field">
              Reason (audit log)
              <input value={extend.reason} onChange={(e) => setExtend((x) => ({ ...x, reason: e.target.value }))} required minLength={3} maxLength={300} placeholder="Credit for the outage on 12 Nov" />
            </label>
            <button type="submit" disabled={busy || !sub?.plan || !sub?.expiresAt}>
              Extend
            </button>
          </form>
        </div>
        {data?.orders?.length > 0 && (
          <div>
            <h3>Purchases</h3>
            <Table
              rows={data.orders}
              columns={[
                { label: 'Started', render: (o) => formatDate(o.createdAt) },
                { label: 'Plan', render: (o) => `${o.planName}, ${o.months === 12 ? '12 months' : '1 month'}` },
                { label: 'Amount', num: true, render: (o) => formatRupees(o.amounts.totalPaise) },
                { label: 'Status', render: (o) => <Badge value={o.status === 'created' ? 'pending' : o.status} /> },
                { label: 'Covers', render: (o) => (o.period?.from ? `${formatDay(o.period.from)} → ${formatDay(o.period.to)}` : '—') },
              ]}
            />
          </div>
        )}
        {data?.invoices?.length > 0 && (
          <div>
            <h3>Invoices</h3>
            <Table rows={data.invoices} columns={[{ label: 'Number', render: (i) => <span className="mono">{i.number}</span> }, { label: 'Date', render: (i) => formatDay(i.issuedAt) }, { label: 'Total', num: true, render: (i) => formatRupees(i.totalPaise) }, { label: '', render: (i) => <PrintButton id={i._id} /> }]} />
          </div>
        )}
      </div>
    </dialog>
  );
}

/* ───────────── Invoices ───────────── */

function PrintButton({ id }) {
  const [error, setError] = useState(null);
  const print = async () => {
    setError(null);
    try {
      printInvoice(await api.get(`/admin/subscription-invoices/${id}`));
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

const istStart = (date) => (date ? new Date(`${date}T00:00:00+05:30`).toISOString() : undefined);
const istEnd = (date) => (date ? new Date(new Date(`${date}T00:00:00+05:30`).getTime() + 86_400_000).toISOString() : undefined);

function Invoices({ filters, setFilter }) {
  const range = { from: istStart(filters.from), to: istEnd(filters.to) };
  const { data, error } = useApi('/admin/subscription-invoices', { ...range, page: filters.page });
  const [downloadError, setDownloadError] = useState(null);
  const totals = data?.items.reduce((t, i) => ({ taxable: t.taxable + i.taxablePaise, gst: t.gst + i.cgstPaise + i.sgstPaise + i.igstPaise }), { taxable: 0, gst: 0 });
  const download = async () => {
    setDownloadError(null);
    try {
      await api.download('/admin/subscription-invoices', { ...range, format: 'csv' }, 'subscription-invoices.csv');
    } catch (err) {
      setDownloadError(err);
    }
  };

  return (
    <div className="stack" style={{ marginTop: 14 }}>
      <div className="row" style={{ alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label className="field">
            From
            <input type="date" value={filters.from ?? ''} onChange={(e) => setFilter('from', e.target.value)} />
          </label>
          <label className="field">
            To
            <input type="date" value={filters.to ?? ''} onChange={(e) => setFilter('to', e.target.value)} />
          </label>
        </div>
        <button onClick={download}>
          <Download size={16} /> Export CSV for GST filing
        </button>
      </div>
      <ErrorNote error={error ?? downloadError} />
      {data && data.items.length > 0 && (
        <div className="small muted">
          This page: {rupeesShort(totals.taxable)} taxable, {rupeesShort(totals.gst)} GST. The CSV has every invoice in the dates chosen.
        </div>
      )}
      <Table
        rows={data?.items}
        empty="No invoices yet"
        columns={[
          { label: 'Number', render: (i) => <span className="mono">{i.number}</span> },
          { label: 'Date', render: (i) => formatDay(i.issuedAt) },
          {
            label: 'Vendor',
            render: (i) => (
              <>
                <Link to={`/vendors/${i.vendor}`}>{i.recipient?.name}</Link>
                <div className="small muted mono">{i.recipient?.gstin ?? 'Unregistered'}</div>
              </>
            ),
          },
          { label: 'Taxable', num: true, render: (i) => formatRupees(i.taxablePaise) },
          { label: 'GST', num: true, render: (i) => formatRupees(i.cgstPaise + i.sgstPaise + i.igstPaise) },
          { label: 'Total', num: true, render: (i) => formatRupees(i.totalPaise) },
          { label: '', render: (i) => <PrintButton id={i._id} /> },
        ]}
      />
      <Pager data={data} onPage={(page) => setFilter('page', page)} />
    </div>
  );
}

/* ───────────── Billing profile ───────────── */

function BillingProfile() {
  const { data, error } = useApi('/admin/billing-profile');
  const [form, setForm] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setForm(data);
  }, [data]);
  const set = (key) => (e) => {
    setSaved(false);
    setForm((f) => ({ ...f, [key]: e.target.value }));
  };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setSaveError(null);
    try {
      const { defaultSacCode, ...body } = form;
      setForm(await api.put('/admin/billing-profile', { ...body, gstin: body.gstin.trim().toUpperCase() }));
      setSaved(true);
    } catch (err) {
      setSaveError(err);
    } finally {
      setBusy(false);
    }
  };

  if (!form) return <ErrorNote error={error} />;
  return (
    <form className="stack" onSubmit={save} style={{ marginTop: 14, maxWidth: 640 }}>
      <p className="small muted" style={{ margin: 0 }}>
        Printed as the supplier on every plan invoice. The GSTIN's state decides CGST + SGST (vendor in the same state) or IGST. Changes apply to invoices issued from now on.
      </p>
      <div className="grid-fields">
        <label className="field">
          Legal name
          <input value={form.legalName} onChange={set('legalName')} maxLength={160} placeholder="Nurvia Petcare Private Limited" />
        </label>
        <label className="field">
          GSTIN
          <input className="mono" value={form.gstin} onChange={set('gstin')} maxLength={15} placeholder="29ABCDE1234F1Z5" />
        </label>
      </div>
      <label className="field">
        Registered address
        <textarea rows={2} value={form.address} onChange={set('address')} maxLength={300} />
      </label>
      <div className="grid-fields three">
        <label className="field">
          Billing email
          <input type="email" value={form.email} onChange={set('email')} />
        </label>
        <label className="field">
          Phone
          <input value={form.phone} onChange={set('phone')} maxLength={20} />
        </label>
        <label className="field">
          SAC code
          <input className="mono" value={form.sacCode} onChange={set('sacCode')} placeholder={form.defaultSacCode} maxLength={8} />
        </label>
      </div>
      <p className="small muted" style={{ margin: 0 }}>Empty SAC uses {form.defaultSacCode}. Confirm the right code for the subscription service with your accountant.</p>
      <ErrorNote error={saveError} />
      <div className="row">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save invoice details'}
        </button>
        {saved && <span className="small muted">Saved</span>}
      </div>
    </form>
  );
}
