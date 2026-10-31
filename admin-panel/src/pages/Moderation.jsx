import { api } from '../api.js';
import { Badge, ErrorNote, Pager, Table, formatDate, useApi, useConfirm } from '../ui.jsx';
import { useFilters } from '../useFilters.js';

const VISIBILITY_ACTIONS = [
  { status: 'visible', label: 'Restore', when: ['hidden', 'removed'] },
  { status: 'hidden', label: 'Hide', when: ['visible'], danger: true },
  { status: 'removed', label: 'Remove', when: ['visible', 'hidden'], danger: true },
];

const photo = (item) => (item.photos ?? item.images)?.[0]?.url;

const TYPES = {
  posts: {
    label: 'Posts',
    statuses: ['visible', 'hidden', 'removed'],
    actions: VISIBILITY_ACTIONS,
    owner: (i) => i.author,
    content: (i) => (
      <>
        {i.text || <span className="muted">(image only)</span>}
        <div className="small muted">
          {i.images?.length ?? 0} image(s) · {i.reactionCount} reactions · {i.commentCount} comments
        </div>
      </>
    ),
  },
  comments: { label: 'Comments', statuses: ['visible', 'hidden', 'removed'], actions: VISIBILITY_ACTIONS, owner: (i) => i.author, content: (i) => i.text },
  reviews: {
    label: 'Reviews',
    statuses: ['visible', 'hidden', 'removed'],
    actions: VISIBILITY_ACTIONS,
    owner: (i) => i.author,
    content: (i) => (
      <>
        <strong>{'★'.repeat(i.rating)}</strong> <span className="muted">for {i.vendor?.businessName}</span>
        <div>{i.text}</div>
      </>
    ),
  },
  'community-dogs': {
    label: 'Community dogs',
    statuses: ['visible', 'hidden', 'removed'],
    actions: VISIBILITY_ACTIONS,
    owner: (i) => i.createdBy,
    content: (i) => (
      <>
        <strong>{i.name || 'Unnamed'}</strong> · {i.area}
        {i.city && `, ${i.city}`}
        <div className="small muted">{i.description}</div>
      </>
    ),
  },
  'adoption-listings': {
    label: 'Adoption listings',
    statuses: ['pending_review', 'open', 'on_hold', 'adopted', 'closed', 'rejected', 'removed'],
    actions: [
      { status: 'open', label: 'Approve', when: ['pending_review', 'rejected', 'removed'] },
      { status: 'rejected', label: 'Reject', when: ['pending_review'], danger: true },
      { status: 'removed', label: 'Remove', when: ['pending_review', 'open', 'on_hold'], danger: true },
    ],
    owner: (i) => i.postedBy,
    content: (i) => (
      <>
        <strong>{i.name}</strong> · {i.species}
        {i.breed && `, ${i.breed}`} · {i.city}
        <div className="small muted">{i.description}</div>
      </>
    ),
  },
};

export default function Moderation() {
  const [filters, setFilter] = useFilters({ type: 'posts' });
  const config = TYPES[filters.type] ?? TYPES.posts;
  const { type, ...query } = filters;
  const { data, error, reload } = useApi(`/admin/moderation/${type}`, query);
  const [confirm, dialog] = useConfirm();

  const act = (item, action) =>
    confirm({
      title: `${action.label} this item?`,
      message: action.status === 'open' ? 'The listing becomes visible to everyone in the app.' : 'The author is notified with your reason.',
      reason: action.danger ? 'required' : 'optional',
      danger: action.danger,
      confirmLabel: action.label,
      onConfirm: async (reason) => {
        await api.patch(`/admin/moderation/${type}/${item._id}`, { status: action.status, reason });
        reload();
      },
    });

  return (
    <div>
      {dialog}
      <div className="page-head">
        <h1>Moderation</h1>
      </div>
      <div className="tabs" role="tablist">
        {Object.entries(TYPES).map(([key, t]) => (
          <button
            key={key}
            role="tab"
            aria-selected={key === type}
            className={`tab ${key === type ? 'active' : ''}`}
            onClick={() => setFilter({ type: key, status: '' })}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="filters">
        <select value={filters.status ?? ''} onChange={(e) => setFilter('status', e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          {config.statuses.map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ')}
            </option>
          ))}
        </select>
      </div>
      <ErrorNote error={error} />
      <div className="card">
        <Table
          rows={data?.items}
          empty="Nothing to moderate here"
          columns={[
            {
              label: 'Content',
              render: (i) => (
                <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                  {photo(i) && <img src={photo(i)} alt="" width="56" height="56" style={{ objectFit: 'cover', borderRadius: 6, flexShrink: 0 }} />}
                  <div style={{ maxWidth: 520 }}>{config.content(i)}</div>
                </div>
              ),
            },
            { label: 'By', render: (i) => <>{config.owner(i)?.name ?? '—'}<div className="small muted">{config.owner(i)?.phone}</div></> },
            { label: 'Posted', render: (i) => formatDate(i.createdAt) },
            { label: 'Status', render: (i) => <>
                <Badge value={i.status} />
                {i.moderation?.reason && <div className="small muted">{i.moderation.reason}</div>}
              </> },
            {
              label: 'Actions',
              render: (i) => (
                <div className="row">
                  {config.actions
                    .filter((a) => a.when.includes(i.status))
                    .map((a) => (
                      <button key={a.status} className={a.danger ? 'danger' : ''} onClick={() => act(i, a)}>
                        {a.label}
                      </button>
                    ))}
                </div>
              ),
            },
          ]}
        />
        <Pager data={data} onPage={(p) => setFilter('page', p)} />
      </div>
    </div>
  );
}
