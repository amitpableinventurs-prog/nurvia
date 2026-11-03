import { ImagePlus, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useSession } from '../session.jsx';
import { ErrorNote, SchedulePill, formatDate, fromLocalInput, scheduleState, toLocalInput, useApi, useConfirm } from '../ui.jsx';

// Offer banners at the top of the pet parent app's Home tab (GET /home/content shows up to 5 live ones).
const PET_TYPES = { dog: 'Dogs', cat: 'Cats', bird: 'Birds', fish: 'Fish', small_pet: 'Small pets' };
const THEME = { background: '#1f3d33', foreground: '#ffffff', accent: '#d9b46a' };
const EMPTY = { eyebrow: '', title: '', subtitle: '', ctaLabel: '', ctaLink: '', theme: THEME, petTypes: [], citySlugs: [], startsAt: '', endsAt: '', sortOrder: 0, active: true, image: null };

const toForm = (b) => ({
  eyebrow: b.eyebrow ?? '',
  title: b.title,
  subtitle: b.subtitle ?? '',
  ctaLabel: b.cta?.label ?? '',
  ctaLink: b.cta?.link ?? '',
  theme: { ...THEME, ...b.theme },
  petTypes: b.petTypes ?? [],
  citySlugs: b.citySlugs ?? [],
  startsAt: toLocalInput(b.startsAt),
  endsAt: toLocalInput(b.endsAt),
  sortOrder: b.sortOrder ?? 0,
  active: b.active,
  image: b.image ? { url: b.image.url } : null,
});

// The app swaps "{pet}" for the pet's name; the preview uses a sample one.
const sample = (text) => text?.replaceAll('{pet}', 'Bruno');

export function BannerPreview({ banner }) {
  const { theme = THEME } = banner;
  const cta = banner.cta?.label ?? banner.ctaLabel;
  return (
    <div className="promo" style={{ '--promo-bg': theme.background, '--promo-fg': theme.foreground, '--promo-accent': theme.accent }}>
      <div className="promo-text">
        {banner.eyebrow && <div className="promo-eyebrow">{sample(banner.eyebrow)}</div>}
        <div className="promo-title">{sample(banner.title) || 'Banner title'}</div>
        {banner.subtitle && <div className="promo-sub">{sample(banner.subtitle)}</div>}
        {cta && <span className="promo-cta">{cta}</span>}
      </div>
      {banner.image?.url && <img className="promo-img" src={banner.image.url} alt="" />}
    </div>
  );
}

const audience = (b, cityName) => {
  const pets = b.petTypes?.length ? b.petTypes.map((p) => PET_TYPES[p]).join(', ') : 'All pets';
  const cities = b.citySlugs?.length ? b.citySlugs.map(cityName).join(', ') : 'all cities';
  return `${pets} · ${cities}`;
};

export default function Banners() {
  const { can } = useSession();
  const { data, error, reload } = useApi('/admin/banners');
  const { data: platform } = useApi('/admin/platform', undefined, { enabled: can('analytics.read') });
  const cities = platform?.cities ?? [];
  const cityName = (slug) => cities.find((c) => c.slug === slug)?.name ?? slug;
  const [editing, setEditing] = useState(null); // null: closed; {}: new; a banner: edit
  const [actionError, setActionError] = useState(null);
  const [confirm, confirmDialog] = useConfirm();

  const run = async (fn) => {
    setActionError(null);
    try {
      await fn();
      reload();
    } catch (err) {
      setActionError(err);
    }
  };

  const banners = data?.items;
  const liveCount = banners?.filter((b) => scheduleState(b) === 'live').length ?? 0;

  return (
    <div className="stack">
      {confirmDialog}
      <div className="page-head">
        <div>
          <h1>Banners</h1>
          <p className="muted small" style={{ margin: '6px 0 0' }}>
            Offer banners at the top of the app's Home tab. Up to 5 live banners are shown, lowest order first, filtered by the pet type and city of the person viewing.
          </p>
        </div>
        <button className="primary" onClick={() => setEditing({})}>
          <Plus size={16} /> New banner
        </button>
      </div>
      <ErrorNote error={error ?? actionError} />
      {banners && liveCount > 5 && <div className="notice">{liveCount} banners are live. Each person sees at most 5 of the ones that match them, lowest order first.</div>}
      {banners && !banners.length && (
        <div className="card empty">
          No banners yet. <button className="link" onClick={() => setEditing({})}>Create the first one</button>
        </div>
      )}
      <div className="banner-grid">
        {banners?.map((b) => (
          <article key={b._id} className="card stack banner-card">
            <BannerPreview banner={b} />
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <SchedulePill item={b} />
              <span className="small muted">Order {b.sortOrder}</span>
            </div>
            <dl className="kv small">
              <dt>Shown to</dt>
              <dd>{audience(b, cityName)}</dd>
              <dt>Runs</dt>
              <dd>
                {b.startsAt ? formatDate(b.startsAt) : 'Now'} → {b.endsAt ? formatDate(b.endsAt) : 'no end date'}
              </dd>
              {b.cta?.link && (
                <>
                  <dt>Opens</dt>
                  <dd className="mono" style={{ wordBreak: 'break-all' }}>{b.cta.link}</dd>
                </>
              )}
            </dl>
            <div className="row">
              <button onClick={() => setEditing(b)}>Edit</button>
              <button onClick={() => run(() => api.patch(`/admin/banners/${b._id}`, { active: !b.active }))}>{b.active ? 'Turn off' : 'Turn on'}</button>
              <button
                className="danger"
                style={{ marginLeft: 'auto' }}
                onClick={() =>
                  confirm({
                    title: 'Delete this banner?',
                    message: `"${b.title}" is removed from the app at once. To bring it back later, turn it off instead.`,
                    confirmLabel: 'Delete',
                    danger: true,
                    onConfirm: async () => {
                      await api.delete(`/admin/banners/${b._id}`);
                      reload();
                    },
                  })
                }
              >
                Delete
              </button>
            </div>
          </article>
        ))}
      </div>
      {editing && <BannerEditor banner={editing} cities={cities} nextOrder={banners?.length ?? 0} onClose={() => setEditing(null)} onSaved={reload} />}
    </div>
  );
}

function BannerEditor({ banner, cities, nextOrder, onClose, onSaved }) {
  const isNew = !banner._id;
  const [form, setForm] = useState(() => (isNew ? { ...EMPTY, sortOrder: nextOrder } : toForm(banner)));
  const [imageFileId, setImageFileId] = useState(undefined); // undefined: unchanged; null: removed
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef(null);
  const dialog = useRef(null);
  useEffect(() => {
    if (!dialog.current.open) dialog.current.showModal();
  }, []);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const setTheme = (key) => (e) => setForm((f) => ({ ...f, theme: { ...f.theme, [key]: e.target.value } }));
  const toggle = (key, value) => setForm((f) => ({ ...f, [key]: f[key].includes(value) ? f[key].filter((v) => v !== value) : [...f[key], value] }));

  const pickImage = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const saved = await api.upload(file, 'banner');
      setImageFileId(saved._id);
      setForm((f) => ({ ...f, image: { url: saved.url } }));
    } catch (err) {
      setError(err);
    } finally {
      setUploading(false);
    }
  };

  const save = async (e) => {
    e.preventDefault();
    if (Boolean(form.ctaLabel.trim()) !== Boolean(form.ctaLink.trim())) return setError(new Error('Give the button both a label and a link, or leave both empty'));
    setBusy(true);
    setError(null);
    const body = {
      eyebrow: form.eyebrow.trim() || null,
      title: form.title.trim(),
      subtitle: form.subtitle.trim() || null,
      cta: form.ctaLabel.trim() ? { label: form.ctaLabel.trim(), link: form.ctaLink.trim() } : null,
      theme: form.theme,
      petTypes: form.petTypes,
      citySlugs: form.citySlugs,
      startsAt: fromLocalInput(form.startsAt),
      endsAt: fromLocalInput(form.endsAt),
      sortOrder: Number(form.sortOrder) || 0,
      active: form.active,
      ...(imageFileId !== undefined && { imageFileId }),
    };
    try {
      if (isNew) await api.post('/admin/banners', body);
      else await api.patch(`/admin/banners/${banner._id}`, body);
      onSaved();
      dialog.current.close();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog className="wide" ref={dialog} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <h2>{isNew ? 'New banner' : 'Edit banner'}</h2>
        <div className="editor">
          <div className="stack">
            <label className="field">
              Small line above the title
              <input value={form.eyebrow} onChange={set('eyebrow')} maxLength={60} placeholder="{pet}-friendly selection" />
            </label>
            <label className="field">
              Title
              <input value={form.title} onChange={set('title')} required minLength={2} maxLength={120} placeholder="Spring Care & Nutrition Festival" autoFocus />
            </label>
            <label className="field">
              Subtitle
              <textarea value={form.subtitle} onChange={set('subtitle')} maxLength={300} style={{ minHeight: 60 }} placeholder="Up to 30% off vet-approved diets." />
            </label>
            <p className="small muted" style={{ margin: '-6px 0 0' }}>
              <span className="mono">{'{pet}'}</span> becomes the name of the user's pet.
            </p>
            <div className="grid-fields">
              <label className="field">
                Button label
                <input value={form.ctaLabel} onChange={set('ctaLabel')} maxLength={40} placeholder="Explore offers" />
              </label>
              <label className="field">
                Button opens
                <input value={form.ctaLink} onChange={set('ctaLink')} maxLength={500} placeholder="nurvia://shop/products?category=food" />
              </label>
            </div>
            <fieldset className="choices">
              <legend>Pet types (none ticked: all)</legend>
              {Object.entries(PET_TYPES).map(([key, label]) => (
                <label key={key} className="choice">
                  <input type="checkbox" checked={form.petTypes.includes(key)} onChange={() => toggle('petTypes', key)} /> {label}
                </label>
              ))}
            </fieldset>
            {cities.length > 0 && (
              <fieldset className="choices">
                <legend>Cities (none ticked: all)</legend>
                {cities.map((c) => (
                  <label key={c.slug} className="choice">
                    <input type="checkbox" checked={form.citySlugs.includes(c.slug)} onChange={() => toggle('citySlugs', c.slug)} /> {c.name}
                  </label>
                ))}
              </fieldset>
            )}
            <div className="grid-fields">
              <label className="field">
                Starts
                <input type="datetime-local" value={form.startsAt} onChange={set('startsAt')} />
              </label>
              <label className="field">
                Ends
                <input type="datetime-local" value={form.endsAt} onChange={set('endsAt')} min={form.startsAt || undefined} />
              </label>
            </div>
            <div className="grid-fields">
              <label className="field">
                Display order (lowest first)
                <input type="number" min={0} max={1000} value={form.sortOrder} onChange={set('sortOrder')} />
              </label>
              <label className="choice" style={{ alignSelf: 'end', minHeight: 36 }}>
                <input type="checkbox" checked={form.active} onChange={set('active')} /> Switched on
              </label>
            </div>
          </div>
          <div className="stack">
            <div className="eyebrow">Preview</div>
            <BannerPreview banner={form} />
            <div className="grid-fields three">
              {[
                ['background', 'Background'],
                ['foreground', 'Text'],
                ['accent', 'Accent'],
              ].map(([key, label]) => (
                <label key={key} className="field">
                  {label}
                  <input type="color" value={form.theme[key]} onChange={setTheme(key)} className="swatch" />
                </label>
              ))}
            </div>
            <div className="row">
              <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={pickImage} />
              <button type="button" onClick={() => fileInput.current.click()} disabled={uploading}>
                <ImagePlus size={16} /> {uploading ? 'Uploading…' : form.image ? 'Replace image' : 'Add image'}
              </button>
              {form.image && (
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    setImageFileId(null);
                    setForm((f) => ({ ...f, image: null }));
                  }}
                >
                  Remove image
                </button>
              )}
            </div>
            <p className="small muted" style={{ margin: 0 }}>
              JPEG, PNG or WebP. The app shows it beside the text.
            </p>
          </div>
        </div>
        <ErrorNote error={error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" onClick={() => dialog.current.close()}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || uploading}>
            {busy ? 'Saving…' : isNew ? 'Create banner' : 'Save changes'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
