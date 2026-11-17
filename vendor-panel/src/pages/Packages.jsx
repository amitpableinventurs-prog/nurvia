import { Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Badge, ErrorNote, Table, formatRupees, useApi } from '../ui.jsx';
import { CustomerPicker, UpgradeNote, usePlan } from '../workspace.jsx';

// Multi-session packages ("5 baths for ₹2,000"). A sold package is used up one session per
// completed appointment booked against it.
export default function Packages() {
  const { data, error, reload } = useApi('/vendors/me/packages');
  const { data: plan } = usePlan();
  const [editing, setEditing] = useState(null);
  const [selling, setSelling] = useState(null);
  const allowed = plan?.features?.packages !== false;

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>Service packages</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>Sell sessions in advance. Pick the package when you book an appointment and a session is used when it is completed.</p>
        </div>
        {allowed && (
          <button className="primary" onClick={() => setEditing({})}>
            <Plus size={16} /> New package
          </button>
        )}
      </div>
      {plan && !allowed && <UpgradeNote feature="Service packages">Packages you already sold keep working. Upgrade to create or sell more.</UpgradeNote>}
      <ErrorNote error={error} />
      <section className="card">
        <Table
          rows={data}
          empty="No packages yet"
          columns={[
            {
              label: 'Package',
              render: (p) => (
                <>
                  <strong>{p.name}</strong>
                  {p.description && <div className="small muted">{p.description}</div>}
                </>
              ),
            },
            { label: 'Services', render: (p) => <span className="small">{p.services?.map((s) => s.name).join(', ') || 'Any'}</span> },
            { label: 'Sessions', num: true, render: (p) => p.sessions },
            { label: 'Price', num: true, render: (p) => formatRupees(p.pricePaise) },
            { label: 'Valid for', render: (p) => (p.validityDays ? `${p.validityDays} days` : 'No expiry') },
            { label: 'Status', render: (p) => <Badge value={p.active ? 'active' : 'hidden'} /> },
            {
              label: '',
              render: (p) =>
                allowed && (
                  <div className="row" style={{ flexWrap: 'nowrap' }}>
                    {p.active && (
                      <button className="primary" onClick={() => setSelling(p)}>
                        Sell
                      </button>
                    )}
                    <button onClick={() => setEditing(p)}>Edit</button>
                  </div>
                ),
            },
          ]}
        />
      </section>
      {editing && <PackageEditor pkg={editing} onClose={() => setEditing(null)} onSaved={reload} />}
      {selling && <SellPackage pkg={selling} onClose={() => setSelling(null)} />}
    </div>
  );
}

function PackageEditor({ pkg, onClose, onSaved }) {
  const dialog = useRef(null);
  const { data: services } = useApi('/vendors/me/services');
  const [form, setForm] = useState(() => ({
    name: pkg.name ?? '',
    description: pkg.description ?? '',
    serviceIds: pkg.services?.map((s) => s._id ?? s) ?? [],
    sessions: pkg.sessions ?? 5,
    price: pkg.pricePaise ? String(pkg.pricePaise / 100) : '',
    validityDays: pkg.validityDays ?? '',
    active: pkg.active ?? true,
  }));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!dialog.current.open) dialog.current.showModal();
  }, []);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const toggle = (id) => setForm((f) => ({ ...f, serviceIds: f.serviceIds.includes(id) ? f.serviceIds.filter((s) => s !== id) : [...f.serviceIds, id] }));

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      serviceIds: form.serviceIds,
      sessions: Number(form.sessions),
      pricePaise: Math.round(Number(form.price) * 100),
      ...(form.validityDays !== '' && { validityDays: Number(form.validityDays) }),
      active: form.active,
    };
    try {
      if (pkg._id) await api.patch(`/vendors/me/packages/${pkg._id}`, body);
      else await api.post('/vendors/me/packages', body);
      onSaved();
      dialog.current.close();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={dialog} onClose={onClose} style={{ width: 'min(540px, calc(100vw - 32px))' }}>
      <form className="stack" onSubmit={save}>
        <h2>{pkg._id ? `Edit ${pkg.name}` : 'New package'}</h2>
        <label className="field">
          Name
          <input value={form.name} onChange={set('name')} required maxLength={120} placeholder="5 grooming sessions" autoFocus />
        </label>
        <label className="field">
          Description
          <input value={form.description} onChange={set('description')} maxLength={1000} placeholder="Bath, brush and nail trim" />
        </label>
        <div className="vp-grid-2">
          <label className="field">
            Sessions
            <input type="number" min={1} max={365} value={form.sessions} onChange={set('sessions')} required />
          </label>
          <label className="field">
            Price (₹)
            <input type="number" min={0} step={1} value={form.price} onChange={set('price')} required />
          </label>
          <label className="field">
            Valid for (days)
            <input type="number" min={1} max={1095} value={form.validityDays} onChange={set('validityDays')} placeholder="No expiry" />
          </label>
        </div>
        {services?.length > 0 && (
          <div className="field">
            Services it covers (none: any)
            <div className="row" style={{ gap: 6 }}>
              {services
                .filter((s) => s.active || form.serviceIds.includes(s._id))
                .map((s) => (
                  <label key={s._id} className="vp-chip" style={{ cursor: 'pointer' }}>
                    <input type="checkbox" checked={form.serviceIds.includes(s._id)} onChange={() => toggle(s._id)} /> {s.name}
                  </label>
                ))}
            </div>
          </div>
        )}
        {form.sessions > 0 && form.price > 0 && (
          <div className="small muted">{formatRupees(Math.round((Number(form.price) * 100) / Number(form.sessions)))} a session.</div>
        )}
        <label className="row small" style={{ gap: 8 }}>
          <input type="checkbox" checked={form.active} onChange={set('active')} /> On sale
        </label>
        <ErrorNote error={error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" onClick={() => dialog.current.close()}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save package'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function SellPackage({ pkg, onClose }) {
  const dialog = useRef(null);
  const [customer, setCustomer] = useState(null);
  const [paidOffline, setPaidOffline] = useState(true);
  const [sold, setSold] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!dialog.current.open) dialog.current.showModal();
  }, []);

  const sell = async () => {
    setError(null);
    try {
      setSold(await api.post(`/vendors/me/customers/${customer._id}/packages`, { packageId: pkg._id, paidOffline }));
    } catch (err) {
      setError(err);
    }
  };

  return (
    <dialog ref={dialog} onClose={onClose} style={{ width: 'min(480px, calc(100vw - 32px))' }}>
      <div className="stack">
        <h2>Sell {pkg.name}</h2>
        {sold ? (
          <p>
            Sold to {customer.name}: {sold.sessionsTotal} sessions for {formatRupees(sold.pricePaise)}. Choose the package when you book their appointments.
          </p>
        ) : (
          <>
            <div className="field">
              Customer
              <CustomerPicker value={customer} onChange={setCustomer} />
            </div>
            <label className="row small" style={{ gap: 8 }}>
              <input type="checkbox" checked={paidOffline} onChange={(e) => setPaidOffline(e.target.checked)} /> Paid at the counter ({formatRupees(pkg.pricePaise)})
            </label>
          </>
        )}
        <ErrorNote error={error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={() => dialog.current.close()}>{sold ? 'Done' : 'Cancel'}</button>
          {!sold && (
            <button className="primary" onClick={sell} disabled={!customer}>
              Sell package
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}
