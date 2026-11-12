import { Router } from 'express';
import { z } from 'zod';
import { LANGUAGES } from '../../common/languages.js';
import { badRequest } from '../../common/errors.js';
import { validate } from '../../common/validate.js';
import { apiDoc } from '../../docs/api-doc.js';
import { supportContent } from './support-content.js';
import { CITY_MODULES, FEATURES, cityModuleState, citySummary, getPlatform, matchCity, pickerCity, searchCities } from './platform.service.js';

const router = Router();

// What the apps may show: platform switches, the city list for a picker, and, for the caller's
// city or location, whether booking and the marketplace are live, coming soon or unavailable.
router.get(
  '/',
  validate({ query: { city: z.string().trim().max(80).optional(), lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional() } }),
  async (req, res) => {
    const { features, cities } = await getPlatform();
    const visible = cities.filter((c) => c.status !== 'disabled');
    const summary = (c) => citySummary(c, features);
    const city = cities.length ? matchCity(cities, req.valid.query) : null;
    const asked = req.valid.query.city || req.valid.query.lat !== undefined;
    const modules = Object.fromEntries(
      CITY_MODULES.map((m) => [
        m,
        !features[m] ? 'disabled' : !cities.length ? 'active' : city ? cityModuleState(city, m) : asked ? 'unavailable' : null,
      ]),
    );
    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      features: Object.fromEntries(Object.keys(FEATURES).map((k) => [k, features[k]])),
      citiesConfigured: cities.length > 0,
      cities: visible.map(summary),
      city: city && city.status !== 'disabled' ? summary(city) : null,
      // null means no city was given, so the app should ask the user to pick one.
      modules,
      // For the "Preferred Language" picker.
      languages: LANGUAGES,
    });
  },
);

router.get(
  '/support',
  apiDoc({
    summary: 'Help & Support screen: care desk, contact details and common questions',
    description: 'Public, so it also works signed out. `contact.email` opens the mail app; show `answer` when a question is tapped.',
    responses: { 200: { description: 'Help & Support content', example: supportContent() } },
  }),
  (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json(supportContent());
  },
);

// The "Select city" picker on sign-up and the profile. Before the user types: the cities Nurvia is
// in (disabled ones left out). As they type (`q`): any Indian city or town, for autocomplete. With
// lat & lng it also detects the Nurvia city covering that spot, so the app can preselect it.
// The chosen `slug` is what /auth/register and PATCH /users/me take as `city`.
router.get(
  '/cities',
  apiDoc({
    summary: 'City picker with search as you type: Nurvia cities, any Indian city, and the city detected from a location',
    description: [
      'Without `q`: the cities Nurvia is in, in display order; `status` is `active` or `coming_soon`. Show these before the user types.',
      'With `q` (call it as the user types, e.g. `q=ind`): any Indian city or town whose name, or another name for it, matches, best match first (whole name, then start of the name, then start of a later word, then anywhere; larger places first). Nurvia\'s cities rank first and keep their `status`; other places have `status: unavailable` (Nurvia services are not there yet, but the user can still pick it as their city). `matched` is the other name that was found ("Bombay" finds Mumbai, "Gurgaon" finds Delhi NCR). `limit` caps the list (default 20, at most 50). City data: GeoNames (geonames.org), CC BY 4.0.',
      'Send the phone\'s `lat` and `lng` to detect the city: `detected` is the Nurvia city whose area covers that spot, or `null` when Nurvia is not there yet (the user then picks from the list).',
      'Send the chosen item\'s `slug` as `city` to `POST /auth/register` or `PATCH /users/me`. A Nurvia city is saved with its `citySlug`; any other place is saved by name only. Localities for the next field come from `GET /explore/localities?city=<slug>` (Nurvia cities only).',
    ].join('\n\n'),
    responses: {
      200: {
        description: 'Cities, and the detected one',
        examples: {
          search: {
            summary: 'Searching q=ind',
            value: {
              items: [
                { slug: 'indore', name: 'Indore', region: 'Madhya Pradesh', status: 'unavailable' },
                { slug: 'indapur', name: 'Indapur', region: 'Maharashtra', status: 'unavailable' },
                { slug: 'indi', name: 'Indi', region: 'Karnataka', status: 'unavailable' },
              ],
              detected: null,
            },
          },
          alias: {
            summary: 'Searching q=gurgaon',
            value: { items: [{ slug: 'delhi-ncr', name: 'Delhi NCR', region: 'Delhi', status: 'active', matched: 'Gurgaon' }], detected: null },
          },
          detected: {
            summary: 'With lat=12.9784&lng=77.6408 (Indiranagar)',
            value: {
              items: [
                { slug: 'delhi-ncr', name: 'Delhi NCR', region: 'Delhi', status: 'active' },
                { slug: 'mumbai', name: 'Mumbai', region: 'Maharashtra', status: 'coming_soon' },
                { slug: 'bengaluru', name: 'Bengaluru', region: 'Karnataka', status: 'active' },
                { slug: 'hyderabad', name: 'Hyderabad', region: 'Telangana', status: 'coming_soon' },
              ],
              detected: { slug: 'bengaluru', name: 'Bengaluru', region: 'Karnataka', status: 'active' },
            },
          },
          outside: {
            summary: 'A location no city covers',
            value: { items: [{ slug: 'delhi-ncr', name: 'Delhi NCR', region: 'Delhi', status: 'active' }], detected: null },
          },
        },
      },
      400: { description: 'Only one of lat and lng was sent', example: { error: { code: 'BAD_REQUEST', message: 'Send both lat and lng' } } },
    },
  }),
  validate({
    query: {
      lat: z.coerce.number().min(-90).max(90).optional(),
      lng: z.coerce.number().min(-180).max(180).optional(),
      q: z.string().trim().max(80).optional(),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    },
  }),
  async (req, res) => {
    const { lat, lng, q, limit } = req.valid.query;
    if ((lat === undefined) !== (lng === undefined)) throw badRequest('Send both lat and lng');
    const { cities } = await getPlatform();
    const visible = cities.filter((c) => c.status !== 'disabled');
    const items = q ? searchCities(cities, q, limit) : visible.map(pickerCity);
    const detected = lat !== undefined ? matchCity(visible, { lat, lng }) : null;
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ items, detected: detected && pickerCity(detected) });
  },
);

export default router;
