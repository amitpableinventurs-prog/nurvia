import { z } from 'zod';
import { env } from '../config/env.js';
import { badRequest, unavailable } from '../common/errors.js';

// Address search for forms, limited to India. Every provider returns the same shapes:
//   suggestion: { id, title, subtitle }
//   place: { formatted, address: { line1, line2?, city?, state?, pincode? }, location: { lat, lng } }
// A suggestion's id is opaque: pass it back to placeDetails() for the address and map pin.

const TIMEOUT_MS = 6000;
const INDIA_BBOX = '68.1,6.5,97.5,37.1'; // west, south, east, north
const DOWN = 'Address search is not responding right now. Fill in the address yourself.';

const clean = (parts) => [...new Set(parts.map((p) => p?.trim()).filter(Boolean))];
const join = (parts) => clean(parts).join(', ');
const pincodeOf = (value) => value?.replace(/\s/g, '').match(/^\d{6}$/)?.[0];

async function getJson(url, init) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    console.warn(`[geocoding] ${new URL(url).host}: ${err.message}`);
    throw unavailable(DOWN);
  }
  // The host only: Google's Geocoding API takes the key in the query string.
  if (!res.ok) {
    console.warn(`[geocoding] ${new URL(url).host}: HTTP ${res.status}`);
    throw unavailable(DOWN);
  }
  return res.json();
}

function toPlace({ name, street, area = [], city, state, postcode, location, formatted }) {
  const rest = clean(area).filter((a) => a !== name && a !== street && a !== city);
  const line1 = join([name, street]) || rest.shift() || city;
  const pincode = pincodeOf(postcode);
  return {
    formatted: formatted ?? join([line1, ...rest, city, state, pincode]),
    address: { line1, ...(rest.length && { line2: rest.join(', ') }), ...(city && { city }), ...(state && { state }), ...(pincode && { pincode }) },
    location,
  };
}

// ---- Photon (photon.komoot.io): OpenStreetMap data, built for search as you type ----

const PHOTON_HEADERS = { 'User-Agent': 'Nurvia/0.1 (address search)' };

// A Photon result already carries the address and coordinates, and Photon has no lookup by id,
// so the place itself is the id.
const OSM_ID = 'osm.';
const encodePlace = (place) => OSM_ID + Buffer.from(JSON.stringify(place)).toString('base64url');
const placeShape = z.object({
  formatted: z.string(),
  address: z.object({ line1: z.string(), line2: z.string().optional(), city: z.string().optional(), state: z.string().optional(), pincode: z.string().optional() }),
  location: z.object({ lat: z.number(), lng: z.number() }),
});

// A street, colony or area result is named after itself, and so is a shop or building ("house").
// For a reverse lookup the nearest shop or building is usually a neighbour, so its name is left out.
function fromPhoton({ geometry, properties: p }, { named = true } = {}) {
  const city = p.city ?? p.county?.replace(/\s+(tahsil|tehsil|taluka|taluk|mandal)$/i, '');
  const name = p.name && ![p.street, city, p.district, p.locality].includes(p.name) && (named || p.type !== 'house') ? p.name : undefined;
  // OpenStreetMap often names a district after its city ("Indore City"), which adds nothing.
  const area = clean([p.locality, p.district]).filter((a) => !city || !a.toLowerCase().includes(city.toLowerCase()));
  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  const place = toPlace({ name, street, area, city, state: p.state, postcode: p.postcode, location: { lat: geometry.coordinates[1], lng: geometry.coordinates[0] } });
  return { place, title: place.address.line1, subtitle: join([place.address.line2, city, p.state]) };
}

const photon = {
  async search({ q, near, limit }) {
    const params = new URLSearchParams({ q, limit: String(limit + 4), lang: 'en', bbox: INDIA_BBOX });
    if (near) {
      params.set('lat', near.lat);
      params.set('lon', near.lng);
    }
    const body = await getJson(`${env.geocoding.photonUrl}/api/?${params}`, { headers: PHOTON_HEADERS });
    // The same place is often mapped twice in OpenStreetMap (a point and an outline).
    const seen = new Set();
    return body.features
      .filter((f) => f.properties.countrycode === 'IN')
      .map((f) => fromPhoton(f))
      .filter(({ title, subtitle }) => {
        const key = `${title}|${subtitle}`;
        return !seen.has(key) && seen.add(key);
      })
      .slice(0, limit)
      .map(({ place, title, subtitle }) => ({ id: encodePlace(place), title, subtitle }));
  },
  async details(id) {
    try {
      return placeShape.parse(JSON.parse(Buffer.from(id.slice(OSM_ID.length), 'base64url').toString()));
    } catch {
      throw badRequest('Unknown place id. Search again and pick a suggestion.');
    }
  },
  async reverse({ lat, lng }) {
    const params = new URLSearchParams({ lat, lon: lng, lang: 'en', limit: '1' });
    const body = await getJson(`${env.geocoding.photonUrl}/reverse?${params}`, { headers: PHOTON_HEADERS });
    const feature = body.features.find((f) => f.properties.countrycode === 'IN');
    return feature && { ...fromPhoton(feature, { named: false }).place, location: { lat, lng } };
  },
};

// ---- Google: Places API (New) for search and details, Geocoding API for reverse ----

function googleKey() {
  if (!env.geocoding.googleMapsApiKey) throw unavailable('Address search is not set up yet (GOOGLE_MAPS_API_KEY is missing).');
  return env.geocoding.googleMapsApiKey;
}

// components: [{ name, types }] from either API.
function fromGoogle(components, { name, location, formatted }) {
  const pick = (...types) => types.map((t) => components.find((c) => c.types.includes(t))?.name).find(Boolean);
  return toPlace({
    name,
    street: join([pick('subpremise'), pick('premise'), pick('street_number'), pick('route')]),
    area: ['neighborhood', 'sublocality_level_3', 'sublocality_level_2', 'sublocality_level_1'].map((t) => pick(t)),
    city: pick('locality', 'administrative_area_level_3', 'administrative_area_level_2'),
    state: pick('administrative_area_level_1'),
    postcode: pick('postal_code'),
    location,
    formatted,
  });
}

const google = {
  async search({ q, near, limit, session }) {
    const body = await getJson('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': googleKey() },
      body: JSON.stringify({
        input: q,
        includedRegionCodes: ['in'],
        languageCode: 'en',
        ...(session && { sessionToken: session }),
        ...(near && { locationBias: { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 50_000 } } }),
      }),
    });
    return (body.suggestions ?? [])
      .filter((s) => s.placePrediction)
      .slice(0, limit)
      .map(({ placePrediction: p }) => ({ id: p.placeId, title: p.structuredFormat?.mainText?.text ?? p.text.text, subtitle: p.structuredFormat?.secondaryText?.text ?? '' }));
  },
  // Passing the search's session token bills the searches and this lookup as one session.
  async details(id, { session }) {
    const params = new URLSearchParams({ languageCode: 'en', ...(session && { sessionToken: session }) });
    const p = await getJson(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}?${params}`, {
      headers: { 'X-Goog-Api-Key': googleKey(), 'X-Goog-FieldMask': 'formattedAddress,location,addressComponents,displayName,types' },
    });
    return fromGoogle(
      (p.addressComponents ?? []).map((c) => ({ name: c.longText, types: c.types })),
      { name: p.types?.includes('establishment') ? p.displayName?.text : undefined, location: { lat: p.location.latitude, lng: p.location.longitude }, formatted: p.formattedAddress },
    );
  },
  async reverse({ lat, lng }) {
    const params = new URLSearchParams({ latlng: `${lat},${lng}`, language: 'en', region: 'in', key: googleKey() });
    const body = await getJson(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);
    if (!['OK', 'ZERO_RESULTS'].includes(body.status)) {
      console.warn(`[geocoding] Google Geocoding: ${body.status}`);
      throw unavailable(DOWN);
    }
    const r = body.results[0];
    return r && fromGoogle(r.address_components.map((c) => ({ name: c.long_name, types: c.types })), { location: { lat, lng }, formatted: r.formatted_address });
  },
};

const PROVIDERS = { photon, google };

function provider() {
  const p = PROVIDERS[env.geocoding.provider];
  if (!p) throw unavailable(`Unknown GEOCODING_PROVIDER "${env.geocoding.provider}"`);
  return p;
}

// Suggestions for what the user has typed; `near` ({ lat, lng }) ranks places close to it first.
export const searchPlaces = ({ q, near, limit = 6, session }) => provider().search({ q, near, limit, session });

// The address and map pin of a suggestion. A Photon id works whichever provider is set.
export const placeDetails = (id, { session } = {}) => (id.startsWith(OSM_ID) ? photon : provider()).details(id, { session });

// The address at a map pin, or null when there is none. Its location is the pin itself.
export const reverseGeocode = ({ lat, lng }) => provider().reverse({ lat, lng });
