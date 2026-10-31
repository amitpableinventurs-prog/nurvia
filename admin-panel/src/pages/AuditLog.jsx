import { ErrorNote, Pager, Table, formatDate, useApi } from '../ui.jsx';
import { useFilters } from '../useFilters.js';

export default function AuditLog() {
  const [filters, setFilter] = useFilters();
  const { data, error } = useApi('/admin/audit', filters);

  return (
    <div>
      <div className="page-head">
        <h1>Audit log</h1>
      </div>
      <div className="filters">
        <input placeholder="Action, e.g. vendor.approve" defaultValue={filters.action} onKeyDown={(e) => e.key === 'Enter' && setFilter('action', e.currentTarget.value)} aria-label="Action" />
      </div>
      <ErrorNote error={error} />
      <div className="card">
        <Table
          rows={data?.items}
          empty="No admin activity recorded"
          columns={[
            { label: 'When', render: (a) => formatDate(a.createdAt) },
            { label: 'Who', render: (a) => a.actor?.name ?? a.actor?.email ?? '—' },
            { label: 'Action', render: (a) => <span className="mono">{a.action}</span> },
            { label: 'Target', render: (a) => <span className="mono small">{a.targetType} {a.targetId}</span> },
            { label: 'Reason', render: (a) => a.reason ?? '' },
            { label: 'IP', render: (a) => <span className="mono small">{a.ip}</span> },
          ]}
        />
        <Pager data={data} onPage={(p) => setFilter('page', p)} />
      </div>
    </div>
  );
}
