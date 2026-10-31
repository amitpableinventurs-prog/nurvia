// Test data for the iOS Simulator, whose default GPS location is San Francisco (37.785834, -122.406417).
// Adds an "Indore" city centred on that point, four local pet shops around it (three are approved
// marketplace sellers with products) and two Indore banners, so GET /home/content is not empty there.
// This is fake data: real phones in Indore will not match this city. Dev only.
//   node scripts/seed-simulator.js            (add, or refresh)
//   node scripts/seed-simulator.js --remove   (take it all out again)
import { connectDb, disconnectDb } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { runWithTenant } from '../src/common/tenancy.js';
import { ROLES } from '../src/common/roles.js';
import { Category } from '../src/modules/categories/category.model.js';
import { Banner } from '../src/modules/home/banner.model.js';
import { City } from '../src/modules/platform/platform.model.js';
import { Product } from '../src/modules/shop/shop.model.js';
import { User } from '../src/modules/users/user.model.js';
import { Vendor } from '../src/modules/vendors/vendor.model.js';

if (env.isProd) throw new Error('Refusing to load simulator test data with NODE_ENV=production');

const SIM = { lat: 37.785834, lng: -122.406417 };
const point = (dLat, dLng) => ({ type: 'Point', coordinates: [SIM.lng + dLng, SIM.lat + dLat] });
// Fixed ids, so running the script again replaces this data instead of adding a second copy.
const id = (n) => `66f0510000000000000000${String(n).padStart(2, '0')}`;

const CITY_ID = id(1);
const daily = (open, close, days = [0, 1, 2, 3, 4, 5, 6]) => days.map((day) => ({ day, open, close }));

// [owner name, phone, business, dLat, dLng, store, hours, rating, reviews, seller]
const SHOPS = [
  ['Ankit Jain', '+919300000101', 'Navlakha Pet Mart', 0.002, 0.003,
    { type: 'pet_store', locality: 'Navlakha', note: 'Fresh food and treats, packed for pickup in 10 minutes', tags: ['Food & treats', 'Fresh stock daily'], inStorePickup: true }, daily('09:00', '21:00'), 4.6, 24, true],
  ['Dr. Neha Sharma', '+919300000102', 'Vijay Nagar Pet Pharmacy', -0.006, 0.008,
    { type: 'pharmacy', locality: 'Vijay Nagar', note: 'Vet-run pharmacy with a vaccine fridge and prescription diets', tags: ['Vaccines in stock', 'Prescription diets'], inStorePickup: true, coldChain: true, vetTechOnSite: true, stockVerifiedAt: new Date(Date.now() - 20 * 60_000) },
    daily('08:00', '22:00'), 4.8, 41, true],
  ['Ritika Verma', '+919300000103', 'Paws Boutique Palasia', 0.012, -0.01,
    { type: 'boutique', locality: 'Palasia', note: 'Handmade collars, harnesses and grooming kits', tags: ['Designer collars', 'Grooming tools'], inStorePickup: true }, daily('11:00', '20:00', [1, 2, 3, 4, 5, 6]), 4.4, 12, true],
  ['Sanjay Patel', '+919300000104', 'Rajwada Pet Corner', -0.018, -0.02,
    { type: 'pet_store', locality: 'Rajwada', note: 'Everyday supplies, aquarium and bird care at budget prices', tags: ['Aquarium & birds', 'Budget packs'] }, daily('10:00', '21:00'), 4.2, 8, false],
];
const OWNER_IDS = SHOPS.map((_, i) => id(10 + i));
const VENDOR_IDS = SHOPS.map((_, i) => id(20 + i));

// [name, brand, category slug, pets, art kind, colour, accent, shop index, featured, variants[[label, mrp, price, stock]], highlights]
const PRODUCTS = [
  ['Lamb & Brown Rice Adult Dog Food', 'Malwa Meals', 'food', ['dog'], 'bag', '#9a3412', '#fde68a', 0, true, [['1.2 kg', 699, 579, 30], ['3 kg', 1599, 1299, 18]], ['Gentle on sensitive tummies', 'No added colours']],
  ['Tuna & Pumpkin Cat Pouches (Pack of 12)', 'Purrfect Bowl', 'food', ['cat'], 'pouch', '#0e7490', '#fed7aa', 0, true, [['12 × 70 g', 720, 599, 40]], ['Added taurine', 'Pumpkin for digestion']],
  ['Chicken Liver Training Bites', 'Tail Tales', 'treats', ['dog'], 'pouch', '#b91c1c', '#fecaca', 0, true, [['150 g', 299, 249, 60]], ['Soft, bite-sized', 'Single protein']],
  ['Cotton Rope Chew Toy', 'Zoomies', 'toys', ['dog'], 'box', '#ca8a04', '#1e3a8a', 0, false, [['Medium', 349, 279, 35]], ['Flosses teeth while playing', 'Machine washable']],
  ['Herbal Anti-Tick Spray', 'VetWise', 'health-care', ['dog'], 'bottle', '#15803d', '#d9f99d', 1, true, [['200 ml', 449, 379, 25]], ['Neem & citronella', 'Safe for daily use']],
  ['Senior Joint Support Chews', 'VetWise', 'health-care', ['dog'], 'bottle', '#6d28d9', '#ddd6fe', 1, false, [['60 chews', 899, 749, 20]], ['Glucosamine & chondroitin', 'For dogs 7 years and older']],
  ['Kitten Growth Dry Food', 'Purrfect Bowl', 'food', ['cat'], 'bag', '#be185d', '#fbcfe8', 1, false, [['1 kg', 649, 549, 15]], ['DHA for development', 'Small kibble']],
  ['Handwoven Leather Collar', 'Paws & Petals', 'walk-gear', ['dog', 'cat'], 'collar', '#78350f', '#fcd34d', 2, true, [['Small', 899, 749, 12], ['Large', 1099, 899, 8]], ['Made in Indore', 'Brass buckle']],
];
const PRODUCT_IDS = PRODUCTS.map((_, i) => id(40 + i));
const BANNER_IDS = [id(60), id(61)];

const slugify = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function remove() {
  await Product.deleteMany({ _id: { $in: PRODUCT_IDS } });
  await Banner.deleteMany({ _id: { $in: BANNER_IDS } });
  await Vendor.deleteMany({ _id: { $in: VENDOR_IDS } });
  await User.deleteMany({ _id: { $in: OWNER_IDS } });
  await City.deleteMany({ _id: CITY_ID });
}

async function seed() {
  await remove();
  await City.create({
    _id: CITY_ID, slug: 'indore', name: 'Indore', region: 'Madhya Pradesh', status: 'active', modules: { booking: 'active', marketplace: 'active' },
    center: point(0, 0), radiusKm: 25, sortOrder: 4,
    localities: SHOPS.map(([, , , dLat, dLng, store]) => ({ name: store.locality, center: point(dLat, dLng), popular: true })),
  });

  const petShop = await Category.findOne({ kind: 'vendor', slug: 'pet-shop' }).select('_id').lean();
  for (const [i, [ownerName, phone, businessName, dLat, dLng, store, operatingHours, ratingAvg, ratingCount, seller]] of SHOPS.entries()) {
    await User.create({ _id: OWNER_IDS[i], name: ownerName, phone, city: 'Indore', citySlug: 'indore', roles: [ROLES.VENDOR, ...(seller ? [ROLES.SELLER] : [])] });
    await Vendor.create({
      _id: VENDOR_IDS[i], owner: OWNER_IDS[i], businessName, categories: petShop ? [petShop._id] : [], phone,
      address: { line1: `${12 + i * 7} Main Road, ${store.locality}`, city: 'Indore', state: 'Madhya Pradesh', pincode: '452001' },
      location: point(dLat, dLng), operatingHours, store, status: 'active', ratingAvg, ratingCount,
      kyc: { status: 'approved', submittedAt: new Date(), reviewedAt: new Date() },
      ...(seller && {
        seller: { status: 'approved', legalName: `${businessName} LLP`, submittedAt: new Date(), reviewedAt: new Date(), pickupAddress: { line1: store.locality, city: 'Indore', pincode: '452001', phone } },
      }),
    });
  }

  const categories = await Category.find({ kind: 'product' }).select('slug').lean();
  const bySlug = new Map(categories.map((c) => [c.slug, c._id]));
  await Product.create(
    PRODUCTS.map(([name, brand, cat, petTypes, kind, color, accent, shop, featured, variants, highlights], i) => ({
      _id: PRODUCT_IDS[i], seller: VENDOR_IDS[shop], name, slug: slugify(name), brand, category: bySlug.get(cat), petTypes,
      art: { kind, color, accent }, featured, highlights, ratingAvg: 4.3 + (i % 5) / 10, ratingCount: 20 + i * 13, soldCount: 50 + i * 37,
      description: `${name} by ${brand}. ${highlights.join('. ')}. Sold by ${SHOPS[shop][2]}, Indore.`,
      variants: variants.map(([label, mrp, price, stock], v) => ({ sku: `IDR-${i + 1}-${v + 1}`, label, mrpPaise: mrp * 100, pricePaise: price * 100, stock })),
      tags: [cat, ...petTypes],
    })),
  );

  await Banner.create([
    {
      _id: BANNER_IDS[0], eyebrow: '{pet}-friendly picks in Indore', title: 'Indore Pet Care Week', subtitle: 'Up to 25% off food and treats from local Indore stores.',
      cta: { label: 'Shop now', link: 'nurvia://shop/products?category=food&sort=discount' }, citySlugs: ['indore'], sortOrder: 0,
    },
    {
      _id: BANNER_IDS[1], eyebrow: 'Tick season', title: 'Herbal tick protection', subtitle: 'Neem sprays and spot-ons, in stock at Vijay Nagar Pet Pharmacy.',
      cta: { label: 'View', link: 'nurvia://shop/products?category=health-care' }, petTypes: ['dog'], citySlugs: ['indore'], theme: { background: '#16325c', accent: '#fcd34d' }, sortOrder: 1,
    },
  ]);
}

await connectDb();
await runWithTenant(env.defaultTenant, process.argv.includes('--remove') ? remove : seed);
console.info(process.argv.includes('--remove') ? 'Removed the simulator test data.' : `Added simulator test data around ${SIM.lat}, ${SIM.lng} (city "Indore").`);
await disconnectDb();
