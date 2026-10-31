import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mockSignature } from '../src/integrations/payments.js';
import { dispatchDueReminders } from '../src/jobs/reminders.js';
import { RefreshToken } from '../src/modules/auth/auth.model.js';
import { Booking } from '../src/modules/bookings/booking.model.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { Reminder } from '../src/modules/pets/pet.model.js';
import { api, createAdmin, istDate, pdfBuffer, pngBuffer, seedCategories, signUpByPhone, startDb, stopDb, tenantRun } from './helpers.js';

const BANGALORE = { lat: 12.9716, lng: 77.5946 };
const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '09:00', close: '18:00' }));

let categories, admin, parent, vendorUser, vendorId, serviceId, petId;

beforeAll(async () => {
  await startDb();
  categories = await seedCategories();
  admin = await createAdmin();
  parent = await signUpByPhone('Asha');
  vendorUser = await signUpByPhone('Ravi');
});
afterAll(stopDb);

describe('auth', () => {
  it('rejects a wrong OTP and locks after too many attempts', async () => {
    const phone = '+919900000001';
    await api().post('/auth/otp/request').send({ phone }).expect(200);
    for (let i = 0; i < 5; i++) await api().post('/auth/otp/verify').send({ phone, code: '000000' }).expect(401);
    await api().post('/auth/otp/verify').send({ phone, code: '000000' }).expect(429);
  });

  it('rotates refresh tokens and ends the session on reuse', async () => {
    const user = await signUpByPhone();
    const first = await api().post('/auth/refresh').send({ refreshToken: user.refreshToken }).expect(200);
    await tenantRun(() => RefreshToken.updateMany({ replacedBy: { $exists: true } }, { revokedAt: new Date(Date.now() - 3_600_000) }));
    await api().post('/auth/refresh').send({ refreshToken: user.refreshToken }).expect(401);
    await api().post('/auth/refresh').send({ refreshToken: first.body.refreshToken }).expect(401);
  });

  it('keeps tokens bound to their tenant', async () => {
    await api(parent.accessToken, 'store-b').get('/users/me').expect(401);
    await api(parent.accessToken).get('/users/me').expect(200);
    await api(undefined, 'no-such-store').get('/categories').expect(400);
  });

  it('blocks app users from the admin API', async () => {
    await parent.http.get('/admin/dashboard').expect(403);
    await parent.http.get('/admin/badges').expect(403);
  });
});

describe('pets and health records', () => {
  it('creates a pet, a record with a reminder, and dispatches the reminder', async () => {
    const pet = await parent.http.post('/pets').send({ name: 'Bruno', species: 'dog', breed: 'Indie' }).expect(201);
    petId = pet.body._id;

    const record = await parent.http
      .post(`/pets/${petId}/records`)
      .send({ type: 'vaccination', title: 'Rabies', date: '2026-01-10', nextDueDate: '2027-01-10', remind: true })
      .expect(201);
    expect(record.body.title).toBe('Rabies');

    // Make the reminder due now and run the dispatcher.
    await tenantRun(() => Reminder.updateMany({ pet: petId }, { dueAt: new Date(Date.now() - 1000) }));
    await dispatchDueReminders();
    const notes = await parent.http.get('/notifications').expect(200);
    expect(notes.body.items.some((n) => n.type === 'reminder.due')).toBe(true);
  });

  it("hides other users' pets", async () => {
    await vendorUser.http.get(`/pets/${petId}`).expect(404);
  });
});

describe('vendor onboarding and discovery', () => {
  it('registers, submits KYC and is approved by an admin', async () => {
    const created = await vendorUser.http
      .post('/vendors')
      .send({
        businessName: 'Happy Paws Clinic',
        categoryIds: [String(categories.vet._id)],
        address: { line1: '12 MG Road', city: 'Bengaluru', pincode: '560001' },
        location: BANGALORE,
        operatingHours: ALL_WEEK,
      })
      .expect(201);
    vendorId = created.body._id;

    // Not discoverable before approval.
    const before = await api().get(`/vendors?lat=${BANGALORE.lat}&lng=${BANGALORE.lng}`).expect(200);
    expect(before.body.total).toBe(0);

    // The vendor role is picked up on the next request, no new token needed.
    const service = await vendorUser.http
      .post('/vendors/me/services')
      .send({ name: 'Full groom', categoryId: String(categories.grooming._id), pricePaise: 99900, durationMin: 60 })
      .expect(201);
    serviceId = service.body._id;

    const upload = await vendorUser.http.post('/files').field('purpose', 'vendor_kyc').attach('file', pdfBuffer, 'license.pdf').expect(201);
    expect(upload.body.visibility).toBe('private');
    await parent.http.get(`/files/${upload.body._id}`).expect(403);
    await admin.http.get(`/files/${upload.body._id}`).expect(200);

    const pan = await vendorUser.http.post('/files').field('purpose', 'vendor_kyc').attach('file', pdfBuffer, 'pan.pdf').expect(201);

    await admin.http.post(`/admin/vendors/${vendorId}/review`).send({ action: 'approve' }).expect(409); // no KYC yet
    // Listed in the opposite order to upload: each type must stay with its own file.
    await vendorUser.http
      .post('/vendors/me/kyc')
      .send({ documents: [{ type: 'pan', fileId: pan.body._id }, { type: 'shop_license', fileId: upload.body._id }] })
      .expect(200);
    const dossier = await admin.http.get(`/admin/vendors/${vendorId}`).expect(200);
    expect(dossier.body.kyc.documents.map((d) => [d.type, d.name])).toEqual([['pan', 'pan.pdf'], ['shop_license', 'license.pdf']]);
    const inbox = await admin.http.get('/notifications').expect(200);
    expect(inbox.body.items[0]).toMatchObject({ type: 'vendor.kyc_submitted', title: 'New vendor application: Happy Paws Clinic' });

    // Approval waits for the licence check, unless the reviewer records why it can go live without one.
    await admin.http.post(`/admin/vendors/${vendorId}/review`).send({ action: 'approve' }).expect(400);
    await admin.http.post(`/admin/vendors/${vendorId}/license-check`).send({ result: 'verified', note: 'Matched BBMP register' }).expect(200);
    await admin.http.post(`/admin/vendors/${vendorId}/review`).send({ action: 'approve' }).expect(200);

    const near = await api().get(`/vendors?lat=${BANGALORE.lat}&lng=${BANGALORE.lng}&radiusKm=5`).expect(200);
    expect(near.body.total).toBe(1);
    expect(near.body.items[0].kyc).toBeUndefined();
    const far = await api().get('/vendors?lat=28.6139&lng=77.2090&radiusKm=5').expect(200);
    expect(far.body.total).toBe(0);

    // Another tenant cannot see it.
    const otherTenant = await api(undefined, 'store-b').get('/vendors').expect(200);
    expect(otherTenant.body.total).toBe(0);
  });

  it('rejects uploads whose content is not an allowed type', async () => {
    await parent.http.post('/files').field('purpose', 'pet_photo').attach('file', Buffer.from('<?php echo 1;'), 'x.png').expect(400);
    await parent.http.post('/files').field('purpose', 'pet_photo').attach('file', pngBuffer, 'x.png').expect(201);
  });
});

describe('bookings and payments', () => {
  let bookingId;

  it('books an available slot and prevents double booking', async () => {
    const date = istDate(2);
    const slots = await api().get(`/vendors/${vendorId}/availability?serviceId=${serviceId}&date=${date}`).expect(200);
    expect(slots.body.slots.length).toBeGreaterThan(0);
    const scheduledAt = slots.body.slots[0];

    const booking = await parent.http.post('/bookings').send({ vendorId, serviceId, petId, scheduledAt }).expect(201);
    bookingId = booking.body._id;
    expect(booking.body.serviceSnapshot.pricePaise).toBe(99900);

    await parent.http.post('/bookings').send({ vendorId, serviceId, petId, scheduledAt }).expect(409);
    const after = await api().get(`/vendors/${vendorId}/availability?serviceId=${serviceId}&date=${date}`).expect(200);
    expect(after.body.slots).not.toContain(scheduledAt);
  });

  it('rejects bookings outside operating hours', async () => {
    const scheduledAt = new Date(`${istDate(2)}T20:00:00+05:30`).toISOString();
    await parent.http.post('/bookings').send({ vendorId, serviceId, petId, scheduledAt }).expect(400);
  });

  it('enforces who may perform each action', async () => {
    await parent.http.post(`/bookings/${bookingId}/actions`).send({ action: 'accept' }).expect(403);
    await vendorUser.http.post(`/bookings/${bookingId}/actions`).send({ action: 'complete' }).expect(409);
    const accepted = await vendorUser.http.post(`/bookings/${bookingId}/actions`).send({ action: 'accept' }).expect(200);
    expect(accepted.body.status).toBe('accepted');
  });

  it('takes payment and refunds when the vendor cancels', async () => {
    const order = await parent.http.post(`/payments/bookings/${bookingId}/order`).expect(201);
    expect(order.body.amountPaise).toBe(99900);

    const paymentId = 'pay_test_1';
    await parent.http.post('/payments/verify').send({ orderId: order.body.orderId, paymentId, signature: 'bad' }).expect(400);
    const paid = await parent.http
      .post('/payments/verify')
      .send({ orderId: order.body.orderId, paymentId, signature: mockSignature(`${order.body.orderId}|${paymentId}`) })
      .expect(200);
    expect(paid.body.payment.status).toBe('paid');

    const cancelled = await vendorUser.http.post(`/bookings/${bookingId}/actions`).send({ action: 'cancel', reason: 'Vet unavailable' }).expect(200);
    expect(cancelled.body.status).toBe('cancelled');
    expect(cancelled.body.payment.status).toBe('refunded');
  });

  it('accepts signed webhooks only', async () => {
    const body = JSON.stringify({ event: 'payment.failed', payload: { payment: { entity: { notes: { tenant: 'nurvia' } } } } });
    await api().post('/payments/webhook').set('Content-Type', 'application/json').set('x-razorpay-signature', 'nope').send(body).expect(400);
    await api().post('/payments/webhook').set('Content-Type', 'application/json').set('x-razorpay-signature', mockSignature(body)).send(body).expect(200);
  });

  it('allows one review per completed booking and updates the rating', async () => {
    const slots = await api().get(`/vendors/${vendorId}/availability?serviceId=${serviceId}&date=${istDate(3)}`).expect(200);
    const booking = await parent.http.post('/bookings').send({ vendorId, serviceId, petId, scheduledAt: slots.body.slots[0] }).expect(201);
    await parent.http.post('/reviews').send({ bookingId: booking.body._id, rating: 5 }).expect(409);

    await vendorUser.http.post(`/bookings/${booking.body._id}/actions`).send({ action: 'accept' }).expect(200);
    // Move the appointment into the past so it can be completed.
    await tenantRun(() => Booking.updateOne({ _id: booking.body._id }, { scheduledAt: new Date(Date.now() - 3_600_000) }));
    await vendorUser.http.post(`/bookings/${booking.body._id}/actions`).send({ action: 'complete' }).expect(200);

    await parent.http.post('/reviews').send({ bookingId: booking.body._id, rating: 4, text: 'Gentle with Bruno' }).expect(201);
    await parent.http.post('/reviews').send({ bookingId: booking.body._id, rating: 5 }).expect(409);
    const vendor = await api().get(`/vendors/${vendorId}`).expect(200);
    expect(vendor.body.ratingAvg).toBe(4);
    expect(vendor.body.ratingCount).toBe(1);
  });

  it('shows the emergency contact to the vendor only around an accepted visit', async () => {
    await parent.http.patch('/users/me').send({ emergencyContact: { name: 'Rahul', phone: '98450 11111' } }).expect(200);
    const slots = await api().get(`/vendors/${vendorId}/availability?serviceId=${serviceId}&date=${istDate(4)}`).expect(200);
    const booking = await parent.http.post('/bookings').send({ vendorId, serviceId, petId, scheduledAt: slots.body.slots[0] }).expect(201);
    const contactSeenBy = async (who) => (await who.http.get(`/bookings/${booking.body._id}`).expect(200)).body.customerEmergencyContact;

    expect(await contactSeenBy(vendorUser)).toBeNull(); // pending
    await vendorUser.http.post(`/bookings/${booking.body._id}/actions`).send({ action: 'accept' }).expect(200);
    expect(await contactSeenBy(vendorUser)).toBeNull(); // days away

    await tenantRun(() => Booking.updateOne({ _id: booking.body._id }, { scheduledAt: new Date(Date.now() + 3_600_000) }));
    expect(await contactSeenBy(vendorUser)).toEqual({ name: 'Rahul', phone: '+919845011111' });
    expect(await contactSeenBy(parent)).toBeNull();
    // Keeps the admin dashboard counts below about the bookings made above.
    await tenantRun(() => Booking.deleteOne({ _id: booking.body._id }));
  });
});

describe('community, adoption and moderation', () => {
  it('moderates a reported post', async () => {
    const post = await parent.http.post('/community/posts').send({ text: 'Bruno at the park!', tags: ['Indie'] }).expect(201);
    await vendorUser.http.put(`/community/posts/${post.body._id}/reaction`).send({ type: 'love' }).expect(200);
    await vendorUser.http.put(`/community/posts/${post.body._id}/reaction`).send({ type: 'like' }).expect(200);
    const feed = await vendorUser.http.get('/community/posts?tag=indie').expect(200);
    expect(feed.body.items[0]).toMatchObject({ reactionCount: 1, myReaction: 'like' });

    await vendorUser.http.post('/reports').send({ targetType: 'post', targetId: post.body._id, reason: 'spam' }).expect(202);
    const queue = await admin.http.get('/admin/reports').expect(200);
    expect(queue.body.items[0].target.text).toBe('Bruno at the park!');

    await admin.http.patch(`/admin/moderation/posts/${post.body._id}`).send({ status: 'hidden' }).expect(400); // reason required
    await admin.http.patch(`/admin/moderation/posts/${post.body._id}`).send({ status: 'hidden', reason: 'Spam' }).expect(200);
    await parent.http.get(`/community/posts/${post.body._id}`).expect(404);
  });

  it('runs an adoption listing from review to application', async () => {
    const photo = await parent.http.post('/files').field('purpose', 'adoption').attach('file', pngBuffer, 'p.png').expect(201);
    const listing = await parent.http
      .post('/adoption/listings')
      .send({ name: 'Kali', species: 'dog', description: 'Friendly two-year-old indie, vaccinated.', photoFileIds: [photo.body._id], city: 'Bengaluru' })
      .expect(201);
    expect(listing.body.status).toBe('pending_review');
    await vendorUser.http.post(`/adoption/listings/${listing.body._id}/applications`).send({ message: 'We have a big garden.' }).expect(404);

    await admin.http.patch(`/admin/moderation/adoption-listings/${listing.body._id}`).send({ status: 'open' }).expect(200);
    const application = await vendorUser.http
      .post(`/adoption/listings/${listing.body._id}/applications`)
      .send({ message: 'We have a big garden.' })
      .expect(201);
    await vendorUser.http.patch(`/adoption/applications/${application.body._id}`).send({ status: 'approved' }).expect(403);
    await parent.http.patch(`/adoption/applications/${application.body._id}`).send({ status: 'approved' }).expect(200);
  });

  it('lets caregivers log care for community dogs', async () => {
    const dog = await parent.http.post('/community-dogs').send({ name: 'Brownie', area: 'Indiranagar 12th Main', location: BANGALORE }).expect(201);
    await vendorUser.http.post(`/community-dogs/${dog.body._id}/logs`).send({ type: 'fed' }).expect(403);
    await vendorUser.http.post(`/community-dogs/${dog.body._id}/logs`).send({ type: 'sighting' }).expect(201);
    await parent.http.post(`/community-dogs/${dog.body._id}/logs`).send({ type: 'sterilized' }).expect(201);
    const near = await parent.http.get(`/community-dogs?lat=${BANGALORE.lat}&lng=${BANGALORE.lng}&radiusKm=2`).expect(200);
    expect(near.body.items[0]).toMatchObject({ name: 'Brownie', sterilized: true });
  });
});

describe('admin', () => {
  it('suspends a user, which blocks them immediately', async () => {
    const victim = await signUpByPhone('Spammer');
    await admin.http.patch(`/admin/users/${victim.user._id}/status`).send({ status: 'suspended', reason: 'Spam reports' }).expect(200);
    await victim.http.get('/users/me').expect(403);
    await api().post('/auth/refresh').send({ refreshToken: victim.refreshToken }).expect(401);
  });

  it('limits staff to their permissions', async () => {
    const staff = await createAdmin('staff');
    await staff.http.get('/admin/dashboard').expect(200);
    await staff.http.post(`/admin/vendors/${vendorId}/review`).send({ action: 'suspend', reason: 'x' }).expect(403);
    await staff.http.post('/admin/announcements').send({ title: 'Hello', body: 'World' }).expect(403);
  });

  it('reports dashboard counts and analytics, and records an audit trail', async () => {
    const dash = await admin.http.get('/admin/dashboard').expect(200);
    expect(dash.body.vendors.active).toBe(1);
    expect(dash.body.bookings.total).toBe(2);
    expect(dash.body.bookingStatus).toMatchObject({ cancelled: 1, completed: 1 });
    expect(dash.body.payments.refundedPaise).toBe(99900);
    expect(dash.body.topVendors[0]).toMatchObject({ businessName: 'Happy Paws Clinic', bookings: 1 });
    const badges = await admin.http.get('/admin/badges').expect(200);
    expect(badges.body).toEqual({ vendors: { awaitingApproval: dash.body.vendors.awaitingApproval }, adoption: { awaitingReview: dash.body.adoption.awaitingReview }, reports: { open: dash.body.reports.open } });
    const analytics = await admin.http.get('/admin/analytics').expect(200);
    expect(analytics.body.series.bookings.reduce((n, d) => n + d.count, 0)).toBe(2);
    expect(analytics.body.revenue.reduce((n, d) => n + d.amountPaise, 0)).toBe(99900);
    const auditLog = await admin.http.get('/admin/audit').expect(200);
    expect(auditLog.body.items.map((a) => a.action)).toContain('vendor.approve');
  });

  it('sends announcements to every active user', async () => {
    const sent = await admin.http.post('/admin/announcements').send({ title: 'Welcome', body: 'Nurvia is live', audience: 'all' }).expect(201);
    expect(sent.body.recipientCount).toBeGreaterThan(2);
    const count = await tenantRun(() => Notification.countDocuments({ type: 'announcement' }));
    expect(count).toBe(sent.body.recipientCount);
  });
});
