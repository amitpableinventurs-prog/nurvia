import { LocateFixed } from 'lucide-react';
import { useState } from 'react';
import { AddressSearch, addressFields } from '../address-search.jsx';
import { api } from '../api.js';
import { NurviaMark } from '../icons.jsx';
import { useSession } from '../session.jsx';
import { ErrorNote, useApi } from '../ui.jsx';

const CITY_NOTES = {
  coming_soon: (c) => `Bookings in ${c} are coming soon. Register now and you will be ready when Nurvia launches there.`,
  disabled: (c) => `Nurvia is not taking bookings in ${c} at the moment. You can still register.`,
  unavailable: () => 'Nurvia has not launched in this city yet. You can still register, and the team will be in touch.',
};

// First sign-in: register the business. Hours, services and KYC follow inside the panel.
export default function Onboarding() {
  const { session, signOut, reload } = useSession();
  const { data: categories } = useApi('/categories', { kind: 'vendor' });
  const [form, setForm] = useState({ ownerName: session.user.name ?? '', businessName: '', categoryIds: [], line1: '', line2: '', city: '', state: '', pincode: '', phone: session.user.phone ?? '', email: session.user.email ?? '', homeVisits: false });
  const [location, setLocation] = useState(null);
  const { data: config } = useApi('/config', { city: form.city.trim() || undefined });
  // Without a shared location, the business is pinned at its city's centre so it still shows up nearby.
  const pin = location ?? config?.city?.center;
  const bookingState = form.city.trim() && config?.modules.booking;
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const toggleCategory = (id) => setForm((f) => ({ ...f, categoryIds: f.categoryIds.includes(id) ? f.categoryIds.filter((c) => c !== id) : [...f.categoryIds, id].slice(0, 5) }));

  // A picked address fills in every field and moves the map pin to it.
  const pickPlace = (place) => {
    setForm((f) => ({ ...f, ...addressFields(place.address) }));
    setLocation(place.location);
  };

  const locate = () => {
    setLocating(true);
    navigator.geolocation?.getCurrentPosition(
      async (p) => {
        const here = { lat: p.coords.latitude, lng: p.coords.longitude };
        setLocation(here);
        setLocating(false);
        // Fills in the address fields that are still empty from the address at the pin.
        const place = await api.get('/geo/reverse', here).catch(() => null);
        if (place) setForm((f) => ({ ...f, ...Object.fromEntries(Object.entries(addressFields(place.address)).filter(([key]) => !f[key].trim())) }));
      },
      () => setLocating(false),
      { timeout: 10_000 },
    );
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (form.ownerName.trim() !== (session.user.name ?? '')) await api.patch('/users/me', { name: form.ownerName.trim() });
      await api.post('/vendors', {
        businessName: form.businessName,
        categoryIds: form.categoryIds,
        phone: form.phone ? (form.phone.startsWith('+') ? form.phone : `+91${form.phone}`) : undefined,
        ...(form.email.trim() && { email: form.email.trim() }),
        address: { line1: form.line1, ...(form.line2 && { line2: form.line2 }), city: form.city, ...(form.state && { state: form.state }), ...(form.pincode && { pincode: form.pincode }) },
        location: pin,
        homeVisits: form.homeVisits,
        // A sensible default the partner can change on the profile page.
        operatingHours: [1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '10:00', close: '19:00' })),
      });
      await reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login" style={{ alignItems: 'start', paddingTop: 48 }}>
      <form className="card stack" style={{ width: 'min(620px, 100%)' }} onSubmit={submit}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="row" style={{ gap: 12 }}>
            <NurviaMark size={40} />
            <div>
              <div className="eyebrow">Partner panel · step 1 of 3</div>
              <h1 style={{ fontSize: 24 }}>
                Register your <em>business</em>
              </h1>
            </div>
          </div>
          <button type="button" className="link small" onClick={signOut}>
            Sign out
          </button>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          After this you will add your services and upload your KYC documents. Nurvia reviews new partners within 24 hours.
        </p>
        <div className="vp-grid-2">
          <label className="field">
            Owner / contact person
            <input value={form.ownerName} onChange={set('ownerName')} required minLength={2} maxLength={120} placeholder="Dr. Kiran Patel" autoComplete="name" />
          </label>
          <label className="field">
            Business name
            <input value={form.businessName} onChange={set('businessName')} required minLength={2} maxLength={120} placeholder="Happy Paws Veterinary Clinic" />
          </label>
        </div>
        <fieldset className="field vp-fieldset">
          <legend>What do you offer? (up to 5)</legend>
          <div className="row">
            {categories?.map((c) => (
              <button type="button" key={c._id} className="vp-chip" aria-pressed={form.categoryIds.includes(c._id)} onClick={() => toggleCategory(c._id)}>
                {c.name}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="vp-grid-2">
          <label className="field">
            Address
            <AddressSearch value={form.line1} onChange={set('line1')} onPick={pickPlace} near={pin} required placeholder="Search your shop, street or area" />
          </label>
          <label className="field">
            Area / locality
            <input value={form.line2} onChange={set('line2')} placeholder="Indiranagar 2nd Stage" />
          </label>
          <label className="field">
            City
            <input value={form.city} onChange={(e) => setForm((f) => ({ ...f, city: e.target.value, state: '' }))} required list="vp-cities" placeholder="Delhi NCR" />
            <datalist id="vp-cities">
              {config?.cities.map((c) => (
                <option key={c.slug} value={c.name} />
              ))}
            </datalist>
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
          <label className="field">
            Business phone
            <input value={form.phone} onChange={set('phone')} inputMode="tel" maxLength={14} />
          </label>
          <label className="field">
            Business email
            <input type="email" value={form.email} onChange={set('email')} autoComplete="email" />
          </label>
          <div className="field">
            Map location
            <button type="button" onClick={locate} disabled={locating}>
              <LocateFixed size={15} /> {location ? `${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}` : locating ? 'Locating…' : 'Use my current location'}
            </button>
          </div>
        </div>
        {bookingState && CITY_NOTES[bookingState] && <div className="notice small">{CITY_NOTES[bookingState](config.city?.name ?? form.city.trim())}</div>}
        {location && (
          <div className="small muted">
            Map pin: {location.lat.toFixed(5)}, {location.lng.toFixed(5)} ·{' '}
            <a href={`https://www.google.com/maps?q=${location.lat},${location.lng}`} target="_blank" rel="noreferrer">
              Check it on the map
            </a>
          </div>
        )}
        {!location && (
          <div className="small muted">
            {pin
              ? `Your map pin will be placed in the centre of ${config.city.name}. For accurate "near me" results, stand at your shop and use your current location.`
              : 'Share your location (stand at your shop and tap the button above) so customers searching nearby can find you.'}
          </div>
        )}
        <label className="row small">
          <input type="checkbox" checked={form.homeVisits} onChange={set('homeVisits')} style={{ minHeight: 0 }} /> I also offer home visits
        </label>
        <ErrorNote error={error} />
        <button className="primary" disabled={busy || !form.categoryIds.length || !pin} style={{ minHeight: 42 }}>
          {busy ? 'Creating…' : 'Create business profile'}
        </button>
      </form>
    </div>
  );
}
