import { Badge, ErrorNote, Pager, Table, ago, formatDay, useApi } from '../ui.jsx';
import { useFilters } from '../useFilters.js';

// Pet parents: everyone with an app account. A vendor who also uses the app as a pet parent is listed too.
export default function Customers() {
  const [filters, setFilter] = useFilters();
  const { data, error, loading } = useApi('/admin/users', { ...filters, role: 'pet_parent' });

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Customers</h1>
          {data && <p className="muted small" style={{ margin: '6px 0 0' }}>{data.total.toLocaleString('en-IN')} {data.total === 1 ? 'customer' : 'customers'}</p>}
        </div>
      </div>
      <div className="filters">
        <input type="search" placeholder="Name, phone or email" defaultValue={filters.q} onKeyDown={(e) => e.key === 'Enter' && setFilter('q', e.currentTarget.value)} aria-label="Search by name, phone or email" />
        <select value={filters.status ?? ''} onChange={(e) => setFilter('status', e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          {['active', 'suspended', 'deleted'].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </div>
      <ErrorNote error={error} />
      <div className="card">
        {loading && !data && <div className="empty">Loading…</div>}
        <Table
          rows={data?.items}
          empty="No customers match these filters"
          columns={[
            { label: 'Customer', render: (u) => <><strong>{u.name ?? '—'}</strong><div className="small muted">{u.phone ?? u.email ?? '—'}</div></> },
            { label: 'City', render: (u) => <>{u.city ?? '—'}{u.locality && <div className="small muted">{u.locality}</div>}</> },
            { label: 'Pets', num: true, render: (u) => u.petCount },
            { label: 'Bookings', num: true, render: (u) => u.bookingCount },
            { label: 'Orders', num: true, render: (u) => u.orderCount },
            { label: 'Joined', render: (u) => formatDay(u.createdAt) },
            { label: 'Last active', render: (u) => (u.lastLoginAt ? ago(u.lastLoginAt) : '—') },
            { label: 'Status', render: (u) => <Badge value={u.status} /> },
          ]}
        />
        <Pager data={data} onPage={(p) => setFilter('page', p)} />
      </div>
    </div>
  );
}
