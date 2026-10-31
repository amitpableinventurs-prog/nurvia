import { Link } from 'react-router-dom';
import { Badge, ErrorNote, Pager, Table, formatDate, useApi } from '../ui.jsx';
import { useFilters } from '../useFilters.js';

export default function Vendors() {
  const [filters, setFilter] = useFilters();
  const { data, error, loading } = useApi('/admin/vendors', filters);

  return (
    <div>
      <div className="page-head">
        <h1>Vendors</h1>
      </div>
      <div className="filters">
        <input type="search" placeholder="Business name" defaultValue={filters.q} onKeyDown={(e) => e.key === 'Enter' && setFilter('q', e.currentTarget.value)} aria-label="Search by business name" />
        <select value={filters.status ?? ''} onChange={(e) => setFilter('status', e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          {['pending', 'active', 'rejected', 'suspended'].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select value={filters.kycStatus ?? ''} onChange={(e) => setFilter('kycStatus', e.target.value)} aria-label="KYC status">
          <option value="">Any KYC</option>
          {['not_submitted', 'submitted', 'approved', 'rejected'].map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ')}
            </option>
          ))}
        </select>
        <input placeholder="City" defaultValue={filters.city} onKeyDown={(e) => e.key === 'Enter' && setFilter('city', e.currentTarget.value)} aria-label="City" />
      </div>
      <ErrorNote error={error} />
      <div className="card">
        {loading && !data && <div className="empty">Loading…</div>}
        <Table
          rows={data?.items}
          empty="No vendors match these filters"
          columns={[
            { label: 'Business', render: (v) => <Link to={`/vendors/${v._id}`}>{v.businessName}</Link> },
            { label: 'Owner', render: (v) => <>{v.owner?.name ?? '—'}<div className="small muted">{v.owner?.phone ?? v.owner?.email}</div></> },
            { label: 'Categories', render: (v) => v.categories?.map((c) => c.name).join(', ') },
            { label: 'City', render: (v) => v.address?.city },
            { label: 'Status', render: (v) => <Badge value={v.status} /> },
            { label: 'KYC', render: (v) => <Badge value={v.kyc?.status} /> },
            { label: 'Submitted', render: (v) => formatDate(v.kyc?.submittedAt) },
          ]}
        />
        <Pager data={data} onPage={(p) => setFilter('page', p)} />
      </div>
    </div>
  );
}
