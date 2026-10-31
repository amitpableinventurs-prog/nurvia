import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Booking } from '../src/modules/bookings/booking.model.js';
import { Pet } from '../src/modules/pets/pet.model.js';
import { Review } from '../src/modules/reviews/review.model.js';
import { Service } from '../src/modules/vendors/vendor.model.js';
import { istDate, seedCategories, signUpByPhone, startDb, stopDb, tenantRun } from './helpers.js';

const BANGALORE = { lat: 12.9716, lng: 77.5946 };
const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '00:00', close: '23:59' }));

let owner, customer, vendor, service, pet;

beforeAll(async () => {
  await startDb();
  const categories = await seedCategories();
  owner = await signUpByPhone('Kiran');
  customer = await signUpByPhone('Asha');
  vendor = (
    await owner.http
      .post('/vendors')
      .send({ businessName: 'Happy Paws', categoryIds: [String(categories.vet._id)], address: { line1: '1 MG Road', city: 'Bengaluru' }, location: BANGALORE, operatingHours: ALL_WEEK })
      .expect(201)
  ).body;
  service = (await owner.http.post('/vendors/me/services').send({ name: 'Consultation', pricePaise: 60000, durationMin: 30 }).expect(201)).body;
  const customerId = (await customer.http.get('/users/me')).body._id;
  pet = await tenantRun(() => Pet.create({ owner: customerId, name: 'Bruno', species: 'dog' }));

  const now = Date.now();
  const booking = (code, startOffsetMin, status, payment = { status: 'unpaid' }) => ({
    code, user: customerId, pet: pet._id, vendor: vendor._id, vendorOwner: vendor.owner, service: service._id,
    serviceSnapshot: { name: 'Consultation', pricePaise: 60000, durationMin: 30 },
    scheduledAt: new Date(now + startOffsetMin * 60_000), endsAt: new Date(now + (startOffsetMin + 30) * 60_000), status, payment,
  });
  const paid = (daysAgo) => ({ status: 'paid', gateway: 'mock', amountPaise: 60000, paidAt: new Date(now - daysAgo * 86_400_000) });
  await tenantRun(() =>
    Booking.create([
      booking('NOW1', -10, 'accepted', paid(1)),
      booking('LATER1', 24 * 60, 'pending'),
      booking('OLD1', -3 * 24 * 60, 'completed', paid(4)),
      booking('OLD2', -4 * 24 * 60, 'no_show'),
      booking('REF1', -5 * 24 * 60, 'cancelled', { ...paid(6), status: 'refunded', refundedAt: new Date() }),
    ]),
  );
  const old = await tenantRun(() => Booking.findOne({ code: 'OLD1' }));
  const older = await tenantRun(() => Booking.findOne({ code: 'OLD2' }));
  await tenantRun(() =>
    Review.create([
      { vendor: vendor._id, booking: old._id, author: customerId, rating: 5, text: 'Lovely vet' },
      { vendor: vendor._id, booking: older._id, author: customerId, rating: 4, text: 'Good', vendorReply: { text: 'Thanks!', at: new Date() } },
    ]),
  );
});
afterAll(stopDb);

describe('vendor panel', () => {
  it('keeps people without a business out', async () => {
    await customer.http.get('/vendors/me/dashboard').expect(403);
  });

  it('summarises the day, pending requests, earnings and setup', async () => {
    const res = await owner.http.get('/vendors/me/dashboard').expect(200);
    expect(res.body.vendor).toMatchObject({ businessName: 'Happy Paws', status: 'pending', licenseStatus: 'pending_upload' });
    expect(res.body.today.inProgress).toBe(1);
    expect(res.body.pending.count).toBe(1);
    expect(res.body.pending.items[0]).toMatchObject({ code: 'LATER1', pet: { name: 'Bruno' } });
    expect(res.body.earnings.last30Paise).toBe(120000);
    expect(res.body.earnings.refunded30Paise).toBe(60000);
    expect(res.body.completionRate).toBe(33); // 1 completed of completed + no-show + cancelled
    expect(res.body.reviews.unreplied).toBe(1);
    expect(res.body.setup).toEqual({ services: true, hours: true, photos: false, kyc: false, license: false });
  });

  it('gives the sidebar the same badge counts as the dashboard, cheaply', async () => {
    const [dash, badges] = await Promise.all([owner.http.get('/vendors/me/dashboard').expect(200), owner.http.get('/vendors/me/badges').expect(200)]);
    expect(badges.body).toEqual({ vendor: dash.body.vendor, pending: { count: dash.body.pending.count }, reviews: { unreplied: dash.body.reviews.unreplied }, pause: dash.body.pause });
    await customer.http.get('/vendors/me/badges').expect(403);
  });

  it('returns an earnings statement with a daily series', async () => {
    const res = await owner.http.get('/vendors/me/earnings').expect(200);
    expect(res.body.totals).toEqual({ grossPaise: 180000, refundedPaise: 60000, netPaise: 120000, count: 3 });
    expect(res.body.daily).toHaveLength(3);
    expect(res.body.transactions[0]).toMatchObject({ code: 'NOW1', customer: 'Asha', paymentStatus: 'paid' });
    await owner.http.get('/vendors/me/earnings?from=2020-01-01&to=2026-01-01').expect(400);
  });

  it('lists reviews still waiting on a reply', async () => {
    const all = await owner.http.get('/vendors/me/reviews').expect(200);
    expect(all.body.total).toBe(2);
    const open = await owner.http.get('/vendors/me/reviews?unreplied=true').expect(200);
    expect(open.body.items.map((r) => r.text)).toEqual(['Lovely vet']);
  });

  it('filters the booking list to one local day', async () => {
    const tomorrow = await owner.http.get(`/bookings?as=vendor&date=${istDate(1)}`).expect(200);
    const today = await owner.http.get(`/bookings?as=vendor&date=${istDate(0)}`).expect(200);
    expect([...tomorrow.body.items, ...today.body.items].map((b) => b.code)).toContain('LATER1');
    expect(today.body.items.map((b) => b.code)).toContain('NOW1');
    await owner.http.get('/bookings?as=vendor&date=tomorrow').expect(400);
  });

  it('includes the licence status on the profile', async () => {
    const me = await owner.http.get('/vendors/me').expect(200);
    expect(me.body.licenseStatus).toBe('pending_upload');
    expect(await tenantRun(() => Service.countDocuments({ vendor: vendor._id }))).toBe(1);
  });
});
