import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, createAdmin, seedCategories, signUpByPhone, startDb, stopDb } from './helpers.js';

// Photon answers as it does for these places; no request leaves the test.
const feature = (lng, lat, properties) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: { countrycode: 'IN', country: 'India', ...properties } });
const MALL = feature(75.8672, 22.6991, { type: 'house', name: 'Sapna Sangeeta Mall', housenumber: '13', street: 'Sapna Sangeeta Road', district: 'Indore City', city: 'Indore', state: 'Madhya Pradesh', postcode: '452001' });
const ROAD = feature(75.869, 22.7007, { type: 'street', name: 'Sapna Sangeeta Road', district: 'Indore City', city: 'Indore', state: 'Madhya Pradesh', postcode: '452001' });
const GURGAON = feature(77.1007, 28.4977, { type: 'locality', name: 'DLF Phase 3', district: 'Sector 24', city: 'Gurgaon', state: 'Haryana', postcode: '122010' });
const LAHORE = feature(74.3436, 31.5497, { type: 'city', name: 'Lahore', countrycode: 'PK' });

let categories, user, admin, photon;

beforeAll(async () => {
  await startDb();
  categories = await seedCategories();
  user = await signUpByPhone('Nikhil');
  admin = await createAdmin();
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await stopDb();
});

beforeEach(() => {
  photon = vi.fn(async (url) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === '/reverse') return { ok: true, json: async () => ({ features: searchParams.get('lat') === '15' ? [] : [MALL] }) };
    const q = searchParams.get('q');
    return { ok: true, json: async () => ({ features: q.startsWith('dlf') ? [GURGAON] : [ROAD, MALL, MALL, LAHORE] }) };
  });
  vi.stubGlobal('fetch', photon);
});

describe('address search', () => {
  it('needs a signed-in user', async () => {
    await api().get('/geo/search?q=sapna').expect(401);
  });

  it('suggests places in India as the user types, nearby first', async () => {
    const res = await user.http.get('/geo/search?q=sapna sangeeta&lat=22.72&lng=75.86').expect(200);
    expect(res.body.items.map(({ title, subtitle }) => ({ title, subtitle }))).toEqual([
      { title: 'Sapna Sangeeta Road', subtitle: 'Indore, Madhya Pradesh' },
      { title: 'Sapna Sangeeta Mall, 13 Sapna Sangeeta Road', subtitle: 'Indore, Madhya Pradesh' },
    ]);
    const sent = new URL(photon.mock.calls[0][0]).searchParams;
    expect([sent.get('lat'), sent.get('lon')]).toEqual(['22.72', '75.86']);
  });

  it('gives the picked place as address fields and a map pin', async () => {
    const [, mall] = (await user.http.get('/geo/search?q=sapna').expect(200)).body.items;
    const res = await user.http.get(`/geo/places/${mall.id}`).expect(200);
    expect(res.body).toEqual({
      formatted: 'Sapna Sangeeta Mall, 13 Sapna Sangeeta Road, Indore, Madhya Pradesh, 452001',
      address: { line1: 'Sapna Sangeeta Mall, 13 Sapna Sangeeta Road', city: 'Indore', state: 'Madhya Pradesh', pincode: '452001' },
      location: { lat: 22.6991, lng: 75.8672 },
      city: null,
    });
    // The fields go straight into the vendor sign-up.
    await user.http.post('/vendors').send({ businessName: 'Sapna Pet Clinic', categoryIds: [String(categories.vet._id)], address: res.body.address, location: res.body.location }).expect(201);
    await user.http.get('/geo/places/osm.bm90LWEtcGxhY2U').expect(400);
  });

  it('files a place under the Nurvia city that covers it', async () => {
    await admin.http.post('/admin/cities').send({ slug: 'delhi-ncr', name: 'Delhi NCR', aliases: ['Noida'], center: { lat: 28.6139, lng: 77.209 }, radiusKm: 60, status: 'active' }).expect(201);
    const [item] = (await user.http.get('/geo/search?q=dlf phase 3').expect(200)).body.items;
    const res = await user.http.get(`/geo/places/${item.id}`).expect(200);
    expect(res.body.address).toEqual({ line1: 'DLF Phase 3', line2: 'Sector 24, Gurgaon', city: 'Delhi NCR', state: 'Haryana', pincode: '122010' });
    expect(res.body.city).toMatchObject({ slug: 'delhi-ncr', name: 'Delhi NCR', status: 'active' });
  });

  it('finds the address at a map pin, keeping the pin', async () => {
    const res = await user.http.get('/geo/reverse?lat=22.6995&lng=75.868').expect(200);
    // The nearest shop is a neighbour, not the user's own place.
    expect(res.body.address).toEqual({ line1: '13 Sapna Sangeeta Road', city: 'Indore', state: 'Madhya Pradesh', pincode: '452001' });
    expect(res.body.location).toEqual({ lat: 22.6995, lng: 75.868 });
    await user.http.get('/geo/reverse?lat=15&lng=65').expect(404);
  });

  it('says so when the provider is down, so the user types the address', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 502 }));
    const res = await user.http.get('/geo/search?q=sapna').expect(503);
    expect(res.body.error.message).toMatch(/Fill in the address yourself/);
  });
});
