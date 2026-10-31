import {
  AlertTriangle, ArrowRight, BadgeCheck, CalendarClock, Check, Dog, Download, Fingerprint, FlaskConical, HeartHandshake, Hourglass,
  ShieldAlert, ShieldCheck, Store, UsersRound,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { DuoIcon } from '../icons.jsx';
import { useSession } from '../session.jsx';
import { ErrorNote, LicensePill, ago, formatDate, formatDay, useApi, useConfirm } from '../ui.jsx';

const WINDOWS = [
  ['24h', 'Last 24 hours'],
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
];
const REFRESH_MS = 60_000;
const n = (v) => (v ?? 0).toLocaleString('en-IN');
const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 1000) / 10}%` : '—');
const months = (m) => (m == null ? null : m < 12 ? `${m} mo` : `${Math.round(m / 12)} yr${m >= 24 ? 's' : ''}`);

// Re-renders every minute so queues and metrics stay current while the page is open.
function useTick(ms) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => document.visibilityState === 'visible' && setTick((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return tick;
}

export default function Overview() {
  const { can } = useSession();
  const [range, setRange] = useState('7d');
  const [sort, setSort] = useState('sla');
  const tick = useTick(REFRESH_MS);
  const [confirm, dialog] = useConfirm();

  const { data: m, error } = useApi('/admin/overview', { window: range, _: tick });
  const { data: status } = useApi('/admin/system/status', { _: tick });
  const { data: ledger } = useApi('/admin/audit/verify', { recent: 500, _: tick }, { enabled: can('audit.read') });
  const vendors = useApi('/admin/queues/vendor-applications', { sort, limit: 5, _: tick }, { enabled: can('vendors.read') });
  const safety = useApi('/admin/queues/safety', { limit: 3, _: tick }, { enabled: can('reports.manage') });
  const dogs = useApi('/admin/queues/community-dogs', { limit: 1, _: tick }, { enabled: can('content.moderate') });
  const adoptions = useApi('/admin/queues/adoption-audits', { limit: 1, _: tick }, { enabled: can('content.moderate') });

  const [exporting, setExporting] = useState(null);
  const exportDossier = async () => {
    setExporting('busy');
    try {
      const res = await api.download('/admin/audit/export', {}, 'nurvia-audit.csv');
      setExporting(res.headers.get('x-audit-chain')?.startsWith('verified') ? null : 'The ledger check failed: the export marks where the chain breaks.');
    } catch (e) {
      setExporting(e.message);
    }
  };

  const sandbox = status?.integrations.filter((i) => i.mode !== 'live') ?? [];
  const windowLabel = WINDOWS.find(([k]) => k === range)[1].toLowerCase();

  return (
    <div className="stack ov" style={{ gap: 22 }}>
      {dialog}
      <div className="page-head" style={{ marginBottom: 0, alignItems: 'flex-start' }}>
        <div>
          <div className="eyebrow">Super admin · Operational oversight</div>
          <h1 style={{ marginTop: 6 }}>
            Phase 1 <em>overview</em>
          </h1>
          <p className="muted" style={{ margin: '6px 0 0', maxWidth: 620 }}>
            Live platform health, statutory compliance checks and the queues that need a decision today.
          </p>
        </div>
        <div className="row">
          <label className="row small muted" style={{ gap: 6 }}>
            Metrics window
            <select value={range} onChange={(e) => setRange(e.target.value)}>
              {WINDOWS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {can('audit.read') && (
            <button className="primary" onClick={exportDossier} disabled={exporting === 'busy'} title="All admin actions from the last 30 days as CSV, with ledger hashes">
              <Download size={16} /> {exporting === 'busy' ? 'Exporting…' : 'Export audit dossier'}
            </button>
          )}
        </div>
      </div>
      {exporting && exporting !== 'busy' && <div className="error">{exporting}</div>}

      <div className="ov-banners">
        <div className="ov-banner good">
          <ShieldCheck size={18} />
          <p>
            <strong>Statutory compliance:</strong> community dog care follows the <em>Animal Birth Control Rules, 2023</em>, and adoptions follow AWBI
            non-commercial guidance. Nurvia takes no fee on adoption listings.
          </p>
        </div>
        {sandbox.length > 0 && (
          <div className="ov-banner warn">
            <FlaskConical size={18} />
            <p>
              <strong>Test integrations:</strong> {sandbox.map((i) => `${i.label} (${i.detail})`).join(', ')}{' '}
              {sandbox.length === 1 ? 'is' : 'are'} not connected to a live provider. Everything else on this page is live data.
            </p>
          </div>
        )}
      </div>

      <ErrorNote error={error} />

      <section aria-labelledby="snapshot">
        <div className="ov-section-head">
          <div className="row" style={{ gap: 10 }}>
            <h2 id="snapshot" style={{ margin: 0 }}>Operational snapshot</h2>
            <span className="ov-live">
              <span className="ov-live-dot" /> Live
            </span>
          </div>
          <span className="small muted">
            Growth over the {windowLabel}
            {m && ` · updated ${new Date(m.generatedAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })}`}
          </span>
        </div>
        <div className="ov-metrics">
          <Metric label="Pet parents" icon={UsersRound} tone="violet" value={m?.petParents.total} foot={m && <span className="ov-up">+{n(m.petParents.new)} new</span>} />
          <Metric
            label="Pet passports"
            icon={Fingerprint}
            tone="blue"
            value={m?.pets.total}
            foot={m && <span>{pct(m.pets.microchipped, m.pets.total)} microchipped</span>}
          />
          <Metric
            to="/moderation?type=community-dogs"
            label="Community dogs"
            icon={Dog}
            tone="amber"
            value={m?.communityDogs.monitored}
            foot={m && <span>{n(m.communityDogs.vaccinated)} vaccinated · {n(m.communityDogs.sterilized)} sterilised</span>}
          />
          <Metric
            to="/vendors?status=pending&kycStatus=submitted"
            label="Verified providers"
            icon={BadgeCheck}
            tone="green"
            value={m?.providers.verified}
            foot={m && <span className={m.providers.pendingKyc ? 'ov-warn' : ''}>{n(m.providers.pendingKyc)} awaiting KYC</span>}
          />
          <Metric
            to="/bookings"
            label="Bookings today"
            icon={CalendarClock}
            tone="orange"
            value={m?.bookingsToday.scheduled}
            foot={m && <span>{n(m.bookingsToday.inProgress)} in progress · {n(m.bookingsToday.completed)} done</span>}
          />
          <Metric
            to="/reports"
            label="Safety reports"
            icon={AlertTriangle}
            tone="rose"
            value={m?.safety.open}
            alert={m?.safety.high > 0}
            foot={m && (m.safety.high ? <span className="ov-crit">{n(m.safety.high)} high priority</span> : <span>None high priority</span>)}
          />
        </div>
      </section>

      <section aria-labelledby="queues" className="stack" style={{ gap: 16 }}>
        <div className="ov-section-head">
          <div>
            <h2 id="queues" style={{ margin: 0 }}>Triage queues</h2>
            <span className="small muted">Records waiting on a manual check or an urgent moderation decision.</span>
          </div>
          {can('vendors.read') && (
            <label className="row small muted" style={{ gap: 6 }}>
              Sort vendors by
              <select value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="sla">Urgency (SLA due first)</option>
                <option value="newest">Newest first</option>
              </select>
            </label>
          )}
        </div>

        <div className="ov-grid ov-grid-wide">
          {can('vendors.read') && <VendorQueue q={vendors} />}
          {can('reports.manage') && <SafetyQueue q={safety} confirm={confirm} canModerate={can('content.moderate')} />}
        </div>
        {can('content.moderate') && (
          <div className="ov-grid">
            <DogQueue q={dogs} confirm={confirm} />
            <AdoptionQueue q={adoptions} confirm={confirm} />
          </div>
        )}
      </section>

      {status && (
        <footer className="ov-foot small">
          <span>
            Database: <strong>{status.database.status === 'ok' ? `${status.database.name} · ${status.database.replicaSet ? `replica set ${status.database.replicaSet}` : 'standalone'}` : 'unreachable'}</strong>
            {status.database.latencyMs != null && ` · ${status.database.latencyMs} ms`}
          </span>
          <span>
            Node: <strong>{status.node}</strong> · up {Math.round(status.uptimeSec / 3600)} h
          </span>
          {ledger && (
            <span>
              Audit ledger:{' '}
              {ledger.ok ? (
                <strong className="ov-good">SHA-256 verified ({n(ledger.checked)} recent entries)</strong>
              ) : (
                <strong className="ov-crit">Chain broken at entry #{ledger.brokenAt.seq}</strong>
              )}
            </span>
          )}
          <span>
            Release <strong>v{status.release}</strong> · {status.environment}
          </span>
        </footer>
      )}
    </div>
  );
}

// A metric without `to` is shown as a plain card.
function Metric({ to, label, icon, tone, value, foot, alert = false }) {
  const Box = to ? Link : 'div';
  return (
    <Box to={to} className={`card ov-metric ${alert ? 'alert' : ''}`}>
      <div className="kpi-top">
        <span className="kpi-label">{label}</span>
        <DuoIcon icon={icon} tone={tone} size={34} />
      </div>
      <div className="kpi-value num">{value == null ? '—' : n(value)}</div>
      <div className="small muted">{foot}</div>
    </Box>
  );
}

function QueueCard({ icon, tone, title, sub, badge, children, footer, className = '' }) {
  return (
    <section className={`card ov-queue ${className}`}>
      <div className="ov-queue-head">
        <DuoIcon icon={icon} tone={tone} size={38} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <div className="small muted">{sub}</div>
        </div>
        {badge}
      </div>
      <div className="ov-queue-body">{children}</div>
      {footer && <div className="ov-queue-foot">{footer}</div>}
    </section>
  );
}

function Loading({ q, empty }) {
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return <div className="empty">Loading…</div>;
  return (
    <div className="empty">
      <Check size={18} /> {empty}
    </div>
  );
}

// ---- Queue A ----

function VendorQueue({ q }) {
  const d = q.data;
  return (
    <QueueCard
      icon={Store}
      tone="amber"
      title="A · Vendor applications"
      sub="Clinics and care providers waiting on KYC and trade licence checks"
      badge={d && <span className="ov-chip">SLA {d.slaHours} h</span>}
      footer={
        d && (
          <>
            <span className="muted">
              Showing {d.items.length} of {d.total} awaiting review
            </span>
            <Link to="/vendors?status=pending&kycStatus=submitted" className="row" style={{ gap: 4 }}>
              All vendor applications <ArrowRight size={14} />
            </Link>
          </>
        )
      }
    >
      {d?.items.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Vendor</th>
                <th>Locality</th>
                <th>Submitted</th>
                <th>Trade licence</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {d.items.map((v) => (
                <tr key={v._id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{v.businessName}</div>
                    <div className="small muted">{v.categories.join(', ') || 'No category'}</div>
                  </td>
                  <td className="small">
                    {v.locality}
                    <div className="muted">{v.city}</div>
                  </td>
                  <td className="small">
                    {formatDay(v.submittedAt)}
                    <div className={v.overdue ? 'ov-crit' : 'muted'}>
                      {v.overdue ? `SLA missed ${ago(v.slaDueAt).replace(' ago', '')} ago` : `due ${new Date(v.slaDueAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })}`}
                    </div>
                  </td>
                  <td>
                    <LicensePill status={v.licenseStatus} />
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <Link to={`/vendors/${v._id}`} className={`ov-btn ${v.licenseStatus === 'pending_upload' ? '' : 'primary'}`}>
                      Review dossier
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Loading q={q} empty="No applications waiting" />
      )}
    </QueueCard>
  );
}

// ---- Queue B ----

const REASONS = {
  harmful_advice: 'Unsafe health advice',
  animal_cruelty: 'Animal cruelty',
  fraud: 'Fraud',
  harassment: 'Harassment',
  abuse: 'Abuse',
  misinformation: 'Misinformation',
  spam: 'Spam',
  inappropriate: 'Inappropriate',
  other: 'Other',
};

function SafetyQueue({ q, confirm, canModerate }) {
  const d = q.data;
  const top = d?.items[0];
  const preview = top?.target && (top.target.text ?? top.target.name ?? top.target.businessName ?? top.target.title);

  const enforce = () =>
    confirm({
      title: 'Take the content down?',
      message: 'The reported item is removed, its author is told why, and every open report on it is closed.',
      reason: 'required',
      danger: true,
      confirmLabel: 'Remove content',
      onConfirm: async (resolution) => {
        await api.post(`/admin/reports/${top._id}/enforce`, { resolution });
        q.reload();
      },
    });
  const dismiss = () =>
    confirm({
      title: 'Dismiss this report?',
      message: top.quarantined ? 'The content goes back on view unless another high-priority report on it is still open.' : 'Nothing changes for the reported item.',
      reason: 'required',
      confirmLabel: 'Dismiss',
      onConfirm: async (resolution) => {
        await api.patch(`/admin/reports/${top._id}`, { status: 'dismissed', resolution });
        q.reload();
      },
    });

  return (
    <QueueCard
      icon={ShieldAlert}
      tone="rose"
      title="B · Safety alerts"
      sub="Highest severity first"
      className={top?.severity === 'high' ? 'ov-urgent' : ''}
      badge={top?.severity === 'high' && <span className="ov-chip crit">Immediate</span>}
      footer={
        top && (
          <>
            <button className="danger-solid" onClick={enforce} disabled={!canModerate} title={canModerate ? undefined : 'Needs the content.moderate permission'}>
              <ShieldAlert size={15} /> Take action
            </button>
            <button onClick={dismiss}>Dismiss</button>
          </>
        )
      }
    >
      {top ? (
        <div className="stack" style={{ gap: 12 }}>
          <div className="ov-case">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="mono muted">Case {top.ref}</span>
              <span className={`badge ${top.severity === 'high' ? 'critical' : top.severity === 'medium' ? 'warning' : ''}`}>
                {top.severity} · {REASONS[top.reason] ?? top.reason}
              </span>
            </div>
            <div className="small muted" style={{ marginTop: 8, textTransform: 'capitalize' }}>
              Reported {top.targetType.replace('_', ' ')}
              {top.target?.status && ` · now ${top.target.status}`}
            </div>
            <p className="ov-quote">{preview ? `“${preview}”` : 'The reported item has been deleted.'}</p>
            {top.details && (
              <div className="ov-flag">
                <strong>Reporter's note:</strong> {top.details}
                {top.quarantined && top.target?.status === 'hidden' && <> Auto-hidden from the feed until a decision.</>}
              </div>
            )}
            <div className="row small muted" style={{ justifyContent: 'space-between', marginTop: 10 }}>
              <span>
                Reported by {top.reporter.name ?? 'a member'} ({top.reporter.label})
              </span>
              <span>{ago(top.createdAt)}</span>
            </div>
          </div>
          <Link to="/reports" className="row small" style={{ justifyContent: 'space-between' }}>
            <span className="muted">
              Other open reports: <strong style={{ color: 'var(--ink)' }}>{d.total - 1}</strong>
              {d.total > 1 && ` (${d.bySeverity.high} high, ${d.bySeverity.medium} medium, ${d.bySeverity.low} low in total)`}
            </span>
            <ArrowRight size={14} />
          </Link>
        </div>
      ) : (
        <Loading q={q} empty="No open reports" />
      )}
    </QueueCard>
  );
}

// ---- Queue C ----

function DogQueue({ q, confirm }) {
  const d = q.data;
  const dog = d?.items[0];
  const decide = (action) =>
    confirm({
      title: action === 'approve' ? `Give ${dog.name ?? 'this dog'} the community badge?` : 'Ask the caregiver for changes',
      message: action === 'approve' ? 'Confirms the territory and caregivers. The caregiver is notified.' : 'Say what needs fixing; the caregiver is notified.',
      reason: action === 'approve' ? 'optional' : 'required',
      confirmLabel: action === 'approve' ? 'Approve badge' : 'Request changes',
      onConfirm: async (note) => {
        await api.post(`/admin/compliance/community-dogs/${dog._id}/verification`, { action, note });
        q.reload();
      },
    });
  const shot = dog?.lastVaccination;
  return (
    <QueueCard
      icon={Dog}
      tone="amber"
      title="C · Community dog profiles"
      sub="Territory verification and caregiver endorsement"
      badge={d && <span className="ov-chip">{d.total} pending</span>}
      footer={
        dog && (
          <>
            <span className="small muted">Submitted {ago(dog.createdAt)}</span>
            <div className="row">
              <button onClick={() => decide('request_changes')}>Request changes</button>
              <button className="primary" onClick={() => decide('approve')}>
                Approve badge
              </button>
            </div>
          </>
        )
      }
    >
      {dog ? (
        <div className="ov-case">
          <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <span className="ov-avatar">{(dog.name ?? '?').slice(0, 2).toUpperCase()}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong style={{ fontSize: 16 }}>{dog.name ?? 'Unnamed dog'}</strong>
                <span className="mono small muted">{dog.ref}</span>
              </div>
              <div className="small muted" style={{ textTransform: 'capitalize' }}>
                {[dog.sex !== 'unknown' && dog.sex, months(dog.approxAgeMonths), dog.sterilized ? 'sterilised' : 'not sterilised'].filter(Boolean).join(' · ')}
              </div>
            </div>
          </div>
          <dl className="ov-kv">
            <dt>Territory</dt>
            <dd>
              {dog.area}
              {dog.city && `, ${dog.city}`}
            </dd>
            <dt>Submitted by</dt>
            <dd>{dog.submitter?.name ?? dog.submitter?.phone ?? '—'}</dd>
            <dt>Vaccination</dt>
            <dd className={shot ? 'ov-good' : 'ov-warn'}>{shot ? `${shot.note ?? 'Vaccinated'} · valid till ${formatDay(shot.validUntil)}` : 'No vaccination logged'}</dd>
            <dt>Caregivers</dt>
            <dd className={dog.caregiverCount > 1 ? 'ov-good' : 'ov-warn'}>
              {dog.caregiverCount} {dog.caregiverCount === 1 ? 'feeder (no co-feeder yet)' : 'co-feeders confirmed'}
            </dd>
          </dl>
          {dog.description && <p className="ov-quote small">“{dog.description}”</p>}
        </div>
      ) : (
        <Loading q={q} empty="No profiles waiting" />
      )}
    </QueueCard>
  );
}

// ---- Queue D ----

const HOME = { apartment: 'Apartment', independent_house: 'Independent house', farm: 'Farm', other: 'Other' };

function AdoptionQueue({ q, confirm }) {
  const d = q.data;
  const a = d?.items[0];
  const [chipAt, setChipAt] = useState('');
  const [error, setError] = useState(null);
  const url = a && `/admin/compliance/adoption/applications/${a._id}/compliance`;

  const act = (body, options) =>
    confirm({
      ...options,
      onConfirm: async (note) => {
        await api.post(url, { ...body, note });
        q.reload();
      },
    });
  const schedule = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await api.post(url, { action: 'schedule_microchip', scheduledAt: new Date(chipAt).toISOString() });
      setChipAt('');
      q.reload();
    } catch (err) {
      setError(err);
    }
  };

  const c = a?.compliance;
  const ready = c && c.homeCheck.status === 'passed' && (!a.microchipRequired || c.microchip?.scheduledAt || c.microchip?.chipId);

  return (
    <QueueCard
      icon={HeartHandshake}
      tone="teal"
      title="D · Adoption compliance"
      sub="Zero-fee check, home visit and microchip before sign-off"
      badge={d && <span className="ov-chip">{d.total} awaiting sign-off</span>}
      footer={
        a && (
          <>
            <span className="small muted">Stage: {c.status === 'info_requested' ? 'waiting on information' : 'final sign-off'}</span>
            <div className="row">
              <button onClick={() => act({ action: 'request_info' }, { title: 'Request more information', reason: 'required', confirmLabel: 'Send request', message: 'The adopter and the lister are both notified.' })}>
                Request info
              </button>
              <button
                className="primary"
                disabled={!ready}
                title={ready ? undefined : 'Needs a passed home check and a microchip appointment'}
                onClick={() => act({ action: 'certify' }, { title: `Certify ${a.listing?.name}'s adoption?`, reason: 'optional', confirmLabel: 'Certify', message: 'The listing is marked adopted and other pending applications are closed.' })}
              >
                Certify adoption
              </button>
            </div>
          </>
        )
      }
    >
      {a ? (
        <div className="ov-case">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong style={{ fontSize: 16 }}>Enquiry {a.ref}</strong>
            {c.homeCheck.status === 'passed' && <span className="badge good">Home check passed</span>}
          </div>
          <div className="small muted" style={{ marginBottom: 6 }}>
            {a.listing?.name} ({[a.listing?.breed ?? a.listing?.species, months(a.listing?.ageMonths)].filter(Boolean).join(', ')})
          </div>
          <dl className="ov-kv">
            <dt>Adopter</dt>
            <dd>
              {a.applicant?.name ?? a.applicant?.phone}
              {a.home?.type && <span className="muted"> · {HOME[a.home.type]}</span>}
            </dd>
            <dt>Fee</dt>
            <dd className="ov-good">
              <Check size={13} /> ₹0 · no fee taken (non-commercial)
            </dd>
            <dt>Home check</dt>
            <dd className={c.homeCheck.status === 'passed' ? '' : c.homeCheck.status === 'failed' ? 'ov-crit' : 'ov-warn'}>
              {c.homeCheck.status === 'pending' ? (
                <span className="row" style={{ gap: 6 }}>
                  Not done yet
                  <button className="link" onClick={() => act({ action: 'home_check', result: 'passed' }, { title: 'Home check passed', reason: 'optional', confirmLabel: 'Record pass', message: 'Who visited, and what did they see?' })}>
                    Record pass
                  </button>
                  <button className="link" style={{ color: 'var(--critical)' }} onClick={() => act({ action: 'home_check', result: 'failed' }, { title: 'Home check failed', reason: 'required', danger: true, confirmLabel: 'Record failure' })}>
                    Record fail
                  </button>
                </span>
              ) : (
                c.homeCheck.note ?? c.homeCheck.status
              )}
            </dd>
            <dt>Microchip</dt>
            <dd>
              {c.microchip?.chipId ? (
                <span className="mono">{c.microchip.chipId}</span>
              ) : c.microchip?.scheduledAt ? (
                `Booked for ${formatDate(c.microchip.scheduledAt)}`
              ) : a.microchipRequired ? (
                <form className="row" style={{ gap: 6 }} onSubmit={schedule}>
                  <input type="datetime-local" value={chipAt} onChange={(e) => setChipAt(e.target.value)} required aria-label="Microchip appointment" />
                  <button>Book</button>
                </form>
              ) : (
                <span className="muted">Not required for {a.listing?.species}</span>
              )}
            </dd>
          </dl>
          {c.status === 'info_requested' && c.note && (
            <div className="ov-flag" style={{ marginTop: 10 }}>
              <Hourglass size={13} /> Waiting on: {c.note}
            </div>
          )}
          <ErrorNote error={error} />
        </div>
      ) : (
        <Loading q={q} empty="No adoptions awaiting sign-off" />
      )}
    </QueueCard>
  );
}
