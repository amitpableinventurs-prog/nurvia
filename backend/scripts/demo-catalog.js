// Demo storefront catalogue for `npm run dev:memory`. All brands are fictional.
import { Category } from '../src/modules/categories/category.model.js';
import { Banner } from '../src/modules/home/banner.model.js';
import { Coupon, Product } from '../src/modules/shop/shop.model.js';

// [name, slug, icon]; the icon is a key the apps map to their own artwork.
const CATEGORIES = [
  ['Food', 'food', 'food'],
  ['Treats', 'treats', 'treats'],
  ['Toys', 'toys', 'toys'],
  ['Grooming', 'grooming', 'grooming'],
  ['Health care', 'health-care', 'health'],
  ['Walk gear', 'walk-gear', 'walk'],
  ['Beds & home', 'beds-home', 'bed'],
  ['Litter & hygiene', 'litter-hygiene', 'litter'],
];

// [name, brand, category slug, pets, art kind, colour, accent, rating, reviews, sold, featured, variants[[label, mrp, price, stock]], highlights]
const PRODUCTS = [
  ['Chicken & Rice Adult Dry Food', 'Bark Bistro', 'food', ['dog'], 'bag', '#c2410c', '#fde68a', 4.6, 812, 2310, true, [['1.2 kg', 649, 549, 40], ['3 kg', 1499, 1199, 25], ['10 kg', 4299, 3399, 8]], ['Real chicken is the first ingredient', 'No artificial colours', 'Omega 3 & 6 for a glossy coat']],
  ['Puppy Starter Lamb Kibble', 'Bark Bistro', 'food', ['dog'], 'bag', '#7c3aed', '#fbcfe8', 4.7, 356, 980, false, [['1 kg', 599, 529, 30], ['3 kg', 1599, 1349, 12]], ['DHA for brain development', 'Small kibble for little mouths']],
  ['Ocean Fish Feast Wet Food (Pack of 12)', 'Purrfect Bowl', 'food', ['cat'], 'can', '#0369a1', '#a5f3fc', 4.5, 640, 1890, true, [['12 × 85 g', 780, 624, 50], ['24 × 85 g', 1560, 1170, 20]], ['Chunks in gravy', 'Complete & balanced', 'Added taurine']],
  ['Indoor Cat Salmon Dry Food', 'Purrfect Bowl', 'food', ['cat'], 'bag', '#0f766e', '#fecaca', 4.4, 288, 760, false, [['1.5 kg', 899, 749, 22], ['4 kg', 2199, 1799, 9]], ['Hairball control', 'Supports a healthy weight']],
  ['Homestyle Curd Rice & Chicken Meal', 'Desi Dog Co.', 'food', ['dog'], 'pouch', '#15803d', '#fef08a', 4.8, 190, 540, true, [['Pack of 6', 594, 499, 35]], ['Freshly cooked, Indian recipes', 'Gentle on the tummy']],
  ['Chicken Jerky Strips', 'Tail Tales', 'treats', ['dog'], 'pouch', '#b45309', '#fed7aa', 4.7, 1024, 3120, true, [['100 g', 349, 279, 60], ['250 g', 799, 599, 30]], ['Single ingredient', 'High protein training treat']],
  ['Calcium Milk Bones', 'Tail Tales', 'treats', ['dog'], 'bone', '#f5f5f4', '#f97316', 4.3, 420, 1450, false, [['Pack of 10', 199, 169, 80]], ['Calcium for strong bones', 'Low fat']],
  ['Lickable Tuna Cat Treats', 'Meowmama', 'treats', ['cat'], 'tube', '#db2777', '#fbcfe8', 4.8, 870, 2650, true, [['4 tubes', 299, 229, 70], ['20 tubes', 1299, 949, 25]], ['Hand-feed bonding moments', 'Great for hiding pills']],
  ['Dental Chew Sticks', 'FurFresh', 'treats', ['dog'], 'box', '#16a34a', '#bbf7d0', 4.2, 310, 690, false, [['Small · 28 sticks', 549, 449, 26], ['Large · 14 sticks', 549, 449, 0]], ['Reduces tartar build-up', 'Freshens breath']],
  ['Squeaky Rope Tug Ball', 'Zoomies', 'toys', ['dog'], 'ball', '#ea580c', '#1d4ed8', 4.5, 530, 1720, true, [['Medium', 399, 299, 45], ['Large', 499, 379, 20]], ['Cotton rope flosses teeth', 'Durable natural rubber']],
  ['Feather Wand Teaser', 'Meowmama', 'toys', ['cat'], 'box', '#9333ea', '#fde047', 4.6, 402, 1190, false, [['Single', 249, 199, 55]], ['Telescopic handle', 'Two refill feathers included']],
  ['Snuffle Mat Puzzle', 'Zoomies', 'toys', ['dog', 'cat'], 'bed', '#0d9488', '#fcd34d', 4.7, 214, 520, true, [['Standard', 1299, 899, 14]], ['Slows down fast eaters', 'Machine washable']],
  ['Bird Swing with Bells', 'Chirpy', 'toys', ['bird'], 'box', '#65a30d', '#fbbf24', 4.4, 96, 240, false, [['One size', 349, 279, 18]], ['Natural wood perch', 'Safe non-toxic colours']],
  ['Neem & Aloe Dog Shampoo', 'FurFresh', 'grooming', ['dog'], 'bottle', '#166534', '#d9f99d', 4.5, 760, 2040, true, [['200 ml', 349, 279, 40], ['500 ml', 699, 529, 18]], ['Soothes itchy skin', 'Paraben free', 'Mild tick & flea repellent']],
  ['Slicker Brush with Self-Clean Button', 'Paws & Petals', 'grooming', ['dog', 'cat'], 'box', '#be185d', '#fbcfe8', 4.6, 480, 1310, false, [['Medium', 599, 449, 33]], ['Removes loose undercoat', 'One-click hair release']],
  ['Paw Balm (Monsoon Care)', 'Paws & Petals', 'grooming', ['dog'], 'tube', '#a16207', '#fef3c7', 4.8, 205, 610, true, [['50 g', 399, 349, 25]], ['Protects pads from wet & hot pavements', 'Lick-safe beeswax formula']],
  ['Tick & Flea Spot-On (Pack of 3)', 'VetWise', 'health-care', ['dog'], 'box', '#1d4ed8', '#bfdbfe', 4.4, 690, 1830, false, [['Small dog', 899, 749, 30], ['Large dog', 1199, 999, 22]], ['Lasts up to 4 weeks per dose', 'Waterproof after 48 hours']],
  ['Multivitamin Chewable Tablets', 'VetWise', 'health-care', ['dog', 'cat'], 'bottle', '#7e22ce', '#e9d5ff', 4.3, 260, 640, false, [['60 tablets', 549, 469, 28]], ['Supports immunity & coat', 'Chicken flavoured']],
  ['Probiotic Gut Health Powder', 'VetWise', 'health-care', ['dog', 'cat'], 'can', '#047857', '#a7f3d0', 4.6, 140, 330, false, [['30 sachets', 699, 599, 0]], ['Eases loose stools', 'Sprinkle on food']],
  ['Reflective Padded Harness', 'Walkies', 'walk-gear', ['dog'], 'collar', '#e11d48', '#fde047', 4.7, 590, 1520, true, [['S', 1099, 799, 16], ['M', 1199, 849, 20], ['L', 1299, 899, 9]], ['No-pull front clip', 'Reflective strips for night walks']],
  ['Personalised Name Collar', 'Walkies', 'walk-gear', ['dog', 'cat'], 'collar', '#2563eb', '#fbbf24', 4.5, 330, 870, false, [['Small', 599, 499, 40], ['Large', 699, 579, 30]], ['Free name & phone engraving', 'Quick-release buckle']],
  ['Retractable Leash 5 m', 'Walkies', 'walk-gear', ['dog'], 'box', '#0f172a', '#f97316', 4.2, 210, 470, false, [['Up to 25 kg', 1199, 949, 12]], ['One-button brake & lock', 'Ergonomic grip']],
  ['Orthopaedic Memory Foam Bed', 'Snooze Den', 'beds-home', ['dog'], 'bed', '#78716c', '#fcd34d', 4.8, 180, 360, true, [['Medium', 3999, 2799, 7], ['Large', 4999, 3499, 4]], ['Eases joint pain for senior dogs', 'Removable washable cover']],
  ['Cosy Cave Cat Bed', 'Snooze Den', 'beds-home', ['cat'], 'bed', '#9d174d', '#fecdd3', 4.6, 150, 300, false, [['One size', 1799, 1299, 11]], ['Hooded for hide-and-seek', 'Ultra-soft plush']],
  ['Clumping Bentonite Litter', 'Meowmama', 'litter-hygiene', ['cat'], 'bag', '#475569', '#bae6fd', 4.4, 720, 2210, false, [['5 kg', 599, 499, 36], ['10 kg', 1099, 899, 14]], ['Lavender scent', '99% dust free']],
  ['Biodegradable Poop Bags (8 rolls)', 'FurFresh', 'litter-hygiene', ['dog'], 'box', '#15803d', '#bbf7d0', 4.7, 950, 3300, false, [['120 bags', 399, 299, 90]], ['Plant-based, compostable', 'Leak-proof & extra thick']],
];

export async function seedCatalog({ sellers }) {
  const categories = await Category.create(CATEGORIES.map(([name, slug, icon], i) => ({ kind: 'product', name, slug, icon, sortOrder: i })));
  const bySlug = new Map(categories.map((c) => [c.slug, c._id]));
  const now = Date.now();
  await Product.create(
    PRODUCTS.map(([name, brand, cat, petTypes, kind, color, accent, ratingAvg, ratingCount, soldCount, featured, variants, highlights], i) => ({
      seller: sellers[i % sellers.length],
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      brand,
      category: bySlug.get(cat),
      petTypes,
      art: { kind, color, accent },
      ratingAvg,
      ratingCount,
      soldCount,
      featured,
      highlights,
      description: `${name} by ${brand}. ${highlights.join('. ')}. Sold by a Nurvia-verified local store; delivered in 1–2 days within the city.`,
      variants: variants.map(([label, mrp, price, stock], v) => ({ sku: `${brand.slice(0, 3).toUpperCase()}-${i + 1}-${v + 1}`, label, mrpPaise: mrp * 100, pricePaise: price * 100, stock })),
      tags: [cat, ...petTypes],
      createdAt: new Date(now - (PRODUCTS.length - i) * 2 * 86_400_000),
    })),
  );
  await Coupon.create([
    { code: 'WELCOME10', description: '10% off your first order (up to ₹200)', type: 'percent', value: 10, maxDiscountPaise: 20_000 },
    { code: 'PAWS100', description: '₹100 off on orders above ₹999', type: 'flat', value: 10_000, minOrderPaise: 99_900 },
    { code: 'MONSOON15', description: '15% off above ₹1,499 (up to ₹400)', type: 'percent', value: 15, minOrderPaise: 149_900, maxDiscountPaise: 40_000 },
  ]);
  // Home screen banners; "{pet}" becomes the name of the pet the screen is showing.
  await Banner.create([
    {
      eyebrow: '{pet}-friendly selection', title: 'Spring Care & Nutrition Festival', subtitle: 'Up to 30% off vet-approved diets, picked for your pet.',
      cta: { label: 'Explore Offers', link: 'nurvia://shop/products?category=food&sort=discount' }, sortOrder: 0,
    },
    {
      eyebrow: 'Monsoon care', title: 'Paw balms & tick protection', subtitle: 'Dry paws and no ticks this season. MONSOON15 takes 15% off above ₹1,499.',
      cta: { label: 'Shop now', link: 'nurvia://shop/products?category=grooming' }, petTypes: ['dog'], theme: { background: '#16325c', accent: '#fcd34d' }, sortOrder: 1,
    },
  ]);
}
