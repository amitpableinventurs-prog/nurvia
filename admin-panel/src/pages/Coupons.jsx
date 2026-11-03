import { BadgePercent, Plus, TicketPercent } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { ErrorNote, SchedulePill, Table, formatDay, formatRupees, fromLocalInput, scheduleState, toLocalInput, useApi, useConfirm } from '../ui.jsx';
import { useFilters } from '../useFilters.js';

// Cart offers in the shop. A coupon needs its code entered at checkout; an automatic discount is
// applied without one. Each order gets one offer: a valid entered code, else the best automatic one.
const KINDS = { all: 'All offers', code: 'Coupon codes', auto: 'Automatic discounts' };
const EMPTY = { autoApply: false, code: '', description: '', type: 'percent', value: '', maxDiscount: '', minOrder: '', startsAt: '', expiresAt: '', active: true };

const rupees = (paise) => (paise ? String(paise / 100) : '');
const paise = (value) => (value === '' || value === null ? null : Math.round(Number(value) * 100));
const rupeesShort = (p) => formatRupees(p).replace(/\.00$/, '');

// Same rule as checkout (shop.service.js): percent of the cart, capped, never more than the cart.
const amountOff = (c, cartPaise) => {
  const off = c.type === 'percent' ? Math.floor((cartPaise * c.value) / 100) : c.value;
  return Math.min(c.maxDiscountPaise ? Math.min(off, c.maxDiscountPaise) : off, cartPaise);
};

export const describeOffer = (c) => {
  const off = c.type === 'percent' ? `${c.value}% off` : `${rupeesShort(c.value)} off`;
  const cap = c.type === 'percent' && c.maxDiscountPaise ? ` up to ${rupeesShort(c.maxDiscountPaise)}` : '';
  const min = c.minOrderPaise ? ` on orders of ${rupeesShort(c.minOrderPaise)}+` : '';
  return off + cap + min;
};

export default function Coupons() {
  const [filters, setFilter] = useFilters({ kind: 'all' });
  const { data, error, reload } = useApi('/admin/coupons');
  const [editing, setEditing] = useState(null); // null: closed; { autoApply }: new; a coupon: edit
  const [actionError, setActionError] = useState(null);
  const [confirm, confirmDialog] = useConfirm();

  const run = async (fn) => {
    setActionError(null);
    try {
      await fn();
      reload();
    } catch (err) {
      setActionError(err);
    }
  };

  const rows = data?.filter((c) => filters.kind === 'all' || (filters.kind === 'auto') === Boolean(c.autoApply));
  const live = data?.filter((c) => scheduleState(c) === 'live') ?? [];
  const used = data?.reduce((n, c) => ({ orders: n.orders + c.usage.orders, discountPaise: n.discountPaise + c.usage.discountPaise }), { orders: 0, discountPaise: 0 });

  return (
    <div className="stack">
      {confirmDialog}
      <div className="page-head">
        <div>
          <h1>Discounts &amp; coupons</h1>
          <p className="muted small" style={{ margin: '6px 0 0' }}>
            Coupons apply when the customer enters the code. Automatic discounts apply at checkout by themselves. An order gets one: a valid code it entered, otherwise the best automatic discount it qualifies for.
          </p>
        </div>
        <div className="row">
          <button onClick={() => setEditing({ autoApply: true })}>
            <BadgePercent size={16} /> New discount
          </button>
          <button className="primary" onClick={() => setEditing({ autoApply: false })}>
            <Plus size={16} /> New coupon
          </button>
        </div>
      </div>

      {data && (
        <div className="tiles">
          <div className="tile">
            <div className="small muted">Live coupon codes</div>
            <div className="kpi-value">{live.filter((c) => !c.autoApply).length}</div>
          </div>
          <div className="tile">
            <div className="small muted">Live automatic discounts</div>
            <div className="kpi-value">{live.filter((c) => c.autoApply).length}</div>
          </div>
          <div className="tile">
            <div className="small muted">Orders with an offer</div>
            <div className="kpi-value">{used.orders.toLocaleString('en-IN')}</div>
          </div>
          <div className="tile">
            <div className="small muted">Discount given</div>
            <div className="kpi-value">{rupeesShort(used.discountPaise)}</div>
          </div>
        </div>
      )}

      <ErrorNote error={error ?? actionError} />
      <section className="card">
        <div className="tabs" role="tablist">
          {Object.entries(KINDS).map(([kind, label]) => (
            <button key={kind} role="tab" aria-selected={kind === filters.kind} className={`tab ${kind === filters.kind ? 'active' : ''}`} onClick={() => setFilter('kind', kind)}>
              {label}
            </button>
          ))}
        </div>
        <Table
          rows={rows}
          empty={filters.kind === 'auto' ? 'No automatic discounts yet' : filters.kind === 'code' ? 'No coupon codes yet' : 'No offers yet'}
          columns={[
            {
              label: 'Offer',
              render: (c) => (
                <>
                  <div className="row" style={{ gap: 6 }}>
                    {c.autoApply ? <BadgePercent size={15} className="muted" aria-hidden /> : <TicketPercent size={15} className="muted" aria-hidden />}
                    <strong className="mono" style={{ fontSize: 13 }}>{c.code}</strong>
                    <span className="ov-chip">{c.autoApply ? 'Automatic' : 'Code'}</span>
                  </div>
                  {c.description && <div className="small muted">{c.description}</div>}
                </>
              ),
            },
            { label: 'Discount', render: (c) => describeOffer(c) },
            { label: 'Runs', render: (c) => <span className="small">{c.startsAt ? formatDay(c.startsAt) : 'Now'} → {c.expiresAt ? formatDay(c.expiresAt) : 'no end'}</span> },
            {
              label: 'Used',
              num: true,
              render: (c) => (
                <>
                  {c.usage.orders.toLocaleString('en-IN')} {c.usage.orders === 1 ? 'order' : 'orders'}
                  {c.usage.discountPaise > 0 && <div className="small muted">{rupeesShort(c.usage.discountPaise)} off</div>}
                </>
              ),
            },
            { label: 'Status', render: (c) => <SchedulePill item={c} /> },
            {
              label: 'Actions',
              render: (c) => (
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <button onClick={() => setEditing(c)}>Edit</button>
                  <button onClick={() => run(() => api.patch(`/admin/coupons/${c._id}`, { active: !c.active }))}>{c.active ? 'Turn off' : 'Turn on'}</button>
                  {c.usage.orders === 0 && (
                    <button
                      className="danger"
                      onClick={() =>
                        confirm({
                          title: `Delete ${c.code}?`,
                          message: 'No order has used it, so it can be deleted. The code becomes free to reuse.',
                          confirmLabel: 'Delete',
                          danger: true,
                          onConfirm: async () => {
                            await api.delete(`/admin/coupons/${c._id}`);
                            reload();
                          },
                        })
                      }
                    >
                      Delete
                    </button>
                  )}
                </div>
              ),
            },
          ]}
        />
      </section>
      {editing && <CouponEditor coupon={editing} onClose={() => setEditing(null)} onSaved={reload} />}
    </div>
  );
}

function CouponEditor({ coupon, onClose, onSaved }) {
  const isNew = !coupon._id;
  const [form, setForm] = useState(() =>
    isNew
      ? { ...EMPTY, autoApply: coupon.autoApply }
      : {
          autoApply: Boolean(coupon.autoApply),
          code: coupon.code,
          description: coupon.description ?? '',
          type: coupon.type,
          value: coupon.type === 'flat' ? rupees(coupon.value) : String(coupon.value),
          maxDiscount: rupees(coupon.maxDiscountPaise),
          minOrder: rupees(coupon.minOrderPaise),
          startsAt: toLocalInput(coupon.startsAt),
          expiresAt: toLocalInput(coupon.expiresAt),
          active: coupon.active,
        },
  );
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const dialog = useRef(null);
  useEffect(() => {
    if (!dialog.current.open) dialog.current.showModal();
  }, []);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const percent = form.type === 'percent';
  const value = percent ? Math.round(Number(form.value)) : paise(form.value);
  const draft = { type: form.type, value: value || 0, maxDiscountPaise: percent ? paise(form.maxDiscount) : null, minOrderPaise: paise(form.minOrder) ?? 0 };
  const exampleCart = Math.max(draft.minOrderPaise, 100_000);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      ...(isNew && { code: form.code.trim().toUpperCase() }),
      autoApply: form.autoApply,
      description: form.description.trim() || null,
      type: form.type,
      value,
      maxDiscountPaise: draft.maxDiscountPaise,
      minOrderPaise: draft.minOrderPaise,
      startsAt: fromLocalInput(form.startsAt),
      expiresAt: fromLocalInput(form.expiresAt),
      active: form.active,
    };
    try {
      if (isNew) await api.post('/admin/coupons', body);
      else await api.patch(`/admin/coupons/${coupon._id}`, body);
      onSaved();
      dialog.current.close();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const noun = form.autoApply ? 'discount' : 'coupon';
  return (
    <dialog ref={dialog} onClose={onClose} style={{ width: 'min(560px, calc(100vw - 32px))' }}>
      <form className="stack" onSubmit={save}>
        <h2>{isNew ? `New ${noun}` : `Edit ${form.code}`}</h2>
        <div className="segmented" role="group" aria-label="How it applies">
          <button type="button" aria-pressed={!form.autoApply} onClick={() => setForm((f) => ({ ...f, autoApply: false }))}>
            <TicketPercent size={15} /> Coupon code
          </button>
          <button type="button" aria-pressed={form.autoApply} onClick={() => setForm((f) => ({ ...f, autoApply: true }))}>
            <BadgePercent size={15} /> Automatic discount
          </button>
        </div>
        <p className="small muted" style={{ margin: '-6px 0 0' }}>
          {form.autoApply ? 'Applied at checkout to every cart that qualifies; nothing to enter. The code below is shown on the order.' : 'Applied only when the customer enters the code at checkout.'}
        </p>
        <div className="grid-fields">
          <label className="field">
            Code
            <input
              className="mono"
              value={form.code}
              onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') }))}
              required
              minLength={3}
              maxLength={20}
              disabled={!isNew}
              placeholder={form.autoApply ? 'DIWALI10' : 'WELCOME10'}
              autoFocus={isNew}
            />
          </label>
          <label className="field">
            Discount type
            <select value={form.type} onChange={set('type')}>
              <option value="percent">Percentage off</option>
              <option value="flat">Fixed amount off (₹)</option>
            </select>
          </label>
        </div>
        <label className="field">
          Description shown to customers
          <input value={form.description} onChange={set('description')} maxLength={200} placeholder="10% off your first order (up to ₹200)" />
        </label>
        <div className="grid-fields three">
          <label className="field">
            {percent ? 'Percent off' : 'Amount off (₹)'}
            <input type="number" min={1} max={percent ? 90 : undefined} step={percent ? 1 : 0.01} value={form.value} onChange={set('value')} required />
          </label>
          <label className="field">
            Max discount (₹)
            <input type="number" min={1} step={0.01} value={percent ? form.maxDiscount : ''} onChange={set('maxDiscount')} disabled={!percent} placeholder={percent ? 'No cap' : '—'} />
          </label>
          <label className="field">
            Min order (₹)
            <input type="number" min={0} step={0.01} value={form.minOrder} onChange={set('minOrder')} placeholder="None" />
          </label>
        </div>
        <div className="grid-fields">
          <label className="field">
            Starts
            <input type="datetime-local" value={form.startsAt} onChange={set('startsAt')} />
          </label>
          <label className="field">
            Ends
            <input type="datetime-local" value={form.expiresAt} onChange={set('expiresAt')} min={form.startsAt || undefined} />
          </label>
        </div>
        <label className="choice">
          <input type="checkbox" checked={form.active} onChange={set('active')} /> Switched on
        </label>
        {value > 0 && (
          <div className="notice small">
            <strong>{describeOffer(draft)}</strong>
            {form.autoApply ? ', applied automatically.' : `, with code ${form.code || '…'}.`} Example: a {rupeesShort(exampleCart)} cart gets {rupeesShort(amountOff(draft, exampleCart))} off.
          </div>
        )}
        <ErrorNote error={error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" onClick={() => dialog.current.close()}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Saving…' : isNew ? `Create ${noun}` : 'Save changes'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
