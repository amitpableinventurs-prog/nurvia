import { Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { ErrorNote, Table, ago, formatDay, useApi } from '../ui.jsx';
import { AppointmentDialog, CustomerPicker, ist } from '../workspace.jsx';

// Customers waiting for a slot. When one opens, offer it, then book it straight from the list.
const TABS = { waiting: 'Waiting', offered: 'Offered a slot', booked: 'Booked', removed: 'Removed' };

export default function Waitlist() {
  const [status, setStatus] = useState('waiting');
  const { data, error, reload } = useApi('/vendors/me/waitlist', { status });
  const [adding, setAdding] = useState(false);
  const [booking, setBooking] = useState(null);
  const [actionError, setActionError] = useState(null);

  const update = async (entry, body) => {
    setActionError(null);
    try {
      await api.patch(`/vendors/me/waitlist/${entry._id}`, body);
      reload();
    } catch (err) {
      setActionError(err);
    }
  };

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>Waitlist</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>Keep a list of customers who want an earlier or busier slot, and book them when one opens.</p>
        </div>
        <button className="primary" onClick={() => setAdding(true)}>
          <Plus size={16} /> Add to waitlist
        </button>
      </div>
      <section className="card">
        <div className="tabs" role="tablist">
          {Object.entries(TABS).map(([key, label]) => (
            <button key={key} role="tab" aria-selected={key === status} className={`tab ${key === status ? 'active' : ''}`} onClick={() => setStatus(key)}>
              {label}
            </button>
          ))}
        </div>
        <ErrorNote error={error ?? actionError} />
        <Table
          rows={data}
          empty={status === 'waiting' ? 'Nobody is waiting' : 'Nothing here'}
          columns={[
            {
              label: 'Customer',
              render: (e) => (
                <>
                  <strong>{e.customer?.name}</strong>
                  <div className="small muted">{e.customer?.phone}</div>
                </>
              ),
            },
            { label: 'For', render: (e) => e.service?.name ?? <span className="muted">Any service</span> },
            {
              label: 'Preferred',
              render: (e) => (e.preferredFrom || e.preferredTo ? <span className="small">{formatDay(e.preferredFrom)} → {formatDay(e.preferredTo)}</span> : <span className="small muted">Any time</span>),
            },
            { label: 'Note', render: (e) => <span className="small">{e.note}</span> },
            { label: 'Added', render: (e) => <span className="small muted">{ago(e.createdAt)}</span> },
            {
              label: '',
              render: (e) =>
                ['waiting', 'offered'].includes(e.status) && (
                  <div className="row" style={{ flexWrap: 'nowrap' }}>
                    <button className="primary" onClick={() => setBooking(e)}>
                      Book
                    </button>
                    {e.status === 'waiting' && <button onClick={() => update(e, { status: 'offered' })}>Offered</button>}
                    <button onClick={() => update(e, { status: 'removed' })}>Remove</button>
                  </div>
                ),
            },
          ]}
        />
      </section>
      {adding && <AddEntry onClose={() => setAdding(false)} onSaved={reload} />}
      {booking && (
        <AppointmentDialog
          initial={{ customer: booking.customer, serviceId: booking.service?._id ?? null }}
          onClose={() => setBooking(null)}
          onSaved={async (appointment) => {
            await update(booking, { status: 'booked', appointmentId: appointment._id });
          }}
        />
      )}
    </div>
  );
}

function AddEntry({ onClose, onSaved }) {
  const dialog = useRef(null);
  const { data: services } = useApi('/vendors/me/services');
  const [customer, setCustomer] = useState(null);
  const [form, setForm] = useState({ serviceId: '', from: '', to: '', note: '' });
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!dialog.current.open) dialog.current.showModal();
  }, []);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const save = async (e) => {
    e.preventDefault();
    if (!customer) return setError(new Error('Choose a customer'));
    setError(null);
    try {
      await api.post('/vendors/me/waitlist', {
        customerId: customer._id,
        ...(form.serviceId && { serviceId: form.serviceId }),
        ...(form.from && { preferredFrom: ist(form.from) }),
        ...(form.to && { preferredTo: ist(form.to, '23:59') }),
        ...(form.note.trim() && { note: form.note.trim() }),
      });
      onSaved();
      dialog.current.close();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <dialog ref={dialog} onClose={onClose} style={{ width: 'min(520px, calc(100vw - 32px))' }}>
      <form className="stack" onSubmit={save}>
        <h2>Add to waitlist</h2>
        <div className="field">
          Customer
          <CustomerPicker value={customer} onChange={setCustomer} />
        </div>
        <label className="field">
          Service
          <select value={form.serviceId} onChange={set('serviceId')}>
            <option value="">Any service</option>
            {services
              ?.filter((s) => s.active)
              .map((s) => (
                <option key={s._id} value={s._id}>
                  {s.name}
                </option>
              ))}
          </select>
        </label>
        <div className="vp-grid-2">
          <label className="field">
            Earliest date
            <input type="date" value={form.from} onChange={set('from')} />
          </label>
          <label className="field">
            Latest date
            <input type="date" value={form.to} onChange={set('to')} min={form.from || undefined} />
          </label>
        </div>
        <label className="field">
          Note
          <input value={form.note} onChange={set('note')} maxLength={500} placeholder="Mornings only, prefers Dr. Nisha" />
        </label>
        <ErrorNote error={error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" onClick={() => dialog.current.close()}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Add
          </button>
        </div>
      </form>
    </dialog>
  );
}
