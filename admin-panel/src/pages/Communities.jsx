import { Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Badge, ErrorNote, Pager, Table, useApi } from '../ui.jsx';
import { useFilters } from '../useFilters.js';

// Communities pet parents join and post in: by city, locality, breed, community-dog care, rescue and
// adoption. Posts and comments in them are moderated on the Moderation screen.
const KINDS = { city: 'City', locality: 'Locality', breed: 'Breed', community_dogs: 'Community-dog care', rescue: 'Rescue', adoption: 'Adoption' };
const EMPTY = { name: '', slug: '', kind: 'city', description: '', city: '', locality: '', breed: '', sortOrder: 0 };
const slugify = (text) => text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

export default function Communities() {
  const [filters, setFilter] = useFilters({ status: 'active' });
  const { data, error, reload } = useApi('/admin/communities', { status: filters.status, kind: filters.kind, page: filters.page });
  const [editing, setEditing] = useState(null);
  const [actionError, setActionError] = useState(null);

  const setStatus = async (c, status) => {
    setActionError(null);
    try {
      await api.patch(`/admin/communities/${c._id}`, { status });
      reload();
    } catch (err) {
      setActionError(err);
    }
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Communities</h1>
          <p className="muted small" style={{ margin: '6px 0 0' }}>
            Groups pet parents join and post in. Archiving one hides it and its posts from the app; nothing is deleted. Report and remove posts on the Moderation screen.
          </p>
        </div>
        <button className="primary" onClick={() => setEditing({})}>
          <Plus size={16} /> New community
        </button>
      </div>
      <section className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="tabs" role="tablist">
            {['active', 'archived'].map((s) => (
              <button key={s} role="tab" aria-selected={filters.status === s} className={`tab ${filters.status === s ? 'active' : ''}`} onClick={() => setFilter('status', s)}>
                {s === 'active' ? 'Active' : 'Archived'}
              </button>
            ))}
          </div>
          <select value={filters.kind ?? ''} onChange={(e) => setFilter('kind', e.target.value)} aria-label="Kind">
            <option value="">All kinds</option>
            {Object.entries(KINDS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <ErrorNote error={error ?? actionError} />
        <Table
          rows={data?.items}
          empty="No communities yet"
          columns={[
            {
              label: 'Community',
              render: (c) => (
                <>
                  <strong>{c.name}</strong>
                  <div className="small muted mono">{c.slug}</div>
                </>
              ),
            },
            { label: 'Kind', render: (c) => <span className="ov-chip">{KINDS[c.kind]}</span> },
            { label: 'Where / breed', render: (c) => <span className="small">{[c.locality, c.city, c.breed].filter(Boolean).join(', ') || 'Everywhere'}</span> },
            { label: 'Members', num: true, render: (c) => c.memberCount.toLocaleString('en-IN') },
            { label: 'Posts', num: true, render: (c) => c.postCount.toLocaleString('en-IN') },
            { label: 'Status', render: (c) => <Badge value={c.status === 'active' ? 'active' : 'hidden'} /> },
            {
              label: '',
              render: (c) => (
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <button onClick={() => setEditing(c)}>Edit</button>
                  <button onClick={() => setStatus(c, c.status === 'active' ? 'archived' : 'active')}>{c.status === 'active' ? 'Archive' : 'Restore'}</button>
                </div>
              ),
            },
          ]}
        />
        <Pager data={data} onPage={(page) => setFilter('page', page)} />
      </section>
      {editing && <CommunityEditor community={editing} onClose={() => setEditing(null)} onSaved={reload} />}
    </div>
  );
}

function CommunityEditor({ community, onClose, onSaved }) {
  const isNew = !community._id;
  const dialog = useRef(null);
  const [form, setForm] = useState(() => (isNew ? EMPTY : { ...EMPTY, ...Object.fromEntries(Object.keys(EMPTY).map((k) => [k, community[k] ?? EMPTY[k]])) }));
  const [cover, setCover] = useState(community.cover?.url ?? null);
  const [coverFileId, setCoverFileId] = useState(undefined);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!dialog.current.open) dialog.current.showModal();
  }, []);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const upload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      const stored = await api.upload(file, 'community');
      setCover(stored.url);
      setCoverFileId(stored._id);
    } catch (err) {
      setError(err);
    }
  };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      name: form.name.trim(),
      slug: form.slug.trim(),
      kind: form.kind,
      description: form.description.trim() || undefined,
      city: form.city.trim() || null,
      locality: form.locality.trim() || null,
      breed: form.breed.trim() || null,
      sortOrder: Number(form.sortOrder) || 0,
      ...(coverFileId !== undefined && { coverFileId }),
    };
    try {
      if (isNew) await api.post('/admin/communities', body);
      else await api.patch(`/admin/communities/${community._id}`, body);
      onSaved();
      dialog.current.close();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={dialog} onClose={onClose} style={{ width: 'min(560px, calc(100vw - 32px))' }}>
      <form className="stack" onSubmit={save}>
        <h2>{isNew ? 'New community' : `Edit ${community.name}`}</h2>
        <div className="grid-fields">
          <label className="field">
            Name
            <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value, ...(isNew && { slug: slugify(e.target.value) }) }))} required minLength={2} maxLength={80} placeholder="Indiranagar pet parents" autoFocus />
          </label>
          <label className="field">
            Link name
            <input className="mono" value={form.slug} onChange={(e) => setForm((f) => ({ ...f, slug: slugify(e.target.value) }))} required minLength={2} maxLength={60} />
          </label>
        </div>
        <label className="field">
          Kind
          <select value={form.kind} onChange={set('kind')}>
            {Object.entries(KINDS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <div className="grid-fields three">
          <label className="field">
            City
            <input value={form.city} onChange={set('city')} maxLength={80} placeholder="Bengaluru" />
          </label>
          <label className="field">
            Locality
            <input value={form.locality} onChange={set('locality')} maxLength={80} placeholder="Indiranagar" />
          </label>
          <label className="field">
            Breed
            <input value={form.breed} onChange={set('breed')} maxLength={60} placeholder="Indie" />
          </label>
        </div>
        <p className="small muted" style={{ margin: '-4px 0 0' }}>Leave the city empty for a community open to every city (a breed, or rescue across India).</p>
        <label className="field">
          Description
          <textarea rows={3} value={form.description} onChange={set('description')} maxLength={1000} placeholder="Tips, playdates and lost & found for pet parents in Indiranagar." />
        </label>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label className="field" style={{ flex: 1 }}>
            Cover image
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={upload} />
          </label>
          {cover && <img src={cover} alt="" style={{ width: 96, height: 54, objectFit: 'cover', borderRadius: 8 }} />}
          {cover && (
            <button type="button" onClick={() => (setCover(null), setCoverFileId(null))}>
              Remove
            </button>
          )}
        </div>
        <label className="field" style={{ width: 140 }}>
          Order
          <input type="number" value={form.sortOrder} onChange={set('sortOrder')} />
        </label>
        <ErrorNote error={error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" onClick={() => dialog.current.close()}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Saving…' : isNew ? 'Create community' : 'Save changes'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
