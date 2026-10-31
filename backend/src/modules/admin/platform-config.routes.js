import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../common/auth.js';
import { notFound } from '../../common/errors.js';
import { PERMISSIONS } from '../../common/roles.js';
import { partialShape, point, validate } from '../../common/validate.js';
import { audit } from '../audit/audit.model.js';
import { Category } from '../categories/category.model.js';
import { MODULE_STATES, City, PlatformConfig } from '../platform/platform.model.js';
import { notifyMarketplaceWaitlist } from '../explore/explore.service.js';
import { CITY_MODULES, FEATURES, cityModuleState, clearPlatformCache, getPlatform } from '../platform/platform.service.js';
import { Vendor } from '../vendors/vendor.model.js';

const router = Router();
const read = requirePermission(PERMISSIONS.ANALYTICS_READ);
const configure = requirePermission(PERMISSIONS.PLATFORM_CONFIGURE);

// Everything the "Cities & features" screen shows in one call.
router.get('/platform', read, async (_req, res) => {
  clearPlatformCache();
  const { features, cities } = await getPlatform();
  const [categories, vendorsByCity] = await Promise.all([
    Category.find({ kind: 'vendor' }).sort({ sortOrder: 1, name: 1 }).select('name slug active').lean(),
    Vendor.aggregate([{ $match: { status: 'active' } }, { $group: { _id: { $toLower: '$address.city' }, count: { $sum: 1 } } }]),
  ]);
  const supply = new Map(vendorsByCity.map((r) => [r._id, r.count]));
  res.json({
    features: Object.entries(FEATURES).map(([key, f]) => ({ key, label: f.label, phase: f.phase, cityScoped: Boolean(f.cityScoped), notBuilt: Boolean(f.notBuilt), enabled: features[key] })),
    cityModules: CITY_MODULES,
    cities: cities.map((c) => ({
      ...c,
      // Live vendors whose address is in this city, so staff can see whether booking has supply.
      liveVendors: [...new Set([c.name, c.slug, ...(c.aliases ?? [])].map((n) => n.toLowerCase()))].reduce((n, name) => n + (supply.get(name) ?? 0), 0),
    })),
    vendorCategories: categories,
  });
});

router.patch(
  '/platform/features',
  configure,
  validate({ body: Object.fromEntries(Object.keys(FEATURES).map((k) => [k, z.boolean().optional()])) }),
  async (req, res) => {
    const changes = Object.fromEntries(Object.entries(req.valid.body).filter(([, v]) => v !== undefined));
    const config = (await PlatformConfig.findOne({ key: 'platform' })) ?? new PlatformConfig({ key: 'platform' });
    config.features = { ...config.features, ...changes };
    config.markModified('features');
    await config.save();
    clearPlatformCache();
    await audit(req, 'platform.features', { type: 'platform_config', id: config._id }, { meta: changes });
    res.json((await getPlatform()).features);
  },
);

const state = z.enum(MODULE_STATES);
const cityBody = {
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,40}$/, 'Use lowercase letters, digits and hyphens'),
  name: z.string().trim().min(2).max(80),
  region: z.string().trim().max(80).optional(),
  aliases: z.array(z.string().trim().min(2).max(80)).max(30).optional(),
  center: point,
  // The full list of neighbourhoods for the locality picker; popular ones are offered first.
  localities: z.array(z.object({ name: z.string().trim().min(2).max(80), center: point, popular: z.boolean().optional() })).max(300).optional(),
  radiusKm: z.number().min(1).max(200).optional(),
  status: state.optional(),
  modules: z.object(Object.fromEntries(CITY_MODULES.map((m) => [m, state.optional()]))).optional(),
  sortOrder: z.number().int().optional(),
};

router.post('/cities', configure, validate({ body: cityBody }), async (req, res) => {
  const city = await City.create(req.valid.body);
  clearPlatformCache();
  await audit(req, 'city.create', { type: 'city', id: city._id }, { meta: { slug: city.slug, status: city.status } });
  res.status(201).json(city);
});

// Cities are never deleted (addresses keep referring to them); set status to disabled instead.
router.patch('/cities/:id', configure, validate({ body: partialShape(cityBody) }), async (req, res) => {
  const city = await City.findById(req.valid.params.id);
  if (!city) throw notFound('City');
  const { modules, ...rest } = req.valid.body;
  const before = { status: city.status, modules: { ...city.toObject().modules } };
  city.set(rest);
  for (const [m, s] of Object.entries(modules ?? {})) if (s) city.set(`modules.${m}`, s);
  await city.save();
  clearPlatformCache();
  await audit(req, 'city.update', { type: 'city', id: city._id }, { meta: { before, changes: req.valid.body } });
  // Shoppers who asked to hear when the marketplace reaches their city.
  if (city.status === 'active' && cityModuleState(city, 'marketplace') === 'active' && !(before.status === 'active' && (before.modules?.marketplace ?? 'active') === 'active')) {
    await notifyMarketplaceWaitlist(city).catch((err) => console.error('[waitlist]', err));
  }
  res.json(city);
});

export default router;
