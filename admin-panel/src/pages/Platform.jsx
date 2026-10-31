import { MapPinned, Plus, ToggleRight } from 'lucide-react';
import { useRef, useState } from 'react';
import { api } from '../api.js';
import { DuoIcon } from '../icons.jsx';
import { useSession } from '../session.jsx';
import { ErrorNote, useApi } from '../ui.jsx';

const STATES = [
  ['active', 'Active'],
  ['coming_soon', 'Coming soon'],
  ['disabled', 'Disabled'],
];
const MODULE_LABELS = { booking: 'Service booking', marketplace: 'Marketplace' };
const EMPTY_CITY = { name: '', slug: '', region: '', aliases: '', lat: '', lng: '', radiusKm: 40, status: 'coming_soon' };
const slugify = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

function StateSelect({ value, onChange, disabled, label }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-label={label} className={`pf-state ${value}`}>
      {STATES.map(([k, l]) => (
        <option key={k} value={k}>
          {l}
        </option>
      ))}
    </select>
  );
}

function Switch({ checked, onChange, disabled, label }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="pf-switch" disabled={disabled} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export default function Platform() {
  const { can } = useSession();
  const editable = can('platform.configure');
  const { data, error, reload } = useApi('/admin/platform');
  const [actionError, setActionError] = useState(null);
  const [busy, setBusy] = useState(null);

  const run = async (key, fn) => {
    setBusy(key);
    setActionError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(null);
    }
  };
  const setFeature = (key, value) => run(`f:${key}`, () => api.patch('/admin/platform/features', { [key]: value }));
  const setCategory = (c, active) => run(`c:${c._id}`, () => api.patch(`/admin/categories/${c._id}`, { active }));
  const updateCity = (city, body) => run(`city:${city._id}`, () => api.patch(`/admin/cities/${city._id}`, body));

  const dialog = useRef(null);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_CITY);
  const [formError, setFormError] = useState(null);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value, ...(key === 'name' && !editing?._id && { slug: slugify(e.target.value) }) }));
  const openCity = (city) => {
    setEditing(city ?? {});
    setForm(
      city
        ? { name: city.name, slug: city.slug, region: city.region ?? '', aliases: (city.aliases ?? []).join(', '), lat: city.center.coordinates[1], lng: city.center.coordinates[0], radiusKm: city.radiusKm, status: city.status }
        : EMPTY_CITY,
    );
    setFormError(null);
    queueMicrotask(() => dialog.current?.showModal());
  };
  const saveCity = async (e) => {
    e.preventDefault();
    setFormError(null);
    const body = {
      name: form.name.trim(),
      slug: form.slug.trim(),
      region: form.region.trim() || undefined,
      aliases: form.aliases.split(',').map((a) => a.trim()).filter(Boolean),
      center: { lat: Number(form.lat), lng: Number(form.lng) },
      radiusKm: Number(form.radiusKm),
      status: form.status,
    };
    try {
      if (editing._id) await api.patch(`/admin/cities/${editing._id}`, body);
      else await api.post('/admin/cities', body);
      dialog.current.close();
      reload();
    } catch (err) {
      setFormError(err);
    }
  };

  return (
    <div className="stack" style={{ gap: 20 }}>
      <dialog ref={dialog} onClose={() => setEditing(null)} style={{ width: 'min(520px, calc(100vw - 32px))' }}>
        {editing && (
          <form className="stack" onSubmit={saveCity}>
            <h2>{editing._id ? `Edit ${editing.name}` : 'Add a city'}</h2>
            <div className="pf-grid">
              <label className="field">
                Name
                <input value={form.name} onChange={set('name')} required maxLength={80} placeholder="Pune" autoFocus />
              </label>
              <label className="field">
                Slug
                <input value={form.slug} onChange={set('slug')} required pattern="[a-z0-9-]{2,40}" disabled={Boolean(editing._id)} className="mono" />
              </label>
              <label className="field">
                State / UT
                <input value={form.region} onChange={set('region')} maxLength={80} />
              </label>
              <label className="field">
                Launch status
                <select value={form.status} onChange={set('status')}>
                  {STATES.map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field">
              Other names (comma separated)
              <input value={form.aliases} onChange={set('aliases')} placeholder="Pimpri-Chinchwad, Hinjewadi" />
              <span className="small muted" style={{ fontWeight: 400 }}>Addresses that say any of these count as this city.</span>
            </label>
            <div className="pf-grid">
              <label className="field">
                Centre latitude
                <input type="number" step="any" min="-90" max="90" value={form.lat} onChange={set('lat')} required />
              </label>
              <label className="field">
                Centre longitude
                <input type="number" step="any" min="-180" max="180" value={form.lng} onChange={set('lng')} required />
              </label>
              <label className="field">
                Radius (km)
                <input type="number" min="1" max="200" value={form.radiusKm} onChange={set('radiusKm')} required />
              </label>
            </div>
            <span className="small muted">People whose location is within the radius are treated as being in this city.</span>
            <ErrorNote error={formError} />
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => dialog.current.close()}>
                Cancel
              </button>
              <button className="primary">{editing._id ? 'Save city' : 'Add city'}</button>
            </div>
          </form>
        )}
      </dialog>

      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>
            Cities & <em>features</em>
          </h1>
          <p className="muted" style={{ margin: '6px 0 0', maxWidth: 680 }}>
            Launch cities and switch modules on or off without a code change. Apps pick up changes within a minute. Pet passport, health records and reminders always
            work for every user, in any city.
          </p>
        </div>
        {editable && (
          <button className="primary" onClick={() => openCity()}>
            <Plus size={16} /> Add city
          </button>
        )}
      </div>
      {!editable && <div className="notice small">You can view these settings. Changing them needs the platform.configure permission.</div>}
      <ErrorNote error={error ?? actionError} />

      {data && (
        <>
          <section className="card">
            <div className="card-head">
              <div className="row" style={{ gap: 10 }}>
                <DuoIcon icon={MapPinned} tone="teal" size={36} />
                <div>
                  <h2 style={{ margin: 0 }}>Cities</h2>
                  <div className="small muted">Booking and the marketplace only run where both the city and the module are active.</div>
                </div>
              </div>
            </div>
            {data.cities.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>City</th>
                      <th>Launch status</th>
                      {data.cityModules.map((m) => (
                        <th key={m}>{MODULE_LABELS[m] ?? m}</th>
                      ))}
                      <th className="num">Live vendors</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.cities.map((c) => (
                      <tr key={c._id} style={c.status === 'disabled' ? { opacity: 0.6 } : undefined}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{c.name}</div>
                          <div className="small muted">
                            {[c.region, c.aliases?.length && `also ${c.aliases.slice(0, 4).join(', ')}${c.aliases.length > 4 ? '…' : ''}`].filter(Boolean).join(' · ')}
                          </div>
                        </td>
                        <td>
                          <StateSelect value={c.status} label={`${c.name} launch status`} disabled={!editable || busy} onChange={(status) => updateCity(c, { status })} />
                        </td>
                        {data.cityModules.map((m) => (
                          <td key={m}>
                            <StateSelect
                              value={c.modules?.[m] ?? 'active'}
                              label={`${MODULE_LABELS[m]} in ${c.name}`}
                              disabled={!editable || busy || c.status !== 'active'}
                              onChange={(s) => updateCity(c, { modules: { [m]: s } })}
                            />
                            {c.status !== 'active' && <div className="small muted">follows the city</div>}
                            {!data.features.find((f) => f.key === m)?.enabled && <div className="small ov-warn">switched off platform-wide</div>}
                          </td>
                        ))}
                        <td className="num">
                          {c.liveVendors}
                          {c.status === 'active' && c.modules?.booking !== 'disabled' && c.liveVendors === 0 && <div className="small ov-warn">no supply yet</div>}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {editable && (
                            <button className="link" onClick={() => openCity(c)}>
                              Edit
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty">No cities yet. Until you add one, booking and the marketplace run everywhere.</div>
            )}
          </section>

          <div className="grid-2" style={{ alignItems: 'start' }}>
            <section className="card">
              <div className="card-head">
                <div className="row" style={{ gap: 10 }}>
                  <DuoIcon icon={ToggleRight} tone="violet" size={36} />
                  <div>
                    <h2 style={{ margin: 0 }}>Features</h2>
                    <div className="small muted">Platform-wide switches, for every city</div>
                  </div>
                </div>
              </div>
              <ul className="pf-list">
                {data.features.map((f) => (
                  <li key={f.key}>
                    <div>
                      <div style={{ fontWeight: 600 }}>{f.label}</div>
                      <div className="small muted">
                        Phase {f.phase}
                        {f.cityScoped && ' · also set per city'}
                        {f.notBuilt && ' · not built yet; the switch is ready for the apps'}
                      </div>
                    </div>
                    <Switch checked={f.enabled} label={f.label} disabled={!editable || Boolean(busy)} onChange={(v) => setFeature(f.key, v)} />
                  </li>
                ))}
              </ul>
            </section>

            <section className="card">
              <div className="card-head">
                <div>
                  <h2 style={{ margin: 0 }}>Vendor categories</h2>
                  <div className="small muted">Switched-off categories disappear from search and sign-up</div>
                </div>
              </div>
              <ul className="pf-list">
                {data.vendorCategories.map((c) => (
                  <li key={c._id}>
                    <div style={{ fontWeight: 600 }}>{c.name}</div>
                    <Switch checked={c.active} label={c.name} disabled={!can('categories.manage') || Boolean(busy)} onChange={(v) => setCategory(c, v)} />
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
