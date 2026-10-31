// The grooming booking flow screens: summary, securing the slot (with alternatives), confirmation,
// My Appointments and appointment details, plus the vendor's desk check-in and passport view.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Booking, SlotHold } from '../src/modules/bookings/booking.model.js';
import { sendAppointmentReminders } from '../src/modules/bookings/booking.service.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { VendorStaff } from '../src/modules/operations/operations.model.js';
import { HealthRecord } from '../src/modules/pets/pet.model.js';
import { User } from '../src/modules/users/user.model.js';
import { Service, Vendor } from '../src/modules/vendors/vendor.model.js';
import { api, istDate, signUpByPhone, startDb, stopDb, tenantRun } from './helpers.js';

const INDIRANAGAR = { lat: 12.9784, lng: 77.6408 };
const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '09:00', close: '18:00' }));
const HOUR = 3_600_000;

let owner, parent, rival, vendor, service, teeth, groomer, bruno, mishti, rex;

const pick = (overrides = {}) => ({ vendorId: vendor._id, serviceId: service._id, petId: bruno._id, addOnIds: [teeth._id], ...overrides });
const slotsOn = async (days, query = `&addOnIds=${teeth._id}`) =>
  (await api().get(`/vendors/${vendor._id}/availability?serviceId=${service._id}&date=${istDate(days)}${query}`).expect(200)).body;
// Moves a booking's times directly, for what happens close to the visit.
const moveTo = (id, startsInMs) =>
  tenantRun(() => Booking.updateOne({ _id: id }, { scheduledAt: new Date(Date.now() + startsInMs), endsAt: new Date(Date.now() + startsInMs + 105 * 60_000) }));

beforeAll(async () => {
  await startDb();
  owner = await signUpByPhone('Kiran');
  parent = await signUpByPhone('Asha');
  rival = await signUpByPhone('Meera');
  await tenantRun(async () => {
    await User.updateOne({ _id: owner.user._id }, { $addToSet: { roles: 'vendor' } });
    await User.updateOne({ _id: parent.user._id }, { location: { type: 'Point', coordinates: [77.6345, 12.9719] } });
    vendor = await Vendor.create({
      owner: owner.user._id,
      businessName: 'Happy Paws Grooming',
      phone: '+919845000099',
      address: { line1: '12th Main Road', city: 'Bengaluru' },
      location: { type: 'Point', coordinates: [INDIRANAGAR.lng, INDIRANAGAR.lat] },
      operatingHours: ALL_WEEK,
      arrivalInstructions: 'Please arrive 10 minutes early with your dog on a leash.',
      status: 'active',
      kyc: { status: 'approved', licenseCheck: { status: 'verified' } },
    });
    service = await Service.create({
      vendor: vendor._id,
      name: 'Full Grooming',
      pricePaise: 79900,
      durationMin: 90,
      species: ['dog'],
      addOns: [{ name: 'Teeth Cleaning & Fresh Breath', pricePaise: 14900, durationMin: 15 }],
    });
    teeth = service.addOns[0];
    groomer = await VendorStaff.create({ vendor: vendor._id, user: rival.user._id, name: 'Avinash K.', phone: '+919845000098', role: 'groomer', title: 'Master Canine Stylist', experienceYears: 6 });
  });
  bruno = (await parent.http.post('/pets').send({ name: 'Bruno', species: 'dog', breed: 'Golden Retriever', weightKg: 31.5, conditions: ['Dermatitis: oatmeal shampoo only'] }).expect(201)).body;
  mishti = (await parent.http.post('/pets').send({ name: 'Mishti', species: 'cat' }).expect(201)).body;
  rex = (await rival.http.post('/pets').send({ name: 'Rex', species: 'dog' }).expect(201)).body;
  // A rabies vaccination a clinic shared, so it counts as verified.
  await tenantRun(() =>
    HealthRecord.create({ pet: bruno._id, owner: parent.user._id, type: 'vaccination', title: 'Rabies', date: new Date(Date.now() - 30 * 24 * HOUR), nextDueDate: new Date(Date.now() + 300 * 24 * HOUR), source: 'clinic' }),
  );
});
afterAll(stopDb);

describe('booking summary', () => {
  it('lists the people a customer can choose, without contact details', async () => {
    const { body } = await api().get(`/vendors/${vendor._id}/staff`).expect(200);
    expect(body.items).toEqual([{ _id: String(groomer._id), name: 'Avinash K.', role: 'groomer', title: 'Master Canine Stylist', experienceYears: 6, ratingAvg: null, ratingCount: 0 }]);
  });

  it('fits fewer start times once an add-on lengthens the visit', async () => {
    const plain = await slotsOn(2, '');
    const withTeeth = await slotsOn(2);
    expect([plain.durationMin, withTeeth.durationMin]).toEqual([90, 105]);
    expect(withTeeth.slots.length).toBeLessThan(plain.slots.length);
  });

  it('prices the visit with add-ons and shows what the passport would share', async () => {
    const [scheduledAt] = (await slotsOn(2)).slots;
    const { body } = await parent.http.post('/bookings/quote').send(pick({ scheduledAt, staffId: groomer._id })).expect(200);
    expect(body).toMatchObject({
      vendor: { businessName: 'Happy Paws Grooming', verified: true },
      pet: { name: 'Bruno', breed: 'Golden Retriever', weightKg: 31.5 },
      staff: { name: 'Avinash K.', title: 'Master Canine Stylist' },
      slot: { available: true },
      pricing: { totalPaise: 94800, durationMin: 105, taxesIncluded: true, fees: [{ key: 'convenience_fee', amountPaise: 0 }] },
      paymentModes: [{ key: 'pay_at_provider', default: true }, { key: 'online' }],
      policy: { hoursBefore: 2, canReschedule: true },
    });
    expect(body.pricing.lines.map((l) => [l.kind, l.pricePaise, l.durationMin])).toEqual([['service', 79900, 90], ['add_on', 14900, 15]]);
    expect(new Date(scheduledAt) - new Date(body.policy.freeCancellationUntil)).toBe(2 * HOUR);
    expect(body.vendor.distanceKm).toBeGreaterThan(0);
    expect(body.passport.coreVaccines.find((v) => v.key === 'rabies')).toMatchObject({ status: 'recorded', verified: true });
    expect(body.passport.alerts).toEqual([{ kind: 'condition', text: 'Dermatitis: oatmeal shampoo only' }]);
  });

  it('refuses add-ons, pets and people the service does not take', async () => {
    const [scheduledAt] = (await slotsOn(2)).slots;
    await parent.http.post('/bookings/quote').send(pick({ scheduledAt, petId: mishti._id })).expect(400);
    await parent.http.post('/bookings/quote').send(pick({ scheduledAt, addOnIds: [String(service._id)] })).expect(400);
    await parent.http.post('/bookings/quote').send(pick({ scheduledAt, staffId: String(service._id) })).expect(400);
  });
});

describe('securing the slot', () => {
  let held;

  it('holds the slot for a few minutes and hides it from others', async () => {
    const [scheduledAt] = (await slotsOn(2)).slots;
    const { body } = await parent.http.post('/bookings/holds').send(pick({ scheduledAt, staffId: groomer._id })).expect(201);
    expect(body).toMatchObject({ held: true, alternatives: [], hold: { scheduledAt } });
    expect(body.hold.secondsLeft).toBeGreaterThan(290);
    held = body.hold;
    expect((await slotsOn(2)).slots).not.toContain(scheduledAt);
  });

  it('holds the closest free time when the slot was just taken', async () => {
    const { body } = await rival.http.post('/bookings/holds').send(pick({ scheduledAt: held.scheduledAt, petId: rex._id })).expect(200);
    expect(body).toMatchObject({ held: false, reason: 'slot_taken', requested: held.scheduledAt });
    expect(body.alternatives.length).toBe(3);
    expect(body.alternatives.filter((a) => a.held).map((a) => a.scheduledAt)).toEqual([body.hold.scheduledAt]);
    expect(['morning', 'afternoon', 'evening']).toContain(body.alternatives[0].partOfDay);
    await rival.http.get(`/bookings/holds/${body.hold._id}`).expect(200);
    await parent.http.get(`/bookings/holds/${body.hold._id}`).expect(404);
    await rival.http.delete(`/bookings/holds/${body.hold._id}`).expect(204);
  });

  it('books the held slot, keeping its place in line', async () => {
    const { body } = await parent.http
      .post('/bookings')
      .send({ holdId: held._id, sharePassport: true, notes: 'Low heat blow dry, paw balm after' })
      .expect(201);
    expect(body).toMatchObject({
      _id: held._id,
      status: 'pending',
      assignedStaff: String(groomer._id),
      staffRequested: true,
      sharePassport: true,
      paymentMode: 'pay_at_provider',
      serviceSnapshot: { name: 'Full Grooming', pricePaise: 94800, durationMin: 105, basePricePaise: 79900, addOns: [{ name: 'Teeth Cleaning & Fresh Breath' }] },
    });
    expect(new Date(body.endsAt) - new Date(body.scheduledAt)).toBe(105 * 60_000);
    expect(await tenantRun(() => SlotHold.countDocuments({ user: parent.user._id }))).toBe(0);
  });

  it('answers SLOT_TAKEN with alternatives when booking a taken slot directly', async () => {
    const res = await rival.http.post('/bookings').send(pick({ scheduledAt: held.scheduledAt, petId: rex._id })).expect(409);
    expect(res.body.error.code).toBe('SLOT_TAKEN');
    expect(res.body.error.details.alternatives.length).toBeGreaterThan(0);
    expect(res.body.error.details.hold).toBeNull();
  });

  it('asks for a new time once a hold has ended', async () => {
    const [scheduledAt] = (await slotsOn(3)).slots;
    const { body } = await parent.http.post('/bookings/holds').send(pick({ scheduledAt })).expect(201);
    await tenantRun(() => SlotHold.updateOne({ _id: body.hold._id }, { expiresAt: new Date(Date.now() - 1000) }));
    const res = await parent.http.post('/bookings').send({ holdId: body.hold._id }).expect(409);
    expect(res.body.error.code).toBe('HOLD_EXPIRED');
    expect((await slotsOn(3)).slots).toContain(scheduledAt);
  });
});

describe('My Appointments and appointment details', () => {
  let booking, later;

  beforeAll(async () => {
    booking = (await parent.http.get('/bookings/appointments').expect(200)).body.items[0];
    const [scheduledAt] = (await slotsOn(4)).slots;
    later = (await parent.http.post('/bookings').send(pick({ scheduledAt })).expect(201)).body;
  });

  it('shows tabs, pet chips and cards', async () => {
    const { body } = await parent.http.get('/bookings/appointments').expect(200);
    expect(body.counts).toEqual({ upcoming: 2, past: 0, cancelled: 0 });
    expect(body.pets).toEqual([expect.objectContaining({ name: 'Bruno', count: 2 })]);
    expect(body.recent).toEqual([]);
    expect(body.items[0]).toMatchObject({
      next: true,
      state: 'requested',
      title: 'Full Grooming + Teeth Cleaning & Fresh Breath',
      vendor: { businessName: 'Happy Paws Grooming', verified: true },
      pet: { name: 'Bruno' },
      amountPaise: 94800,
      paymentMode: 'pay_at_provider',
      actions: { directions: true, reschedule: true, cancel: true, bookAgain: false, review: false },
      rebook: { vendorId: String(vendor._id), serviceId: String(service._id), addOnIds: [String(teeth._id)], petId: bruno._id },
    });
    expect(body.items[1].next).toBe(false);
    expect((await parent.http.get(`/bookings/appointments?pet=${mishti._id}`).expect(200)).body.total).toBe(0);
  });

  it('shows confirmation details with progress, check-in code and calendar links', async () => {
    await owner.http.post(`/bookings/${booking._id}/actions`).send({ action: 'accept' }).expect(200);
    const { body } = await parent.http.get(`/bookings/${booking._id}/details`).expect(200);
    expect(body).toMatchObject({
      state: 'confirmed',
      progress: { step: 2, total: 4, ended: null },
      staff: { name: 'Avinash K.', title: 'Master Canine Stylist', experienceYears: 6 },
      staffRequested: true,
      vendor: { phone: '+919845000099', arrivalInstructions: 'Please arrive 10 minutes early with your dog on a leash.' },
      pricing: { totalPaise: 94800 },
      careNotes: {
        alerts: [{ kind: 'condition', text: 'Dermatitis: oatmeal shampoo only' }],
        instructions: 'Low heat blow dry, paw balm after',
        passport: { shared: true, active: false },
      },
      reminder: { sent: false, channels: ['push', 'in_app'] },
      checkIn: { available: true, checkedInAt: null },
    });
    expect(body.progress.steps.map((s) => s.state)).toEqual(['done', 'current', 'upcoming', 'upcoming']);
    expect(body.checkIn.code).toMatch(/^NVC1\./);
    expect(body.vendor.directionsUrl).toContain('destination=12.9784,77.6408');
    expect(body.calendar.google).toContain('calendar.google.com');
    expect(body.vendor.hours).toHaveProperty('open');
    await rival.http.get(`/bookings/${booking._id}/details`).expect(404);

    const ics = await parent.http.get(`/bookings/${booking._id}/calendar.ics`).expect(200);
    expect(ics.headers['content-type']).toContain('text/calendar');
    expect(ics.text).toContain('SUMMARY:Bruno: Full Grooming');
    expect(ics.text).toContain('LOCATION:Happy Paws Grooming\\, 12th Main Road\\, Bengaluru');
  });

  it('lets the customer and the business message each other', async () => {
    await parent.http.post(`/bookings/${booking._id}/messages`).send({ body: 'Can you use the oatmeal shampoo?' }).expect(201);
    await owner.http.post(`/bookings/${booking._id}/messages`).send({ body: 'Yes, noted.' }).expect(201);
    const { body } = await parent.http.get(`/bookings/${booking._id}/messages`).expect(200);
    expect(body.items.map((m) => [m.side, m.mine])).toEqual([['customer', true], ['vendor', false]]);
    await rival.http.get(`/bookings/${booking._id}/messages`).expect(403);
  });

  it('lets the customer reschedule before the cutoff, for the studio to confirm again', async () => {
    await owner.http.post(`/bookings/${later._id}/actions`).send({ action: 'accept' }).expect(200);
    const [newTime] = (await slotsOn(5)).slots;
    const { body } = await parent.http.post(`/bookings/${later._id}/actions`).send({ action: 'reschedule', scheduledAt: newTime }).expect(200);
    expect(body).toMatchObject({ status: 'pending', scheduledAt: newTime });
    expect(new Date(body.endsAt) - new Date(body.scheduledAt)).toBe(105 * 60_000);
  });

  it('opens the passport and check-in close to the visit, and reminds the customer', async () => {
    await owner.http.get(`/vendors/me/bookings/${booking._id}/passport`).expect(403);
    await moveTo(booking._id, HOUR);

    const passport = await owner.http.get(`/vendors/me/bookings/${booking._id}/passport`).expect(200);
    expect(passport.body).toMatchObject({ pet: { name: 'Bruno' }, instructions: 'Low heat blow dry, paw balm after', conditions: ['Dermatitis: oatmeal shampoo only'] });
    expect(passport.body.reminders).toBeUndefined();
    await owner.http.get(`/vendors/me/bookings/${later._id}/passport`).expect(403);

    await tenantRun(() => sendAppointmentReminders());
    expect(await tenantRun(() => Notification.exists({ user: parent.user._id, type: 'booking.reminder' }))).toBeTruthy();

    const { body: details } = await parent.http.get(`/bookings/${booking._id}/details`).expect(200);
    expect(details).toMatchObject({ careNotes: { passport: { active: true } }, reminder: { sent: true }, policy: { canReschedule: false, canCancel: true } });
    await parent.http.post(`/bookings/${booking._id}/actions`).send({ action: 'reschedule', scheduledAt: later.scheduledAt }).expect(409);

    await owner.http.post('/vendors/me/bookings/check-in').send({ token: `${details.checkIn.code.slice(0, -2)}xx` }).expect(400);
    await owner.http.post('/vendors/me/bookings/check-in').send({ token: details.checkIn.code }).expect(200);
    await owner.http.post('/vendors/me/bookings/check-in').send({ code: booking.code }).expect(200);
    const after = (await parent.http.get(`/bookings/${booking._id}/details`).expect(200)).body;
    expect(after).toMatchObject({ state: 'in_progress', progress: { step: 3 }, checkIn: { available: false } });
  });

  it('moves cancelled visits to their tab', async () => {
    await parent.http.post(`/bookings/${later._id}/actions`).send({ action: 'cancel' }).expect(200);
    const { body } = await parent.http.get('/bookings/appointments?tab=cancelled').expect(200);
    expect(body.counts).toMatchObject({ upcoming: 1, cancelled: 1 });
    expect(body.items[0]).toMatchObject({ state: 'cancelled', actions: { reschedule: false, cancel: false, bookAgain: true } });
    const details = (await parent.http.get(`/bookings/${later._id}/details`).expect(200)).body;
    expect(details.progress.ended).toBe('cancelled');
  });
});
