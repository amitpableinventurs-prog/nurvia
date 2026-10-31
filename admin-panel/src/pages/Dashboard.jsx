import {
  ArrowDownRight, ArrowRight, ArrowUpRight, BadgeCheck, CalendarHeart, CheckCircle2, Dog, HeartHandshake, Hourglass, Megaphone,
  MessagesSquare, PawPrint, ScanSearch, Siren, Store, Table2, TrendingUp, UserRoundPlus, UsersRound, Wallet,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { HBars, Sparkline, TrendChart, bucket, fillDays } from '../charts.jsx';
import { DuoIcon } from '../icons.jsx';
import { useSession } from '../session.jsx';
import { Badge, ErrorNote, formatDate, useApi } from '../ui.jsx';

const RANGES = [7, 30, 90];

// Indian-style compact currency: ₹12,450 · ₹1.2L · ₹3.4Cr
export function rupeesCompact(paise) {
  const r = paise / 100;
  if (r >= 1e7) return `₹${(r / 1e7).toFixed(1).replace(/\.0$/, '')}Cr`;
  if (r >= 1e5) return `₹${(r / 1e5).toFixed(1).replace(/\.0$/, '')}L`;
  return `₹${Math.round(r).toLocaleString('en-IN')}`;
}
const count = (v) => Math.round(v).toLocaleString('en-IN');
const countTick = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}K` : String(Math.round(v)));

const METRICS = [
  { key: 'bookings', label: 'Bookings', icon: CalendarHeart, tone: 'orange' },
  { key: 'revenue', label: 'Online payments', icon: Wallet, tone: 'green', money: true },
  { key: 'registrations', label: 'Sign-ups', icon: UserRoundPlus, tone: 'violet' },
  { key: 'searches', label: 'Searches', icon: ScanSearch, tone: 'blue' },
  { key: 'pets', label: 'Pets added', icon: PawPrint, tone: 'amber' },
  { key: 'vendors', label: 'Vendor sign-ups', icon: Store, tone: 'teal' },
  { key: 'communityDogs', label: 'Community dogs', icon: Dog, tone: 'amber' },
  { key: 'adoptionListings', label: 'Adoption listings', icon: HeartHandshake, tone: 'rose' },
];
const KPI_KEYS = ['bookings', 'revenue', 'registrations', 'searches'];

function greeting() {
  const h = Number(new Date().toLocaleString('en-IN', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

function Delta({ current, previous, days }) {
  if (!previous && !current) return <span className="delta flat">No activity</span>;
  if (!previous) return <span className="delta up">New this period</span>;
  const pct = Math.round(((current - previous) / previous) * 100);
  const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  const Icon = dir === 'down' ? ArrowDownRight : ArrowUpRight;
  return (
    <span className={`delta ${dir}`} title={`vs previous ${days} days`}>
      {dir !== 'flat' && <Icon size={13} strokeWidth={2.5} />}
      {pct > 0 ? '+' : ''}
      {pct}%
    </span>
  );
}

export default function Dashboard() {
  const { session, can } = useSession();
  const [range, setRange] = useState(30);
  const [metric, setMetric] = useState('bookings');
  const [asTable, setAsTable] = useState(false);

  // Fetch twice the range so the previous period is available for comparison.
  const period = useMemo(() => {
    const to = new Date();
    return { to: to.toISOString(), from: new Date(to.getTime() - (range * 2 - 1) * 86_400_000).toISOString() };
  }, [range]);
  const { data: d, error } = useApi('/admin/dashboard');
  const { data: analytics, error: analyticsError } = useApi('/admin/analytics', period);
  const { data: latest } = useApi(can('bookings.read') ? '/admin/bookings' : null, { limit: 6 }, { enabled: can('bookings.read') });

  const periods = useMemo(() => {
    if (!analytics) return null;
    const out = {};
    for (const m of METRICS) {
      const rows = m.key === 'revenue' ? analytics.revenue : analytics.series[m.key] ?? [];
      const all = fillDays(rows, analytics.from, analytics.to, m.key === 'revenue' ? 'amountPaise' : 'count');
      const current = all.slice(-range);
      const previous = all.slice(0, all.length - range);
      out[m.key] = {
        days: current,
        total: current.reduce((n, x) => n + x.value, 0),
        previousTotal: previous.reduce((n, x) => n + x.value, 0),
      };
    }
    return out;
  }, [analytics, range]);

  const selected = METRICS.find((m) => m.key === metric);
  const fmt = (m) => (m.money ? rupeesCompact : count);
  const chartDays = periods ? bucket(periods[metric].days, range > 45 ? 30 : 60) : [];

  const queue = d && [
    { to: '/vendors?status=pending&kycStatus=submitted', label: 'Vendors awaiting KYC approval', n: d.vendors.awaitingApproval, icon: BadgeCheck, tone: 'amber' },
    { to: '/moderation?type=adoption-listings&status=pending_review', label: 'Adoption listings to review', n: d.adoption.awaitingReview, icon: HeartHandshake, tone: 'rose' },
    { to: '/reports', label: 'Open user reports', n: d.reports.open, icon: Siren, tone: 'orange' },
    { to: '/bookings?status=pending', label: 'Bookings waiting on vendors', n: d.bookings.pending, icon: Hourglass, tone: 'blue' },
  ];
  const openItems = queue?.reduce((n, q) => n + q.n, 0) ?? 0;

  const statusRows = d && [
    ['Pending', 'pending'],
    ['Confirmed', 'accepted'],
    ['Completed', 'completed'],
    ['Cancelled', 'cancelled'],
    ['Declined', 'rejected'],
    ['No-show', 'no_show'],
  ].map(([label, key]) => ({ label, value: d.bookingStatus?.[key] ?? 0 }));

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="page-head hello">
        <div>
          <div className="eyebrow">{new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' })}</div>
          <h1 style={{ marginTop: 6 }}>
            {greeting()}, <em>{session.user.name?.split(' ')[0] ?? 'there'}</em>
          </h1>
          <p className="muted" style={{ margin: '6px 0 0' }}>
            {openItems ? `${openItems} item${openItems === 1 ? '' : 's'} need${openItems === 1 ? 's' : ''} your attention today.` : 'Everything is up to date.'}
          </p>
        </div>
        <div className="segmented" role="group" aria-label="Date range">
          {RANGES.map((r) => (
            <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>
              {r} days
            </button>
          ))}
        </div>
      </div>

      <ErrorNote error={error ?? analyticsError} />

      <section className="kpis" aria-label="Key metrics">
        {METRICS.filter((m) => KPI_KEYS.includes(m.key)).map((m) => {
          const p = periods?.[m.key];
          return (
            <button
              key={m.key}
              className="card kpi"
              onClick={() => setMetric(m.key)}
              aria-pressed={metric === m.key}
              style={{ textAlign: 'left', alignItems: 'stretch', cursor: 'pointer', outline: metric === m.key ? '2px solid var(--series-1)' : undefined, outlineOffset: -1 }}
            >
              <div className="kpi-top">
                <span className="kpi-label">{m.label}</span>
                <DuoIcon icon={m.icon} tone={m.tone} size={40} tilt />
              </div>
              <div className="kpi-value num">{p ? fmt(m)(p.total) : '—'}</div>
              <div className="kpi-foot">
                {p ? <Delta current={p.total} previous={p.previousTotal} days={range} /> : <span />}
                {p && <Sparkline values={bucket(p.days, 14).map((x) => x.value)} />}
              </div>
              <span className="small muted">vs previous {range} days</span>
            </button>
          );
        })}
      </section>

      <div className="dash-grid">
        <section className="card hero-chart">
          <div className="card-head" style={{ alignItems: 'flex-start' }}>
            <div>
              <div className="row" style={{ gap: 8 }}>
                <TrendingUp size={16} color="var(--series-1)" />
                <h2>{selected.label}</h2>
              </div>
              <div className="row" style={{ marginTop: 6, gap: 10 }}>
                <span className="big-number num">{periods ? fmt(selected)(periods[metric].total) : '—'}</span>
                {periods && <Delta current={periods[metric].total} previous={periods[metric].previousTotal} days={range} />}
              </div>
            </div>
            <div className="row">
              <select value={metric} onChange={(e) => setMetric(e.target.value)} aria-label="Metric">
                {METRICS.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
              <button onClick={() => setAsTable((v) => !v)} aria-pressed={asTable} title={asTable ? 'Show chart' : 'Show table'}>
                {asTable ? <TrendingUp size={16} /> : <Table2 size={16} />}
              </button>
            </div>
          </div>
          {periods ? (
            <TrendChart
              days={chartDays}
              label={selected.label}
              format={selected.money ? rupeesCompact : count}
              formatTick={selected.money ? (v) => rupeesCompact(v) : countTick}
              showTable={asTable}
            />
          ) : (
            <div style={{ height: 250 }} />
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Needs attention</h2>
            {openItems === 0 && d && (
              <span className="row small" style={{ color: 'var(--good-ink)', fontWeight: 700, gap: 4 }}>
                <CheckCircle2 size={15} /> All clear
              </span>
            )}
          </div>
          <div className="queue">
            {queue?.map((q) => (
              <Link key={q.to} to={q.to} className={`queue-item ${q.n ? '' : 'clear'}`}>
                <DuoIcon icon={q.icon} tone={q.n ? q.tone : 'ink'} size={40} tilt />
                <span>{q.label}</span>
                <span className="queue-count">{q.n}</span>
                <ArrowRight size={16} className="muted" />
              </Link>
            ))}
          </div>
          {can('announcements.send') && (
            <Link to="/announcements" className="row small" style={{ marginTop: 14, gap: 6 }}>
              <Megaphone size={15} /> Send an announcement
            </Link>
          )}
        </section>
      </div>

      <div className="dash-grid-3">
        <section className="card">
          <div className="card-head">
            <h2>Bookings by status</h2>
            <span className="small muted">all time</span>
          </div>
          {statusRows && <HBars rows={statusRows} />}
          {d && (
            <div className="row small" style={{ marginTop: 14, justifyContent: 'space-between', borderTop: '1px solid var(--grid)', paddingTop: 12 }}>
              <span className="muted">Collected online</span>
              <strong className="num">{rupeesCompact(d.payments.paidPaise)}</strong>
              <span className="muted">Refunded</span>
              <strong className="num">{rupeesCompact(d.payments.refundedPaise)}</strong>
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Top vendors</h2>
            <span className="small muted">last 30 days</span>
          </div>
          {d?.topVendors.length ? (
            d.topVendors.map((v, i) => (
              <div key={v._id} className="rank">
                <span className="rank-n">{i + 1}</span>
                <div style={{ minWidth: 0 }}>
                  <Link to={`/vendors/${v._id}`} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {v.businessName}
                  </Link>
                  <span className="small muted">{v.ratingCount ? `★ ${v.ratingAvg} · ${v.ratingCount} reviews` : 'No reviews yet'}</span>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="num" style={{ fontWeight: 700 }}>{v.bookings}</div>
                  <div className="small muted num">{rupeesCompact(v.gmvPaise)}</div>
                </div>
              </div>
            ))
          ) : (
            <div className="empty">No bookings in the last 30 days</div>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Latest bookings</h2>
            {can('bookings.read') && (
              <Link to="/bookings" className="small">
                View all
              </Link>
            )}
          </div>
          {latest?.items.length ? (
            latest.items.map((b) => (
              <Link key={b._id} to={`/bookings/${b._id}`} className="rank" style={{ color: 'inherit', gridTemplateColumns: 'minmax(0, 1fr) auto' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {b.serviceSnapshot?.name} · {b.pet?.name}
                  </div>
                  <span className="small muted">
                    {b.vendor?.businessName} · {formatDate(b.scheduledAt)}
                  </span>
                </div>
                <Badge value={b.status} />
              </Link>
            ))
          ) : (
            <div className="empty">No bookings yet</div>
          )}
        </section>
      </div>

      {d && (
        <section className="mini-tiles" aria-label="Platform totals">
          {[
            { label: 'Users', value: d.users.total, sub: `+${d.users.today} today`, icon: UsersRound, tone: 'violet' },
            { label: 'Pets', value: d.pets, icon: PawPrint, tone: 'orange' },
            { label: 'Active vendors', value: d.vendors.active, icon: Store, tone: 'green' },
            { label: 'Community dogs', value: d.communityDogs, icon: Dog, tone: 'amber' },
            { label: 'Open adoptions', value: d.adoption.open, icon: HeartHandshake, tone: 'rose' },
            { label: 'Community posts', value: d.posts, icon: MessagesSquare, tone: 'blue' },
          ].map((t) => (
            <div key={t.label} className="card mini-tile">
              <DuoIcon icon={t.icon} tone={t.tone} size={44} tilt />
              <div>
                <div className="v num">{t.value.toLocaleString('en-IN')}</div>
                <div className="small muted">
                  {t.label}
                  {t.sub && ` · ${t.sub}`}
                </div>
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
