// The pet parent app's Home tab in one round trip: offer banners, shop categories, products picked
// for one of the user's pets, and local stores near them. Staff manage the banners under /admin/banners.
import { Router } from 'express';
import { z } from 'zod';
import { optionalAuth } from '../../common/auth.js';
import { badRequest, notFound } from '../../common/errors.js';
import { escapeRegex, objectId, partialShape, validate } from '../../common/validate.js';
import { apiDoc } from '../../docs/api-doc.js';
import { audit } from '../audit/audit.model.js';
import { Category } from '../categories/category.model.js';
import { DEFAULT_RADIUS_KM, findShops, placeOut, placeQuery } from '../explore/explore.routes.js';
import { resolvePlace } from '../explore/explore.service.js';
import { attachmentsFor } from '../files/file.routes.js';
import { ageMonths } from '../pets/care.js';
import { Pet } from '../pets/pet.model.js';
import { getPlatform, matchCity, moduleAvailability } from '../platform/platform.service.js';
import { PET_TYPES, Product } from '../shop/shop.model.js';
import { CARD_FIELDS, SORTS } from '../shop/shop.routes.js';
import { shownProducts } from '../shop/shop.service.js';
import { Banner } from './banner.model.js';

const router = Router();

const MAX_BANNERS = 5;
const RECOMMENDED_LIMIT = 3;
const LOCAL_STORES_LIMIT = 6;

// Pet species to the pet types products are tagged with. "other" has no products.
const PRODUCT_PET_TYPE = { dog: 'dog', cat: 'cat', bird: 'bird', fish: 'fish', small_animal: 'small_pet', rabbit: 'small_pet' };
const SENIOR_FROM_MONTHS = { dog: 84, cat: 132 };
const PET_FIELDS = 'name species breed sex dateOfBirth approxAgeMonths weightKg photo allergies conditions';

function lifeStage(species, months) {
  if (months === null) return null;
  if (months < 12) return 'young';
  return months >= (SENIOR_FROM_MONTHS[species] ?? Infinity) ? 'senior' : 'adult';
}

// The pet the screen is for: the one asked for, or the user's first pet. Signed out or no pets: none.
async function homePet(user, petId) {
  const pet = user && (await Pet.findOne({ owner: user._id, archivedAt: null, ...(petId && { _id: petId }) }).sort({ createdAt: 1 }).select(PET_FIELDS).lean());
  if (petId && !pet) throw notFound('Pet');
  if (!pet) return null;
  const months = ageMonths(pet);
  return {
    _id: pet._id,
    name: pet.name,
    species: pet.species,
    breed: pet.breed ?? null,
    weightKg: pet.weightKg ?? null,
    ageMonths: months,
    lifeStage: lifeStage(pet.species, months),
    photo: pet.photo?.url ?? null,
    allergies: pet.allergies ?? [],
    conditions: pet.conditions ?? [],
  };
}

const live = (now) => [{ $or: [{ startsAt: null }, { startsAt: { $lte: now } }] }, { $or: [{ endsAt: null }, { endsAt: { $gt: now } }] }];
const anyOr = (field, value) => ({ $or: [{ [field]: { $size: 0 } }, ...(value ? [{ [field]: value }] : [])] });
const personalise = (text, pet) => text?.replaceAll('{pet}', pet?.name ?? 'your pet') ?? null;

async function homeBanners({ pet, citySlug }) {
  const banners = await Banner.find({ active: true, $and: [...live(new Date()), anyOr('petTypes', pet && PRODUCT_PET_TYPE[pet.species]), anyOr('citySlugs', citySlug)] })
    .sort({ sortOrder: 1, createdAt: -1 })
    .limit(MAX_BANNERS)
    .lean();
  return banners.map((b) => ({
    _id: b._id,
    eyebrow: personalise(b.eyebrow, pet),
    title: personalise(b.title, pet),
    subtitle: personalise(b.subtitle, pet),
    image: b.image?.url ?? null,
    cta: b.cta?.label && b.cta?.link ? { label: b.cta.label, link: b.cta.link } : null,
    theme: b.theme,
  }));
}

// In-stock products for the pet's species, featured and best-selling first. Puppy and kitten
// products only go to pets under a year, and a product whose name, tags or highlights mention one
// of the pet's allergies is left out (products have no ingredient list to check instead).
// Without a pet: the shop's featured best sellers.
async function recommendedProducts(pet) {
  const filter = await shownProducts({ inStock: true });
  if (pet) {
    if (!PRODUCT_PET_TYPE[pet.species]) return [];
    filter.petTypes = PRODUCT_PET_TYPE[pet.species];
    const avoid = [...pet.allergies, ...(pet.lifeStage && pet.lifeStage !== 'young' ? ['puppy', 'kitten'] : [])].map((w) => w.trim()).filter(Boolean);
    if (avoid.length) {
      const words = new RegExp(`\\b(${avoid.map(escapeRegex).join('|')})\\b`, 'i');
      filter.$nor = [{ name: words }, { tags: words }, { highlights: words }];
    }
  }
  return Product.find(filter).select(CARD_FIELDS).sort({ featured: -1, ...SORTS.popular }).limit(RECOMMENDED_LIMIT).lean();
}

const HOME_EXAMPLE = {
  location: { source: 'gps', lat: 12.9784, lng: 77.6408, city: 'Bengaluru', locality: null },
  pet: { _id: '6ad889a8e6cbea1891b82300', name: 'Bruno', species: 'dog', breed: 'Golden Retriever', weightKg: 31.5, ageMonths: 43, lifeStage: 'adult', photo: null, allergies: ['chicken'], conditions: ['sensitive skin'] },
  marketplace: { state: 'active', city: { slug: 'bengaluru', name: 'Bengaluru' } },
  banners: [
    {
      _id: '6ad889a8e6cbea1891b82400', eyebrow: 'Bruno-friendly selection', title: 'Spring Care & Nutrition Festival', subtitle: 'Up to 30% off vet-approved diets for your dog.', image: null,
      cta: { label: 'Explore Offers', link: 'nurvia://shop/products?category=food&sort=discount' }, theme: { background: '#1f3d33', foreground: '#ffffff', accent: '#d9b46a' },
    },
  ],
  categories: [
    { _id: '6ad889a8e6cbea1891b82500', name: 'Food', slug: 'food', icon: 'food' },
    { _id: '6ad889a8e6cbea1891b82501', name: 'Treats', slug: 'treats', icon: 'treats' },
  ],
  recommended: [
    {
      _id: '6ad889a8e6cbea1891b82600', name: 'Homestyle Curd Rice & Chicken Meal', slug: 'homestyle-curd-rice-chicken-meal', brand: 'Desi Dog Co.', images: [], art: { kind: 'pouch', color: '#15803d', accent: '#fef08a' },
      pricePaise: 49900, mrpPaise: 59400, discountPct: 16, inStock: true, ratingAvg: 4.8, ratingCount: 190, petTypes: ['dog'], category: '6ad889a8e6cbea1891b82500',
      variants: [{ sku: 'DES-5-1', label: 'Pack of 6', mrpPaise: 59400, pricePaise: 49900, stock: 35 }],
    },
  ],
  localStores: {
    items: [
      {
        _id: '6ad889a8e6cbea1891b82700', businessName: 'Paws & Whiskers Essentials', type: 'pet_store', description: 'Fresh food and treats, packed for pickup in 10 minutes', badge: 'nurvia_partner', address: { line1: '8 Defence Colony', city: 'Bengaluru', pincode: '560038' },
        locality: 'Indiranagar', distanceKm: 0.4, ratingAvg: 4.6, ratingCount: 12, photo: null, tags: ['Curated treats & food'], inStorePickup: true, coldChain: false, vetTechOnSite: false, stockVerifiedAt: null,
        hours: { open: true, closesAt: '20:00', closingSoon: false }, location: { lat: 12.9785, lng: 77.641 }, directionsUrl: 'https://www.google.com/maps/dir/?api=1&destination=12.9785,77.641',
        actions: { call: true, directions: true, checkStock: false },
      },
    ],
    total: 1,
    radiusKm: 5,
  },
};

router.get(
  '/content',
  apiDoc({
    summary: 'Home screen: banners, shop categories, products recommended for a pet, local stores',
    description: [
      'Everything the Home tab shows, in one call. Works signed out; signed in, it is personalised for one of the user\'s pets.',
      '`pet`: the pet the screen is for (`petId`, or the user\'s first pet; `null` when signed out or the user has no pets). Use it for the header and "Recommended for {name}". `lifeStage` is `young` (under a year), `adult` or `senior` (from 7 years for dogs, 11 for cats); `null` when the age is not known.',
      '`banners`: live offer banners for the pet\'s type and the user\'s city, in display order, at most 5. "{pet}" in the text is already replaced with the pet\'s name. Open `cta.link` when the button is tapped.',
      '`categories`: top-level shop categories in display order; open `GET /shop/products?category=<slug>`. `icon` is a key the app maps to its own icon.',
      '`recommended`: up to 3 in-stock products for the pet\'s species, featured and best-selling first. Puppy and kitten products are only suggested for pets under a year, and products whose name, tags or highlights mention one of the pet\'s `allergies` are left out. Signed out or no pets: the shop\'s featured best sellers. Product cards are the same as in `GET /shop/products`.',
      'Categories and recommended products are empty while the marketplace is switched off. `marketplace.state` says whether shopping is live where the user is (`active`, `coming_soon`, `disabled`, `unavailable`).',
      '`localStores`: up to 6 pet shops, pharmacies and boutiques within 5 km, nearest first (cards as in `GET /explore/shops`; "View all" opens that with the same location). Location: `lat`/`lng` from the phone, else a `locality` picked by hand, else the location saved on the account. With none of them, shops in `city`, best rated first, and `radiusKm` is `null`.',
    ].join('\n\n'),
    responses: { 200: { description: 'Home screen content', example: HOME_EXAMPLE } },
  }),
  optionalAuth,
  validate({ query: { ...placeQuery, petId: objectId.optional() } }),
  async (req, res) => {
    const place = await resolvePlace(req.valid.query, req.user?._id);
    const near = place.lat !== undefined;
    const at = near ? { lat: place.lat, lng: place.lng } : { city: place.city };
    const [pet, { features, cities }] = await Promise.all([homePet(req.user, req.valid.query.petId), getPlatform()]);
    const shopping = features.marketplace;

    const [banners, categories, recommended, shops, marketplace] = await Promise.all([
      homeBanners({ pet, citySlug: matchCity(cities, at)?.slug }),
      shopping ? Category.find({ kind: 'product', active: true, parent: null }).sort({ sortOrder: 1, name: 1 }).select('name slug icon').lean() : [],
      shopping ? recommendedProducts(pet) : [],
      findShops(place),
      moduleAvailability('marketplace', at),
    ]);
    res.json({
      location: placeOut(place),
      pet,
      marketplace,
      banners,
      categories,
      recommended,
      localStores: { items: shops.slice(0, LOCAL_STORES_LIMIT), total: shops.length, radiusKm: near ? DEFAULT_RADIUS_KM : null },
    });
  },
);

// ---- Admin: banners (mounted at /admin/banners) ----

export const adminBannersRouter = Router();

const hex = z.string().regex(/^#[0-9a-f]{6}$/i, 'Use a colour such as #1f3d33');
const bannerBody = {
  eyebrow: z.string().trim().max(60).nullable().optional(),
  title: z.string().trim().min(2).max(120),
  subtitle: z.string().trim().max(300).nullable().optional(),
  // From POST /files with purpose `banner`; null removes the image.
  imageFileId: objectId.nullable().optional(),
  cta: z.object({ label: z.string().trim().min(1).max(40), link: z.string().trim().min(1).max(500) }).nullable().optional(),
  theme: z.object({ background: hex, foreground: hex, accent: hex }).partial().optional(),
  petTypes: z.array(z.enum(PET_TYPES)).max(PET_TYPES.length).optional(),
  citySlugs: z.array(z.string().regex(/^[a-z0-9-]+$/).max(60)).max(50).optional(),
  startsAt: z.coerce.date().nullable().optional(),
  endsAt: z.coerce.date().nullable().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
  active: z.boolean().optional(),
};

// null clears a field. Theme colours are set one by one, so changing one keeps the others.
async function bannerFields(userId, { imageFileId, theme, ...body }) {
  const fields = Object.fromEntries(Object.entries(body).map(([key, value]) => [key, value ?? undefined]));
  if (imageFileId !== undefined) fields.image = imageFileId ? (await attachmentsFor(userId, [imageFileId], ['banner']))[0] : undefined;
  for (const [key, value] of Object.entries(theme ?? {})) fields[`theme.${key}`] = value;
  if (body.citySlugs?.length) {
    const { cities } = await getPlatform();
    const unknown = body.citySlugs.filter((slug) => !cities.some((c) => c.slug === slug));
    if (unknown.length) throw badRequest(`Unknown city: ${unknown.join(', ')}`);
  }
  return fields;
}

const checkDates = (banner) => {
  if (banner.startsAt && banner.endsAt && banner.endsAt <= banner.startsAt) throw badRequest('The end date must be after the start date');
};

adminBannersRouter.get('/', async (_req, res) => {
  res.json({ items: await Banner.find().sort({ active: -1, sortOrder: 1, createdAt: -1 }).lean() });
});

adminBannersRouter.post('/', validate({ body: bannerBody }), async (req, res) => {
  const banner = new Banner({ ...(await bannerFields(req.user._id, req.valid.body)), createdBy: req.user._id });
  checkDates(banner);
  await banner.save();
  await audit(req, 'banner.create', { type: 'banner', id: banner._id }, { meta: { title: banner.title } });
  res.status(201).json(banner);
});

adminBannersRouter.patch('/:id', validate({ body: partialShape(bannerBody) }), async (req, res) => {
  const banner = await Banner.findById(req.valid.params.id);
  if (!banner) throw notFound('Banner');
  banner.set(await bannerFields(req.user._id, req.valid.body));
  checkDates(banner);
  await banner.save();
  await audit(req, 'banner.update', { type: 'banner', id: banner._id }, { meta: { fields: Object.keys(req.valid.body) } });
  res.json(banner);
});

adminBannersRouter.delete('/:id', validate(), async (req, res) => {
  const banner = await Banner.findByIdAndDelete(req.valid.params.id);
  if (!banner) throw notFound('Banner');
  await audit(req, 'banner.delete', { type: 'banner', id: banner._id }, { meta: { title: banner.title } });
  res.status(204).end();
});

export default router;
