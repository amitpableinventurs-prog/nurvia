import { CalendarOff, PauseCircle, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { DuoIcon } from '../icons.jsx';
import { ErrorNote, formatDate, formatDay, istDay, useApi, useConfirm } from '../ui.jsx';

// IST wall-clock date + time → a Date.
const ist = (date, time = '00:00') => new Date(`${date}T${time}:00+05:30`);
const isIstMidnight = (value) => (new Date(value).getTime() + 330 * 60_000) % 86_400_000 === 0;
// Calendar arithmetic on the YYYY-MM-DD string itself, so the time zone cannot shift the date.
const nextDay = (date) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

function Conflicts({ items }) {
  if (!items?.length) return null;
  return (
    <div className="vp-status warn" style={{ marginBottom: 0 }}>
      <strong>
        {items.length} booking{items.length === 1 ? '' : 's'} already in this time
      </strong>
      <span>They were not cancelled. Reschedule or cancel each one so the customer is told.</span>
      <ul style={{ margin: 0, paddingLeft: 18, width: '100%' }}>
        {items.map((b) => (
          <li key={b._id}>
            <Link to={`/bookings/${b._id}`}>
              {formatDate(b.scheduledAt)} · {b.pet?.name} · {b.serviceSnapshot?.name}
            </Link>{' '}
            <span className="small muted">({b.user?.name ?? 'customer'}, {b.status})</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Availability() {
  const { data, error, reload } = useApi('/vendors/me/time-off');
  const [confirm, dialog] = useConfirm();

  const [mode, setMode] = useState('days');
  const [form, setForm] = useState({ fromDate: istDay(1), toDate: istDay(1), date: istDay(1), fromTime: '10:00', toTime: '13:00', reason: '' });
  const [conflicts, setConflicts] = useState(null);
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const [pauseUntil, setPauseUntil] = useState('');
  const [pauseReason, setPauseReason] = useState('');
  const [pauseConflicts, setPauseConflicts] = useState(null);
  const [pauseError, setPauseError] = useState(null);

  const addBlock = async (e) => {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    setConflicts(null);
    // Whole days run from midnight to the following midnight, IST.
    const [from, to] = mode === 'days' ? [ist(form.fromDate), ist(nextDay(form.toDate))] : [ist(form.date, form.fromTime), ist(form.date, form.toTime)];
    try {
      const res = await api.post('/vendors/me/time-off', { from, to, reason: form.reason.trim() || undefined });
      setConflicts(res.conflicts);
      setForm((f) => ({ ...f, reason: '' }));
      reload();
    } catch (err) {
      setFormError(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = (block) =>
    confirm({
      title: 'Open this time again?',
      message: 'Customers will be able to book these slots again.',
      confirmLabel: 'Remove block',
      onConfirm: async () => {
        await api.del(`/vendors/me/time-off/${block._id}`);
        reload();
      },
    });

  const setPause = async (active) => {
    setPauseError(null);
    setPauseConflicts(null);
    try {
      const res = await api.put('/vendors/me/pause', active ? { active, ...(pauseUntil && { until: ist(pauseUntil) }), reason: pauseReason.trim() || undefined } : { active });
      setPauseConflicts(res.conflicts);
      reload();
    } catch (err) {
      setPauseError(err);
    }
  };

  const pause = data?.pause;

  return (
    <div className="stack" style={{ gap: 18 }}>
      {dialog}
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>Availability</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>
            Block holidays or a few hours, or pause new bookings for a while. Your weekly hours are on the <Link to="/profile">business profile</Link>.
          </p>
        </div>
      </div>
      <ErrorNote error={error} />

      <section className={`card ${pause?.active ? 'vp-paused' : ''}`}>
        <div className="card-head">
          <div className="row" style={{ gap: 10 }}>
            <DuoIcon icon={PauseCircle} tone={pause?.active ? 'rose' : 'amber'} size={36} />
            <div>
              <h2 style={{ margin: 0 }}>{pause?.active ? 'New bookings are paused' : 'Pause new bookings'}</h2>
              <div className="small muted">
                {pause?.active
                  ? `${pause.until ? `Until ${formatDay(pause.until)}` : 'Until you turn it back on'}${pause.reason ? ` · ${pause.reason}` : ''}. Existing bookings stay as they are.`
                  : 'For when you are unwell, short-staffed or renovating. Customers cannot book you until the date you pick.'}
              </div>
            </div>
          </div>
        </div>
        {pause?.active ? (
          <button className="primary" onClick={() => setPause(false)}>
            Resume bookings now
          </button>
        ) : (
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <label className="field">
              Until (optional)
              <input type="date" value={pauseUntil} min={istDay(1)} onChange={(e) => setPauseUntil(e.target.value)} />
            </label>
            <label className="field" style={{ flex: 1, minWidth: 200 }}>
              Note for yourself (optional)
              <input value={pauseReason} onChange={(e) => setPauseReason(e.target.value)} maxLength={200} placeholder="Clinic renovation" />
            </label>
            <button className="danger" onClick={() => setPause(true)}>
              Pause bookings
            </button>
          </div>
        )}
        <ErrorNote error={pauseError} />
        <div style={{ marginTop: 12 }}>
          <Conflicts items={pauseConflicts} />
        </div>
      </section>

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <form className="card stack" onSubmit={addBlock}>
          <div className="row" style={{ gap: 10 }}>
            <DuoIcon icon={CalendarOff} tone="blue" size={36} />
            <h2 style={{ margin: 0 }}>Block dates or times</h2>
          </div>
          <div className="segmented" role="group" aria-label="Block type" style={{ alignSelf: 'flex-start' }}>
            <button type="button" aria-pressed={mode === 'days'} onClick={() => setMode('days')}>
              Whole days
            </button>
            <button type="button" aria-pressed={mode === 'hours'} onClick={() => setMode('hours')}>
              Some hours
            </button>
          </div>
          {mode === 'days' ? (
            <div className="vp-grid-2">
              <label className="field">
                From
                <input type="date" value={form.fromDate} min={istDay()} onChange={(e) => setForm((f) => ({ ...f, fromDate: e.target.value, toDate: f.toDate < e.target.value ? e.target.value : f.toDate }))} required />
              </label>
              <label className="field">
                To (inclusive)
                <input type="date" value={form.toDate} min={form.fromDate} onChange={set('toDate')} required />
              </label>
            </div>
          ) : (
            <div className="vp-grid-2">
              <label className="field">
                Day
                <input type="date" value={form.date} min={istDay()} onChange={set('date')} required />
              </label>
              <div className="row" style={{ alignItems: 'flex-end', gap: 6 }}>
                <label className="field">
                  From
                  <input type="time" value={form.fromTime} onChange={set('fromTime')} required />
                </label>
                <label className="field">
                  To
                  <input type="time" value={form.toTime} onChange={set('toTime')} required />
                </label>
              </div>
            </div>
          )}
          <label className="field">
            Reason (only you see this)
            <input value={form.reason} onChange={set('reason')} maxLength={200} placeholder="Diwali holiday, Dr. away at a conference" />
          </label>
          <ErrorNote error={formError} />
          <button className="primary" disabled={busy} style={{ alignSelf: 'flex-start' }}>
            Block this time
          </button>
          <Conflicts items={conflicts} />
        </form>

        <section className="card">
          <h2>Upcoming blocks</h2>
          {data?.timeOff.length ? (
            <ul className="vp-docs">
              {data.timeOff.map((t) => {
                const allDay = isIstMidnight(t.from) && isIstMidnight(t.to);
                return (
                  <li key={t._id}>
                    <span>
                      <strong>
                        {allDay
                          ? `${formatDay(t.from)}${new Date(t.to) - new Date(t.from) > 86_400_000 ? ` – ${formatDay(new Date(new Date(t.to).getTime() - 1))}` : ''} · all day`
                          : `${formatDate(t.from)} – ${new Date(t.to).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })}`}
                      </strong>
                      {t.reason && <div className="small muted">{t.reason}</div>}
                    </span>
                    <button type="button" className="vp-icon-btn" onClick={() => remove(t)} aria-label="Remove block">
                      <Trash2 size={14} />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="empty small">Nothing blocked. Customers can book any free slot within your hours.</div>
          )}
        </section>
      </div>
    </div>
  );
}
