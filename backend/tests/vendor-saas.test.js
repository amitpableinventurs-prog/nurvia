import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Booking } from '../src/modules/bookings/booking.model.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { Appointment, CrmNote, VendorCustomer } from '../src/modules/operations/operations.model.js';
import { sendWorkspaceReminders } from '../src/modules/operations/reminders.js';
import { Review } from '../src/modules/reviews/review.model.js';
import { Vendor } from '../src/modules/vendors/vendor.model.js';
import { pdfBuffer, seedCategories, signUpByPhone, startDb, stopDb, tenantRun } from './helpers.js';

// Vendor SaaS workspace: configurable staff permissions, CRM documents, reminders for the business's
// own appointments and follow-ups, and the reviews and new-versus-returning parts of the report.

const BLR = { lat: 12.9716, lng: 77.5946 };
const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '00:00', close: '23:59' }));
const HOUR = 3_600_000;
const userId = async (who) => (await who.http.get('/users/me')).body._id;
const notes = (user, type) => tenantRun(() => Notification.find({ user, type }).lean());

let owner, reception, groomer, parent, vendor, ownerId, receptionStaff, groomerStaff;

beforeAll(async () => {
  await startDb();
  const categories = await seedCategories();
  owner = await signUpByPhone('Kiran');
  reception = await signUpByPhone('Rita');
  groomer = await signUpByPhone('Pooja');
  parent = await signUpByPhone('Asha');
  ownerId = await userId(owner);
  vendor = (
    await owner.http
      .post('/vendors')
      .send({ businessName: 'Happy Paws', categoryIds: [String(categories.vet._id)], address: { line1: '1 MG Road', city: 'Bengaluru' }, location: BLR, operatingHours: ALL_WEEK })
      .expect(201)
  ).body;
  await tenantRun(() => Vendor.updateOne({ _id: vendor._id }, { status: 'active', 'kyc.status': 'approved' }));
  receptionStaff = (await owner.http.post('/vendors/me/staff').send({ name: 'Rita', phone: reception.phone, role: 'receptionist', revokedCapabilities: ['customers.manage'] }).expect(201)).body;
  groomerStaff = (await owner.http.post('/vendors/me/staff').send({ name: 'Pooja', phone: groomer.phone, role: 'groomer' }).expect(201)).body;
});

afterAll(stopDb);

describe('staff permissions', () => {
  it('lists roles with their defaults and lets the owner take permissions away', async () => {
    const { body } = await owner.http.get('/vendors/me/staff/roles').expect(200);
    expect(body.roles.map((r) => r.role)).toEqual(['manager', 'receptionist', 'vet', 'groomer', 'trainer', 'walker', 'boarding_attendant', 'other']);
    expect(body.capabilities.find((c) => c.key === 'staff.manage').label).toBe('Manage staff and reminders');

    const rita = (await owner.http.get('/vendors/me/staff').expect(200)).body.find((s) => s.name === 'Rita');
    expect(rita.capabilities).toEqual(['calendar.read', 'bookings.manage', 'customers.read']);
    await reception.http.post('/vendors/me/customers').send({ name: 'Walk-in' }).expect(403);
    expect((await reception.http.get('/vendors/me/workspace').expect(200)).body.capabilities).not.toContain('customers.manage');

    // Giving it back.
    await owner.http.patch(`/vendors/me/staff/${receptionStaff._id}`).send({ revokedCapabilities: [] }).expect(200);
    await reception.http.post('/vendors/me/customers').send({ name: 'Walk-in' }).expect(201);
  });
});

describe('CRM documents', () => {
  it('keeps documents on a customer that the whole team can open', async () => {
    const customer = (await owner.http.post('/vendors/me/customers').send({ name: 'Neha', pets: [{ name: 'Simba', species: 'cat' }] }).expect(201)).body;
    const file = (await owner.http.post('/files').field('purpose', 'crm_document').attach('file', pdfBuffer, 'consent.pdf').expect(201)).body;
    expect(file.url).toBeUndefined(); // private
    const doc = (await owner.http.post(`/vendors/me/customers/${customer._id}/documents`).send({ fileId: file._id, title: 'Grooming consent', petId: customer.pets[0]._id }).expect(201)).body;

    const detail = (await reception.http.get(`/vendors/me/customers/${customer._id}`).expect(200)).body;
    expect(detail.documents.map((d) => d.title)).toEqual(['Grooming consent']);
    const opened = await reception.http.get(`/vendors/me/customers/${customer._id}/documents/${doc._id}`).expect(200);
    expect(opened.headers['content-type']).toMatch(/pdf/);
    await parent.http.get(`/vendors/me/customers/${customer._id}/documents/${doc._id}`).expect(404);

    await owner.http.delete(`/vendors/me/customers/${customer._id}/documents/${doc._id}`).expect(204);
    expect((await owner.http.get(`/vendors/me/customers/${customer._id}`).expect(200)).body.documents).toEqual([]);
  });
});

describe('reminders', () => {
  let customer;

  beforeAll(async () => {
    const parentId = await userId(parent);
    customer = await tenantRun(() => VendorCustomer.create({ vendor: vendor._id, user: parentId, name: 'Asha', source: 'nurvia', pets: [{ name: 'Bruno', species: 'dog' }] }));
  });

  it('has settings the owner can change', async () => {
    expect((await owner.http.get('/vendors/me/reminder-settings').expect(200)).body).toEqual({ customerHours: [24], staffMinutes: 60, followUps: true });
    expect((await owner.http.put('/vendors/me/reminder-settings').send({ customerHours: [2, 24, 24] }).expect(200)).body.customerHours).toEqual([24, 2]);
    await groomer.http.put('/vendors/me/reminder-settings').send({ staffMinutes: 30 }).expect(403);
  });

  it('reminds the customer and the staff member once each, and again after a move', async () => {
    const at = new Date(Date.now() + 20 * HOUR).toISOString();
    const appt = (await owner.http.post('/vendors/me/appointments').send({ customerId: String(customer._id), serviceName: 'Bath', scheduledAt: at, staffId: groomerStaff._id }).expect(201)).body;
    const parentId = await userId(parent);
    const groomerId = await userId(groomer);

    await tenantRun(() => sendWorkspaceReminders());
    await tenantRun(() => sendWorkspaceReminders());
    expect(await notes(parentId, 'appointment.reminder')).toHaveLength(1);
    expect(await notes(groomerId, 'staff.appointment_reminder')).toHaveLength(0);

    // Inside two hours: the 2-hour customer reminder, and the staff one at an hour.
    await tenantRun(() => Appointment.updateOne({ _id: appt._id }, { scheduledAt: new Date(Date.now() + 50 * 60_000) }));
    await tenantRun(() => sendWorkspaceReminders());
    expect(await notes(parentId, 'appointment.reminder')).toHaveLength(2);
    const staffNotes = await notes(groomerId, 'staff.appointment_reminder');
    expect(staffNotes).toHaveLength(1);
    expect(staffNotes[0].title).toBe('Coming up: Bath for Bruno');

    // Moving it through the API arms the reminders again.
    await owner.http.patch(`/vendors/me/appointments/${appt._id}`).send({ scheduledAt: new Date(Date.now() + 10 * HOUR).toISOString() }).expect(200);
    await tenantRun(() => sendWorkspaceReminders());
    expect(await notes(parentId, 'appointment.reminder')).toHaveLength(3);
  });

  it('tells the author when a follow-up is due', async () => {
    const note = (await owner.http.post(`/vendors/me/customers/${customer._id}/notes`).send({ text: 'Check the ear infection', followUpAt: new Date(Date.now() + HOUR).toISOString() }).expect(201)).body;
    await tenantRun(() => sendWorkspaceReminders());
    expect(await notes(ownerId, 'crm.follow_up')).toHaveLength(0);
    await tenantRun(() => CrmNote.updateOne({ _id: note._id }, { followUpAt: new Date(Date.now() - 60_000) }));
    await tenantRun(() => sendWorkspaceReminders());
    await tenantRun(() => sendWorkspaceReminders());
    const sent = await notes(ownerId, 'crm.follow_up');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ title: 'Follow up with Asha', body: 'Check the ear infection' });
  });
});

describe('dashboard report', () => {
  it('adds reviews and new versus returning customers', async () => {
    const parentId = await userId(parent);
    const pet = (await parent.http.post('/pets').send({ name: 'Bruno', species: 'dog' }).expect(201)).body;
    const booking = (code, daysAgo) => {
      const at = new Date(Date.now() - daysAgo * 24 * HOUR);
      return { code, user: parentId, pet: pet._id, vendor: vendor._id, vendorOwner: ownerId, service: vendor._id, serviceSnapshot: { name: 'Consultation', pricePaise: 50000, durationMin: 30 }, scheduledAt: at, endsAt: new Date(at.getTime() + 30 * 60_000), status: 'completed' };
    };
    const [older, recent] = await tenantRun(() => Booking.create([booking('NVOLD0001', 60), booking('NVNEW0001', 3)]));
    await tenantRun(() =>
      Review.create([
        { vendor: vendor._id, booking: recent._id, author: parentId, rating: 5, text: 'Lovely', vendorReply: { text: 'Thank you', at: new Date() } },
        { vendor: vendor._id, booking: older._id, author: parentId, rating: 3 },
      ]),
    );

    const from = new Date(Date.now() - 10 * 24 * HOUR).toISOString();
    const to = new Date(Date.now() + HOUR).toISOString();
    const report = (await owner.http.get('/vendors/me/reports').query({ from, to }).expect(200)).body;
    // Asha came 60 days ago too, so she is returning, not new.
    expect(report.customers).toMatchObject({ unique: 1, returning: 1, new: 0 });
    // Both reviews were written today.
    expect(report.reviews).toEqual({ count: 2, ratingAvg: 4, byRating: { 5: 1, 4: 0, 3: 1, 2: 0, 1: 0 }, repliedPct: 50 });
  });
});
