import { ArrowRight, CalendarCheck2, CalendarClock, Check, Circle, Hourglass, Star, Wallet } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ApprovalSteps } from '../approval.jsx';
import { availableActions, runAction, useReschedule } from '../booking-actions.jsx';
import { DuoIcon } from '../icons.jsx';
import { useSession } from '../session.jsx';
import { Badge, ErrorNote, ago, formatDate, formatTime, rupeesCompact, useApi, useConfirm } from '../ui.jsx';

const SETUP = [
  ['services', 'Add your services and prices', '/services'],
  ['hours', 'Set your opening hours', '/profile'],
  ['photos', 'Add photos of your clinic or studio', '/profile'],
  ['kyc', 'Submit KYC documents', '/documents'],
  ['license', 'Upload your trade or veterinary licence', '/documents'],
];

function greeting() {
  const h = Number(new Date().toLocaleString('en-IN', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export default function Dashboard() {
  const { session } = useSession();
  const { data: d, error, reload } = useApi('/vendors/me/dashboard');
  const [confirm, dialog] = useConfirm();
  const [reschedule, rescheduleDialog] = useReschedule(reload);
  const act = (booking, action) => runAction({ booking, action, confirm, reschedule, onDone: reload });

  if (error) return <ErrorNote error={error} />;
  if (!d) return <div className="muted">Loading…</div>;

  const todo = SETUP.filter(([key]) => !d.setup[key]);
  const now = new Date();
  // First name, skipping a title such as "Dr." so the greeting reads "Good morning, Kiran".
  const first = (session.user.name ?? '').split(' ').find((w) => w && !w.endsWith('.')) ?? '';

  return (
    <div className="stack" style={{ gap: 20 }}>
      {dialog}
      {rescheduleDialog}
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>
            {greeting()}
            {first && (
              <>
                , <em>{first}</em>
              </>
            )}
          </h1>
          <p className="muted" style={{ margin: '6px 0 0' }}>
            {d.today.remaining ? `${d.today.remaining} appointment${d.today.remaining === 1 ? '' : 's'} still to go today.` : 'Nothing else on the schedule today.'}
            {d.pending.count > 0 && ` ${d.pending.count} request${d.pending.count === 1 ? '' : 's'} waiting for you.`}
          </p>
        </div>
      </div>

      {d.pause && (
        <div className="vp-status crit" role="status">
          <strong>New bookings are paused</strong>
          <span>
            {d.pause.until ? `Customers can book you again from ${formatDate(d.pause.until)}.` : 'Customers cannot book you until you resume.'}
            {d.pause.reason && ` (${d.pause.reason})`}
          </span>
          <Link to="/availability" className="ov-btn">
            Manage
          </Link>
        </div>
      )}
      {!d.pause && d.nextTimeOff && (
        <div className="notice small">
          Next blocked time: {formatDate(d.nextTimeOff.from)} to {formatDate(d.nextTimeOff.to)}
          {d.nextTimeOff.reason && ` · ${d.nextTimeOff.reason}`}. <Link to="/availability">Availability</Link>
        </div>
      )}

      {session.vendor.status !== 'active' && session.vendor.status !== 'suspended' && (
        <section className="card">
          <div className="card-head">
            <h2>Getting you live on Nurvia</h2>
          </div>
          <ApprovalSteps vendor={session.vendor} />
        </section>
      )}

      {todo.length > 0 && (
        <section className="card vp-setup">
          <div className="card-head">
            <h2>Finish setting up</h2>
            <span className="small muted">
              {SETUP.length - todo.length} of {SETUP.length} done
            </span>
          </div>
          <div className="vp-progress" aria-hidden="true">
            <span style={{ width: `${((SETUP.length - todo.length) / SETUP.length) * 100}%` }} />
          </div>
          <ul className="vp-checklist">
            {SETUP.map(([key, label, to]) => (
              <li key={key} className={d.setup[key] ? 'done' : ''}>
                {d.setup[key] ? <Check size={16} /> : <Circle size={16} />}
                {d.setup[key] ? <span>{label}</span> : <Link to={to}>{label}</Link>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="ov-metrics" aria-label="Key numbers">
        <Tile icon={CalendarCheck2} tone="orange" label="Today" value={d.today.bookings.length} foot={`${d.today.inProgress} in progress`} to="/bookings?view=today" />
        <Tile icon={Hourglass} tone="amber" label="Requests" value={d.pending.count} foot={`${d.upcomingWeek} booked this week`} to="/bookings?status=pending" alert={d.pending.count > 0} />
        <Tile icon={Wallet} tone="green" label="This month" value={rupeesCompact(d.earnings.monthPaise)} foot={`${rupeesCompact(d.earnings.last30Paise)} in 30 days`} to="/earnings" />
        <Tile
          icon={Star}
          tone="violet"
          label="Rating"
          value={d.reviews.ratingCount ? `${d.reviews.ratingAvg.toFixed(1)}★` : '—'}
          foot={d.reviews.unreplied ? `${d.reviews.unreplied} to reply` : `${d.reviews.ratingCount} reviews`}
          to="/reviews"
        />
        <Tile icon={CalendarClock} tone="blue" label="Completion" value={d.completionRate == null ? '—' : `${d.completionRate}%`} foot="of visits, last 30 days" to="/bookings?status=completed" />
      </section>

      <section className="card vp-glance" aria-label="Bookings at a glance">
        {[
          ['Upcoming', d.counts.upcoming, '/bookings?view=upcoming'],
          ['Completed', d.counts.completed, '/bookings?view=all&status=completed'],
          ['Cancelled / declined', d.counts.cancelled, '/bookings?view=all&status=cancelled'],
          ['No-shows', d.counts.noShow, '/bookings?view=all&status=no_show'],
          ['Customers', d.customers, null],
          ['All bookings', d.counts.total, '/bookings?view=all'],
        ].map(([label, value, to]) => {
          const body = (
            <>
              <span className="num">{value.toLocaleString('en-IN')}</span>
              <span className="small muted">{label}</span>
            </>
          );
          return to ? (
            <Link key={label} to={to}>
              {body}
            </Link>
          ) : (
            <div key={label}>{body}</div>
          );
        })}
      </section>

      <div className="ov-grid ov-grid-wide">
        <section className="card ov-queue">
          <div className="ov-queue-head">
            <DuoIcon icon={CalendarCheck2} tone="orange" size={38} />
            <div style={{ flex: 1 }}>
              <h2 style={{ margin: 0 }}>Today's schedule</h2>
              <div className="small muted">{d.today.bookings.length ? `${d.today.bookings.length} appointments` : 'No appointments today'}</div>
            </div>
            <Link to="/bookings?view=today" className="small">
              Full day
            </Link>
          </div>
          <div className="ov-queue-body">
            {d.today.bookings.length ? (
              <ol className="vp-timeline">
                {d.today.bookings.map((b) => {
                  const live = b.status === 'accepted' && new Date(b.scheduledAt) <= now && new Date(b.endsAt) > now;
                  return (
                    <li key={b._id} className={live ? 'live' : new Date(b.endsAt) < now ? 'past' : ''}>
                      <span className="vp-time num">{formatTime(b.scheduledAt)}</span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontWeight: 600 }}>
                          {b.pet?.name} <span className="muted" style={{ fontWeight: 400 }}>· {b.serviceSnapshot?.name}</span>
                        </div>
                        <div className="small muted">
                          {b.user?.name ?? b.user?.phone} · {b.code}
                          {live && <strong className="ov-good"> · in progress</strong>}
                        </div>
                      </div>
                      <Badge value={b.status} />
                      <div className="row" style={{ gap: 6 }}>
                        {availableActions(b)
                          .filter((a) => a.primary)
                          .map((a) => (
                            <button key={a.action} className="ov-btn primary" onClick={() => act(b, a)}>
                              {a.label}
                            </button>
                          ))}
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <div className="empty">Your day is clear.</div>
            )}
          </div>
        </section>

        <section className="card ov-queue">
          <div className="ov-queue-head">
            <DuoIcon icon={Hourglass} tone="amber" size={38} />
            <div style={{ flex: 1 }}>
              <h2 style={{ margin: 0 }}>Waiting for you</h2>
              <div className="small muted">Accept quickly: customers book elsewhere if they wait</div>
            </div>
            {d.pending.count > 0 && <span className="ov-chip">{d.pending.count}</span>}
          </div>
          <div className="ov-queue-body stack" style={{ gap: 10 }}>
            {d.pending.items.length ? (
              d.pending.items.map((b) => (
                <div key={b._id} className="ov-case">
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <strong>
                      {b.pet?.name} · {b.serviceSnapshot?.name}
                    </strong>
                    <span className="small muted">requested {ago(b.createdAt)}</span>
                  </div>
                  <div className="small muted" style={{ margin: '4px 0 10px' }}>
                    {formatDate(b.scheduledAt)} · {b.user?.name ?? b.user?.phone}
                    {b.pet?.breed && ` · ${b.pet.breed}`}
                  </div>
                  {b.notes && <p className="ov-quote small">“{b.notes}”</p>}
                  <div className="row">
                    {availableActions(b).map((a) => (
                      <button key={a.action} className={a.primary ? 'primary' : a.danger ? 'danger' : ''} onClick={() => act(b, a)}>
                        {a.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <div className="empty">
                <Check size={18} /> No requests waiting
              </div>
            )}
            {d.pending.count > d.pending.items.length && (
              <Link to="/bookings?status=pending" className="row small">
                All {d.pending.count} requests <ArrowRight size={14} />
              </Link>
            )}
          </div>
        </section>
      </div>

      {d.reviews.recent.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>Latest reviews</h2>
            <Link to="/reviews" className="small">
              {d.reviews.unreplied ? `Reply to ${d.reviews.unreplied}` : 'All reviews'}
            </Link>
          </div>
          <div className="vp-reviews-mini">
            {d.reviews.recent.map((r) => (
              <div key={r._id}>
                <div className="vp-stars" aria-label={`${r.rating} out of 5`}>
                  {'★'.repeat(r.rating)}
                  <span>{'★'.repeat(5 - r.rating)}</span>
                </div>
                <p style={{ margin: '4px 0' }}>{r.text || <span className="muted">No comment</span>}</p>
                <div className="small muted">
                  {r.author?.name ?? 'Customer'} · {ago(r.createdAt)}
                  {!r.vendorReply?.text && <strong className="ov-warn"> · awaiting reply</strong>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Tile({ icon, tone, label, value, foot, to, alert = false }) {
  return (
    <Link to={to} className={`card ov-metric ${alert ? 'vp-alert' : ''}`}>
      <div className="kpi-top">
        <span className="kpi-label">{label}</span>
        <DuoIcon icon={icon} tone={tone} size={34} />
      </div>
      <div className="kpi-value num">{value}</div>
      <div className="small muted">{foot}</div>
    </Link>
  );
}
