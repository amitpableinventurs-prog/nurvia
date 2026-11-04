import { ImagePlus, LocateFixed, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { AddressSearch, addressFields } from '../address-search.jsx';
import { api } from '../api.js';
import { useSession } from '../session.jsx';
import { ErrorNote, useApi } from '../ui.jsx';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// Monday first, the way Indian shop hours are usually written.
const ORDER = [1, 2, 3, 4, 5, 6, 0];

export default function Profile() {
  const { session, refreshVendor, reload: reloadSession } = useSession();
  const [ownerName, setOwnerName] = useState(session.user.name ?? '');
  const v = session.vendor;
  const { data: categories } = useApi('/categories', { kind: 'vendor' });

  const [form, setForm] = useState(() => ({
    businessName: v.businessName,
    description: v.description ?? '',
    phone: v.phone ?? '',
    email: v.email ?? '',
    line1: v.address.line1,
    line2: v.address.line2 ?? '',
    city: v.address.city,
    state: v.address.state ?? '',
    pincode: v.address.pincode ?? '',
    categoryIds: v.categories.map((c) => c._id ?? c),
    homeVisits: v.homeVisits,
    slotCapacity: v.slotCapacity,
  }));
  const [hours, setHours] = useState(() => Object.fromEntries(ORDER.map((d) => [d, v.operatingHours.filter((w) => w.day === d).map(({ open, close }) => ({ open, close }))])));
  const [location, setLocation] = useState(null);
  const [photos, setPhotos] = useState(v.photos ?? []);
  const [saved, setSaved] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const setWindow = (day, i, key, value) => setHours((h) => ({ ...h, [day]: h[day].map((w, j) => (j === i ? { ...w, [key]: value } : w)) }));
  const addWindow = (day) => setHours((h) => ({ ...h, [day]: [...h[day], h[day].length ? { open: '17:00', close: '20:00' } : { open: '10:00', close: '19:00' }] }));
  const removeWindow = (day, i) => setHours((h) => ({ ...h, [day]: h[day].filter((_, j) => j !== i) }));
  const copyMonday = () => setHours((h) => Object.fromEntries(ORDER.map((d) => [d, d === 0 ? h[0] : h[1].map((w) => ({ ...w }))])));

  const addPhoto = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const uploaded = await api.upload(file, 'vendor_photo');
      setPhotos((p) => [...p, { file: uploaded._id, url: uploaded.url, name: uploaded.originalName }]);
    } catch (err) {
      setError(err);
    }
  };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      await api.patch('/vendors/me', {
        businessName: form.businessName.trim(),
        description: form.description.trim() || undefined,
        phone: form.phone.trim() || undefined,
        email: form.email.trim() || undefined,
        categoryIds: form.categoryIds,
        address: { line1: form.line1, ...(form.line2 && { line2: form.line2 }), city: form.city, ...(form.state && { state: form.state }), ...(form.pincode && { pincode: form.pincode }) },
        homeVisits: form.homeVisits,
        slotCapacity: Number(form.slotCapacity),
        operatingHours: ORDER.flatMap((day) => hours[day].map((w) => ({ day, ...w }))),
        photoFileIds: photos.map((p) => p.file),
        ...(location && { location }),
      });
      if (ownerName.trim() && ownerName.trim() !== session.user.name) {
        await api.patch('/users/me', { name: ownerName.trim() });
        await reloadSession();
      } else {
        await refreshVendor();
      }
      setSaved(new Date());
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" style={{ gap: 18 }} onSubmit={save}>
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>Business profile</h1>
          <p className="muted" style={{ margin: '4px 0 0' }}>This is what pet parents see when they find you on Nurvia.</p>
        </div>
        <div className="row">
          {saved && <span className="small ov-good">Saved</span>}
          <button className="primary" disabled={busy || !form.categoryIds.length} title={form.categoryIds.length ? undefined : 'Pick at least one category'}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
      <ErrorNote error={error} />

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <section className="card stack">
          <h2 style={{ margin: 0 }}>About</h2>
          <label className="field">
            Business name
            <input value={form.businessName} onChange={set('businessName')} required minLength={2} maxLength={120} />
          </label>
          <label className="field">
            Description
            <textarea value={form.description} onChange={set('description')} maxLength={2000} placeholder="Your speciality, doctors, facilities, languages spoken" />
          </label>
          <fieldset className="field vp-fieldset">
            <legend>Categories</legend>
            <div className="row">
              {categories?.map((c) => (
                <button
                  type="button"
                  key={c._id}
                  className="vp-chip"
                  aria-pressed={form.categoryIds.includes(c._id)}
                  onClick={() => setForm((f) => ({ ...f, categoryIds: f.categoryIds.includes(c._id) ? f.categoryIds.filter((x) => x !== c._id) : [...f.categoryIds, c._id].slice(0, 5) }))}
                >
                  {c.name}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="vp-grid-2">
            <label className="field">
              Owner / contact person
              <input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} required minLength={2} maxLength={120} autoComplete="name" />
            </label>
            <label className="field">
              Phone
              <input value={form.phone} onChange={set('phone')} inputMode="tel" maxLength={20} />
            </label>
            <label className="field">
              Email
              <input type="email" value={form.email} onChange={set('email')} />
            </label>
          </div>
          <div className="vp-grid-2">
            <label className="field">
              Address
              <AddressSearch
                value={form.line1}
                onChange={set('line1')}
                // A picked address fills in every field and moves the map pin to it.
                onPick={(place) => {
                  setForm((f) => ({ ...f, ...addressFields(place.address) }));
                  setLocation(place.location);
                }}
                near={location ?? { lat: v.location.coordinates[1], lng: v.location.coordinates[0] }}
                required
                placeholder="Search your shop, street or area"
              />
            </label>
            <label className="field">
              Area / locality
              <input value={form.line2} onChange={set('line2')} />
            </label>
            <label className="field">
              City
              <input value={form.city} onChange={(e) => setForm((f) => ({ ...f, city: e.target.value, state: '' }))} required />
            </label>
            <label className="field">
              PIN code
              <input
                value={form.pincode}
                onChange={(e) => setForm((f) => ({ ...f, pincode: e.target.value.replace(/\D/g, '').slice(0, 6) }))}
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                title="Enter a 6-digit PIN code"
                placeholder="110001"
                autoComplete="postal-code"
              />
            </label>
          </div>
          <button
            type="button"
            onClick={() => navigator.geolocation?.getCurrentPosition((p) => setLocation({ lat: p.coords.latitude, lng: p.coords.longitude }))}
            style={{ alignSelf: 'flex-start' }}
          >
            <LocateFixed size={15} /> {location ? `Map pin moved to ${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}` : 'Move map pin to my current location'}
          </button>
          <div className="vp-grid-2">
            <label className="field">
              Customers per time slot
              <input type="number" min="1" max="50" value={form.slotCapacity} onChange={set('slotCapacity')} />
            </label>
            <label className="row small" style={{ alignSelf: 'end', minHeight: 36 }}>
              <input type="checkbox" checked={form.homeVisits} onChange={set('homeVisits')} style={{ minHeight: 0 }} /> I offer home visits
            </label>
          </div>
        </section>

        <div className="stack">
          <section className="card">
            <div className="card-head">
              <h2>Opening hours</h2>
              <button type="button" className="link small" onClick={copyMonday}>
                Copy Monday to Mon–Sat
              </button>
            </div>
            <div className="vp-hours">
              {ORDER.map((day) => (
                <div key={day} className="vp-hours-row">
                  <span className="vp-day">{DAYS[day].slice(0, 3)}</span>
                  <div className="stack" style={{ gap: 6, flex: 1 }}>
                    {hours[day].length === 0 && <span className="muted small" style={{ lineHeight: '32px' }}>Closed</span>}
                    {hours[day].map((w, i) => (
                      <div key={i} className="row" style={{ gap: 6 }}>
                        <input type="time" value={w.open} onChange={(e) => setWindow(day, i, 'open', e.target.value)} aria-label={`${DAYS[day]} opens`} required />
                        <span className="muted">to</span>
                        <input type="time" value={w.close} onChange={(e) => setWindow(day, i, 'close', e.target.value)} aria-label={`${DAYS[day]} closes`} required />
                        <button type="button" className="vp-icon-btn" onClick={() => removeWindow(day, i)} aria-label={`Remove ${DAYS[day]} hours`}>
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <button type="button" className="vp-icon-btn" onClick={() => addWindow(day)} aria-label={hours[day].length ? `Add a split shift on ${DAYS[day]}` : `Open on ${DAYS[day]}`} title={hours[day].length ? 'Add a split shift' : 'Open this day'}>
                    <Plus size={14} />
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Photos</h2>
              <label className="ov-btn" style={{ cursor: 'pointer' }}>
                <ImagePlus size={15} /> Add photo
                <input type="file" accept="image/jpeg,image/png,image/webp" onChange={addPhoto} hidden />
              </label>
            </div>
            {photos.length ? (
              <div className="vp-photos">
                {photos.map((p) => (
                  <figure key={p.file}>
                    <img src={p.url} alt={p.name ?? 'Business photo'} />
                    <button type="button" className="vp-icon-btn" onClick={() => setPhotos((list) => list.filter((x) => x.file !== p.file))} aria-label="Remove photo">
                      <X size={14} />
                    </button>
                  </figure>
                ))}
              </div>
            ) : (
              <div className="empty small">Listings with photos get more bookings. Add your reception, treatment room or grooming area.</div>
            )}
            <p className="small muted" style={{ marginBottom: 0 }}>New photos are saved when you press Save changes.</p>
          </section>
        </div>
      </div>
    </form>
  );
}
