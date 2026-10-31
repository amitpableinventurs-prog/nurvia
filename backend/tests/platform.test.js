import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLES } from '../src/common/roles.js';
import { Booking } from '../src/modules/bookings/booking.model.js';
import { Category } from '../src/modules/categories/category.model.js';
import { Pet } from '../src/modules/pets/pet.model.js';
import { Vendor } from '../src/modules/vendors/vendor.model.js';
import { api, createAdmin, istDate, seedCategories, signUpByPhone, startDb, stopDb, tenantRun } from './helpers.js';

const DELHI = { lat: 28.6139, lng: 77.209 };
const BENGALURU = { lat: 12.9716, lng: 77.5946 };
const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '06:00', close: '22:00' }));

let categories, admin, staff, parent, delhiOwner, blrOwner, delhiVendor, blrVendor, delhiService, blrService, petId;

async function openVendor(owner, name, city, location) {
  const vendor = (
    await owner.http
      .post('/vendors')
      .send({ businessName: name, categoryIds: [String(categories.vet._id)], address: { line1: '1 Main Road', city }, location, operatingHours: ALL_WEEK })
      .expect(201)
  ).body;
  const service = (await owner.http.post('/vendors/me/services').send({ name: 'Consultation', pricePaise: 50000, durationMin: 30 }).expect(201)).body;
  await tenantRun(() => Vendor.updateOne({ _id: vendor._id }, { status: 'active' }));
  return [vendor, service];
}

beforeAll(async () => {
  await startDb();
  categories = await seedCategories();
  admin = await createAdmin();
  staff = await createAdmin(ROLES.STAFF);
  parent = await signUpByPhone('Asha');
  delhiOwner = await signUpByPhone('Delhi Vet');
  blrOwner = await signUpByPhone('Bengaluru Vet');
  [delhiVendor, delhiService] = await openVendor(delhiOwner, 'Gurugram Pet Clinic', 'Gurugram', DELHI);
  [blrVendor, blrService] = await openVendor(blrOwner, 'Indiranagar Pet Clinic', 'Bengaluru', BENGALURU);
  petId = (await parent.http.post('/pets').send({ name: 'Bruno', species: 'dog' }).expect(201)).body._id;
});
afterAll(stopDb);

const firstSlot = async (vendor, service, days = 2) =>
  (await api().get(`/vendors/${vendor._id}/availability?serviceId=${service._id}&date=${istDate(days)}`).expect(200)).body.slots[0];

describe('before any city is configured', () => {
  it('runs booking everywhere', async () => {
    const config = await api().get('/config').expect(200);
    expect(config.body).toMatchObject({ citiesConfigured: false, modules: { booking: 'active', marketplace: 'active' }, features: { adoption: true, sos: false } });
    const found = await api().get('/vendors').expect(200);
    expect(found.body.total).toBe(2);
  });
});

describe('city rollout', () => {
  it('lets staff with the permission configure cities', async () => {
    const delhi = { slug: 'delhi-ncr', name: 'Delhi NCR', aliases: ['Gurugram', 'Noida'], center: DELHI, radiusKm: 60, status: 'active' };
    await staff.http.post('/admin/cities').send(delhi).expect(403);
    await admin.http.post('/admin/cities').send(delhi).expect(201);
    await admin.http.post('/admin/cities').send({ slug: 'bengaluru', name: 'Bengaluru', aliases: ['Bangalore'], center: BENGALURU, status: 'coming_soon' }).expect(201);
    await admin.http.post('/admin/cities').send({ slug: 'delhi-ncr', name: 'Dup', center: DELHI }).expect(409);

    const platform = await admin.http.get('/admin/platform').expect(200);
    expect(platform.body.cities.map((c) => [c.slug, c.liveVendors])).toEqual([['bengaluru', 1], ['delhi-ncr', 1]]);
  });

  it('tells the apps where booking is live, by name, alias or location', async () => {
    expect((await api().get('/config?city=noida').expect(200)).body.modules.booking).toBe('active');
    expect((await api().get(`/config?lat=${BENGALURU.lat}&lng=${BENGALURU.lng}`).expect(200)).body).toMatchObject({ city: { slug: 'bengaluru' }, modules: { booking: 'coming_soon' } });
    expect((await api().get('/config?city=Pune').expect(200)).body.modules.booking).toBe('unavailable');
    expect((await api().get('/config').expect(200)).body.modules.booking).toBeNull();
  });

  it('only lists vendors in live cities, and explains an empty city', async () => {
    const everywhere = await api().get('/vendors').expect(200);
    expect(everywhere.body.items.map((v) => v.businessName)).toEqual(['Gurugram Pet Clinic']);

    const blr = await api().get('/vendors?city=Bangalore').expect(200);
    expect(blr.body).toMatchObject({ total: 0, availability: { state: 'coming_soon', city: { name: 'Bengaluru' } } });

    const delhi = await api().get('/vendors?city=Delhi%20NCR').expect(200);
    expect(delhi.body.items.map((v) => v.businessName)).toEqual(['Gurugram Pet Clinic']);
  });

  it('refuses bookings in a city that is not live yet, and opens once it is', async () => {
    const blocked = await api().get(`/vendors/${blrVendor._id}/availability?serviceId=${blrService._id}&date=${istDate(2)}`).expect(409);
    expect(blocked.body.error).toMatchObject({ code: 'MODULE_UNAVAILABLE' });
    const profile = await api().get(`/vendors/${blrVendor._id}`).expect(200);
    expect(profile.body.booking.state).toBe('coming_soon');

    const city = (await admin.http.get('/admin/platform')).body.cities.find((c) => c.slug === 'bengaluru');
    await admin.http.patch(`/admin/cities/${city._id}`).send({ status: 'active', modules: { marketplace: 'coming_soon' } }).expect(200);
    const scheduledAt = await firstSlot(blrVendor, blrService);
    await parent.http.post('/bookings').send({ vendorId: blrVendor._id, serviceId: blrService._id, petId, scheduledAt }).expect(201);
    expect((await api().get('/config?city=Bengaluru')).body.modules).toEqual({ booking: 'active', marketplace: 'coming_soon' });
  });
});

describe('feature flags', () => {
  it('switches modules off platform-wide and back on', async () => {
    await staff.http.patch('/admin/platform/features').send({ adoption: false }).expect(403);
    await admin.http.patch('/admin/platform/features').send({ adoption: false, marketplace: false }).expect(200);

    const res = await parent.http.get('/adoption/listings').expect(403);
    expect(res.body.error.code).toBe('FEATURE_DISABLED');
    await api().get('/shop/home').expect(403);
    await parent.http.get('/pets').expect(200); // the pet passport is never switched off
    expect((await api().get('/config')).body.features).toMatchObject({ adoption: false, marketplace: false });

    await admin.http.patch('/admin/platform/features').send({ adoption: true, marketplace: true }).expect(200);
    await parent.http.get('/adoption/listings').expect(200);
  });

  it('hides vendors in a switched-off category', async () => {
    await tenantRun(() => Category.updateOne({ _id: categories.vet._id }, { active: false }));
    expect((await api().get('/vendors').expect(200)).body.total).toBe(0);
    await tenantRun(() => Category.updateOne({ _id: categories.vet._id }, { active: true }));
    expect((await api().get('/vendors').expect(200)).body.total).toBe(2);
  });
});

describe('vendor time off and pausing', () => {
  it('removes blocked time from availability and refuses bookings in it', async () => {
    const date = istDate(3);
    const before = (await api().get(`/vendors/${delhiVendor._id}/availability?serviceId=${delhiService._id}&date=${date}`).expect(200)).body.slots;
    const from = new Date(`${date}T10:00:00+05:30`);
    const to = new Date(`${date}T13:00:00+05:30`);

    await delhiOwner.http.post('/vendors/me/time-off').send({ from: to, to: from }).expect(400);
    const block = await delhiOwner.http.post('/vendors/me/time-off').send({ from, to, reason: 'Vet conference' }).expect(201);
    const after = (await api().get(`/vendors/${delhiVendor._id}/availability?serviceId=${delhiService._id}&date=${date}`).expect(200)).body.slots;
    expect(after.length).toBe(before.length - 6);
    expect(after.some((s) => new Date(s) >= from && new Date(s) < to)).toBe(false);
    await parent.http.post('/bookings').send({ vendorId: delhiVendor._id, serviceId: delhiService._id, petId, scheduledAt: from.toISOString() }).expect(409);

    const list = await delhiOwner.http.get('/vendors/me/time-off').expect(200);
    expect(list.body.timeOff[0]).toMatchObject({ reason: 'Vet conference' });
    expect((await api().get(`/vendors/${delhiVendor._id}`)).body.timeOff).toBeUndefined();
    await delhiOwner.http.delete(`/vendors/me/time-off/${block.body.block._id}`).expect(204);
  });

  it('reports existing bookings that clash with a new block', async () => {
    const scheduledAt = await firstSlot(delhiVendor, delhiService, 5);
    await parent.http.post('/bookings').send({ vendorId: delhiVendor._id, serviceId: delhiService._id, petId, scheduledAt }).expect(201);
    const block = await delhiOwner.http.post('/vendors/me/time-off').send({ from: scheduledAt, to: new Date(new Date(scheduledAt).getTime() + 3_600_000) }).expect(201);
    expect(block.body.conflicts).toHaveLength(1);
    expect(block.body.conflicts[0]).toMatchObject({ status: 'pending', pet: { name: 'Bruno' } });
  });

  it('pauses new bookings until a date', async () => {
    const until = new Date(`${istDate(2)}T00:00:00+05:30`);
    await delhiOwner.http.put('/vendors/me/pause').send({ active: true, until, reason: 'Clinic renovation' }).expect(200);
    expect(await firstSlot(delhiVendor, delhiService, 1)).toBeUndefined();
    expect(await firstSlot(delhiVendor, delhiService, 2)).toBeDefined();
    const dash = await delhiOwner.http.get('/vendors/me/dashboard').expect(200);
    expect(dash.body.pause).toMatchObject({ active: true, reason: 'Clinic renovation' });
    await delhiOwner.http.put('/vendors/me/pause').send({ active: false }).expect(200);
    expect(await firstSlot(delhiVendor, delhiService, 1)).toBeDefined();
  });

  it('shows dashboard counts and one customer’s history', async () => {
    const dash = await delhiOwner.http.get('/vendors/me/dashboard').expect(200);
    expect(dash.body.counts).toMatchObject({ upcoming: 1, completed: 0, total: 1 });
    expect(dash.body.customers).toBe(1);
    const parentId = (await parent.http.get('/users/me')).body._id;
    const history = await delhiOwner.http.get(`/bookings?as=vendor&customer=${parentId}`).expect(200);
    expect(history.body.total).toBe(1);
    const detail = await delhiOwner.http.get(`/bookings/${history.body.items[0]._id}`).expect(200);
    expect(detail.body.pet).toMatchObject({ name: 'Bruno', species: 'dog' });
    expect(detail.body.statusHistory[0].by).toMatchObject({ name: 'Asha' });
    expect(await tenantRun(() => Booking.countDocuments())).toBe(2);
    expect(await tenantRun(() => Pet.countDocuments())).toBe(1);
  });
});
