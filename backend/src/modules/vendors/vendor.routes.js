import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { authenticate, optionalAuth, requireRoles } from '../../common/auth.js';
import { badRequest, conflict, notFound } from '../../common/errors.js';
import { PERMISSIONS, ROLES } from '../../common/roles.js';
import { escapeRegex, geoQuery, objectId, pageQuery, partialShape, point, validate } from '../../common/validate.js';
import { BOOKABLE_ROLES } from '../bookings/booking.service.js';
import { staffProfiles } from '../bookings/booking.views.js';
import { Category } from '../categories/category.model.js';
import { apiDoc } from '../../docs/api-doc.js';
import { attachmentsFor } from '../files/file.routes.js';
import { notify } from '../notifications/notify.js';
import { VendorStaff } from '../operations/operations.model.js';
import { User } from '../users/user.model.js';
import { assertModuleAt, getPlatform, liveCityNames, moduleAvailability } from '../platform/platform.service.js';
import { addMinutes, localParts, toMinutes } from '../../common/time.js';
import { availableSlots, isBlocked, vendorPlace } from './availability.js';
import { KYC_DOCUMENT_TYPES, STORE_TYPES, SearchLog, Service, Vendor, licenseStatus } from './vendor.model.js';

const router = Router();

const DEFAULT_RADIUS_KM = 5;
const RADIUS_STEPS = [5, 10, 15];
const ALL_NEARBY_KM = 50;
const FEW_RESULTS = 5;
const MAX_CANDIDATES = 500;

// Time-off reasons and pause notes are for the vendor; customers only see the free slots.
const PUBLIC_FIELDS = '-kyc -seller -subscription -statusReason -owner -timeOff -pause.reason';
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');

const vendorBody = {
  businessName: z.string().trim().min(2).max(120),
  categoryIds: z.array(objectId).min(1).max(5),
  description: z.string().max(2000).optional(),
  phone: z.string().max(20).optional(),
  email: z.string().email().optional(),
  address: z.object({
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(80),
    state: z.string().trim().max(80).optional(),
    pincode: z.string().regex(/^\d{6}$/).optional(),
  }),
  location: point,
  operatingHours: z
    .array(z.object({ day: z.number().int().min(0).max(6), open: hhmm, close: hhmm }).refine((w) => w.open < w.close, 'open must be before close'))
    .max(21)
    .optional(),
  slotCapacity: z.number().int().min(1).max(50).optional(),
  homeVisits: z.boolean().optional(),
  arrivalInstructions: z.string().trim().max(300).optional(),
  photoFileIds: z.array(objectId).max(10).optional(),
};

async function vendorFields(userId, { categoryIds, photoFileIds, ...body }) {
  const fields = { ...body };
  if (categoryIds) {
    const count = await Category.countDocuments({ _id: { $in: categoryIds }, kind: 'vendor', active: true });
    if (count !== new Set(categoryIds).size) throw badRequest('Unknown vendor category');
    fields.categories = categoryIds;
  }
  if (photoFileIds) fields.photos = await attachmentsFor(userId, photoFileIds, ['vendor_photo']);
  return fields;
}

async function myVendor(req) {
  const vendor = await Vendor.findOne({ owner: req.user._id });
  if (!vendor) throw notFound('Vendor profile');
  return vendor;
}

// ---- Vendor self-service (Vendor app) ----

router.post(
  '/',
  apiDoc({
    summary: 'Apply as a partner: create my vendor profile',
    description: [
      'Starts a partner application for the signed-in user; staff approve it (`status` starts as `pending`). One profile per account (409 when one exists).',
      '`categoryIds`: 1–5 ids from `GET /categories?kind=vendor`. `location` is the shop\'s pin (from the phone or a map picker); it places the shop in Explore and in nearby search. `operatingHours` uses weekday 0 = Sunday, 24-hour HH:MM.',
      'After approval, `PUT /vendors/me/store` lists the shop in Explore → Local Pet Shops.',
    ].join('\n\n'),
    requestExample: {
      businessName: 'Navlakha Pet Mart',
      categoryIds: ['6ad889a9e6cbea1891b82400'],
      phone: '+919300000101',
      address: { line1: '12 Main Road, Navlakha', city: 'Indore', state: 'Madhya Pradesh', pincode: '452001' },
      location: { lat: 22.6995, lng: 75.8829 },
      operatingHours: [{ day: 1, open: '09:00', close: '21:00' }],
    },
  }),
  authenticate,
  validate({ body: vendorBody }),
  async (req, res) => {
    if (await Vendor.exists({ owner: req.user._id })) throw conflict('You already have a vendor profile');
    const vendor = await Vendor.create({ ...(await vendorFields(req.user._id, req.valid.body)), owner: req.user._id });
    await User.updateOne({ _id: req.user._id }, { $addToSet: { roles: ROLES.VENDOR } });
    res.status(201).json(vendor);
  },
);

router.get('/me', authenticate, requireRoles(ROLES.VENDOR), async (req, res) => {
  const vendor = await (await myVendor(req)).populate('categories', 'name slug');
  res.json({ ...vendor.toJSON(), licenseStatus: licenseStatus(vendor.kyc) });
});

router.patch('/me', authenticate, requireRoles(ROLES.VENDOR), validate({ body: partialShape(vendorBody) }), async (req, res) => {
  const vendor = await myVendor(req);
  vendor.set(await vendorFields(req.user._id, req.valid.body));
  res.json(await vendor.save());
});

// The shop listing in Explore → Local Pet Shops. `type: null` takes the shop out of the directory.
router.put(
  '/me/store',
  authenticate,
  requireRoles(ROLES.VENDOR),
  validate({
    body: {
      type: z.enum(STORE_TYPES).nullable(),
      locality: z.string().trim().max(80).optional(),
      note: z.string().trim().max(160).optional(),
      tags: z.array(z.string().trim().min(2).max(40)).max(8).optional(),
      inStorePickup: z.boolean().optional(),
      coldChain: z.boolean().optional(),
      vetTechOnSite: z.boolean().optional(),
    },
  }),
  async (req, res) => {
    const vendor = await myVendor(req);
    const { type, ...rest } = req.valid.body;
    vendor.set('store', { ...rest, type: type ?? undefined, stockVerifiedAt: vendor.store?.stockVerifiedAt });
    await vendor.save();
    res.json(vendor.store);
  },
);

// "Stock verified": the shop has just checked its shelves; customers see how long ago.
router.post('/me/store/stock-verified', authenticate, requireRoles(ROLES.VENDOR), async (req, res) => {
  const vendor = await myVendor(req);
  if (!vendor.store?.type) throw conflict('Set up your shop listing first (PUT /vendors/me/store)');
  vendor.set('store.stockVerifiedAt', new Date());
  await vendor.save();
  res.json({ stockVerifiedAt: vendor.store.stockVerifiedAt });
});

router.post(
  '/me/kyc',
  authenticate,
  requireRoles(ROLES.VENDOR),
  validate({
    body: {
      gstin: z.string().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/, 'Invalid GSTIN').optional(),
      pan: z.string().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'Invalid PAN').optional(),
      documents: z.array(z.object({ type: z.enum(KYC_DOCUMENT_TYPES), fileId: objectId })).min(1).max(10),
    },
  }),
  async (req, res) => {
    const vendor = await myVendor(req);
    if (vendor.kyc.status === 'approved') throw conflict('KYC is already approved');
    const { documents, gstin, pan } = req.valid.body;
    const files = await attachmentsFor(req.user._id, documents.map((d) => d.fileId), ['vendor_kyc']);
    // attachmentsFor returns files in storage order, so match each document to its file by id.
    const fileById = new Map(files.map((f) => [String(f.file), f]));
    const resubmitted = ['submitted', 'rejected'].includes(vendor.kyc.status);
    vendor.kyc = {
      status: 'submitted',
      gstin,
      pan,
      documents: documents.map((d) => ({ type: d.type, file: fileById.get(d.fileId).file, name: fileById.get(d.fileId).name })),
      submittedAt: new Date(),
    };
    if (vendor.status === 'rejected') vendor.status = 'pending';
    await vendor.save();

    // Tell everyone who can approve vendors that an application is waiting, and confirm to the vendor.
    const reviewers = await User.find({
      status: 'active',
      $or: [{ roles: { $in: [ROLES.ADMIN, ROLES.SUPER_ADMIN] } }, { permissions: PERMISSIONS.VENDORS_REVIEW }],
    })
      .select('_id')
      .lean();
    await notify(
      reviewers.map((r) => r._id),
      {
        type: 'vendor.kyc_submitted',
        title: `${resubmitted ? 'Updated' : 'New'} vendor application: ${vendor.businessName}`,
        body: `${vendor.address.city} · ${documents.length} document${documents.length === 1 ? '' : 's'}. Decide within 24 hours.`,
        data: { vendorId: String(vendor._id) },
      },
    );
    await notify([vendor.owner], {
      type: 'vendor.kyc_received',
      title: 'We have your documents',
      body: 'The Nurvia team reviews new partners within 24 hours. We will notify you as soon as there is a decision.',
      data: { vendorId: String(vendor._id) },
    });
    res.json(vendor);
  },
);

const serviceBody = {
  name: z.string().trim().min(1).max(120),
  categoryId: objectId.optional(),
  description: z.string().max(1000).optional(),
  pricePaise: z.number().int().min(0).max(10_000_000),
  durationMin: z.number().int().min(5).max(24 * 60),
  species: z.array(z.string().max(20)).max(10).optional(),
  mode: z.enum(['at_store', 'home_visit']).optional(),
  // The full list; send an add-on's _id to keep it (and bookings that name it) when editing.
  addOns: z
    .array(
      z.object({
        _id: objectId.optional(),
        name: z.string().trim().min(1).max(120),
        description: z.string().max(300).optional(),
        pricePaise: z.number().int().min(0).max(10_000_000),
        durationMin: z.number().int().min(0).max(240).optional(),
        active: z.boolean().optional(),
      }),
    )
    .max(20)
    .optional(),
  active: z.boolean().optional(),
};

async function serviceFields({ categoryId, ...body }) {
  if (categoryId && !(await Category.exists({ _id: categoryId, kind: 'service' }))) throw badRequest('Unknown service category');
  return { ...body, ...(categoryId && { category: categoryId }) };
}

router.get('/me/services', authenticate, requireRoles(ROLES.VENDOR), async (req, res) => {
  const vendor = await myVendor(req);
  res.json(await Service.find({ vendor: vendor._id }).sort({ createdAt: 1 }).lean());
});

router.post('/me/services', authenticate, requireRoles(ROLES.VENDOR), validate({ body: serviceBody }), async (req, res) => {
  const vendor = await myVendor(req);
  res.status(201).json(await Service.create({ ...(await serviceFields(req.valid.body)), vendor: vendor._id }));
});

router.patch(
  '/me/services/:serviceId',
  authenticate,
  requireRoles(ROLES.VENDOR),
  validate({ params: { serviceId: objectId }, body: partialShape(serviceBody) }),
  async (req, res) => {
    const vendor = await myVendor(req);
    const service = await Service.findOne({ _id: req.valid.params.serviceId, vendor: vendor._id });
    if (!service) throw notFound('Service');
    service.set(await serviceFields(req.valid.body));
    res.json(await service.save());
  },
);

// Services are deactivated rather than deleted because past bookings reference them.
router.delete('/me/services/:serviceId', authenticate, requireRoles(ROLES.VENDOR), validate({ params: { serviceId: objectId } }), async (req, res) => {
  const vendor = await myVendor(req);
  const result = await Service.updateOne({ _id: req.valid.params.serviceId, vendor: vendor._id }, { active: false });
  if (!result.matchedCount) throw notFound('Service');
  res.status(204).end();
});

// ---- Public discovery (Pet Parent app) ----

router.get(
  '/',
  optionalAuth,
  validate({
    query: {
      ...geoQuery,
      ...pageQuery,
      // Location > Service > Distance: 5 km by default, widened to 10 or 15 km, or "all nearby".
      radiusKm: z.coerce.number().positive().max(100).default(DEFAULT_RADIUS_KM),
      nearby: z.enum(['all']).optional(),
      q: z.string().trim().max(80).optional(),
      category: objectId.optional(),
      city: z.string().trim().max(80).optional(),
      homeVisits: z.enum(['true']).optional(),
      minPrice: z.coerce.number().int().min(0).optional(), // paise, matched against active services
      maxPrice: z.coerce.number().int().min(0).optional(),
      minRating: z.coerce.number().min(0).max(5).optional(),
      openNow: z.enum(['true']).optional(),
      verified: z.enum(['true']).optional(),
      sort: z.enum(['recommended', 'distance', 'rating', 'price_low', 'price_high']).default('recommended'),
    },
  }),
  async (req, res) => {
    const { lat, lng, nearby, page, limit, q, category, city, homeVisits, minPrice, maxPrice, minRating, openNow, verified, sort } = req.valid.query;
    const radiusKm = nearby === 'all' ? ALL_NEARBY_KM : req.valid.query.radiusKm;
    const near = lat !== undefined && lng !== undefined;

    // Booking may be off, or not live in the caller's city yet; say so instead of an empty list.
    const availability = await moduleAvailability('booking', city || near ? { city, lat, lng } : {});
    const placeGiven = Boolean(city || near);
    if (availability.state === 'disabled' || (placeGiven && availability.state !== 'active')) {
      return res.json({ items: [], page, limit, total: 0, pages: 0, availability });
    }
    // Only vendors in cities where booking is live, and only in categories that are switched on.
    const liveCities = await liveCityNames('booking');
    const activeCategories = await Category.find({ kind: 'vendor', active: true }).distinct('_id');
    const wanted = category && activeCategories.find((id) => String(id) === category);
    const filter = {
      status: 'active',
      categories: { $in: category ? (wanted ? [wanted] : []) : activeCategories },
      ...(q && { businessName: { $regex: escapeRegex(q), $options: 'i' } }),
      ...(city && { 'address.city': { $regex: `^${escapeRegex(city)}$`, $options: 'i' } }),
      ...(liveCities && !city && { 'address.city': { $in: liveCities.map((n) => new RegExp(`^${escapeRegex(n)}$`, 'i')) } }),
      ...(homeVisits && { homeVisits: true }),
    };
    // A city alias (e.g. Gurugram for Delhi NCR) should find vendors listed under any name of that city.
    if (city && liveCities && availability.city) {
      const match = (await getPlatform()).cities.find((c) => c.slug === availability.city.slug);
      filter['address.city'] = { $in: [match.name, match.slug, ...(match.aliases ?? [])].map((n) => new RegExp(`^${escapeRegex(n)}$`, 'i')) };
    }
    if (minRating !== undefined) filter.ratingAvg = { $gte: minRating };
    if (verified) filter['kyc.licenseCheck.status'] = 'verified';
    // Candidates are ranked in memory: "bookable now" and price ranges depend on services and
    // time-off, which a single query cannot sort by. A city has hundreds of vendors, not millions.
    const candidates = await Vendor.aggregate([
      near
        ? { $geoNear: { near: { type: 'Point', coordinates: [lng, lat] }, distanceField: 'distanceM', maxDistance: radiusKm * 1000, query: filter, spherical: true } }
        : { $match: filter },
      { $limit: MAX_CANDIDATES },
      { $addFields: { verified: { $eq: ['$kyc.licenseCheck.status', 'verified'] } } },
      { $project: { kyc: 0, seller: 0, subscription: 0, statusReason: 0, owner: 0, 'pause.reason': 0, 'timeOff.reason': 0 } },
    ]);
    const prices = await Service.aggregate([
      { $match: { vendor: { $in: candidates.map((v) => v._id) }, active: true } },
      { $group: { _id: '$vendor', min: { $min: '$pricePaise' }, max: { $max: '$pricePaise' }, count: { $sum: 1 } } },
    ]);
    const priceOf = new Map(prices.map((p) => [String(p._id), p]));
    const now = new Date();
    const { weekday, minutes } = localParts(now);
    let ranked = candidates.map(({ timeOff, ...v }) => {
      const p = priceOf.get(String(v._id));
      const open = v.operatingHours.some((w) => w.day === weekday && minutes >= toMinutes(w.open) && minutes < toMinutes(w.close));
      const paused = isBlocked({ ...v, timeOff }, now, addMinutes(now, 1));
      return {
        ...v,
        openNow: open && !paused,
        bookable: Boolean(p?.count) && !(v.pause?.active && (!v.pause.until || v.pause.until > now)),
        priceRange: p ? { minPaise: p.min, maxPaise: p.max } : null,
        distanceKm: v.distanceM !== undefined ? Math.round(v.distanceM / 100) / 10 : undefined,
      };
    });
    if (openNow) ranked = ranked.filter((v) => v.openNow);
    // A vendor matches a price range when any of its active services falls inside it.
    if (minPrice !== undefined || maxPrice !== undefined) {
      ranked = ranked.filter((v) => v.priceRange && v.priceRange.maxPaise >= (minPrice ?? 0) && v.priceRange.minPaise <= (maxPrice ?? Infinity));
    }
    const by = {
      // Available/bookable > distance > rating > verified, as the discovery flow specifies.
      recommended: (a, b) => b.bookable - a.bookable || (a.distanceM ?? 0) - (b.distanceM ?? 0) || b.ratingAvg - a.ratingAvg || b.verified - a.verified,
      distance: (a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0),
      rating: (a, b) => b.ratingAvg - a.ratingAvg || b.ratingCount - a.ratingCount,
      price_low: (a, b) => (a.priceRange?.minPaise ?? Infinity) - (b.priceRange?.minPaise ?? Infinity),
      price_high: (a, b) => (b.priceRange?.maxPaise ?? -1) - (a.priceRange?.maxPaise ?? -1),
    }[sort];
    ranked.sort((a, b) => by(a, b) || String(a._id).localeCompare(String(b._id)));

    const count = ranked.length;
    const items = ranked.slice((page - 1) * limit, page * limit);
    const categoryDocs = await Category.find({ _id: { $in: items.flatMap((v) => v.categories) } }).select('name slug').lean();
    const categoryById = new Map(categoryDocs.map((c) => [String(c._id), c]));
    for (const item of items) item.categories = item.categories.map((id) => categoryById.get(String(id))).filter(Boolean);

    // Few results close by: suggest the next radius up (5 → 10 → 15 → all nearby).
    const nextRadius = RADIUS_STEPS.find((r) => r > radiusKm);
    const suggestExpand = near && nearby !== 'all' && count < FEW_RESULTS ? (nextRadius ? { radiusKm: nextRadius } : { nearby: 'all' }) : null;

    SearchLog.create({ user: req.user?._id, q, category, city, hasLocation: near, resultCount: count }).catch((err) =>
      console.error('[search-log]', err),
    );
    res.json({ items, page, limit, total: count, pages: Math.ceil(count / limit), radiusKm: near ? radiusKm : undefined, suggestExpand, availability });
  },
);

async function activeVendor(id) {
  const vendor = await Vendor.findOne({ _id: id, status: 'active' }).select(PUBLIC_FIELDS).populate('categories', 'name slug');
  if (!vendor) throw notFound('Vendor');
  return vendor;
}

router.get('/:id', validate(), async (req, res) => {
  const vendor = await activeVendor(req.valid.params.id);
  const services = await Service.find({ vendor: vendor._id, active: true }).lean();
  // Lets the app show "Booking coming soon in <city>" on the profile instead of a dead button.
  const booking = await moduleAvailability('booking', vendorPlace(vendor));
  res.json({ ...vendor.toJSON(), services, booking });
});

router.get(
  '/:id/availability',
  validate({
    query: {
      serviceId: objectId,
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
      // Comma-separated add-on ids: they lengthen the visit, so fewer start times fit.
      addOnIds: z
        .string()
        .transform((s) => s.split(',').filter(Boolean))
        .pipe(z.array(objectId).max(20))
        .optional(),
      // Only times this person is free.
      staffId: objectId.optional(),
    },
  }),
  async (req, res) => {
    const { serviceId, date, addOnIds = [], staffId } = req.valid.query;
    const vendor = await Vendor.findOne({ _id: req.valid.params.id, status: 'active' }).lean();
    if (!vendor) throw notFound('Vendor');
    await assertModuleAt('booking', vendorPlace(vendor));
    const service = await Service.findOne({ _id: serviceId, vendor: vendor._id, active: true }).lean();
    if (!service) throw notFound('Service');
    const addOns = addOnIds.map((id) => service.addOns?.find((a) => String(a._id) === id && a.active !== false));
    if (addOns.some((a) => !a)) throw badRequest('Choose add-ons offered with this service');
    if (staffId && !(await VendorStaff.exists({ _id: staffId, vendor: vendor._id, active: true, bookable: { $ne: false }, role: { $in: BOOKABLE_ROLES } }))) {
      throw badRequest('That person cannot be booked here');
    }
    const durationMin = service.durationMin + addOns.reduce((sum, a) => sum + (a.durationMin ?? 0), 0);
    res.json({ date, durationMin, slots: await availableSlots(vendor, date, durationMin, { staffId }) });
  },
);

// The people a customer can choose on the booking screens ("any available" is the default).
router.get('/:id/staff', validate(), async (req, res) => {
  const vendor = await activeVendor(req.valid.params.id);
  const staff = await VendorStaff.find({ vendor: vendor._id, active: true, bookable: { $ne: false }, role: { $in: BOOKABLE_ROLES } })
    .sort({ name: 1 })
    .select('name role title experienceYears')
    .lean();
  res.json({ items: await staffProfiles(vendor._id, staff) });
});

export default router;
