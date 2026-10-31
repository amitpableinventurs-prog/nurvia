import { Phone } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { availableActions, runAction, useReschedule } from '../booking-actions.jsx';
import { Badge, ErrorNote, Table, formatDate, formatDay, formatRupees, useApi, useConfirm } from '../ui.jsx';

const ACTION_LABELS = { create: 'Requested', accept: 'Accepted', reject: 'Declined', reschedule: 'Rescheduled', cancel: 'Cancelled', complete: 'Completed', no_show: 'Marked no-show' };

function age(dob) {
  if (!dob) return null;
  const months = Math.floor((Date.now() - new Date(dob)) / (30.44 * 86_400_000));
  return months < 12 ? `${months} months` : `${Math.floor(months / 12)} yr${months >= 24 ? 's' : ''}${months % 12 ? ` ${months % 12} mo` : ''}`;
}

export default function BookingDetail() {
  const { id } = useParams();
  const { data: b, error, reload } = useApi(`/bookings/${id}`);
  const customerId = b?.user?._id;
  const { data: history } = useApi('/bookings', { as: 'vendor', customer: customerId, limit: 10 }, { enabled: Boolean(customerId) });
  const [confirm, dialog] = useConfirm();
  const [reschedule, rescheduleDialog] = useReschedule(reload);

  if (error) return <ErrorNote error={error} />;
  if (!b) return <div className="muted">Loading…</div>;
  const pet = b.pet ?? {};
  const actions = availableActions({ ...b, vendor: b.vendor?._id, service: b.service });
  const past = history?.items.filter((h) => h._id !== b._id) ?? [];

  return (
    <div className="stack" style={{ gap: 18 }}>
      {dialog}
      {rescheduleDialog}
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <Link to="/bookings" className="small">
            ← Bookings
          </Link>
          <h1>
            {pet.name} · {b.serviceSnapshot?.name}
          </h1>
          <div className="row small" style={{ marginTop: 4 }}>
            <Badge value={b.status} /> <span className="muted mono">{b.code}</span> <span className="muted">· {formatDate(b.scheduledAt)}</span>
          </div>
        </div>
        <div className="row">
          {actions.map((a) => (
            <button
              key={a.action}
              className={a.primary ? 'primary' : a.danger ? 'danger' : ''}
              onClick={() => runAction({ booking: { ...b, vendor: b.vendor?._id }, action: a, confirm, reschedule, onDone: reload })}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <section className="card">
          <h2>Pet</h2>
          <dl className="kv">
            <dt>Name</dt>
            <dd>{pet.name}</dd>
            <dt>Species / breed</dt>
            <dd style={{ textTransform: 'capitalize' }}>{[pet.species, pet.breed].filter(Boolean).join(' · ')}</dd>
            <dt>Sex</dt>
            <dd style={{ textTransform: 'capitalize' }}>
              {pet.sex ?? 'unknown'}
              {pet.neutered != null && ` · ${pet.neutered ? 'neutered' : 'not neutered'}`}
            </dd>
            <dt>Age</dt>
            <dd>{age(pet.dateOfBirth) ?? '—'}</dd>
            <dt>Weight</dt>
            <dd>{pet.weightKg ? `${pet.weightKg} kg` : '—'}</dd>
            <dt>Allergies</dt>
            <dd className={pet.allergies?.length ? 'ov-crit' : ''}>{pet.allergies?.length ? pet.allergies.join(', ') : 'None recorded'}</dd>
            <dt>Microchip</dt>
            <dd className="mono">{pet.microchipId ?? '—'}</dd>
          </dl>
          {b.notes && (
            <>
              <h3 style={{ margin: '14px 0 6px' }}>Note from the customer</h3>
              <p className="ov-quote" style={{ margin: 0 }}>“{b.notes}”</p>
            </>
          )}
        </section>

        <section className="card">
          <h2>Customer & payment</h2>
          <dl className="kv">
            <dt>Customer</dt>
            <dd>{b.user?.name ?? 'Customer'}</dd>
            <dt>Phone</dt>
            <dd>
              {b.user?.phone ? (
                <a href={`tel:${b.user.phone}`} className="row" style={{ gap: 4, display: 'inline-flex' }}>
                  <Phone size={13} /> {b.user.phone}
                </a>
              ) : (
                '—'
              )}
            </dd>
            <dt>Visits with you</dt>
            <dd>{history ? `${history.total} booking${history.total === 1 ? '' : 's'}` : '—'}</dd>
            <dt>Service</dt>
            <dd>
              {b.serviceSnapshot?.name} · {b.serviceSnapshot?.durationMin} min
              {b.serviceSnapshot?.mode === 'home_visit' && ' · home visit'}
            </dd>
            <dt>Price</dt>
            <dd>{formatRupees(b.serviceSnapshot?.pricePaise)}</dd>
            <dt>Payment</dt>
            <dd>
              <Badge value={b.payment?.status} />
              {b.payment?.paidAt && <span className="small muted"> · paid {formatDate(b.payment.paidAt)}</span>}
              {b.payment?.refundedAt && <span className="small muted"> · refunded {formatDate(b.payment.refundedAt)}</span>}
            </dd>
          </dl>
        </section>
      </div>

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <section className="card">
          <h2>What happened</h2>
          <ol className="vp-history">
            {b.statusHistory?.map((h, i) => (
              <li key={i}>
                <strong>{ACTION_LABELS[h.action] ?? h.action}</strong>
                <span className="small muted">
                  {formatDate(h.at)}
                  {h.by?.name && ` · ${h.by.name}`}
                </span>
                {h.note && <div className="small">“{h.note}”</div>}
              </li>
            ))}
          </ol>
        </section>

        <section className="card">
          <h2>Earlier visits by {b.user?.name?.split(' ')[0] ?? 'this customer'}</h2>
          <Table
            rows={history ? past : null}
            empty="First visit with you"
            columns={[
              { label: 'When', render: (h) => <Link to={`/bookings/${h._id}`}>{formatDay(h.scheduledAt)}</Link> },
              { label: 'Pet & service', render: (h) => `${h.pet?.name} · ${h.serviceSnapshot?.name}` },
              { label: 'Status', render: (h) => <Badge value={h.status} /> },
            ]}
          />
        </section>
      </div>
    </div>
  );
}
