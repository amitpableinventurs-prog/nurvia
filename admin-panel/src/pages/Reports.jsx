import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Badge, ErrorNote, Pager, Table, formatDate, useApi, useConfirm } from '../ui.jsx';
import { useFilters } from '../useFilters.js';

// Where a moderator goes to act on each kind of reported item. Reported users have no screen of their own.
const TARGET_LINKS = {
  post: () => '/moderation?type=posts',
  comment: () => '/moderation?type=comments',
  review: () => '/moderation?type=reviews',
  community_dog: () => '/moderation?type=community-dogs',
  adoption_listing: () => '/moderation?type=adoption-listings',
  vendor: (id) => `/vendors/${id}`,
};

const preview = (t) => t && (t.text ?? t.businessName ?? t.name ?? t.phone ?? t.title);

export default function Reports() {
  const [filters, setFilter] = useFilters({ status: 'open' });
  const { data, error, reload } = useApi('/admin/reports', filters);
  const [confirm, dialog] = useConfirm();

  const resolve = (report, status) =>
    confirm({
      title: status === 'actioned' ? 'Mark as actioned' : 'Dismiss report',
      message: status === 'actioned' ? 'Use this after hiding, removing or suspending the reported item.' : 'Nothing will change for the reported item.',
      reason: 'required',
      confirmLabel: status === 'actioned' ? 'Mark actioned' : 'Dismiss',
      onConfirm: async (resolution) => {
        await api.patch(`/admin/reports/${report._id}`, { status, resolution });
        reload();
      },
    });

  return (
    <div>
      {dialog}
      <div className="page-head">
        <h1>Reports</h1>
      </div>
      <div className="filters">
        <select value={filters.status} onChange={(e) => setFilter('status', e.target.value)} aria-label="Status">
          {['open', 'actioned', 'dismissed'].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select value={filters.targetType ?? ''} onChange={(e) => setFilter('targetType', e.target.value)} aria-label="Item type">
          <option value="">Any item</option>
          {Object.keys(TARGET_LINKS).map((t) => (
            <option key={t} value={t}>
              {t.replace('_', ' ')}
            </option>
          ))}
        </select>
      </div>
      <ErrorNote error={error} />
      <div className="card">
        <Table
          rows={data?.items}
          empty={filters.status === 'open' ? 'No open reports — all clear' : 'No reports'}
          columns={[
            { label: 'Reported item', render: (r) => <>
                {TARGET_LINKS[r.targetType] ? <Link to={TARGET_LINKS[r.targetType](r.targetId)}>{r.targetType.replace('_', ' ')}</Link> : r.targetType.replace('_', ' ')}{' '}
                {r.target ? <Badge value={r.target.status} /> : <span className="small muted">(deleted)</span>}
                <div className="small" style={{ maxWidth: 420 }}>{preview(r.target)}</div>
              </> },
            { label: 'Reason', render: (r) => <>{r.reason.replace('_', ' ')}{r.details && <div className="small muted">{r.details}</div>}</> },
            { label: 'Reporter', render: (r) => r.reporter?.name ?? r.reporter?.phone ?? '—' },
            { label: 'Reported', render: (r) => formatDate(r.createdAt) },
            {
              label: filters.status === 'open' ? 'Actions' : 'Resolution',
              render: (r) =>
                r.status === 'open' ? (
                  <div className="row">
                    <button onClick={() => resolve(r, 'actioned')}>Actioned</button>
                    <button onClick={() => resolve(r, 'dismissed')}>Dismiss</button>
                  </div>
                ) : (
                  <>
                    {r.resolution}
                    <div className="small muted">{formatDate(r.resolvedAt)}</div>
                  </>
                ),
            },
          ]}
        />
        <Pager data={data} onPage={(p) => setFilter('page', p)} />
      </div>
    </div>
  );
}
