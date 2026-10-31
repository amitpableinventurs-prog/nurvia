import { Link, useParams } from 'react-router-dom';
import { Badge, ErrorNote, Table, formatDate, formatRupees, useApi } from '../ui.jsx';

export default function BookingDetail() {
  const { id } = useParams();
  const { data: b, error } = useApi(`/admin/bookings/${id}`);
  if (error) return <ErrorNote error={error} />;
  if (!b) return <div className="muted">Loading…</div>;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <Link to="/bookings" className="small">
            ← Bookings
          </Link>
          <h1 className="row">
            Booking <span className="mono" style={{ fontSize: 18 }}>{b.code}</span> <Badge value={b.status} />
          </h1>
        </div>
      </div>
      <div className="grid-2">
        <section className="card">
          <h2>Appointment</h2>
          <dl className="kv">
            <dt>When</dt>
            <dd>
              {formatDate(b.scheduledAt)} – {new Date(b.endsAt).toLocaleTimeString('en-IN', { timeStyle: 'short', timeZone: 'Asia/Kolkata' })}
            </dd>
            <dt>Service</dt>
            <dd>
              {b.serviceSnapshot?.name} · {b.serviceSnapshot?.durationMin} min · {b.serviceSnapshot?.mode?.replace('_', ' ')}
            </dd>
            <dt>Vendor</dt>
            <dd>
              <Link to={`/vendors/${b.vendor?._id}`}>{b.vendor?.businessName}</Link> · {b.vendor?.phone ?? '—'}
            </dd>
            <dt>Customer</dt>
            <dd>
              {b.user?.name ?? 'Unnamed'} · {b.user?.phone ?? b.user?.email}
            </dd>
            <dt>Pet</dt>
            <dd>
              {b.pet?.name} ({[b.pet?.species, b.pet?.breed].filter(Boolean).join(', ')})
            </dd>
            <dt>Notes</dt>
            <dd>{b.notes || '—'}</dd>
            <dt>Booked</dt>
            <dd>{formatDate(b.createdAt)}</dd>
          </dl>
        </section>
        <section className="card">
          <h2>Payment</h2>
          <dl className="kv">
            <dt>Status</dt>
            <dd>
              <Badge value={b.payment?.status} />
            </dd>
            <dt>Amount</dt>
            <dd>{formatRupees(b.payment?.amountPaise ?? b.serviceSnapshot?.pricePaise)}</dd>
            <dt>Gateway</dt>
            <dd>{b.payment?.gateway ?? '—'}</dd>
            <dt>Order</dt>
            <dd className="mono">{b.payment?.orderId ?? '—'}</dd>
            <dt>Payment</dt>
            <dd className="mono">{b.payment?.paymentId ?? '—'}</dd>
            <dt>Paid</dt>
            <dd>{formatDate(b.payment?.paidAt)}</dd>
            <dt>Refund</dt>
            <dd>
              <span className="mono">{b.payment?.refundId ?? '—'}</span> {b.payment?.refundedAt && `· ${formatDate(b.payment.refundedAt)}`}
            </dd>
            {b.payment?.failureReason && (
              <>
                <dt>Failure</dt>
                <dd>{b.payment.failureReason}</dd>
              </>
            )}
          </dl>
        </section>
      </div>
      <section className="card">
        <h2>Status history</h2>
        <Table
          rows={b.statusHistory}
          rowKey={(h) => `${h.at}-${h.action}`}
          columns={[
            { label: 'When', render: (h) => formatDate(h.at) },
            { label: 'Action', render: (h) => h.action?.replace('_', ' ') },
            { label: 'Status', render: (h) => <Badge value={h.status} /> },
            { label: 'By', render: (h) => h.by?.name ?? '—' },
            { label: 'Note', render: (h) => h.note ?? '' },
          ]}
        />
      </section>
    </div>
  );
}
