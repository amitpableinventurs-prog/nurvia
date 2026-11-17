import { ApiError, badRequest } from '../../common/errors.js';
import { currentTenant } from '../../common/tenancy.js';
import { bestMatch, findIndianCity, indianCities, searchKey } from './india-cities.js';
import { City, PlatformConfig } from './platform.model.js';

// Platform-wide modules staff can switch on and off. City-scoped modules are additionally
// limited to cities where they are active; the rest work for every user, in any city.
export const FEATURES = {
  booking: { label: 'Service booking', phase: 1, cityScoped: true, default: true },
  marketplace: { label: 'Marketplace (shop)', phase: 2, cityScoped: true, default: true },
  adoption: { label: 'Adoption', phase: 1, default: true },
  communityDogs: { label: 'Community dogs', phase: 1, default: true },
  community: { label: 'Community feed', phase: 1, default: true },
  ai: { label: 'AI health summary', phase: 1, default: true },
  // Phase 1 ships the SOS / Lost & Found workflows switched off; the full user-facing launch is Phase 2.
  sos: { label: 'SOS / Lost & Found', phase: 2, default: false },
};
export const CITY_MODULES = Object.keys(FEATURES).filter((k) => FEATURES[k].cityScoped);

// Config is read on most requests, so it is cached briefly per tenant and dropped on every change.
// With several API instances, other instances pick a change up within CACHE_MS.
const CACHE_MS = 15_000;
const cache = new Map();

export function clearPlatformCache() {
  cache.delete(currentTenant());
}

async function load() {
  const tenant = currentTenant();
  const hit = cache.get(tenant);
  if (hit && hit.expires > Date.now()) return hit.value;
  const [config, cities] = await Promise.all([PlatformConfig.findOne({ key: 'platform' }).lean(), City.find().sort({ sortOrder: 1, name: 1 }).lean()]);
  const features = Object.fromEntries(Object.entries(FEATURES).map(([k, f]) => [k, config?.features?.[k] ?? f.default]));
  const marketplace = { codEnabled: config?.marketplace?.codEnabled ?? true, codMaxOrderPaise: config?.marketplace?.codMaxOrderPaise ?? 500_000 };
  const value = { features, cities, marketplace };
  cache.set(tenant, { value, expires: Date.now() + CACHE_MS });
  return value;
}

export const getPlatform = load;

// A module's state in a city: a disabled city disables everything, a coming-soon city shows its
// modules as coming soon, and an active city uses each module's own setting.
export function cityModuleState(city, module) {
  const own = city.modules?.[module] ?? 'active';
  if (city.status === 'disabled' || own === 'disabled') return 'disabled';
  if (city.status === 'coming_soon') return 'coming_soon';
  return own;
}

// A city as the apps see it, with each local module's state there.
export const citySummary = (c, features) => ({
  slug: c.slug,
  name: c.name,
  region: c.region,
  status: c.status,
  center: { lat: c.center.coordinates[1], lng: c.center.coordinates[0] },
  modules: Object.fromEntries(CITY_MODULES.map((m) => [m, features[m] ? cityModuleState(c, m) : 'disabled'])),
});

const norm = (s) => s?.trim().toLowerCase();
const namesOf = (city) => [city.name, city.slug, ...(city.aliases ?? [])].map(norm);

export function distanceKm([lng1, lat1], [lng2, lat2]) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

// Finds the configured city for a place name (or alias), or else the nearest city whose radius
// covers the coordinates.
export function matchCity(cities, { city, lat, lng } = {}) {
  if (city) {
    const found = cities.find((c) => namesOf(c).includes(norm(city)));
    if (found) return found;
  }
  if (lat !== undefined && lng !== undefined) {
    const covering = cities
      .map((c) => ({ c, d: distanceKm(c.center.coordinates, [lng, lat]) }))
      .filter(({ c, d }) => d <= c.radiusKm)
      .sort((a, b) => a.d - b.d);
    return covering[0]?.c ?? null;
  }
  return null;
}

// active | coming_soon | disabled | unavailable (no configured city covers the place).
// Before any city is configured, city-scoped modules work everywhere.
// A profile's home city: a configured city by name, slug or alias (also when an Indian place is
// picked by another of its names, e.g. Gurugram for Delhi NCR), else any Indian city or town from
// the search, which has no slug. Before any city is configured, any name is accepted.
export async function resolveCity(name) {
  const { cities } = await getPlatform();
  const visible = cities.filter((c) => c.status !== 'disabled');
  const place = findIndianCity(name);
  const city = matchCity(visible, { city: name }) ?? (place && matchCity(visible, { city: place.name }));
  if (city) return { city: city.name, citySlug: city.slug };
  if (place) return { city: place.name };
  if (!cities.length) return { city: name };
  throw badRequest('Choose a city from the list');
}

// A city in the "Select city" picker.
export const pickerCity = (c) => ({ slug: c.slug, name: c.name, region: c.region, status: c.status });

// The city search as the user types: configured cities and every Indian city or town whose name,
// or another name for it (Bangalore, Bombay, Gurgaon), matches `q`. Best match first, then
// configured cities, then larger places. A configured city's aliases count as its name (staff chose
// them); a match on one of the many spellings GeoNames lists ranks below the same match on a name.
// A place that is a configured city's name or alias is listed only as that city. `matched` is the
// other name that was found.
export function searchCities(cities, q, limit) {
  const query = searchKey(q);
  if (!query) return [];
  const visible = cities.filter((c) => c.status !== 'disabled');
  const covered = new Set(visible.flatMap((c) => [c.name, ...(c.aliases ?? [])].map(searchKey)));
  const hits = [];
  for (const c of visible) {
    const names = [c.name, ...(c.aliases ?? [])];
    const match = bestMatch(names.map(searchKey), query);
    if (match) hits.push({ ...match, rank: match.tier * 2, configured: 1, population: 0, names, item: pickerCity(c) });
  }
  // Before any city is configured, local services run everywhere.
  const status = cities.length ? 'unavailable' : 'active';
  for (const p of indianCities()) {
    if (covered.has(p.keys[0])) continue;
    const match = bestMatch(p.keys, query);
    if (!match) continue;
    const rank = match.tier * 2 + (match.index > 0 ? 1 : 0);
    hits.push({ ...match, rank, configured: 0, population: p.population, names: p.names, item: { slug: p.slug, name: p.name, region: p.region, status } });
  }
  hits.sort((a, b) => a.rank - b.rank || b.configured - a.configured || b.population - a.population || (a.item.name < b.item.name ? -1 : 1));
  return hits.slice(0, limit).map((h) => ({ ...h.item, ...(h.index > 0 && { matched: h.names[h.index] }) }));
}

export async function moduleAvailability(module, place) {
  const { features, cities } = await load();
  if (!features[module]) return { state: 'disabled', city: null };
  if (!FEATURES[module].cityScoped || !cities.length) return { state: 'active', city: null };
  const city = matchCity(cities, place);
  return { state: city ? cityModuleState(city, module) : 'unavailable', city: city && { slug: city.slug, name: city.name } };
}

// Place names a city-scoped module is live in, for filtering records by their address city.
// Returns null when no city is configured (no restriction).
export async function liveCityNames(module) {
  const { cities } = await load();
  if (!cities.length) return null;
  return cities.filter((c) => cityModuleState(c, module) === 'active').flatMap(namesOf);
}

const STATE_COPY = { coming_soon: 'is coming soon to', disabled: 'is not available in', unavailable: 'is not available in' };

export async function assertModuleAt(module, place) {
  const { state, city } = await moduleAvailability(module, place);
  if (state === 'active') return;
  const label = FEATURES[module].label;
  const where = city?.name ?? place.city ?? 'your area';
  throw new ApiError(409, 'MODULE_UNAVAILABLE', state === 'disabled' && !city ? `${label} is switched off right now` : `${label} ${STATE_COPY[state]} ${where}`, {
    module,
    state,
    city,
  });
}

// Route guard for a platform-wide switch.
export function requireFeature(module) {
  const guard = async (_req, _res, next) => {
    const { features } = await load();
    if (!features[module]) throw new ApiError(403, 'FEATURE_DISABLED', `${FEATURES[module].label} is switched off right now`, { module });
    next();
  };
  // Read by the OpenAPI generator (src/docs/openapi.js).
  return Object.assign(guard, { feature: module });
}
