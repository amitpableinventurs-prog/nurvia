// The Explore tab: the local pet shop directory (with calls and pharmacy stock checks), the
// marketplace preview with its "notify me" list, and the locality picker. Community dogs and
// adoption have their own modules.
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, optionalAuth, requirePermission } from '../../common/auth.js';
import { badRequest, conflict, notFound } from '../../common/errors.js';
import { paginate } from '../../common/paginate.js';
import { apiDoc } from '../../docs/api-doc.js';
import { PERMISSIONS } from '../../common/roles.js';
import { addMinutes, localParts, toMinutes } from '../../common/time.js';
import { escapeRegex, objectId, pageQuery, validate } from '../../common/validate.js';
import { startCall } from '../../integrations/call-relay.js';
import { AdoptionListing } from '../adoption/adoption.model.js';
import { CommunityDog } from '../community-dogs/community-dog.model.js';
import { notify } from '../notifications/notify.js';
import { requireCapability, vendorWorkspace } from '../operations/operations.service.js';
import { Pet } from '../pets/pet.model.js';
import { getPlatform, matchCity, moduleAvailability } from '../platform/platform.service.js';
import { isBlocked, openingState } from '../vendors/availability.js';
import { STORE_TYPES, Vendor } from '../vendors/vendor.model.js';
import { MarketplaceWaitlist, STOCK_CHECK_STATUSES, ShopCall, StockCheck } from './explore.model.js';
import { findLocality, popularLocalities, resolvePlace, searchLocalities } from './explore.service.js';

const router = Router();

export const DEFAULT_RADIUS_KM = 5;
const RADIUS_STEPS = [2, 5, 10, 20];
const CLOSING_SOON_MIN = 60;
const MAX_CANDIDATES = 500;
const DESCRIPTION_MAX = 160;

export const placeQuery = {
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  // A locality from GET /explore/localities, when the user has not shared their location.
  locality: z.string().trim().max(80).optional(),
  city: z.string().trim().max(80).optional(),
};

const directionsUrl = (location) => location?.coordinates && `https://www.google.com/maps/dir/?api=1&destination=${location.coordinates[1]},${location.coordinates[0]}`;

// What the shop has earned: a licensed pharmacy, an approved Nurvia seller, or a KYC-checked local shop.
function shopBadge(vendor) {
  if (vendor.store.type === 'pharmacy' && vendor.kyc?.licenseCheck?.status === 'verified') return 'licensed_dispensary';
  if (vendor.seller?.status === 'approved') return 'nurvia_partner';
  return 'verified_local';
}

function shopHours(vendor, now) {
  if (isBlocked(vendor, now, addMinutes(now, 1))) return { open: false, closingSoon: false, temporarilyClosed: true };
  const state = openingState(vendor, now);
  if (!state.open) return { ...state, closingSoon: false };
  const minutesLeft = toMinutes(state.closesAt) - localParts(now).minutes;
  return { ...state, closingSoon: minutesLeft <= CLOSING_SOON_MIN };
}

// The card's one line: the shop's own note, else the start of its profile description.
function shopDescription(vendor) {
  if (vendor.store.note) return vendor.store.note;
  const text = vendor.description?.trim().replace(/\s+/g, ' ');
  if (!text) return null;
  return text.length <= DESCRIPTION_MAX ? text : `${text.slice(0, DESCRIPTION_MAX).replace(/\s+\S*$/, '')}…`;
}

function shopCard(vendor, now) {
  return {
    _id: vendor._id,
    businessName: vendor.businessName,
    type: vendor.store.type,
    description: shopDescription(vendor),
    badge: shopBadge(vendor),
    address: vendor.address,
    locality: vendor.store.locality ?? null,
    distanceKm: vendor.distanceM !== undefined ? Math.round(vendor.distanceM / 100) / 10 : null,
    ratingAvg: vendor.ratingAvg ?? 0,
    ratingCount: vendor.ratingCount ?? 0,
    photo: vendor.photos?.[0]?.url ?? null,
    tags: vendor.store.tags ?? [],
    inStorePickup: Boolean(vendor.store.inStorePickup),
    coldChain: Boolean(vendor.store.coldChain),
    vetTechOnSite: Boolean(vendor.store.vetTechOnSite),
    stockVerifiedAt: vendor.store.stockVerifiedAt ?? null,
    hours: shopHours(vendor, now),
    location: vendor.location?.coordinates ? { lat: vendor.location.coordinates[1], lng: vendor.location.coordinates[0] } : null,
    directionsUrl: directionsUrl(vendor.location),
    actions: { call: Boolean(vendor.phone), directions: Boolean(vendor.location), checkStock: vendor.store.type === 'pharmacy' },
  };
}

export const placeOut = (place) => ({ source: place.source, lat: place.lat ?? null, lng: place.lng ?? null, city: place.city, locality: place.locality });

// Directory shops around a place as cards: within `radiusKm` of its location, or in its city when
// there is no location. Nearest first; by rating with no location or when `sort` is `rating`.
// Also used for the Local Stores row on the home screen.
export async function findShops(place, { radiusKm = DEFAULT_RADIUS_KM, filter = {}, sort = 'nearest' } = {}) {
  const near = place.lat !== undefined;
  const query = { status: 'active', 'store.type': { $in: STORE_TYPES }, ...filter };
  if (!near && place.city) query['address.city'] = { $regex: `^${escapeRegex(place.city)}$`, $options: 'i' };

  const candidates = await Vendor.aggregate([
    near
      ? { $geoNear: { near: { type: 'Point', coordinates: [place.lng, place.lat] }, distanceField: 'distanceM', maxDistance: radiusKm * 1000, query, spherical: true } }
      : { $match: query },
    { $limit: MAX_CANDIDATES },
    { $project: { businessName: 1, description: 1, phone: 1, address: 1, location: 1, store: 1, operatingHours: 1, timeOff: 1, pause: 1, ratingAvg: 1, ratingCount: 1, photos: { $slice: ['$photos', 1] }, 'kyc.licenseCheck.status': 1, 'seller.status': 1, distanceM: 1 } },
  ]);
  const now = new Date();
  const cards = candidates.map((v) => shopCard(v, now));
  return cards.sort(sort === 'rating' || !near ? (a, b) => b.ratingAvg - a.ratingAvg || b.ratingCount - a.ratingCount : (a, b) => a.distanceKm - b.distanceKm);
}

// ---- Local pet shops ----

router.get(
  '/shops',
  apiDoc({
    summary: 'Local pet shops, pharmacies and boutiques around the user',
    description: [
      'Location: `lat`/`lng` from the phone, else a `locality` from `popularLocalities` or `GET /explore/localities`, else the location saved on the account. With none of them, shops in `city`, best rated first, and `radiusKm` is `null`.',
      '`description`: the card\'s one line, written by the shop (`PUT /vendors/me/store` → `note`), else the start of its profile description; `null` when it has neither.',
      'Phone numbers are not listed: "Call store" asks `POST /explore/shops/{id}/call` for the number to dial, when `actions.call` is true.',
    ].join('\n\n'),
  }),
  optionalAuth,
  validate({
    query: {
      ...placeQuery,
      ...pageQuery,
      radiusKm: z.coerce.number().positive().max(50).default(DEFAULT_RADIUS_KM),
      type: z.enum(STORE_TYPES).optional(),
      q: z.string().trim().max(80).optional(),
      openNow: z.enum(['true']).optional(),
      minRating: z.coerce.number().min(0).max(5).optional(),
      sort: z.enum(['nearest', 'rating']).default('nearest'),
    },
  }),
  async (req, res) => {
    const { radiusKm, type, q, openNow, minRating, sort, page, limit } = req.valid.query;
    const place = await resolvePlace(req.valid.query, req.user?._id);
    const near = place.lat !== undefined;
    const pattern = q && { $regex: escapeRegex(q), $options: 'i' };
    const filter = {
      ...(type && { 'store.type': type }),
      ...(pattern && { $or: [{ businessName: pattern }, { 'store.tags': pattern }, { 'store.locality': pattern }] }),
      ...(minRating !== undefined && { ratingAvg: { $gte: minRating } }),
    };
    let cards = await findShops(place, { radiusKm, filter, sort });
    if (openNow) cards = cards.filter((c) => c.hours.open);

    const { cities } = await getPlatform();
    const nextRadius = RADIUS_STEPS.find((r) => r > radiusKm);
    res.json({
      location: placeOut(place),
      // Shown with "Location access disabled": pick a neighbourhood instead.
      popularLocalities: place.source === 'gps' ? [] : popularLocalities(cities, place.city),
      radiusKm: near ? radiusKm : null,
      items: cards.slice((page - 1) * limit, page * limit),
      page,
      limit,
      total: cards.length,
      pages: Math.ceil(cards.length / limit),
      suggestExpand: near && cards.length < 3 && nextRadius ? { radiusKm: nextRadius } : null,
      // Phase 1 is a directory: ordering in the app arrives with the marketplace.
      marketplace: await moduleAvailability('marketplace', near ? { lat: place.lat, lng: place.lng } : { city: place.city }),
    });
  },
);

async function directoryShop(id) {
  const vendor = await Vendor.findOne({ _id: id, status: 'active', 'store.type': { $in: STORE_TYPES } }).select('businessName phone owner store').lean();
  if (!vendor) throw notFound('Shop');
  return vendor;
}

// "Call store (relay)": the number to dial. Masked once a call-relay provider is set up.
router.post(
  '/shops/:id/call',
  apiDoc({
    summary: 'Call store: the number to dial',
    description:
      'Open `tel:<dial>` on the phone. `masked: false` means `dial` is the shop\'s own number; once a call-relay provider is set up it is a temporary relay number and `masked` is `true`. Each call is recorded for the shop.',
    responses: {
      200: { description: 'The number to dial', example: { masked: false, dial: '+919300000101' } },
      409: { description: 'The shop has no phone number (`actions.call` is false on its card)', example: { error: { code: 'CONFLICT', message: 'This shop has not added a phone number' } } },
    },
  }),
  authenticate,
  validate(),
  async (req, res) => {
    const shop = await directoryShop(req.valid.params.id);
    if (!shop.phone) throw conflict('This shop has not added a phone number');
    const call = await startCall({ shopPhone: shop.phone });
    await ShopCall.create({ user: req.user._id, vendor: shop._id, masked: call.masked });
    res.json(call);
  },
);

// ---- Pharmacy stock checks ----

const MAX_OPEN_CHECKS = 5;

router.post(
  '/shops/:id/stock-checks',
  authenticate,
  validate({ body: { items: z.string().trim().min(2).max(500), petId: objectId.optional() } }),
  async (req, res) => {
    const shop = await directoryShop(req.valid.params.id);
    if (shop.store.type !== 'pharmacy') throw badRequest('Stock checks are for pharmacies');
    if (String(shop.owner) === String(req.user._id)) throw badRequest('You cannot ask your own shop');
    if ((await StockCheck.countDocuments({ user: req.user._id, vendor: shop._id, status: 'pending' })) >= MAX_OPEN_CHECKS) {
      throw conflict('Wait for this pharmacy to answer your earlier questions');
    }
    const { items, petId } = req.valid.body;
    const pet = petId ? await Pet.findOne({ _id: petId, owner: req.user._id, archivedAt: null }).select('name species').lean() : null;
    if (petId && !pet) throw notFound('Pet');
    const check = await StockCheck.create({ user: req.user._id, vendor: shop._id, pet: pet?._id, items });
    await notify([shop.owner], {
      type: 'stock_check.requested',
      title: 'Stock check from a customer',
      body: `${items}${pet ? ` · for a ${pet.species}` : ''}`,
      data: { stockCheckId: String(check._id) },
    });
    res.status(201).json(check);
  },
);

router.get('/stock-checks', authenticate, validate({ query: pageQuery }), async (req, res) => {
  const { page, limit } = req.valid.query;
  res.json(await paginate(StockCheck, { user: req.user._id }, { page, limit, populate: [{ path: 'vendor', select: 'businessName address store.locality' }, { path: 'pet', select: 'name' }] }));
});

// ---- Marketplace preview ----

// What in-app shopping will add; shown while the marketplace is not live in the user's area.
const UPCOMING = [
  { key: 'multi_store_cart', title: 'In-app cart & multi-store checkout', description: 'One order across several neighbourhood stores, pharmacies and clinics.' },
  { key: 'same_day_delivery', title: 'Same-day doorstep delivery', description: 'Local courier dispatch with live tracking to your door.' },
  { key: 'cold_chain', title: 'Cold-chain prescription diets', description: 'Temperature-controlled handling for prescription food and medicines.' },
  { key: 'pet_wallet', title: 'Integrated pet wallet & doorstep UPI', description: 'Instant refunds, auto-refill subscriptions and UPI on delivery.' },
];

router.get('/marketplace', optionalAuth, validate({ query: placeQuery }), async (req, res) => {
  const place = await resolvePlace(req.valid.query, req.user?._id);
  const near = place.lat !== undefined;
  const availability = await moduleAvailability('marketplace', near ? { lat: place.lat, lng: place.lng } : { city: place.city });
  const nearbyShops = near
    ? await Vendor.countDocuments({ status: 'active', 'store.type': { $in: STORE_TYPES }, location: { $geoWithin: { $centerSphere: [[place.lng, place.lat], DEFAULT_RADIUS_KM / 6378.1] } } })
    : null;
  const mine = req.user && (await MarketplaceWaitlist.findOne({ user: req.user._id }).select('locality city notifiedAt').lean());
  res.json({
    availability,
    live: availability.state === 'active',
    location: placeOut(place),
    nearbyShops,
    upcoming: availability.state === 'active' ? [] : UPCOMING,
    waitlist: mine ? { joined: true, locality: mine.locality, city: mine.city ?? null } : { joined: false },
  });
});

// "Notify me": one entry per person; joining again moves it to the new locality.
router.put(
  '/marketplace/waitlist',
  authenticate,
  validate({ body: { locality: z.string().trim().min(2).max(80), city: z.string().trim().max(80).optional(), lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional() } }),
  async (req, res) => {
    const { locality, city: cityName, lat, lng } = req.valid.body;
    const { cities } = await getPlatform();
    const known = findLocality(cities, locality, cityName);
    const point = known ? known.locality.center : lat !== undefined && lng !== undefined ? { type: 'Point', coordinates: [lng, lat] } : undefined;
    const city = known?.city ?? matchCity(cities, { city: cityName, ...(point && { lat: point.coordinates[1], lng: point.coordinates[0] }) });
    const entry = await MarketplaceWaitlist.findOneAndUpdate(
      { user: req.user._id },
      { locality: known?.locality.name ?? locality, city: city?.name ?? cityName, citySlug: city?.slug, location: point, $unset: { notifiedAt: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    const availability = await moduleAvailability('marketplace', point ? { lat: point.coordinates[1], lng: point.coordinates[0] } : { city: entry.city });
    res.json({ joined: true, locality: entry.locality, city: entry.city ?? null, live: availability.state === 'active' });
  },
);

router.delete('/marketplace/waitlist', authenticate, async (req, res) => {
  await MarketplaceWaitlist.deleteOne({ user: req.user._id });
  res.status(204).end();
});

// Demand per locality, for deciding where to launch next.
router.get('/marketplace/waitlist/summary', authenticate, requirePermission(PERMISSIONS.PLATFORM_CONFIGURE), async (req, res) => {
  const rows = await MarketplaceWaitlist.aggregate([
    { $match: { notifiedAt: null } },
    { $group: { _id: { city: '$city', locality: '$locality' }, waiting: { $sum: 1 } } },
    { $sort: { waiting: -1 } },
    { $limit: 200 },
  ]);
  res.json({ items: rows.map((r) => ({ city: r._id.city ?? null, locality: r._id.locality, waiting: r.waiting })) });
});

// ---- Locality picker ----

router.get('/localities', validate({ query: { city: z.string().trim().max(80).optional(), q: z.string().trim().max(80).optional() } }), async (req, res) => {
  const { cities } = await getPlatform();
  const { q, city } = req.valid.query;
  const slug = city && cities.find((c) => [c.slug, c.name.toLowerCase()].includes(city.toLowerCase()))?.slug;
  res.json({ items: searchLocalities(cities, { q, citySlug: slug ?? city }).slice(0, 50) });
});

// ---- The Explore tab's landing: what is around the user ----

router.get('/', optionalAuth, validate({ query: placeQuery }), async (req, res) => {
  const place = await resolvePlace(req.valid.query, req.user?._id);
  const near = place.lat !== undefined;
  const within = (km) => near && { $geoWithin: { $centerSphere: [[place.lng, place.lat], km / 6378.1] } };
  const [shops, dogs, adoptions, marketplace] = await Promise.all([
    Vendor.countDocuments({ status: 'active', 'store.type': { $in: STORE_TYPES }, ...(near && { location: within(DEFAULT_RADIUS_KM) }) }),
    CommunityDog.countDocuments({ status: 'visible', draft: { $ne: true }, ...(near && { location: within(DEFAULT_RADIUS_KM) }) }),
    AdoptionListing.countDocuments({ status: 'open', ...(near ? { location: within(25) } : place.city && { city: { $regex: `^${escapeRegex(place.city)}$`, $options: 'i' } }) }),
    moduleAvailability('marketplace', near ? { lat: place.lat, lng: place.lng } : { city: place.city }),
  ]);
  res.json({ location: placeOut(place), nearby: { shops, communityDogs: dogs, adoptions }, marketplace });
});

// ---- Partner app: answering stock checks (mounted at /vendors/me) ----

export const vendorStockChecksRouter = Router();
vendorStockChecksRouter.use('/stock-checks', ...vendorWorkspace, requireCapability('bookings.manage'));

vendorStockChecksRouter.get('/stock-checks', validate({ query: { ...pageQuery, status: z.enum(STOCK_CHECK_STATUSES).optional() } }), async (req, res) => {
  const { page, limit, status } = req.valid.query;
  res.json(await paginate(StockCheck, { vendor: req.vendor._id, ...(status && { status }) }, { page, limit, populate: [{ path: 'user', select: 'name' }, { path: 'pet', select: 'name species breed' }] }));
});

vendorStockChecksRouter.post(
  '/stock-checks/:id/reply',
  validate({ body: { status: z.enum(STOCK_CHECK_STATUSES.filter((s) => s !== 'pending')), reply: z.string().trim().max(500).optional(), holdHours: z.number().int().min(1).max(72).optional() } }),
  async (req, res) => {
    const check = await StockCheck.findOne({ _id: req.valid.params.id, vendor: req.vendor._id });
    if (!check) throw notFound('Stock check');
    const { status, reply, holdHours } = req.valid.body;
    if (holdHours && status === 'unavailable') throw badRequest('Nothing to keep aside when it is unavailable');
    check.set({ status, reply, holdUntil: holdHours ? addMinutes(new Date(), holdHours * 60) : undefined, repliedAt: new Date(), repliedBy: req.user._id });
    await check.save();
    const answer = { available: 'In stock', partial: 'Partly in stock', unavailable: 'Not in stock' }[status];
    await notify([check.user], {
      type: 'stock_check.replied',
      title: `${req.vendor.businessName}: ${answer}`,
      body: [check.items, reply].filter(Boolean).join(' · '),
      data: { stockCheckId: String(check._id), vendorId: String(req.vendor._id) },
    });
    res.json(check);
  },
);

export default router;
