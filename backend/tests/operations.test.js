import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Booking } from '../src/modules/bookings/booking.model.js';
import { Category } from '../src/modules/categories/category.model.js';
import { HealthRecord, Pet } from '../src/modules/pets/pet.model.js';
import { Product } from '../src/modules/shop/shop.model.js';
import { Vendor } from '../src/modules/vendors/vendor.model.js';
import { api, createAdmin, seedCategories, signUpByPhone, startDb, stopDb, tenantRun } from './helpers.js';

// Phase 1 gaps and Phase 2 operations: passport additions, NFC, SOS, vendor workspace and vertical
// records, marketplace aftercare, seller onboarding and settlements, loyalty, plans and admin tools.

const BLR = { lat: 12.9716, lng: 77.5946 };
const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '00:00', close: '23:59' }));
const point = ({ lat, lng }) => ({ type: 'Point', coordinates: [lng, lat] });
const userId = async (who) => (await who.http.get('/users/me')).body._id;

let admin, owner, parent, vendor, service, pet, categories;

async function completedPaidBooking({ amount = 60000, daysAgo = 1 } = {}) {
  const at = new Date(Date.now() - daysAgo * 86_400_000);
  return tenantRun(() =>
    Booking.create({
      code: `T${Math.random().toString(36).slice(2, 9).toUpperCase()}`,
      user: parent.id, pet: pet._id, vendor: vendor._id, vendorOwner: vendor.owner, service: service._id,
      serviceSnapshot: { name: 'Consultation', pricePaise: amount, durationMin: 30 },
      scheduledAt: at, endsAt: new Date(at.getTime() + 30 * 60_000), status: 'accepted',
      payment: { status: 'paid', gateway: 'mock', paymentId: 'pay_mock_1', amountPaise: amount, paidAt: at },
    }),
  );
}

beforeAll(async () => {
  await startDb();
  categories = await seedCategories();
  admin = await createAdmin();
  owner = await signUpByPhone('Kiran');
  parent = await signUpByPhone('Asha');
  parent.id = await userId(parent);
  vendor = (
    await owner.http
      .post('/vendors')
      .send({ businessName: 'Happy Paws', categoryIds: [String(categories.vet._id)], address: { line1: '1 MG Road', city: 'Bengaluru' }, location: BLR, operatingHours: ALL_WEEK })
      .expect(201)
  ).body;
  await tenantRun(() => Vendor.updateOne({ _id: vendor._id }, { status: 'active', 'kyc.status': 'approved' }));
  service = (await owner.http.post('/vendors/me/services').send({ name: 'Consultation', pricePaise: 60000, durationMin: 30 }).expect(201)).body;
  pet = (await parent.http.post('/pets').send({ name: 'Bruno', species: 'dog', allergies: ['chicken'], conditions: ['hip dysplasia'] }).expect(201)).body;
});

afterAll(stopDb);

describe('pet passport additions', () => {
  it('reports core vaccines as recorded, overdue or missing', async () => {
    await parent.http.post(`/pets/${pet._id}/records`).send({ type: 'vaccination', title: 'Anti-rabies', date: '2025-01-10', nextDueDate: '2026-01-10' }).expect(201);
    const { body } = await parent.http.get(`/pets/${pet._id}/care-status`).expect(200);
    expect(body.coreVaccines.find((v) => v.key === 'rabies').status).toBe('overdue');
    expect(body.coreVaccines.find((v) => v.key === 'dhpp').status).toBe('missing');
    expect(body.conditions).toEqual(['hip dysplasia']);
    expect(body.disclaimer).toMatch(/not a substitute/);
  });

  it('lists reminders across pets and builds a timeline', async () => {
    await parent.http.post(`/pets/${pet._id}/reminders`).send({ kind: 'deworming', title: 'Deworm Bruno', dueAt: new Date(Date.now() + 86_400_000).toISOString() }).expect(201);
    const reminders = await parent.http.get('/reminders?days=7').expect(200);
    expect(reminders.body).toHaveLength(1);
    expect(reminders.body[0]).toMatchObject({ kind: 'deworming', pet: { name: 'Bruno' }, overdue: false });
    const timeline = await parent.http.get(`/pets/${pet._id}/timeline`).expect(200);
    expect(timeline.body.items.some((e) => e.kind === 'health_record' && e.title === 'Anti-rabies')).toBe(true);
  });
});

describe('NFC identity and recovery', () => {
  let tags;

  it('lets staff mint tags and an owner activate one', async () => {
    tags = (await admin.http.post('/admin/nfc/tags').send({ count: 3, batch: 'pilot' }).expect(201)).body;
    expect(tags[0].publicUrl).toMatch(/\/t\//);
    await parent.http.post('/nfc/tags/activate').send({ code: tags[0].serial, petId: pet._id }).expect(200);
    // A tag already linked to a pet cannot be taken over by someone else.
    const other = await signUpByPhone('Ravi');
    const otherPet = (await other.http.post('/pets').send({ name: 'Moti', species: 'dog' }).expect(201)).body;
    await other.http.post('/nfc/tags/activate').send({ code: tags[0].code, petId: otherPet._id }).expect(409);
  });

  it('shows only what the owner allows and tells the owner when a finder reports', async () => {
    const view = await api().get(`/nfc/t/${tags[0].code}`).expect(200);
    expect(view.body.pet).toMatchObject({ name: 'Bruno', allergies: ['chicken'] });
    expect(view.body.pet.conditions).toBeUndefined();
    expect(view.body.owner.phone).toBeUndefined();
    expect(view.body.owner.firstName).toBe('Asha');

    await parent.http.put(`/pets/${pet._id}/lost`).send({ active: true, lastSeenArea: 'Indiranagar' }).expect(200);
    expect((await api().get(`/nfc/t/${tags[0].code}`).expect(200)).body.lost).toMatchObject({ lastSeenArea: 'Indiranagar' });

    await api().post(`/nfc/t/${tags[0].code}/found`).send({ message: 'He is with me near the metro', phone: '+919800000001', location: BLR }).expect(201);
    const notes = await parent.http.get('/notifications').expect(200);
    expect(notes.body.items.some((n) => n.type === 'nfc.found_report')).toBe(true);
    const [tag] = (await parent.http.get('/nfc/tags').expect(200)).body;
    const scans = await parent.http.get(`/nfc/tags/${tag._id}/scans`).expect(200);
    expect(scans.body.items.map((s) => s.kind)).toEqual(expect.arrayContaining(['view', 'found_report']));
    expect(scans.body.items[0].ipHash).toBeUndefined();
  });

  it('replaces a lost tag and stops the old one working', async () => {
    const [tag] = (await parent.http.get('/nfc/tags').expect(200)).body;
    await parent.http.post(`/nfc/tags/${tag._id}/replace`).send({ code: tags[1].code }).expect(200);
    await api().get(`/nfc/t/${tags[0].code}`).expect(404);
    expect((await api().get(`/nfc/t/${tags[1].code}`).expect(200)).body.pet.name).toBe('Bruno');
    await parent.http.put(`/pets/${pet._id}/lost`).send({ active: false }).expect(200);
  });
});

describe('SOS and Lost & Found', () => {
  it('stays off until the switch is turned on', async () => {
    const off = await parent.http.get('/sos/incidents').expect(403);
    expect(off.body.error.code).toBe('FEATURE_DISABLED');
    await admin.http.patch('/admin/platform/features').send({ sos: true }).expect(200);
  });

  it('alerts nearby responders and tracks the response to resolution', async () => {
    const volunteer = await signUpByPhone('Volunteer');
    await volunteer.http.put('/sos/responder').send({ kind: 'ngo', organisation: 'CARE', location: BLR, radiusKm: 5 }).expect(200);
    const far = await signUpByPhone('Far away');
    await far.http.put('/sos/responder').send({ kind: 'volunteer', location: { lat: 28.61, lng: 77.2 }, radiusKm: 5 }).expect(200);

    const incident = (await parent.http.post('/sos/incidents').send({ type: 'injured_animal', description: 'Dog hit by a scooter, bleeding', location: BLR, contactPhone: '+919811111111' }).expect(201)).body;
    expect(incident.alertedCount).toBeGreaterThanOrEqual(1);
    expect((await volunteer.http.get('/notifications').expect(200)).body.items.some((n) => n.type === 'sos.injured_animal')).toBe(true);
    expect((await far.http.get('/notifications').expect(200)).body.items.some((n) => n.type === 'sos.injured_animal')).toBe(false);

    // The reporter's phone is shared only with people who respond.
    expect((await volunteer.http.get(`/sos/incidents/${incident._id}`).expect(200)).body.contactPhone).toBeUndefined();
    await volunteer.http.post(`/sos/incidents/${incident._id}/respond`).send({}).expect(200);
    expect((await volunteer.http.get(`/sos/incidents/${incident._id}`).expect(200)).body.contactPhone).toBe('+919811111111');

    await parent.http.post(`/sos/incidents/${incident._id}/status`).send({ status: 'help_on_way' }).expect(403);
    await volunteer.http.post(`/sos/incidents/${incident._id}/status`).send({ status: 'help_on_way' }).expect(200);
    await volunteer.http.post(`/sos/incidents/${incident._id}/status`).send({ status: 'resolved' }).expect(400);
    const done = await volunteer.http.post(`/sos/incidents/${incident._id}/status`).send({ status: 'resolved', outcome: 'treated' }).expect(200);
    expect(done.body.status).toBe('resolved');
  });

  it('puts a pet in lost mode and matches found reports nearby', async () => {
    const lost = (await parent.http.post('/sos/incidents').send({ type: 'lost_pet', petId: pet._id, description: 'Bruno slipped his collar', location: BLR, area: 'Indiranagar' }).expect(201)).body;
    expect((await parent.http.get(`/pets/${pet._id}`).expect(200)).body.lost.active).toBe(true);
    const finder = await signUpByPhone('Finder');
    await finder.http.post('/sos/incidents').send({ type: 'found_pet', species: 'dog', description: 'Brown indie with a red collar', location: { lat: 12.975, lng: 77.6 } }).expect(201);
    expect((await parent.http.get(`/sos/incidents/${lost._id}/matches`).expect(200)).body).toHaveLength(1);
    await parent.http.post(`/sos/incidents/${lost._id}/status`).send({ status: 'resolved', outcome: 'reunited' }).expect(200);
    expect((await parent.http.get(`/pets/${pet._id}`).expect(200)).body.lost.active).toBe(false);
  });
});

describe('vendor workspace: staff, CRM and appointments', () => {
  let receptionist, groomer, staffIds, customer;

  it('adds staff who sign in with their own number and get their role’s access', async () => {
    receptionist = await signUpByPhone('Rita');
    groomer = await signUpByPhone('Gopal');
    const r = await owner.http.post('/vendors/me/staff').send({ name: 'Rita', phone: receptionist.phone, role: 'receptionist' }).expect(201);
    const g = await owner.http.post('/vendors/me/staff').send({ name: 'Gopal', phone: groomer.phone, role: 'groomer' }).expect(201);
    staffIds = { receptionist: r.body._id, groomer: g.body._id };
    const ws = await receptionist.http.get('/vendors/me/workspace').expect(200);
    expect(ws.body).toMatchObject({ role: 'receptionist', vendor: { businessName: 'Happy Paws' } });
    expect(ws.body.capabilities).toContain('customers.manage');
    expect(ws.body.capabilities).not.toContain('reports.read');
    await receptionist.http.post('/vendors/me/staff').send({ name: 'X', phone: '+919822222222', role: 'vet' }).expect(403);
  });

  it('keeps customers from outside Nurvia and Nurvia bookings in one CRM', async () => {
    customer = (await receptionist.http.post('/vendors/me/customers').send({ name: 'Walk-in Wendy', phone: '+919833333333', source: 'walk_in', pets: [{ name: 'Fluffy', species: 'cat' }] }).expect(201)).body;
    await groomer.http.post('/vendors/me/customers').send({ name: 'Nope' }).expect(403);
    await parent.http.post('/bookings').send({ vendorId: vendor._id, serviceId: service._id, petId: pet._id, scheduledAt: new Date(Date.now() + 2 * 86_400_000).toISOString() }).expect(201);
    const list = await owner.http.get('/vendors/me/customers').expect(200);
    expect(list.body.items.map((c) => c.source).sort()).toEqual(['nurvia', 'walk_in']);
    const nurvia = list.body.items.find((c) => c.source === 'nurvia');
    expect(nurvia.pets[0]).toMatchObject({ name: 'Bruno', pet: pet._id });
  });

  it('books recurring appointments and refuses to double-book a staff member', async () => {
    const start = new Date(Date.now() + 3 * 86_400_000);
    const series = await receptionist.http
      .post('/vendors/me/appointments')
      .send({ customerId: customer._id, serviceName: 'Bath', pricePaise: 50000, durationMin: 60, scheduledAt: start.toISOString(), staffId: staffIds.groomer, recurrence: { rule: 'weekly', count: 3 } })
      .expect(201);
    expect(series.body).toHaveLength(3);
    await receptionist.http.post('/vendors/me/appointments').send({ customerId: customer._id, serviceName: 'Nails', scheduledAt: new Date(start.getTime() + 30 * 60_000).toISOString(), staffId: staffIds.groomer }).expect(409);

    const calendar = await groomer.http.get(`/vendors/me/calendar?from=${new Date().toISOString()}&to=${new Date(Date.now() + 30 * 86_400_000).toISOString()}`).expect(200);
    expect(calendar.body.items.filter((i) => i.source === 'vendor')).toHaveLength(3);
    expect(calendar.body.items.some((i) => i.source === 'nurvia')).toBe(true);

    // The assigned groomer can complete their own appointment; the visit is counted on the customer.
    await groomer.http.post(`/vendors/me/appointments/${series.body[0]._id}/status`).send({ status: 'completed' }).expect(200);
    const detail = await owner.http.get(`/vendors/me/customers/${customer._id}`).expect(200);
    expect(detail.body.visitCount).toBe(1);
    const cancelled = await receptionist.http.post(`/vendors/me/appointments/${series.body[1]._id}/status`).send({ status: 'cancelled', series: true }).expect(200);
    expect(cancelled.body.cancelled).toBe(2);
  });

  it('tracks follow-ups and packages', async () => {
    await receptionist.http.post(`/vendors/me/customers/${customer._id}/notes`).send({ text: 'Call about the coat', followUpAt: new Date().toISOString() }).expect(201);
    expect((await receptionist.http.get('/vendors/me/follow-ups').expect(200)).body).toHaveLength(1);
    const pkg = await owner.http.post('/vendors/me/packages').send({ name: '5 baths', sessions: 5, pricePaise: 200000, validityDays: 90 }).expect(201);
    const sold = await receptionist.http.post(`/vendors/me/customers/${customer._id}/packages`).send({ packageId: pkg.body._id }).expect(201);
    expect(sold.body).toMatchObject({ sessionsTotal: 5, sessionsUsed: 0 });
    const report = await owner.http.get(`/vendors/me/reports?from=${new Date(Date.now() - 86_400_000).toISOString()}&to=${new Date(Date.now() + 60 * 86_400_000).toISOString()}`).expect(200);
    expect(report.body.appointments.completedCount).toBe(1);
    expect(report.body.packages.sold).toBe(1);
    await receptionist.http.get('/vendors/me/reports?from=2026-01-01&to=2026-02-01').expect(403);
  });
});

describe('vertical visit records and approved record sync', () => {
  it('sends a vet record to the passport only when the owner accepts it', async () => {
    const booking = await completedPaidBooking();
    const visit = (
      await owner.http
        .post('/vendors/me/visits')
        .send({ kind: 'vet', bookingId: booking._id, summary: 'Ear infection', data: { diagnosis: 'Otitis externa', prescriptions: [{ drug: 'Otomax', dose: '4 drops', frequency: 'twice daily', durationDays: 7 }], followUpAt: new Date(Date.now() + 7 * 86_400_000).toISOString() } })
        .expect(201)
    ).body;
    await owner.http.post('/vendors/me/visits').send({ kind: 'vet', bookingId: booking._id, data: { notAField: true } }).expect(400);
    const before = await tenantRun(() => HealthRecord.countDocuments({ pet: pet._id }));
    const shared = await owner.http.post(`/vendors/me/visits/${visit._id}/share`).expect(200);
    expect(shared.body.recordShare.status).toBe('pending');
    expect(await tenantRun(() => HealthRecord.countDocuments({ pet: pet._id }))).toBe(before);

    const pending = await parent.http.get('/record-shares').expect(200);
    expect(pending.body).toHaveLength(1);
    const accepted = await parent.http.post(`/record-shares/${pending.body[0]._id}/accept`).send({ remindFollowUp: true }).expect(200);
    expect(accepted.body.healthRecord).toMatchObject({ type: 'prescription', title: 'Ear infection' });
    await parent.http.post(`/record-shares/${pending.body[0]._id}/accept`).send({}).expect(409);
    const visits = await parent.http.get(`/pets/${pet._id}/visits`).expect(200);
    expect(visits.body.items[0]).toMatchObject({ kind: 'vet', summary: 'Ear infection' });
  });

  it('records walks with start, end and a route only when the owner allowed it', async () => {
    const booking = await completedPaidBooking();
    const walk = (await owner.http.post('/vendors/me/visits').send({ kind: 'walk', bookingId: booking._id, data: { pickupAddress: 'Gate 2' } }).expect(201)).body;
    await owner.http.post(`/vendors/me/visits/${walk._id}/start`).expect(200);
    await owner.http.post(`/vendors/me/visits/${walk._id}/route`).send({ points: [{ ...BLR, at: new Date().toISOString() }] }).expect(403);
    await owner.http.patch(`/vendors/me/visits/${walk._id}`).send({ data: { routeConsent: true } }).expect(200);
    await owner.http.post(`/vendors/me/visits/${walk._id}/route`).send({ points: [{ ...BLR, at: new Date().toISOString() }] }).expect(200);
    const ended = await owner.http.post(`/vendors/me/visits/${walk._id}/end`).expect(200);
    expect(ended.body.data).toMatchObject({ pickupAddress: 'Gate 2', routeConsent: true });
    expect(typeof ended.body.data.durationMin).toBe('number');
  });
});

describe('discovery filters', () => {
  it('defaults to 5 km, filters by price and suggests a wider radius when results are few', async () => {
    const near = await api().get(`/vendors?lat=${BLR.lat}&lng=${BLR.lng}`).expect(200);
    expect(near.body.radiusKm).toBe(5);
    expect(near.body.items[0]).toMatchObject({ bookable: true, priceRange: { minPaise: 60000, maxPaise: 60000 } });
    expect(near.body.suggestExpand).toEqual({ radiusKm: 10 });
    expect((await api().get(`/vendors?lat=${BLR.lat}&lng=${BLR.lng}&maxPrice=50000`).expect(200)).body.total).toBe(0);
    expect((await api().get(`/vendors?lat=${BLR.lat}&lng=${BLR.lng}&nearby=all`).expect(200)).body.suggestExpand).toBeNull();
    expect((await api().get(`/vendors?lat=${BLR.lat}&lng=${BLR.lng}&verified=true`).expect(200)).body.total).toBe(0);
  });
});

describe('settlements and commission', () => {
  it('settles completed paid bookings once, with commission', async () => {
    await admin.http.put('/admin/finance/commission').send({ bookingPct: 10, marketplacePct: 12, reason: 'Launch rates' }).expect(200);
    const from = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const to = new Date().toISOString();
    // Only completed bookings settle; the paid ones created above are still accepted.
    expect((await admin.http.get(`/admin/finance/settlements/preview?vendorId=${vendor._id}&from=${from}&to=${to}`).expect(200)).body.lines).toHaveLength(0);
    await tenantRun(() => Booking.updateMany({ vendor: vendor._id, 'payment.status': 'paid' }, { status: 'completed' }));
    const preview = await admin.http.get(`/admin/finance/settlements/preview?vendorId=${vendor._id}&from=${from}&to=${to}`).expect(200);
    expect(preview.body.lines.length).toBeGreaterThanOrEqual(2);
    expect(preview.body.lines[0]).toMatchObject({ kind: 'booking', grossPaise: 60000, commissionPaise: 6000, netPaise: 54000 });

    const run = await admin.http.post('/admin/finance/settlements').send({ from, to, vendorId: vendor._id }).expect(201);
    expect(run.body.created).toHaveLength(1);
    const again = await admin.http.post('/admin/finance/settlements').send({ from, to, vendorId: vendor._id }).expect(201);
    expect(again.body.created).toHaveLength(0);

    const id = run.body.created[0]._id;
    await admin.http.post(`/admin/finance/settlements/${id}/mark_paid`).send({ payoutReference: 'UTR1' }).expect(409);
    await admin.http.post(`/admin/finance/settlements/${id}/approve`).send({}).expect(200);
    await admin.http.post(`/admin/finance/settlements/${id}/mark_paid`).send({}).expect(400);
    await admin.http.post(`/admin/finance/settlements/${id}/mark_paid`).send({ payoutReference: 'UTR1' }).expect(200);
    const mine = await owner.http.get('/vendors/me/settlements').expect(200);
    expect(mine.body.items[0]).toMatchObject({ status: 'paid', payoutReference: 'UTR1' });
  });
});

describe('seller onboarding and marketplace aftercare', () => {
  let shopOwner, shopVendor, product, food;
  const sellerProfile = {
    legalName: 'Rohit Pet Supplies LLP',
    gstin: '29AAACR5055K1Z5',
    bank: { accountName: 'Rohit Pet Supplies', accountNumber: '123456789012', ifsc: 'HDFC0001234' },
    pickupAddress: { line1: '3 Jayanagar', city: 'Bengaluru', pincode: '560011' },
  };

  beforeAll(async () => {
    shopOwner = await signUpByPhone('Rohit');
    food = await tenantRun(() => Category.create({ kind: 'product', name: 'Food', slug: 'food' }));
    shopVendor = (
      await shopOwner.http.post('/vendors').send({ businessName: 'Rohit Pets', categoryIds: [String(categories.vet._id)], address: { line1: '3 Jayanagar', city: 'Bengaluru' }, location: BLR }).expect(201)
    ).body;
    await tenantRun(() => Vendor.updateOne({ _id: shopVendor._id }, { status: 'active' }));
  });

  it('shows products in the shop only once the seller profile is approved, and never returns the account number', async () => {
    const productBody = { name: 'Kibble', slug: 'kibble', categoryId: food._id, variants: [{ sku: 'K1', label: '1 kg', mrpPaise: 50000, pricePaise: 45000, stock: 10 }] };
    product = (await shopOwner.http.post('/shop/seller/products').send(productBody).expect(201)).body;
    await api().get('/shop/products/kibble').expect(404);
    const upload = await shopOwner.http.post('/files').field('purpose', 'seller_kyc').attach('file', Buffer.from('%PDF-1.4\n%x\n'), 'gst.pdf').expect(201);
    const applied = await shopOwner.http.put('/shop/seller/profile').send({ ...sellerProfile, documents: [{ type: 'gst_certificate', fileId: upload.body._id }] }).expect(200);
    expect(applied.body.status).toBe('submitted');
    expect(JSON.stringify(applied.body)).not.toContain('123456789012');
    expect(applied.body.bank.accountNumberLast4).toBe('9012');
    const stored = await tenantRun(() => Vendor.findById(shopVendor._id).select('+sellerBankAccountEnc').lean());
    expect(stored.sellerBankAccountEnc).toMatch(/^v1\./);

    await admin.http.post(`/admin/sellers/${shopVendor._id}/review`).send({ action: 'approve', commissionPct: 8 }).expect(200);
    await api().get('/shop/products/kibble').expect(200);
    expect((await api().get(`/vendors/${shopVendor._id}`).expect(200)).body.seller).toBeUndefined();
  });

  it('returns delivered items and refunds the share actually paid', async () => {
    const address = { name: 'Asha', phone: '+919845000000', line1: '12 CMH Road', city: 'Bengaluru', pincode: '560038' };
    const order = (await parent.http.post('/shop/orders').send({ items: [{ productId: product._id, sku: 'K1', qty: 2 }], address, paymentMethod: 'cod' }).expect(201)).body;
    await parent.http.post(`/shop/products/kibble/reviews`).send({ rating: 5 }).expect(403);
    await parent.http.post(`/shop/orders/${order._id}/returns`).send({ items: [{ sku: 'K1', qty: 1 }], reason: 'damaged' }).expect(409);
    for (const status of ['confirmed', 'shipped', 'delivered']) await shopOwner.http.post(`/shop/seller/orders/${order._id}/status`).send({ status }).expect(200);

    await parent.http.post(`/shop/orders/${order._id}/returns`).send({ items: [{ sku: 'K1', qty: 3 }], reason: 'damaged' }).expect(400);
    const [ret] = (await parent.http.post(`/shop/orders/${order._id}/returns`).send({ items: [{ sku: 'K1', qty: 1 }], reason: 'damaged' }).expect(201)).body;
    await shopOwner.http.post(`/shop/seller/returns/${ret._id}/decision`).send({ action: 'refund' }).expect(409);
    await shopOwner.http.post(`/shop/seller/returns/${ret._id}/decision`).send({ action: 'approve' }).expect(200);
    await shopOwner.http.post(`/shop/seller/returns/${ret._id}/decision`).send({ action: 'mark_received', restock: true }).expect(200);
    const refunded = await shopOwner.http.post(`/shop/seller/returns/${ret._id}/decision`).send({ action: 'refund' }).expect(200);
    expect(refunded.body.refund).toMatchObject({ amountPaise: 45000, method: 'manual' });
    expect((await tenantRun(() => Product.findById(product._id).lean())).variants[0].stock).toBe(9);

    await parent.http.post(`/shop/products/kibble/reviews`).send({ rating: 4, text: 'Bruno loves it' }).expect(201);
    await parent.http.post(`/shop/products/kibble/reviews`).send({ rating: 1 }).expect(409);
    expect((await api().get('/shop/products/kibble/reviews').expect(200)).body).toMatchObject({ ratingAvg: 4, ratingCount: 1 });
  });

  it('keeps a wishlist on the server', async () => {
    await parent.http.put(`/shop/wishlist/items/${product._id}`).send({ sku: 'K1' }).expect(200);
    await parent.http.put(`/shop/wishlist/items/${product._id}`).send({}).expect(200);
    const list = await parent.http.get('/shop/wishlist').expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].product.name).toBe('Kibble');

    // The seller sees how many people saved the product, never who.
    const saved = await shopOwner.http.get('/shop/seller/wishlist').expect(200);
    expect(saved.body).toMatchObject({ total: 1, items: [{ savedCount: 1, product: { name: 'Kibble' } }] });
    expect(JSON.stringify(saved.body)).not.toContain(parent.user._id);
    await parent.http.get('/shop/seller/wishlist').expect(403);
  });
});

describe('referrals and loyalty', () => {
  it('rewards both people when the referred user’s first booking completes', async () => {
    const { body: me } = await parent.http.get('/loyalty/me').expect(200);
    const friend = await signUpByPhone('Friend');
    await friend.http.post('/loyalty/referrals/apply').send({ code: me.referral.code }).expect(201);
    await friend.http.post('/loyalty/referrals/apply').send({ code: me.referral.code }).expect(409);
    await parent.http.post('/loyalty/referrals/apply').send({ code: me.referral.code }).expect(400);

    const friendId = await userId(friend);
    const friendPet = await tenantRun(() => Pet.create({ owner: friendId, name: 'Kuku', species: 'cat' }));
    const at = new Date(Date.now() - 3_600_000);
    const booking = await tenantRun(() =>
      Booking.create({
        code: 'REFTEST1', user: friendId, pet: friendPet._id, vendor: vendor._id, vendorOwner: vendor.owner, service: service._id,
        serviceSnapshot: { name: 'Consultation', pricePaise: 60000, durationMin: 30 }, scheduledAt: at, endsAt: new Date(at.getTime() + 1_800_000),
        status: 'accepted', payment: { status: 'paid', amountPaise: 60000, paymentId: 'pay_x', paidAt: at },
      }),
    );
    await owner.http.post(`/bookings/${booking._id}/actions`).send({ action: 'complete' }).expect(200);
    const after = await parent.http.get('/loyalty/me').expect(200);
    expect(after.body.points).toBe(me.points + 100);
    const friendPoints = (await friend.http.get('/loyalty/me').expect(200)).body.points;
    expect(friendPoints).toBe(50 + 6); // referral bonus + 1 point per ₹100 paid
  });
});

describe('plans and admin tools', () => {
  it('enforces a plan’s staff limit', async () => {
    const plan = await admin.http.post('/admin/plans').send({ code: 'starter', name: 'Starter', audience: 'vendor', pricePaise: 99900, limits: { staff: 2 } }).expect(201);
    expect((await api().get('/plans?audience=vendor').expect(200)).body[0].code).toBe('starter');
    await admin.http.put(`/admin/vendors/${vendor._id}/subscription`).send({ planId: plan.body._id, reason: 'Pilot' }).expect(200);
    const res = await owner.http.post('/vendors/me/staff').send({ name: 'Third', phone: '+919844444444', role: 'vet' }).expect(402);
    expect(res.body.error.code).toBe('PLAN_LIMIT');
    expect((await owner.http.get('/vendors/me/subscription').expect(200)).body.usage.staff).toBe(2);
  });

  it('shows pets without private health details, and refunds bookings on request', async () => {
    const view = await admin.http.get(`/admin/pets/${pet._id}`).expect(200);
    expect(view.body.recordCounts.vaccination).toBe(1);
    expect(view.body.conditions).toBeUndefined();
    expect(view.body.tags.length).toBeGreaterThan(0);

    const booking = await completedPaidBooking({ amount: 80000 });
    await admin.http.post(`/admin/bookings/${booking._id}/actions`).send({ action: 'refund', amountPaise: 90000, reason: 'Dispute' }).expect(400);
    const refunded = await admin.http.post(`/admin/bookings/${booking._id}/actions`).send({ action: 'refund', amountPaise: 30000, reason: 'Late start' }).expect(200);
    expect(refunded.body.payment.status).toBe('refunded');
    const payments = await admin.http.get('/admin/payments?status=refunded').expect(200);
    expect(payments.body.items.some((p) => p.code === booking.code && p.kind === 'booking')).toBe(true);

    const staff = await createAdmin('staff');
    await staff.http.post(`/admin/bookings/${booking._id}/actions`).send({ action: 'cancel', reason: 'test' }).expect(403);
    await staff.http.post('/admin/coupons').send({ code: 'NOPE10', type: 'percent', value: 10 }).expect(403);
    await admin.http.post('/admin/coupons').send({ code: 'DIWALI20', type: 'percent', value: 20, maxDiscountPaise: 20000 }).expect(201);
  });

  it('lets staff edit a vendor listing, with an audit entry', async () => {
    await admin.http.patch(`/admin/vendors/${vendor._id}`).send({ description: 'Fixed typo', reason: 'Vendor asked by phone' }).expect(200);
    const audit = await admin.http.get('/admin/audit?action=vendor.edit').expect(200);
    expect(audit.body.items.some((a) => a.action === 'vendor.edit')).toBe(true);
  });
});
