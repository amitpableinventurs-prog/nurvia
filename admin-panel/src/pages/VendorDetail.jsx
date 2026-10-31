import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useSession } from '../session.jsx';
import { Badge, ErrorNote, LicensePill, Table, formatDate, formatRupees, useApi, useConfirm } from '../ui.jsx';

// Decisions on a pending application live in the review checklist; these are for live vendors.
const ACTIONS = {
  active: [{ action: 'suspend', label: 'Suspend', reason: 'required', danger: true }],
  suspended: [{ action: 'reactivate', label: 'Reactivate', reason: 'optional' }],
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SLA_HOURS = 24;

export default function VendorDetail() {
  const { id } = useParams();
  const { can } = useSession();
  const { data: v, error, reload } = useApi(`/admin/vendors/${id}`);
  const [confirm, dialog] = useConfirm();
  const [opened, setOpened] = useState(() => new Set());

  if (error) return <ErrorNote error={error} />;
  if (!v) return <div className="muted">Loading…</div>;

  const openDoc = (d) =>
    api
      .openFile(d.file)
      .then(() => setOpened((s) => new Set(s).add(String(d.file))))
      .catch((e) => alert(e.message));

  const review = (a) =>
    confirm({
      title: `${a.label} ${v.businessName}?`,
      message: a.message,
      reason: a.reason,
      danger: a.danger,
      confirmLabel: a.label,
      onConfirm: async (reason) => {
        await api.post(`/admin/vendors/${id}/review`, { action: a.action, reason });
        reload();
      },
    });

  const licenceVerified = v.licenseStatus === 'verified';
  const approve = () =>
    review({
      action: 'approve',
      label: 'Approve and go live',
      reason: licenceVerified ? 'optional' : 'required',
      message: licenceVerified
        ? 'The business becomes visible and bookable for customers in its city, and the owner is notified.'
        : 'The trade licence has not been verified. Say why this business can go live without it (for example, dog walkers need no trade licence). The reason is kept in the audit log.',
    });
  const requestChanges = () =>
    review({
      action: 'reject',
      label: 'Request changes',
      reason: 'required',
      danger: true,
      message: 'The owner sees your note in their panel, fixes their documents and submits again. The application then comes back to this queue.',
    });

  const checkLicense = (result) =>
    confirm({
      title: result === 'verified' ? 'Licence matches the register' : 'Licence does not match',
      message: 'Check the uploaded licence against the issuing authority (BBMP trade licence or veterinary council) before recording this.',
      reason: result === 'failed' ? 'required' : 'optional',
      danger: result === 'failed',
      confirmLabel: result === 'verified' ? 'Mark verified' : 'Record mismatch',
      onConfirm: async (note) => {
        await api.post(`/admin/vendors/${id}/license-check`, { result, note });
        reload();
      },
    });

  const actions = ACTIONS[v.status] ?? [];
  const inReview = v.status === 'pending' && v.kyc?.status === 'submitted';
  const docs = v.kyc?.documents ?? [];
  const allOpened = docs.length > 0 && docs.every((d) => opened.has(String(d.file)));
  const activeServices = v.services.filter((s) => s.active).length;
  const due = v.kyc?.submittedAt && new Date(new Date(v.kyc.submittedAt).getTime() + SLA_HOURS * 3_600_000);

  return (
    <div className="stack">
      {dialog}
      <div className="page-head">
        <div>
          <Link to="/vendors" className="small">
            ← Vendors
          </Link>
          <h1>{v.businessName}</h1>
          <div className="row small" style={{ marginTop: 4 }}>
            <Badge value={v.status} /> <span className="muted">KYC</span> <Badge value={v.kyc?.status} />
          </div>
        </div>
        {can('vendors.review') && (
          <div className="row">
            {actions.map((a) => (
              <button key={a.action} className={a.danger ? 'danger' : 'primary'} onClick={() => review(a)}>
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {v.status === 'pending' && v.kyc?.status !== 'submitted' && (
        <div className="notice">Waiting for the vendor to submit KYC documents. The application appears in the review queue as soon as they do.</div>
      )}
      {v.status === 'rejected' && (
        <div className="notice">Changes requested{v.statusReason ? `: ${v.statusReason}` : ''}. Waiting for the vendor to update their documents and submit again.</div>
      )}
      {v.statusReason && !['rejected'].includes(v.status) && <div className="notice">Last decision: {v.statusReason}</div>}

      {inReview && (
        <section className="card vd-review">
          <div className="card-head">
            <div>
              <h2 style={{ margin: 0 }}>Review this application</h2>
              <div className="small muted">
                Submitted {formatDate(v.kyc.submittedAt)} ·{' '}
                {due < new Date() ? <strong className="ov-crit">decision overdue</strong> : `decide by ${formatDate(due)}`}
              </div>
            </div>
          </div>
          <ol className="vd-checklist">
            <li className={allOpened ? 'done' : ''}>
              <span className="vd-num">{allOpened ? '✓' : 1}</span>
              <div>
                <strong>Open each document</strong>
                <div className="small muted">Match the names, PAN/GSTIN and address with the business profile.</div>
                <div className="row" style={{ marginTop: 6 }}>
                  {docs.map((d) => (
                    <button key={d.file} className={opened.has(String(d.file)) ? '' : 'primary'} onClick={() => openDoc(d)}>
                      {opened.has(String(d.file)) ? '✓ ' : ''}
                      {d.type.replaceAll('_', ' ')}
                    </button>
                  ))}
                </div>
              </div>
            </li>
            <li className={licenceVerified ? 'done' : v.licenseStatus === 'failed' ? 'bad' : ''}>
              <span className="vd-num">{licenceVerified ? '✓' : 2}</span>
              <div>
                <strong>Check the trade licence</strong> <LicensePill status={v.licenseStatus} />
                <div className="small muted">
                  {v.licenseStatus === 'pending_upload'
                    ? 'No licence uploaded. Request changes, or approve with a reason if this category needs none.'
                    : 'Look it up with the issuing authority (BBMP trade licence or state veterinary council), then record the result.'}
                </div>
                {v.licenseStatus !== 'pending_upload' && (
                  <div className="row" style={{ marginTop: 6 }}>
                    <button onClick={() => checkLicense('verified')} disabled={licenceVerified}>
                      Matches the register
                    </button>
                    <button className="danger" onClick={() => checkLicense('failed')} disabled={v.licenseStatus === 'failed'}>
                      Does not match
                    </button>
                  </div>
                )}
              </div>
            </li>
            <li className={activeServices && v.operatingHours?.length ? 'done' : ''}>
              <span className="vd-num">{activeServices && v.operatingHours?.length ? '✓' : 3}</span>
              <div>
                <strong>Ready for customers?</strong>
                <div className="small muted">
                  {activeServices} active service{activeServices === 1 ? '' : 's'} · {v.operatingHours?.length ? 'opening hours set' : 'no opening hours'} ·{' '}
                  {v.photos?.length ? `${v.photos.length} photos` : 'no photos'}. Not required for approval, but customers cannot book until services and hours exist.
                </div>
              </div>
            </li>
            <li>
              <span className="vd-num">4</span>
              <div>
                <strong>Decide</strong>
                <div className="small muted">The owner is notified either way, and the decision is recorded in the audit log.</div>
                {can('vendors.review') ? (
                  <div className="row" style={{ marginTop: 6 }}>
                    <button className="primary" onClick={approve}>
                      Approve and go live
                    </button>
                    <button className="danger" onClick={requestChanges}>
                      Request changes
                    </button>
                  </div>
                ) : (
                  <div className="small">You can view this application; deciding needs the vendors.review permission.</div>
                )}
              </div>
            </li>
          </ol>
        </section>
      )}

      <div className="grid-2">
        <section className="card">
          <h2>Business</h2>
          <dl className="kv">
            <dt>Owner</dt>
            <dd>
              {v.owner?.name ?? 'Unnamed'} · {v.owner?.phone ?? v.owner?.email}
            </dd>
            <dt>Categories</dt>
            <dd>{v.categories?.map((c) => c.name).join(', ')}</dd>
            <dt>Contact</dt>
            <dd>{[v.phone, v.email].filter(Boolean).join(' · ') || '—'}</dd>
            <dt>Address</dt>
            <dd>{[v.address?.line1, v.address?.line2, v.address?.city, v.address?.state, v.address?.pincode].filter(Boolean).join(', ')}</dd>
            <dt>Location</dt>
            <dd>
              <a href={`https://www.google.com/maps?q=${v.location?.coordinates?.[1]},${v.location?.coordinates?.[0]}`} target="_blank" rel="noreferrer">
                Open map
              </a>
            </dd>
            <dt>Rating</dt>
            <dd>{v.ratingCount ? `${v.ratingAvg} ★ from ${v.ratingCount}` : 'No reviews yet'}</dd>
            <dt>Registered</dt>
            <dd>{formatDate(v.createdAt)}</dd>
          </dl>
          {v.description && <p>{v.description}</p>}
        </section>

        <section className="card">
          <h2>KYC</h2>
          <dl className="kv">
            <dt>GSTIN</dt>
            <dd className="mono">{v.kyc?.gstin ?? '—'}</dd>
            <dt>PAN</dt>
            <dd className="mono">{v.kyc?.pan ?? '—'}</dd>
            <dt>Submitted</dt>
            <dd>{formatDate(v.kyc?.submittedAt)}</dd>
            <dt>Reviewed</dt>
            <dd>{v.kyc?.reviewedAt ? `${formatDate(v.kyc.reviewedAt)} by ${v.kyc.reviewedBy?.name ?? 'staff'}` : '—'}</dd>
            <dt>Trade licence</dt>
            <dd>
              <LicensePill status={v.licenseStatus} />
              {v.kyc?.licenseCheck?.note && <div className="small muted">{v.kyc.licenseCheck.note}</div>}
              {can('vendors.review') && v.licenseStatus !== 'pending_upload' && (
                <div className="row" style={{ marginTop: 8 }}>
                  <button onClick={() => checkLicense('verified')} disabled={v.licenseStatus === 'verified'}>
                    Mark verified
                  </button>
                  <button className="danger" onClick={() => checkLicense('failed')} disabled={v.licenseStatus === 'failed'}>
                    Does not match
                  </button>
                </div>
              )}
            </dd>
          </dl>
          <h3 style={{ margin: '16px 0 8px' }}>Documents</h3>
          {v.kyc?.documents?.length ? (
            <ul>
              {v.kyc.documents.map((d) => (
                <li key={d.file}>
                  <button className="link" onClick={() => api.openFile(d.file).catch((e) => alert(e.message))}>
                    {d.type.replaceAll('_', ' ')}
                  </button>{' '}
                  <span className="small muted">{d.name}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="muted">No documents</div>
          )}
        </section>

        <section className="card">
          <h2>Operating hours</h2>
          {v.operatingHours?.length ? (
            <dl className="kv">
              {DAYS.map((day, i) => {
                const windows = v.operatingHours.filter((w) => w.day === i);
                return [
                  <dt key={`${day}-t`}>{day}</dt>,
                  <dd key={`${day}-d`}>{windows.length ? windows.map((w) => `${w.open}–${w.close}`).join(', ') : <span className="muted">Closed</span>}</dd>,
                ];
              })}
            </dl>
          ) : (
            <div className="muted">Not set — the vendor cannot take bookings until hours are added.</div>
          )}
        </section>
      </div>

      <section className="card">
        <h2>Services</h2>
        <Table
          rows={v.services}
          empty="No services yet"
          columns={[
            { label: 'Service', render: (s) => s.name },
            { label: 'Mode', render: (s) => s.mode.replace('_', ' ') },
            { label: 'Duration', num: true, render: (s) => `${s.durationMin} min` },
            { label: 'Price', num: true, render: (s) => formatRupees(s.pricePaise) },
            { label: 'Status', render: (s) => <Badge value={s.active ? 'active' : 'hidden'} /> },
          ]}
        />
        <div className="row" style={{ marginTop: 12 }}>
          <Link to={`/bookings?vendor=${v._id}`}>View this vendor's bookings →</Link>
        </div>
      </section>
    </div>
  );
}
