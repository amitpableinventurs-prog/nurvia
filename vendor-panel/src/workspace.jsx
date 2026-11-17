import { Lock } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from './api.js';
import { ErrorNote, formatRupees, istDay, useApi } from './ui.jsx';

// Shared pieces of the workspace screens (calendar, waitlist, packages): picking a customer, the
// appointment form, and the note shown when the plan does not include a feature.

// IST wall-clock date + time → ISO string, and back.
export const ist = (date, time = '00:00') => new Date(`${date}T${time}:00+05:30`).toISOString();
export const istParts = (value) => {
  const shifted = new Date(new Date(value).getTime() + 330 * 60_000).toISOString();
  return { date: shifted.slice(0, 10), time: shifted.slice(11, 16) };
};
export const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

// The plan, its features and limits, for the screens that depend on them.
export function usePlan() {
  return useApi('/vendors/me/subscription');
}

export function UpgradeNote({ feature, children }) {
  return (
    <div className="vp-status warn" role="note" style={{ marginBottom: 0 }}>
      <Lock size={16} />
      <strong>{feature} is not in your plan</strong>
      <span>{children ?? 'What you already have stays here. Upgrade to add more.'}</span>
      <Link to="/billing" className="ov-btn">
        See plans
      </Link>
    </div>
  );
}

// Search the business's customers, or add a new one on the spot.
export function CustomerPicker({ value, onChange }) {
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', phone: '' });
  const [error, setError] = useState(null);
  const { data } = useApi('/vendors/me/customers', { q, limit: 8 }, { enabled: !value && !adding });

  if (value) {
    return (
      <div className="row" style={{ justifyContent: 'space-between', padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 12 }}>
        <div>
          <strong>{value.name}</strong> <span className="small muted">{value.phone}</span>
        </div>
        <button type="button" className="link small" onClick={() => onChange(null)}>
          Change
        </button>
      </div>
    );
  }

  const create = async () => {
    setError(null);
    try {
      const phone = draft.phone.replace(/[\s-]/g, '');
      onChange(await api.post('/vendors/me/customers', { name: draft.name.trim(), ...(phone && { phone: phone.startsWith('+') ? phone : `+91${phone}` }), source: 'walk_in' }));
      setAdding(false);
    } catch (err) {
      setError(err);
    }
  };

  if (adding) {
    return (
      <div className="stack" style={{ gap: 8 }}>
        <div className="row">
          <input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="Customer name" maxLength={120} style={{ flex: 1 }} autoFocus />
          <input value={draft.phone} onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))} placeholder="Mobile (optional)" inputMode="tel" maxLength={16} style={{ width: 160 }} />
        </div>
        <div className="row">
          <button type="button" className="primary" onClick={create} disabled={!draft.name.trim()}>
            Add customer
          </button>
          <button type="button" onClick={() => setAdding(false)}>
            Back to search
          </button>
        </div>
        <ErrorNote error={error} />
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 6 }}>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, phone or pet" autoFocus />
      <div className="vp-pick-list">
        {data?.items.map((c) => (
          <button type="button" key={c._id} onClick={() => onChange(c)}>
            <strong>{c.name}</strong>
            <span className="small muted">
              {[c.phone, c.pets?.map((p) => p.name).join(', ')].filter(Boolean).join(' · ')}
            </span>
          </button>
        ))}
        {data && !data.items.length && <div className="small muted" style={{ padding: 6 }}>No customer found</div>}
      </div>
      <button type="button" className="link small" style={{ alignSelf: 'flex-start' }} onClick={() => setAdding(true)}>
        + New customer
      </button>
    </div>
  );
}

const REPEAT = { '': 'Does not repeat', weekly: 'Every week', fortnightly: 'Every 2 weeks', monthly: 'Every month' };

// New appointment for a customer from outside Nurvia (or a regular). `initial` can preset the
// customer, service and date, e.g. when booking someone off the waitlist.
export function AppointmentDialog({ initial = {}, onClose, onSaved }) {
  const dialog = useRef(null);
  const { data: services } = useApi('/vendors/me/services');
  const { data: staff } = useApi('/vendors/me/staff');
  const [customer, setCustomer] = useState(initial.customer ?? null);
  const { data: detail } = useApi(customer ? `/vendors/me/customers/${customer._id}` : null);
  const [form, setForm] = useState({
    serviceId: initial.serviceId ?? null, // null: the first service
    serviceName: '',
    price: '',
    date: initial.date ?? istDay(0),
    time: initial.time ?? '10:00',
    durationMin: '',
    staffId: '',
    petId: '',
    customerPackageId: '',
    repeat: '',
    count: 4,
    paidOffline: false,
    notes: '',
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!dialog.current.open) dialog.current.showModal();
  }, []);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const active = services?.filter((s) => s.active) ?? [];
  const serviceId = form.serviceId ?? active[0]?._id ?? '';
  const service = active.find((s) => s._id === serviceId);
  const packages = detail?.packages?.filter((p) => p.sessionsUsed < p.sessionsTotal && (!p.expiresAt || new Date(p.expiresAt) > new Date())) ?? [];

  const save = async (e) => {
    e.preventDefault();
    if (!customer) return setError(new Error('Choose a customer'));
    setBusy(true);
    setError(null);
    const body = {
      customerId: customer._id,
      ...(form.petId && { petId: form.petId }),
      ...(serviceId ? { serviceId } : { serviceName: form.serviceName.trim() }),
      ...(form.price !== '' && { pricePaise: Math.round(Number(form.price) * 100) }),
      scheduledAt: ist(form.date, form.time),
      ...(form.durationMin && { durationMin: Number(form.durationMin) }),
      ...(form.staffId && { staffId: form.staffId }),
      ...(form.customerPackageId && { customerPackageId: form.customerPackageId }),
      ...(form.repeat && { recurrence: { rule: form.repeat, count: Number(form.count) } }),
      paidOffline: form.paidOffline,
      ...(form.notes.trim() && { notes: form.notes.trim() }),
    };
    try {
      const created = await api.post('/vendors/me/appointments', body);
      onSaved?.(Array.isArray(created) ? created[0] : created);
      dialog.current.close();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={dialog} onClose={onClose} style={{ width: 'min(600px, calc(100vw - 32px))' }}>
      <form className="stack" onSubmit={save}>
        <h2>New appointment</h2>
        <div className="field">
          Customer
          <CustomerPicker value={customer} onChange={setCustomer} />
        </div>
        {customer && (
          <div className="vp-grid-2">
            <label className="field">
              Pet
              <select value={form.petId} onChange={set('petId')}>
                <option value="">{detail?.pets?.length ? 'First pet on record' : 'No pet on record'}</option>
                {detail?.pets?.map((p) => (
                  <option key={p._id} value={p._id}>
                    {p.name} {p.species ? `(${p.species})` : ''}
                  </option>
                ))}
              </select>
            </label>
            {packages.length > 0 && (
              <label className="field">
                Use a package
                <select value={form.customerPackageId} onChange={set('customerPackageId')}>
                  <option value="">No package</option>
                  {packages.map((p) => (
                    <option key={p._id} value={p._id}>
                      {p.name} ({p.sessionsTotal - p.sessionsUsed} left)
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
        <div className="vp-grid-2">
          <label className="field">
            Service
            <select value={serviceId} onChange={set('serviceId')}>
              {active.map((s) => (
                <option key={s._id} value={s._id}>
                  {s.name} · {formatRupees(s.pricePaise)} · {s.durationMin} min
                </option>
              ))}
              <option value="">Something else…</option>
            </select>
          </label>
          {!serviceId && (
            <label className="field">
              What for
              <input value={form.serviceName} onChange={set('serviceName')} required maxLength={120} placeholder="Nail trim" />
            </label>
          )}
        </div>
        <div className="vp-grid-2">
          <label className="field">
            Date
            <input type="date" value={form.date} onChange={set('date')} required />
          </label>
          <label className="field">
            Time
            <input type="time" value={form.time} onChange={set('time')} required step={300} />
          </label>
          <label className="field">
            Minutes
            <input type="number" min={5} max={1440} value={form.durationMin} onChange={set('durationMin')} placeholder={String(service?.durationMin ?? 30)} />
          </label>
          <label className="field">
            Price (₹)
            <input type="number" min={0} step={1} value={form.price} onChange={set('price')} placeholder={service ? String(service.pricePaise / 100) : '0'} />
          </label>
        </div>
        <div className="vp-grid-2">
          <label className="field">
            Staff
            <select value={form.staffId} onChange={set('staffId')}>
              <option value="">Anyone</option>
              {staff
                ?.filter((s) => s.active)
                .map((s) => (
                  <option key={s._id} value={s._id}>
                    {s.name} ({s.role.replaceAll('_', ' ')})
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            Repeat
            <select value={form.repeat} onChange={set('repeat')}>
              {Object.entries(REPEAT).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {form.repeat && (
            <label className="field">
              Number of visits
              <input type="number" min={2} max={52} value={form.count} onChange={set('count')} />
            </label>
          )}
        </div>
        <label className="field">
          Notes
          <input value={form.notes} onChange={set('notes')} maxLength={1000} placeholder="Nervous around dryers" />
        </label>
        <label className="row small" style={{ gap: 8 }}>
          <input type="checkbox" checked={form.paidOffline} onChange={set('paidOffline')} /> Already paid at the counter
        </label>
        <ErrorNote error={error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" onClick={() => dialog.current.close()}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Saving…' : form.repeat ? `Book ${form.count} visits` : 'Book appointment'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
