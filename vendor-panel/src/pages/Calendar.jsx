import { ChevronLeft, ChevronRight, Plus, Repeat } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Badge, ErrorNote, formatRupees, formatTime, istDay, useApi } from '../ui.jsx';
import { AppointmentDialog, addDays, ist, istParts } from '../workspace.jsx';

// The week's Nurvia bookings and the business's own appointments together, one day per column on
// wide screens and one under another on a phone.
const weekStart = (date) => addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));
const dayLabel = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

// What an appointment can move to from where it is (operations.routes.js APPOINTMENT_FLOW).
const NEXT = {
  scheduled: ['confirmed', 'checked_in', 'completed', 'no_show', 'cancelled'],
  confirmed: ['checked_in', 'completed', 'no_show', 'cancelled'],
  checked_in: ['completed'],
};
const ACTION_LABELS = { confirmed: 'Confirm', checked_in: 'Check in', completed: 'Complete', no_show: 'No-show', cancelled: 'Cancel' };

export default function Calendar() {
  const [start, setStart] = useState(() => weekStart(istDay(0)));
  const [staffId, setStaffId] = useState('');
  const [creating, setCreating] = useState(null);
  const [open, setOpen] = useState(null);
  const range = useMemo(() => ({ from: ist(start), to: ist(addDays(start, 7)), staffId: staffId || undefined }), [start, staffId]);
  const { data, error, reload } = useApi('/vendors/me/calendar', range);
  const { data: staff } = useApi('/vendors/me/staff');
  const today = istDay(0);

  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const byDay = {};
  for (const item of data?.items ?? []) (byDay[istParts(item.start).date] ??= []).push(item);

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>Calendar</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Nurvia bookings and your own appointments in one place. Add walk-ins and regulars here; repeat visits are booked in one go.
          </p>
        </div>
        <button className="primary" onClick={() => setCreating({})}>
          <Plus size={16} /> New appointment
        </button>
      </div>

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row">
          <button className="vp-icon-btn" onClick={() => setStart(addDays(start, -7))} aria-label="Previous week">
            <ChevronLeft size={18} />
          </button>
          <button onClick={() => setStart(weekStart(today))}>This week</button>
          <button className="vp-icon-btn" onClick={() => setStart(addDays(start, 7))} aria-label="Next week">
            <ChevronRight size={18} />
          </button>
          <strong style={{ marginLeft: 6 }}>
            {dayLabel(start)} – {dayLabel(addDays(start, 6))}
          </strong>
        </div>
        <select value={staffId} onChange={(e) => setStaffId(e.target.value)} aria-label="Staff">
          <option value="">Everyone</option>
          {staff
            ?.filter((s) => s.active)
            .map((s) => (
              <option key={s._id} value={s._id}>
                {s.name}
              </option>
            ))}
        </select>
      </div>
      <ErrorNote error={error} />

      <div className="vp-week">
        {days.map((day) => (
          <section key={day} className={`vp-week-day ${day === today ? 'today' : ''}`}>
            <header>
              <span>{dayLabel(day)}</span>
              <button className="link small" onClick={() => setCreating({ date: day })} aria-label={`New appointment on ${dayLabel(day)}`}>
                <Plus size={14} />
              </button>
            </header>
            {(byDay[day] ?? []).map((item) =>
              item.source === 'nurvia' ? (
                <Link key={item.id} to={`/bookings/${item.id}`} className={`vp-event nurvia s-${item.status}`} style={item.staff?.color ? { '--event': item.staff.color } : undefined}>
                  <EventBody item={item} />
                </Link>
              ) : (
                <button key={item.id} className={`vp-event own s-${item.status}`} onClick={() => setOpen(item)} style={item.staff?.color ? { '--event': item.staff.color } : undefined}>
                  <EventBody item={item} />
                </button>
              ),
            )}
            {!byDay[day]?.length && <div className="small muted vp-week-empty">Nothing booked</div>}
          </section>
        ))}
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        <span className="vp-key nurvia" /> Nurvia booking <span className="vp-key own" style={{ marginLeft: 12 }} /> Your own appointment
      </p>

      {creating && <AppointmentDialog initial={creating} onClose={() => setCreating(null)} onSaved={reload} />}
      {open && <AppointmentActions item={open} onClose={() => setOpen(null)} onChanged={reload} />}
    </div>
  );
}

function EventBody({ item }) {
  return (
    <>
      <div className="small">
        <strong>{formatTime(item.start)}</strong> {item.seriesId && <Repeat size={11} aria-label="Repeats" />}
      </div>
      <div className="vp-event-title">{item.title}</div>
      <div className="small muted">
        {[item.customer?.name, item.pet?.name].filter(Boolean).join(' · ')}
        {item.staff && ` · ${item.staff.name}`}
      </div>
      {['cancelled', 'no_show', 'completed', 'pending'].includes(item.status) && <Badge value={item.status} />}
    </>
  );
}

function AppointmentActions({ item, onClose, onChanged }) {
  const dialog = useRef(null);
  const { data: appointment, reload } = useApi(`/vendors/me/appointments`, { from: item.start, to: new Date(new Date(item.start).getTime() + 60_000).toISOString() });
  const full = appointment?.find((a) => a._id === item.id);
  const [when, setWhen] = useState(() => istParts(item.start));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!dialog.current.open) dialog.current.showModal();
  }, []);

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
      dialog.current.close();
    } catch (err) {
      setError(err);
      reload();
    } finally {
      setBusy(false);
    }
  };
  const setStatus = (status, series) => run(() => api.post(`/vendors/me/appointments/${item.id}/status`, { status, ...(series && { series: true }) }));
  const reschedule = (e) => {
    e.preventDefault();
    run(() => api.patch(`/vendors/me/appointments/${item.id}`, { scheduledAt: ist(when.date, when.time) }));
  };
  const actions = NEXT[item.status] ?? [];

  return (
    <dialog ref={dialog} onClose={onClose} style={{ width: 'min(480px, calc(100vw - 32px))' }}>
      <div className="stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>{item.title}</h2>
          <Badge value={item.status} />
        </div>
        <div className="small">
          {formatTime(item.start)} – {formatTime(item.end)} · {item.customer?.name} {item.customer?.phone && <span className="muted">{item.customer.phone}</span>}
          {item.pet?.name && ` · ${item.pet.name}`}
          {item.staff && ` · ${item.staff.name}`}
        </div>
        {full && (
          <div className="small muted">
            {formatRupees(full.pricePaise)}
            {full.customerPackage ? ' · from a package' : full.paidOffline ? ' · paid at the counter' : ''}
            {full.notes && ` · ${full.notes}`}
          </div>
        )}
        {actions.length > 0 && (
          <div className="row">
            {actions.map((status) => (
              <button key={status} className={status === 'completed' ? 'primary' : status === 'cancelled' ? 'danger' : ''} disabled={busy} onClick={() => setStatus(status)}>
                {ACTION_LABELS[status]}
              </button>
            ))}
          </div>
        )}
        {item.seriesId && actions.includes('cancelled') && (
          <button className="link small" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => setStatus('cancelled', true)}>
            Cancel this and every later visit in the series
          </button>
        )}
        {actions.includes('cancelled') && (
          <form className="row" onSubmit={reschedule} style={{ alignItems: 'flex-end' }}>
            <label className="field">
              Move to
              <input type="date" value={when.date} onChange={(e) => setWhen((w) => ({ ...w, date: e.target.value }))} required />
            </label>
            <input type="time" value={when.time} onChange={(e) => setWhen((w) => ({ ...w, time: e.target.value }))} required step={300} aria-label="Time" />
            <button type="submit" disabled={busy}>
              Reschedule
            </button>
          </form>
        )}
        <ErrorNote error={error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={() => dialog.current.close()}>Close</button>
        </div>
      </div>
    </dialog>
  );
}
