import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { availableActions, runAction, useReschedule } from '../booking-actions.jsx';
import { Badge, ErrorNote, Pager, Table, formatDate, formatRupees, formatTime, istDay, useApi, useConfirm } from '../ui.jsx';
import { useFilters } from '../useFilters.js';

const VIEWS = [
  ['upcoming', 'Upcoming'],
  ['day', 'By day'],
  ['all', 'All'],
];
const STATUSES = ['pending', 'accepted', 'completed', 'cancelled', 'rejected', 'no_show'];

const shiftDay = (date, days) => new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
const dayLabel = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

export default function Bookings() {
  const [filters, setFilter] = useFilters({ view: 'upcoming' });
  // ?view=today is the dashboard's shortcut to today's day view.
  const view = filters.view === 'today' ? 'day' : filters.view;
  const date = filters.view === 'today' ? istDay() : filters.date ?? istDay();
  const params = {
    as: 'vendor',
    page: filters.page,
    limit: 25,
    status: filters.status,
    ...(view === 'upcoming' && { upcoming: 'true' }),
    ...(view === 'day' && { date, limit: 100 }),
  };
  const { data, error, reload } = useApi('/bookings', params);
  const [confirm, dialog] = useConfirm();
  const [reschedule, rescheduleDialog] = useReschedule(reload);

  return (
    <div>
      {dialog}
      {rescheduleDialog}
      <div className="page-head">
        <div>
          <h1>Bookings</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>Accept requests, move appointments and close visits once they are done.</p>
        </div>
        <div className="segmented" role="group" aria-label="View">
          {VIEWS.map(([key, label]) => (
            <button key={key} aria-pressed={view === key} onClick={() => setFilter({ view: key, date: '' })}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="filters">
        {view === 'day' && (
          <div className="row" style={{ gap: 4 }}>
            <button aria-label="Previous day" onClick={() => setFilter({ view: 'day', date: shiftDay(date, -1) })}>
              <ChevronLeft size={16} />
            </button>
            <input type="date" value={date} onChange={(e) => setFilter({ view: 'day', date: e.target.value })} aria-label="Day" />
            <button aria-label="Next day" onClick={() => setFilter({ view: 'day', date: shiftDay(date, 1) })}>
              <ChevronRight size={16} />
            </button>
            {date !== istDay() && <button onClick={() => setFilter({ view: 'day', date: istDay() })}>Today</button>}
          </div>
        )}
        <select value={filters.status ?? ''} onChange={(e) => setFilter('status', e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace('_', '-')}
            </option>
          ))}
        </select>
      </div>
      {view === 'day' && <h2 style={{ margin: '4px 0 12px' }}>{dayLabel(date)}</h2>}

      <ErrorNote error={error} />
      <div className="card">
        <Table
          rows={data?.items}
          empty={view === 'upcoming' ? 'No upcoming bookings' : view === 'day' ? 'Nothing booked this day' : 'No bookings yet'}
          columns={[
            {
              label: view === 'day' ? 'Time' : 'When',
              render: (b) => (
                <span className="num" style={{ whiteSpace: 'nowrap' }}>
                  {view === 'day' ? formatTime(b.scheduledAt) : formatDate(b.scheduledAt)}
                </span>
              ),
            },
            {
              label: 'Pet & service',
              render: (b) => (
                <>
                  <Link to={`/bookings/${b._id}`} style={{ fontWeight: 600 }}>
                    {b.pet?.name} <span className="muted" style={{ fontWeight: 400 }}>({b.pet?.breed ?? b.pet?.species})</span>
                  </Link>
                  <div className="small">
                    {b.serviceSnapshot?.name} · {b.serviceSnapshot?.durationMin} min
                    {b.serviceSnapshot?.mode === 'home_visit' && ' · home visit'}
                  </div>
                  {b.notes && <div className="small muted">“{b.notes}”</div>}
                </>
              ),
            },
            {
              label: 'Customer',
              render: (b) => (
                <>
                  {b.user?.name ?? 'Customer'}
                  {b.user?.phone && (
                    <div className="small">
                      <a href={`tel:${b.user.phone}`}>{b.user.phone}</a>
                    </div>
                  )}
                </>
              ),
            },
            {
              label: 'Payment',
              render: (b) => (
                <>
                  <span className="num">{formatRupees(b.serviceSnapshot?.pricePaise)}</span>
                  <div>
                    <Badge value={b.payment?.status} />
                  </div>
                </>
              ),
            },
            {
              label: 'Status',
              render: (b) => (
                <>
                  <Badge value={b.status} />
                  <div className="small muted mono">{b.code}</div>
                </>
              ),
            },
            {
              label: 'Actions',
              render: (b) => (
                <div className="row" style={{ gap: 6 }}>
                  {availableActions(b).map((a) => (
                    <button key={a.action} className={a.primary ? 'primary' : a.danger ? 'danger' : ''} onClick={() => runAction({ booking: b, action: a, confirm, reschedule, onDone: reload })}>
                      {a.label}
                    </button>
                  ))}
                </div>
              ),
            },
          ]}
        />
        <Pager data={data} onPage={(p) => setFilter('page', p)} />
      </div>
    </div>
  );
}
