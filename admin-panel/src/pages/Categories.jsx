import { useState } from 'react';
import { api } from '../api.js';
import { useSession } from '../session.jsx';
import { Badge, ErrorNote, Table, useApi } from '../ui.jsx';
import { useFilters } from '../useFilters.js';

const KINDS = { vendor: 'Vendor types', service: 'Service types', product: 'Product categories (Phase 2)' };
const slugify = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export default function Categories() {
  const { can } = useSession();
  const [filters, setFilter] = useFilters({ kind: 'vendor' });
  const { data, error, reload } = useApi('/admin/categories', { kind: filters.kind });
  const [name, setName] = useState('');
  const [actionError, setActionError] = useState(null);
  const editable = can('categories.manage');

  const run = async (fn) => {
    setActionError(null);
    try {
      await fn();
      reload();
    } catch (err) {
      setActionError(err);
    }
  };

  const add = (e) => {
    e.preventDefault();
    run(async () => {
      await api.post('/admin/categories', { kind: filters.kind, name: name.trim(), slug: slugify(name), sortOrder: data?.length ?? 0 });
      setName('');
    });
  };

  return (
    <div>
      <div className="page-head">
        <h1>Categories</h1>
      </div>
      <div className="tabs" role="tablist">
        {Object.entries(KINDS).map(([kind, label]) => (
          <button key={kind} role="tab" aria-selected={kind === filters.kind} className={`tab ${kind === filters.kind ? 'active' : ''}`} onClick={() => setFilter('kind', kind)}>
            {label}
          </button>
        ))}
      </div>
      <ErrorNote error={error ?? actionError} />
      <div className="card stack">
        {editable && (
          <form className="row" onSubmit={add}>
            <input placeholder="New category name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} aria-label="New category name" />
            <button className="primary" disabled={!slugify(name)}>
              Add
            </button>
            {name && <span className="small muted mono">{slugify(name)}</span>}
          </form>
        )}
        <Table
          rows={data}
          empty="No categories yet"
          columns={[
            { label: 'Name', render: (c) => c.name },
            { label: 'Slug', render: (c) => <span className="mono">{c.slug}</span> },
            { label: 'Order', num: true, render: (c) => c.sortOrder },
            { label: 'Status', render: (c) => <Badge value={c.active ? 'active' : 'hidden'} /> },
            ...(editable
              ? [
                  {
                    label: 'Actions',
                    render: (c) => (
                      <div className="row">
                        <button
                          onClick={() => {
                            const next = prompt('Rename category', c.name);
                            if (next?.trim()) run(() => api.patch(`/admin/categories/${c._id}`, { name: next.trim() }));
                          }}
                        >
                          Rename
                        </button>
                        <button onClick={() => run(() => api.patch(`/admin/categories/${c._id}`, { active: !c.active }))}>{c.active ? 'Hide' : 'Show'}</button>
                      </div>
                    ),
                  },
                ]
              : []),
          ]}
        />
      </div>
    </div>
  );
}
