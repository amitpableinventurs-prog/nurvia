import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { ErrorNote, formatDate, formatTime, istDay } from './ui.jsx';

// A dialog listing the free slots on a chosen day, from the same availability the customer sees.
export function useReschedule(onDone) {
  const ref = useRef(null);
  const [booking, setBooking] = useState(null);
  const [date, setDate] = useState(istDay());
  const [slots, setSlots] = useState(null);
  const [picked, setPicked] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!booking) return;
    let stale = false;
    setSlots(null);
    setPicked(null);
    api
      .get(`/vendors/${booking.vendor}/availability`, { serviceId: booking.service, date })
      .then((r) => !stale && setSlots(r.slots))
      .catch((e) => !stale && (setSlots([]), setError(e)));
    return () => {
      stale = true;
    };
  }, [booking, date]);

  const open = (b) => {
    setBooking(b);
    setDate(istDay());
    setError(null);
    queueMicrotask(() => ref.current?.showModal());
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/bookings/${booking._id}/actions`, { action: 'reschedule', scheduledAt: picked });
      ref.current.close();
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const dialog = (
    <dialog ref={ref} onClose={() => setBooking(null)}>
      {booking && (
        <form className="stack" onSubmit={submit}>
          <h2>Reschedule {booking.code}</h2>
          <p className="muted" style={{ margin: 0 }}>
            Now {formatDate(booking.scheduledAt)}. The customer is notified of the new time.
          </p>
          <label className="field">
            Day
            <input type="date" value={date} min={istDay()} onChange={(e) => setDate(e.target.value)} required />
          </label>
          <div className="vp-slots" role="radiogroup" aria-label="Free slots">
            {slots === null ? (
              <span className="muted small">Loading free slots…</span>
            ) : slots.length ? (
              slots.map((s) => (
                <button type="button" key={s} role="radio" aria-checked={picked === s} className="vp-chip" aria-pressed={picked === s} onClick={() => setPicked(s)}>
                  {formatTime(s)}
                </button>
              ))
            ) : (
              <span className="muted small">No free slots this day.</span>
            )}
          </div>
          <ErrorNote error={error} />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => ref.current.close()}>
              Cancel
            </button>
            <button className="primary" disabled={!picked || busy}>
              Move booking
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
  return [open, dialog];
}

// The actions a vendor can take on a booking in each state (mirrors booking.service.js).
// `afterStart` actions only make sense once the appointment has begun.
export const VENDOR_ACTIONS = {
  pending: [
    { action: 'accept', label: 'Accept', primary: true },
    { action: 'reject', label: 'Decline', reason: 'required', danger: true },
    { action: 'reschedule', label: 'Reschedule' },
  ],
  accepted: [
    { action: 'complete', label: 'Mark completed', primary: true, afterStart: true },
    { action: 'no_show', label: 'No-show', afterStart: true, reason: 'optional' },
    { action: 'reschedule', label: 'Reschedule' },
    { action: 'cancel', label: 'Cancel', reason: 'required', danger: true },
  ],
};

const CONFIRM = {
  accept: { title: 'Accept this booking?', message: 'The customer is told their appointment is confirmed.' },
  reject: { title: 'Decline this booking?', message: 'The customer is notified and any payment is refunded.' },
  complete: { title: 'Mark the visit completed?', message: 'The customer can then leave a review.' },
  no_show: { title: 'Mark as a no-show?', message: 'Use this when the customer did not arrive.' },
  cancel: { title: 'Cancel this booking?', message: 'The customer is notified and any payment is refunded in full.' },
};

export function availableActions(booking) {
  const started = new Date(booking.scheduledAt) <= new Date();
  return (VENDOR_ACTIONS[booking.status] ?? []).filter((a) => !a.afterStart || started);
}

// Runs an action through the shared confirm dialog; reschedule asks for a new time instead.
export function runAction({ booking, action, confirm, reschedule, onDone }) {
  if (action.action === 'reschedule') return reschedule(booking);
  const copy = CONFIRM[action.action];
  confirm({
    ...copy,
    reason: action.reason,
    danger: action.danger,
    confirmLabel: action.label,
    onConfirm: async (reason) => {
      await api.post(`/bookings/${booking._id}/actions`, { action: action.action, ...(reason && { reason }) });
      onDone();
    },
  });
}
