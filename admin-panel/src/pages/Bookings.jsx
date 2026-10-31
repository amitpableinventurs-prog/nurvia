import { Link } from 'react-router-dom';
import { Badge, ErrorNote, Pager, Table, formatDate, formatRupees, useApi } from '../ui.jsx';
import { useFilters } from '../useFilters.js';

const STATUSES = ['pending', 'accepted', 'rejected', 'cancelled', 'completed', 'no_show'];
const PAYMENT = ['unpaid', 'pending', 'paid', 'failed', 'refund_pending', 'refunded'];

export default function Bookings() {
  const [filters, setFilter] = useFilters();
  const { data, error, loading } = useApi('/admin/bookings', filters);

  return (
    <div>
      <div className="page-head">
        <h1>Bookings</h1>
      </div>
      <div className="filters">
        <input type="search" placeholder="Booking code" defaultValue={filters.code} onKeyDown={(e) => e.key === 'Enter' && setFilter('code', e.currentTarget.value)} aria-label="Booking code" />
        <select value={filters.status ?? ''} onChange={(e) => setFilter('status', e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ')}
            </option>
          ))}
        </select>
        <select value={filters.paymentStatus ?? ''} onChange={(e) => setFilter('paymentStatus', e.target.value)} aria-label="Payment status">
          <option value="">Any payment</option>
          {PAYMENT.map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ')}
            </option>
          ))}
        </select>
        <label className="row small muted">
          From <input type="date" value={filters.from ?? ''} onChange={(e) => setFilter('from', e.target.value)} />
        </label>
        <label className="row small muted">
          To <input type="date" value={filters.to ?? ''} onChange={(e) => setFilter('to', e.target.value)} />
        </label>
        {filters.vendor && (
          <button onClick={() => setFilter('vendor', '')} title="Clear vendor filter">
            Vendor filter ✕
          </button>
        )}
      </div>
      <ErrorNote error={error} />
      <div className="card">
        {loading && !data && <div className="empty">Loading…</div>}
        <Table
          rows={data?.items}
          empty="No bookings match these filters"
          columns={[
            { label: 'Code', render: (b) => <Link to={`/bookings/${b._id}`} className="mono">{b.code}</Link> },
            { label: 'Appointment', render: (b) => formatDate(b.scheduledAt) },
            { label: 'Customer', render: (b) => <>{b.user?.name ?? '—'}<div className="small muted">{b.pet?.name} · {b.pet?.species}</div></> },
            { label: 'Vendor', render: (b) => <Link to={`/vendors/${b.vendor?._id}`}>{b.vendor?.businessName}</Link> },
            { label: 'Service', render: (b) => b.serviceSnapshot?.name },
            { label: 'Amount', num: true, render: (b) => formatRupees(b.serviceSnapshot?.pricePaise) },
            { label: 'Status', render: (b) => <Badge value={b.status} /> },
            { label: 'Payment', render: (b) => <Badge value={b.payment?.status} /> },
          ]}
        />
        <Pager data={data} onPage={(p) => setFilter('page', p)} />
      </div>
    </div>
  );
}
