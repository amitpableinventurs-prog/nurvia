import { Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { api } from '../api.js';
import { Badge, ErrorNote, Table, formatRupees, useApi, useConfirm } from '../ui.jsx';

const SPECIES = ['dog', 'cat', 'bird', 'rabbit', 'other'];
const EMPTY = { name: '', description: '', price: '', durationMin: 30, mode: 'at_store', species: [], categoryId: '' };

export default function Services() {
  const { data: services, error, reload } = useApi('/vendors/me/services');
  const { data: categories } = useApi('/categories', { kind: 'service' });
  const [confirm, dialog] = useConfirm();
  const ref = useRef(null);
  const [editing, setEditing] = useState(null); // null = closed, {} = new, service = edit
  const [form, setForm] = useState(EMPTY);
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const open = (service) => {
    setEditing(service ?? {});
    setForm(
      service
        ? { name: service.name, description: service.description ?? '', price: String(service.pricePaise / 100), durationMin: service.durationMin, mode: service.mode, species: service.species ?? [], categoryId: service.category ?? '' }
        : EMPTY,
    );
    setFormError(null);
    queueMicrotask(() => ref.current?.showModal());
  };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setFormError(null);
    const body = {
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      pricePaise: Math.round(Number(form.price) * 100),
      durationMin: Number(form.durationMin),
      mode: form.mode,
      species: form.species,
      ...(form.categoryId && { categoryId: form.categoryId }),
    };
    try {
      if (editing._id) await api.patch(`/vendors/me/services/${editing._id}`, body);
      else await api.post('/vendors/me/services', body);
      ref.current.close();
      reload();
    } catch (err) {
      setFormError(err);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (s) =>
    s.active
      ? confirm({
          title: `Stop offering ${s.name}?`,
          message: 'Customers can no longer book it. Existing bookings are not affected, and you can turn it back on later.',
          confirmLabel: 'Turn off',
          danger: true,
          onConfirm: async () => {
            await api.del(`/vendors/me/services/${s._id}`);
            reload();
          },
        })
      : api.patch(`/vendors/me/services/${s._id}`, { active: true }).then(reload);

  return (
    <div>
      {dialog}
      <dialog ref={ref} onClose={() => setEditing(null)} style={{ width: 'min(520px, calc(100vw - 32px))' }}>
        {editing && (
          <form className="stack" onSubmit={save}>
            <h2>{editing._id ? `Edit ${editing.name}` : 'Add a service'}</h2>
            <label className="field">
              Name
              <input value={form.name} onChange={set('name')} required maxLength={120} placeholder="General consultation" autoFocus />
            </label>
            <label className="field">
              Description
              <textarea value={form.description} onChange={set('description')} maxLength={1000} placeholder="What is included, what to bring" />
            </label>
            <div className="vp-grid-2">
              <label className="field">
                Price (₹)
                <input type="number" min="0" step="1" value={form.price} onChange={set('price')} required inputMode="numeric" />
              </label>
              <label className="field">
                Duration (minutes)
                <input type="number" min="5" max="1440" step="5" value={form.durationMin} onChange={set('durationMin')} required />
              </label>
              <label className="field">
                Where
                <select value={form.mode} onChange={set('mode')}>
                  <option value="at_store">At my clinic / studio</option>
                  <option value="home_visit">Home visit</option>
                </select>
              </label>
              <label className="field">
                Category
                <select value={form.categoryId} onChange={set('categoryId')}>
                  <option value="">None</option>
                  {categories?.map((c) => (
                    <option key={c._id} value={c._id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <fieldset className="field vp-fieldset">
              <legend>For (leave empty for all pets)</legend>
              <div className="row">
                {SPECIES.map((s) => (
                  <button
                    type="button"
                    key={s}
                    className="vp-chip"
                    aria-pressed={form.species.includes(s)}
                    onClick={() => setForm((f) => ({ ...f, species: f.species.includes(s) ? f.species.filter((x) => x !== s) : [...f.species, s] }))}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </fieldset>
            <ErrorNote error={formError} />
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => ref.current.close()}>
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {editing._id ? 'Save changes' : 'Add service'}
              </button>
            </div>
          </form>
        )}
      </dialog>

      <div className="page-head">
        <div>
          <h1>Services & prices</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>Customers see these when they book. Price changes never affect existing bookings.</p>
        </div>
        <button className="primary" onClick={() => open()}>
          <Plus size={16} /> Add service
        </button>
      </div>
      <ErrorNote error={error} />
      <div className="card">
        <Table
          rows={services}
          empty="No services yet. Add your first one so customers can book you."
          columns={[
            {
              label: 'Service',
              render: (s) => (
                <>
                  <div style={{ fontWeight: 600, opacity: s.active ? 1 : 0.55 }}>{s.name}</div>
                  {s.description && <div className="small muted" style={{ maxWidth: 420 }}>{s.description}</div>}
                </>
              ),
            },
            { label: 'Price', num: true, render: (s) => formatRupees(s.pricePaise) },
            { label: 'Duration', num: true, render: (s) => `${s.durationMin} min` },
            { label: 'Where', render: (s) => (s.mode === 'home_visit' ? 'Home visit' : 'At clinic') },
            { label: 'For', render: (s) => (s.species?.length ? s.species.join(', ') : <span className="muted">All pets</span>) },
            { label: 'Status', render: (s) => <Badge value={s.active ? 'active' : 'hidden'} /> },
            {
              label: 'Actions',
              render: (s) => (
                <div className="row" style={{ gap: 6 }}>
                  <button onClick={() => open(s)}>Edit</button>
                  <button className={s.active ? 'danger' : ''} onClick={() => toggle(s)}>
                    {s.active ? 'Turn off' : 'Turn on'}
                  </button>
                </div>
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}
