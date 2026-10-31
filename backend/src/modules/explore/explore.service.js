import { badRequest } from '../../common/errors.js';
import { escapeRegex } from '../../common/validate.js';
import { notify } from '../notifications/notify.js';
import { getPlatform, matchCity } from '../platform/platform.service.js';
import { User } from '../users/user.model.js';
import { MarketplaceWaitlist } from './explore.model.js';

const norm = (s) => s?.trim().toLowerCase();

// A configured locality by name, within one city or any.
export function findLocality(cities, name, citySlug) {
  for (const city of cities) {
    if (citySlug && city.slug !== citySlug && norm(city.name) !== norm(citySlug)) continue;
    const locality = city.localities?.find((l) => norm(l.name) === norm(name));
    if (locality) return { city, locality };
  }
  return null;
}

// Where Explore searches from, in order: coordinates sent by the app (GPS), a locality picked by
// hand, then the location saved on the account. `source: none` asks the app for a location.
export async function resolvePlace({ lat, lng, locality, city }, userId) {
  const { cities } = await getPlatform();
  if (lat !== undefined && lng !== undefined) {
    const match = matchCity(cities, { lat, lng });
    return { source: 'gps', lat, lng, city: match?.name ?? null, locality: locality ?? null };
  }
  if (locality) {
    const found = findLocality(cities, locality, city);
    if (!found) throw badRequest('Choose a locality from the list', { localities: popularLocalities(cities, city) });
    const [lngValue, latValue] = found.locality.center.coordinates;
    return { source: 'locality', lat: latValue, lng: lngValue, city: found.city.name, locality: found.locality.name };
  }
  if (userId) {
    const user = await User.findById(userId).select('location locality city').lean();
    if (user?.location?.coordinates?.length) {
      const [lngValue, latValue] = user.location.coordinates;
      return { source: 'saved', lat: latValue, lng: lngValue, city: user.city ?? null, locality: user.locality ?? null };
    }
  }
  return { source: 'none', lat: undefined, lng: undefined, city: city ?? null, locality: null };
}

// The "Popular" chips on the location picker, for one city or every active one.
export function popularLocalities(cities, citySlug) {
  return cities
    .filter((c) => c.status !== 'disabled' && (!citySlug || c.slug === citySlug || norm(c.name) === norm(citySlug)))
    .flatMap((c) => (c.localities ?? []).filter((l) => l.popular).map((l) => ({ name: l.name, city: c.name, citySlug: c.slug })));
}

export function searchLocalities(cities, { q, citySlug }) {
  const pattern = q && new RegExp(escapeRegex(q), 'i');
  return cities
    .filter((c) => c.status !== 'disabled' && (!citySlug || c.slug === citySlug))
    .flatMap((c) =>
      (c.localities ?? [])
        .filter((l) => !pattern || pattern.test(l.name))
        .map((l) => ({ name: l.name, city: c.name, citySlug: c.slug, popular: Boolean(l.popular), lat: l.center.coordinates[1], lng: l.center.coordinates[0] })),
    )
    .sort((a, b) => b.popular - a.popular || a.name.localeCompare(b.name));
}

// Tells everyone waiting in a city that in-app shopping is live there. Each person is told once.
export async function notifyMarketplaceWaitlist(city) {
  const waiting = await MarketplaceWaitlist.find({ citySlug: city.slug, notifiedAt: null }).select('user').lean();
  if (!waiting.length) return 0;
  await notify(
    waiting.map((w) => w.user),
    { type: 'shop.marketplace_live', title: `Shopping on Nurvia is live in ${city.name}`, body: 'Order from neighbourhood pet stores in the app.', data: { city: city.slug } },
  );
  await MarketplaceWaitlist.updateMany({ _id: { $in: waiting.map((w) => w._id) } }, { notifiedAt: new Date() });
  return waiting.length;
}
