// The pet parent app's Home tab: banners, shop categories, products recommended for a pet and
// local stores, plus managing the banners in the admin panel.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Category } from '../src/modules/categories/category.model.js';
import { Product } from '../src/modules/shop/shop.model.js';
import { User } from '../src/modules/users/user.model.js';
import { Vendor } from '../src/modules/vendors/vendor.model.js';
import { api, createAdmin, pngBuffer, signUpByPhone, startDb, stopDb, tenantRun } from './helpers.js';

const BENGALURU = { lat: 12.9716, lng: 77.5946 };
const INDIRANAGAR = { lat: 12.9784, lng: 77.6408 };
const ALWAYS_OPEN = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '00:00', close: '23:59' }));
const at = ({ lat, lng }) => ({ type: 'Point', coordinates: [lng, lat] });
const near = `lat=${INDIRANAGAR.lat}&lng=${INDIRANAGAR.lng}`;

let admin, asha, bruno, pista;

async function shop(name, fields) {
  const owner = await signUpByPhone(name);
  return tenantRun(async () => {
    await User.updateOne({ _id: owner.user._id }, { $addToSet: { roles: 'vendor' } });
    return Vendor.create({ owner: owner.user._id, businessName: name, address: { line1: 'x', city: 'Bengaluru' }, operatingHours: ALWAYS_OPEN, status: 'active', ...fields });
  });
}

const product = (seller, category, name, petTypes, fields = {}) => ({
  seller: seller._id, category: category._id, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), petTypes,
  variants: [{ sku: name.slice(0, 20), label: '1 kg', mrpPaise: 50000, pricePaise: 40000, stock: 10 }], ...fields,
});

beforeAll(async () => {
  await startDb();
  admin = await createAdmin();
  await admin.http
    .post('/admin/cities')
    .send({ slug: 'bengaluru', name: 'Bengaluru', center: BENGALURU, radiusKm: 40, status: 'active', modules: { booking: 'active', marketplace: 'active' } })
    .expect(201);

  const seller = await shop('Paws & Whiskers', {
    location: at({ lat: 12.9785, lng: 77.641 }), seller: { status: 'approved' }, ratingAvg: 4.6, ratingCount: 12,
    store: { type: 'pet_store', locality: 'Indiranagar', tags: ['Curated treats & food'], inStorePickup: true },
  });
  // About 8 km away: outside the 5 km the home screen looks in.
  await shop('Jayanagar Pets', { location: at({ lat: 12.9316, lng: 77.5846 }), store: { type: 'pet_store' } });
  // A clinic with no shop listing never shows as a store.
  await shop('Happy Vet', { location: at(INDIRANAGAR) });

  await tenantRun(async () => {
    const food = await Category.create({ kind: 'product', name: 'Food', slug: 'food', icon: 'food', sortOrder: 0 });
    const toys = await Category.create({ kind: 'product', name: 'Toys', slug: 'toys', icon: 'toys', sortOrder: 1 });
    await Category.create([
      { kind: 'product', name: 'Dry food', slug: 'dry-food', parent: food._id },
      { kind: 'product', name: 'Old stock', slug: 'old-stock', active: false },
    ]);
    await Product.create([
      product(seller, food, 'Chicken Kibble', ['dog'], { featured: true, soldCount: 900, highlights: ['Real chicken first'] }),
      product(seller, food, 'Puppy Lamb Starter', ['dog'], { featured: true, soldCount: 800 }),
      product(seller, food, 'Lamb & Rice Adult', ['dog'], { featured: true, soldCount: 500 }),
      product(seller, toys, 'Rope Tug', ['dog'], { soldCount: 400 }),
      product(seller, toys, 'Squeaky Bone', ['dog'], { soldCount: 300 }),
      product(seller, food, 'Salmon Cat Food', ['cat'], { featured: true, soldCount: 1000 }),
      product(seller, food, 'Sold Out Dog Food', ['dog'], { featured: true, soldCount: 2000, variants: [{ sku: 'SOLD', label: '1 kg', mrpPaise: 100, pricePaise: 100, stock: 0 }] }),
    ]);
  });

  asha = await signUpByPhone('Asha Rao');
  const threeYearsAgo = new Date(Date.now() - 3 * 365 * 86_400_000).toISOString();
  bruno = (await asha.http.post('/pets').send({ name: 'Bruno', species: 'dog', breed: 'Golden Retriever', dateOfBirth: threeYearsAgo, weightKg: 31.5, allergies: ['Chicken'] }).expect(201)).body;
  pista = (await asha.http.post('/pets').send({ name: 'Pista', species: 'cat' }).expect(201)).body;

  const banner = (body) => admin.http.post('/admin/banners').send(body).expect(201);
  await banner({ eyebrow: '{pet}-friendly selection', title: 'Spring Care & Nutrition Festival', cta: { label: 'Explore Offers', link: 'nurvia://shop/products?category=food' } });
  await banner({ title: 'Dog days', petTypes: ['dog'], sortOrder: 1 });
  await banner({ title: 'Cats only', petTypes: ['cat'], sortOrder: 2 });
  await banner({ title: 'Bengaluru launch', citySlugs: ['bengaluru'], sortOrder: 3 });
  await banner({ title: 'Ended', endsAt: new Date(Date.now() - 86_400_000).toISOString() });
  await banner({ title: 'Paused', active: false });
});
afterAll(stopDb);

describe('home content', () => {
  it('shows a signed-out visitor general banners, categories, best sellers and nearby stores', async () => {
    const res = await api().get(`/home/content?${near}`).expect(200);
    expect(res.body.pet).toBeNull();
    expect(res.body.location).toMatchObject({ source: 'gps', city: 'Bengaluru' });
    expect(res.body.marketplace.state).toBe('active');

    expect(res.body.banners.map((b) => b.title)).toEqual(['Spring Care & Nutrition Festival', 'Bengaluru launch']);
    expect(res.body.banners[0]).toMatchObject({ eyebrow: 'your pet-friendly selection', cta: { label: 'Explore Offers', link: 'nurvia://shop/products?category=food' }, theme: { background: '#1f3d33' } });

    // Top-level, active categories only, in display order.
    expect(res.body.categories.map((c) => [c.slug, c.icon])).toEqual([['food', 'food'], ['toys', 'toys']]);

    // In stock only, featured best sellers first, at most three.
    expect(res.body.recommended.map((p) => p.name)).toEqual(['Salmon Cat Food', 'Chicken Kibble', 'Puppy Lamb Starter']);
    expect(res.body.recommended[0]).toMatchObject({ pricePaise: 40000, inStock: true });

    expect(res.body.localStores).toMatchObject({ total: 1, radiusKm: 5 });
    expect(res.body.localStores.items[0]).toMatchObject({ businessName: 'Paws & Whiskers', type: 'pet_store', badge: 'nurvia_partner', locality: 'Indiranagar' });
  });

  it("is personalised for the user's first pet: its banners, and products that suit it", async () => {
    const res = await asha.http.get(`/home/content?${near}`).expect(200);
    expect(res.body.pet).toMatchObject({ _id: bruno._id, name: 'Bruno', breed: 'Golden Retriever', weightKg: 31.5, lifeStage: 'adult', allergies: ['Chicken'] });
    expect(res.body.banners.map((b) => b.title)).toEqual(['Spring Care & Nutrition Festival', 'Dog days', 'Bengaluru launch']);
    expect(res.body.banners[0].eyebrow).toBe('Bruno-friendly selection');
    // Dog products only; nothing with chicken (his allergy) and no puppy food for an adult.
    expect(res.body.recommended.map((p) => p.name)).toEqual(['Lamb & Rice Adult', 'Rope Tug', 'Squeaky Bone']);
  });

  it('switches to another of the user’s pets, and refuses pets that are not theirs', async () => {
    const res = await asha.http.get(`/home/content?${near}&petId=${pista._id}`).expect(200);
    expect(res.body.pet).toMatchObject({ name: 'Pista', lifeStage: null });
    expect(res.body.banners.map((b) => b.title)).toContain('Cats only');
    expect(res.body.recommended.map((p) => p.name)).toEqual(['Salmon Cat Food']);

    const stranger = await signUpByPhone('Stranger');
    await stranger.http.get(`/home/content?petId=${bruno._id}`).expect(404);
    await api().get(`/home/content?petId=${bruno._id}`).expect(404);
  });

  it('lists stores by city when there is no location, and leaves out city banners elsewhere', async () => {
    const byCity = await api().get('/home/content?city=Bengaluru').expect(200);
    expect(byCity.body.localStores).toMatchObject({ total: 2, radiusKm: null });
    expect(byCity.body.localStores.items[0].businessName).toBe('Paws & Whiskers'); // best rated first
    expect(byCity.body.banners.map((b) => b.title)).toContain('Bengaluru launch');

    const nowhere = await api().get('/home/content').expect(200);
    expect(nowhere.body.location.source).toBe('none');
    expect(nowhere.body.banners.map((b) => b.title)).not.toContain('Bengaluru launch');
  });

  it('hides categories and products while the marketplace is switched off', async () => {
    await admin.http.patch('/admin/platform/features').send({ marketplace: false }).expect(200);
    const res = await asha.http.get(`/home/content?${near}`).expect(200);
    expect(res.body).toMatchObject({ categories: [], recommended: [], marketplace: { state: 'disabled' } });
    expect(res.body.banners.length).toBeGreaterThan(0);
    expect(res.body.localStores.total).toBe(1);
    await admin.http.patch('/admin/platform/features').send({ marketplace: true }).expect(200);
  });
});

describe('admin banners', () => {
  it('creates, edits and deletes banners, with an uploaded image', async () => {
    const upload = await admin.http.post('/files').field('purpose', 'banner').attach('file', pngBuffer, 'festival.png').expect(201);
    const created = await admin.http
      .post('/admin/banners')
      .send({ title: 'Image banner', imageFileId: upload.body._id, theme: { background: '#000000', accent: '#ff0000' }, endsAt: new Date(Date.now() + 86_400_000).toISOString(), sortOrder: 9 })
      .expect(201);
    expect(created.body.image.url).toBe(upload.body.url);

    // Changing one colour keeps the others; null clears a field.
    const edited = await admin.http.patch(`/admin/banners/${created.body._id}`).send({ theme: { accent: '#00ff00' }, imageFileId: null, endsAt: null }).expect(200);
    expect(edited.body.theme).toEqual({ background: '#000000', foreground: '#ffffff', accent: '#00ff00' });
    expect(edited.body.image).toBeUndefined();
    expect(edited.body.endsAt).toBeUndefined();

    const list = await admin.http.get('/admin/banners').expect(200);
    expect(list.body.items.map((b) => b.title)).toContain('Image banner');

    await admin.http.delete(`/admin/banners/${created.body._id}`).expect(204);
    await admin.http.delete(`/admin/banners/${created.body._id}`).expect(404);
  });

  it('checks dates, cities and permissions', async () => {
    const backwards = await admin.http.post('/admin/banners').send({ title: 'Backwards', startsAt: '2026-12-10', endsAt: '2026-12-01' }).expect(400);
    expect(backwards.body.error.message).toMatch(/end date/);
    const city = await admin.http.post('/admin/banners').send({ title: 'Nowhere', citySlugs: ['atlantis'] }).expect(400);
    expect(city.body.error.message).toMatch(/atlantis/);
    await asha.http.post('/admin/banners').send({ title: 'Mine' }).expect(403);
  });
});
