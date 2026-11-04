import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../common/auth.js';
import { notFound } from '../../common/errors.js';
import { validate } from '../../common/validate.js';
import { apiDoc } from '../../docs/api-doc.js';
import { placeDetails, reverseGeocode, searchPlaces } from '../../integrations/geocoding.js';
import { citySummary, getPlatform, matchCity } from '../platform/platform.service.js';

// Address search for any form with an address and a map pin: the vendor's shop, a pet parent's
// saved addresses, a home visit. The app shows suggestions as the user types, and picking one
// fills in the address fields and the pin.
const router = Router();
router.use(authenticate);

const lat = z.coerce.number().min(-90).max(90);
const lng = z.coerce.number().min(-180).max(180);
// Google bills the searches and the pick they end in as one session; other providers ignore it.
const session = z.string().trim().max(64).optional();

const norm = (s) => s?.trim().toLowerCase();

// The Nurvia city covering the place becomes its `city`, so the address works with the city
// filters and checks used elsewhere; the place's own town then moves into `line2`.
async function withNurviaCity(place) {
  const { features, cities } = await getPlatform();
  const match = matchCity(
    cities.filter((c) => c.status !== 'disabled'),
    { city: place.address.city, ...place.location },
  );
  if (!match) return { ...place, city: null };
  const { address } = place;
  const town = address.city && norm(address.city) !== norm(match.name) ? address.city : undefined;
  const line2 = [address.line2, town].filter(Boolean).join(', ');
  return { ...place, address: { ...address, ...(line2 && { line2 }), city: match.name }, city: citySummary(match, features) };
}

const placeExample = {
  formatted: '13 Sapna Sangeeta Road, Sapna Sangeeta Mall, Indore, Madhya Pradesh, 452001',
  address: { line1: 'Sapna Sangeeta Mall, 13 Sapna Sangeeta Road', city: 'Indore', state: 'Madhya Pradesh', pincode: '452001' },
  location: { lat: 22.6991, lng: 75.8672 },
  city: { slug: 'indore', name: 'Indore', region: 'Madhya Pradesh', status: 'active', center: { lat: 22.7196, lng: 75.8577 }, modules: { booking: 'active', marketplace: 'active' } },
};

const placeDescription = [
  '`address` has the fields every address form takes (`POST /vendors`, `PUT /users/me/addresses`, a shop order): fill the form with it and let the user correct it. `location` is the map pin, to send as `location`.',
  '`city` is the Nurvia city covering the place (as in `GET /config`), or `null` when Nurvia is not there yet. When there is one, `address.city` is its name and the place\'s own town is added to `address.line2` (Gurugram → `Delhi NCR`, line2 `…, Gurugram`).',
].join('\n\n');

router.get(
  '/search',
  apiDoc({
    summary: 'Address search as you type (India)',
    description: [
      'Call it as the user types in the address field (wait ~300 ms after the last key; from 3 characters). Each item is a suggestion to show in a list: `title` on the first line, `subtitle` under it.',
      'When the user picks one, call `GET /geo/places/{placeId}` with its `id` for the full address and map pin. Ids are opaque and can be long; do not parse them.',
      'Send `lat` and `lng` (the phone\'s location, or the chosen city\'s `center` from `GET /config`) to rank nearby places first. Send the same `session` (any random string, up to 64 characters) with the searches and the pick they end in; start a new one for the next search.',
      'Results come from OpenStreetMap (Photon) or Google, set with `GEOCODING_PROVIDER` on the server. 503 when the provider is not responding: let the user type the address instead.',
    ].join('\n\n'),
    responses: {
      200: {
        description: 'Suggestions, best first',
        example: {
          items: [
            { id: 'osm.eyJmb3JtYXR0ZWQiOi…', title: 'Sapna Sangeeta Road', subtitle: 'Indore, Madhya Pradesh' },
            { id: 'osm.eyJmb3JtYXR0ZWQiOi…', title: 'Sapna Sangeeta Mall, 13 Sapna Sangeeta Road', subtitle: 'Indore, Madhya Pradesh' },
          ],
        },
      },
    },
  }),
  validate({ query: { q: z.string().trim().min(2).max(200), lat: lat.optional(), lng: lng.optional(), limit: z.coerce.number().int().min(1).max(10).default(6), session } }),
  async (req, res) => {
    const { q, lat: nearLat, lng: nearLng, limit, session: token } = req.valid.query;
    const near = nearLat !== undefined && nearLng !== undefined ? { lat: nearLat, lng: nearLng } : undefined;
    res.json({ items: await searchPlaces({ q, near, limit, session: token }) });
  },
);

router.get(
  '/places/:placeId',
  apiDoc({
    summary: 'The address and map pin of a picked suggestion',
    description: placeDescription,
    responses: { 200: { description: 'The place', example: placeExample } },
  }),
  validate({ params: { placeId: z.string().min(1).max(2000).regex(/^[\w.-]+$/) }, query: { session } }),
  async (req, res) => {
    res.json(await withNurviaCity(await placeDetails(req.valid.params.placeId, { session: req.valid.query.session })));
  },
);

router.get(
  '/reverse',
  apiDoc({
    summary: 'The address at a map pin',
    description: [
      'For "Use my current location" or a pin dropped on a map: the address there, to fill in the fields the user has not typed yet. `location` is the pin that was sent. 404 when no address is known there.',
      placeDescription,
    ].join('\n\n'),
    responses: { 200: { description: 'The address at the pin', example: placeExample } },
  }),
  validate({ query: { lat, lng } }),
  async (req, res) => {
    const place = await reverseGeocode(req.valid.query);
    if (!place) throw notFound('Address at this location');
    res.json(await withNurviaCity(place));
  },
);

export default router;
