import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mockSignature } from '../src/integrations/payments.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { SubscriptionInvoice } from '../src/modules/plans/plan.model.js';
import { runSubscriptionJobs } from '../src/modules/plans/subscription.service.js';
import { Booking } from '../src/modules/bookings/booking.model.js';
import { Tenant } from '../src/modules/tenants/tenant.model.js';
import { Vendor } from '../src/modules/vendors/vendor.model.js';
import { api, createAdmin, seedCategories, signUpByPhone, startDb, stopDb, tenantRun } from './helpers.js';

// Module 10, vendor SaaS: plans, the free plan fallback, buying a plan with a GST invoice, staff
// assignments, renewal reminders, and the workspace reports.

const BLR = { lat: 12.9716, lng: 77.5946 };
const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '00:00', close: '23:59' }));
const DAY = 86_400_000;

let admin, owner, vendor, free, pro;

const subscriptionOf = async () => (await owner.http.get('/vendors/me/subscription').expect(200)).body;
const setSubscription = (fields) => tenantRun(() => Vendor.updateOne({ _id: vendor._id }, { $set: Object.fromEntries(Object.entries(fields).map(([k, v]) => [`subscription.${k}`, v])) }));
const notificationsOf = (type) => tenantRun(() => Notification.find({ user: vendor.owner, type }).sort({ createdAt: 1, _id: 1 }).lean());

async function buy(planId, months) {
  const checkout = await owner.http.post('/vendors/me/subscription/checkout').send({ planId, months }).expect(201);
  const paymentId = `pay_${Math.random().toString(36).slice(2, 10)}`;
  const verified = await owner.http
    .post('/vendors/me/subscription/verify')
    .send({ orderId: checkout.body.orderId, paymentId, signature: mockSignature(`${checkout.body.orderId}|${paymentId}`) })
    .expect(200);
  return { checkout: checkout.body, verified: verified.body, paymentId };
}

beforeAll(async () => {
  await startDb();
  const categories = await seedCategories();
  await tenantRun(() => Tenant.updateOne({ slug: 'nurvia' }, { business: { legalName: 'Nurvia Petcare Pvt Ltd', gstin: '29AAACN0000A1Z5', address: 'Bengaluru' } }));
  admin = await createAdmin();
  owner = await signUpByPhone('Kiran');
  vendor = (
    await owner.http
      .post('/vendors')
      .send({ businessName: 'Happy Paws', categoryIds: [String(categories.vet._id)], address: { line1: '1 MG Road', city: 'Bengaluru', state: 'Karnataka' }, location: BLR, operatingHours: ALL_WEEK })
      .expect(201)
  ).body;
  await tenantRun(() => Vendor.updateOne({ _id: vendor._id }, { status: 'active', 'kyc.status': 'approved' }));
});

afterAll(stopDb);

describe('plans', () => {
  it('lets staff set up one free plan and paid plans with monthly and yearly prices', async () => {
    await admin.http.post('/admin/plans').send({ code: 'free-bad', name: 'Free', audience: 'vendor', isFree: true, monthlyPricePaise: 100, yearlyPricePaise: 0 }).expect(400);
    free = (
      await admin.http
        .post('/admin/plans')
        .send({ code: 'free', name: 'Free', audience: 'vendor', isFree: true, monthlyPricePaise: 0, yearlyPricePaise: 0, features: [], limits: { staff: 1, services: 1, products: 5 } })
        .expect(201)
    ).body;
    await admin.http.post('/admin/plans').send({ code: 'free-2', name: 'Basic', audience: 'vendor', isFree: true, monthlyPricePaise: 0, yearlyPricePaise: 0 }).expect(409);
    pro = (
      await admin.http
        .post('/admin/plans')
        .send({ code: 'pro', name: 'Pro', audience: 'vendor', monthlyPricePaise: 100000, yearlyPricePaise: 1000000, features: ['crm', 'visit_records', 'marketplace', 'packages'], limits: { staff: 5 } })
        .expect(201)
    ).body;
    const plans = (await api().get('/plans?audience=vendor').expect(200)).body;
    expect(plans.map((p) => p.code)).toEqual(['free', 'pro']);
    expect((await api().get('/plans/features').expect(200)).body.features.map((f) => f.key)).toEqual(['crm', 'visit_records', 'marketplace', 'packages']);
  });

  it('puts a vendor without a paid plan on the free plan, with its limits and features', async () => {
    const sub = await subscriptionOf();
    expect(sub).toMatchObject({ onFreePlan: true, plan: { code: 'free' }, subscription: null, features: { crm: false, packages: false } });

    await owner.http.post('/vendors/me/services').send({ name: 'Consultation', pricePaise: 50000, durationMin: 30 }).expect(201);
    const limited = await owner.http.post('/vendors/me/services').send({ name: 'Grooming', pricePaise: 80000, durationMin: 60 }).expect(402);
    expect(limited.body.error).toMatchObject({ code: 'PLAN_LIMIT', details: { key: 'services', limit: 1 } });

    const customer = (await owner.http.post('/vendors/me/customers').send({ name: 'Neha', phone: '+919900011122' }).expect(201)).body;
    const gated = await owner.http.post(`/vendors/me/customers/${customer._id}/notes`).send({ text: 'Prefers mornings' }).expect(402);
    expect(gated.body.error).toMatchObject({ code: 'PLAN_FEATURE', details: { feature: 'crm' } });
    await owner.http.post('/vendors/me/packages').send({ name: '5 baths', sessions: 5, pricePaise: 200000 }).expect(402);
    await owner.http.get('/vendors/me/packages').expect(200);
    await owner.http.get('/vendors/me/follow-ups').expect(402);
  });
});

describe('buying a plan', () => {
  it('quotes the price with GST split by state', async () => {
    const same = (await owner.http.get(`/vendors/me/subscription/quote?planId=${pro._id}&months=1`).expect(200)).body;
    expect(same.amounts).toMatchObject({ basePaise: 100000, gstRatePct: 18, cgstPaise: 9000, sgstPaise: 9000, igstPaise: 0, totalPaise: 118000 });
    expect(same.interState).toBe(false);

    await tenantRun(() => Vendor.updateOne({ _id: vendor._id }, { 'kyc.gstin': '27AAACH0000B1Z1' }));
    const other = (await owner.http.get(`/vendors/me/subscription/quote?planId=${pro._id}&months=12`).expect(200)).body;
    expect(other.amounts).toMatchObject({ basePaise: 1000000, igstPaise: 180000, cgstPaise: 0, totalPaise: 1180000 });
    await tenantRun(() => Vendor.updateOne({ _id: vendor._id }, { $unset: { 'kyc.gstin': 1 } }));

    await owner.http.get(`/vendors/me/subscription/quote?planId=${free._id}&months=1`).expect(400);
  });

  it('activates the plan after payment and issues a GST invoice, once', async () => {
    const before = Date.now();
    const { checkout, verified, paymentId } = await buy(pro._id, 1);
    expect(checkout).toMatchObject({ amountPaise: 118000, keyId: 'mock' });
    expect(verified).toMatchObject({ onFreePlan: false, plan: { code: 'pro' }, subscription: { status: 'active', source: 'purchase' }, features: { crm: true } });
    const expires = new Date(verified.subscription.expiresAt).getTime();
    expect(expires - before).toBeGreaterThan(27 * DAY);
    expect(expires - before).toBeLessThan(32 * DAY);

    // The webhook for the same payment changes nothing.
    const raw = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: paymentId, order_id: checkout.orderId, notes: { tenant: 'nurvia' } } } } });
    await api().post('/payments/webhook').set('Content-Type', 'application/json').set('x-razorpay-signature', mockSignature(raw)).send(raw).expect(200);
    expect((await subscriptionOf()).subscription.expiresAt).toBe(verified.subscription.expiresAt);

    const invoices = (await owner.http.get('/vendors/me/subscription/invoices').expect(200)).body;
    expect(invoices.items).toHaveLength(1);
    const invoice = (await owner.http.get(`/vendors/me/subscription/invoices/${invoices.items[0]._id}`).expect(200)).body;
    expect(invoice.number).toMatch(/^NUR\/\d{2}-\d{2}\/000001$/);
    expect(invoice).toMatchObject({ taxablePaise: 100000, cgstPaise: 9000, sgstPaise: 9000, totalPaise: 118000, supplier: { gstin: '29AAACN0000A1Z5', stateName: 'Karnataka' }, recipient: { name: 'Happy Paws' } });
    expect(invoice.lines[0]).toMatchObject({ sac: '998315' });

    // The paid features work now.
    const customer = (await owner.http.get('/vendors/me/customers').expect(200)).body.items[0];
    await owner.http.post(`/vendors/me/customers/${customer._id}/notes`).send({ text: 'Prefers mornings' }).expect(201);
  });

  it('adds a renewal of the same plan after the current end date', async () => {
    const current = new Date((await subscriptionOf()).subscription.expiresAt);
    const { verified } = await buy(pro._id, 12);
    const next = new Date(verified.subscription.expiresAt);
    expect(next.getUTCFullYear() - current.getUTCFullYear()).toBe(1);
    expect(next.getUTCMonth()).toBe(current.getUTCMonth());
    expect((await tenantRun(() => SubscriptionInvoice.countDocuments({ vendor: vendor._id })))).toBe(2);
  });

  it('keeps billing to the owner', async () => {
    const member = await signUpByPhone('Rita');
    await owner.http.post('/vendors/me/staff').send({ name: 'Rita', phone: member.phone, role: 'receptionist' }).expect(201);
    expect((await member.http.get('/vendors/me/subscription').expect(200)).body.plan.code).toBe('pro');
    await member.http.post('/vendors/me/subscription/checkout').send({ planId: pro._id, months: 1 }).expect(403);
    await member.http.get('/vendors/me/subscription/invoices').expect(403);
  });
});

describe('staff assignments and expiry', () => {
  it('lets staff assign, extend and remove plans, including complimentary periods', async () => {
    await admin.http.put(`/admin/vendors/${vendor._id}/subscription`).send({ planId: pro._id, days: 10, complimentary: true, reason: 'Launch offer' }).expect(200);
    let sub = await subscriptionOf();
    expect(sub.subscription).toMatchObject({ source: 'complimentary', daysLeft: 10 });

    await admin.http.post(`/admin/vendors/${vendor._id}/subscription/extend`).send({ days: 5, reason: 'Outage credit' }).expect(200);
    expect((await subscriptionOf()).subscription.daysLeft).toBe(15);

    const list = (await admin.http.get('/admin/subscriptions?status=paid').expect(200)).body;
    expect(list.items.map((v) => v.businessName)).toContain('Happy Paws');
    const detail = (await admin.http.get(`/admin/vendors/${vendor._id}/subscription`).expect(200)).body;
    expect(detail.invoices).toHaveLength(2);

    await admin.http.put(`/admin/vendors/${vendor._id}/subscription`).send({ planId: null, reason: 'Back to free' }).expect(200);
    sub = await subscriptionOf();
    expect(sub).toMatchObject({ onFreePlan: true, subscription: null });
    await admin.http.post(`/admin/vendors/${vendor._id}/subscription/extend`).send({ days: 5, reason: 'Extend the free plan' }).expect(400);

    const csv = await admin.http.get('/admin/subscription-invoices?format=csv').expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\r\n')).toHaveLength(4); // header, two invoices, trailing newline
  });

  it('reminds 7 days and 1 day before the end, then falls back to the free plan without deleting data', async () => {
    await admin.http.put(`/admin/vendors/${vendor._id}/subscription`).send({ planId: pro._id, days: 6, reason: 'Reminder test' }).expect(200);
    await tenantRun(() => runSubscriptionJobs());
    await tenantRun(() => runSubscriptionJobs());
    expect(await notificationsOf('subscription.renewal_due')).toHaveLength(1);

    await setSubscription({ expiresAt: new Date(Date.now() + 12 * 3_600_000) });
    await tenantRun(() => runSubscriptionJobs());
    const reminders = await notificationsOf('subscription.renewal_due');
    expect(reminders).toHaveLength(2);
    expect(reminders[1].title).toMatch(/within a day/);

    await setSubscription({ expiresAt: new Date(Date.now() - 1000) });
    await tenantRun(() => runSubscriptionJobs());
    expect(await notificationsOf('subscription.expired')).toHaveLength(1);
    const sub = await subscriptionOf();
    expect(sub).toMatchObject({ onFreePlan: true, plan: { code: 'free' }, subscription: { status: 'expired' } });
    // The staff member and the CRM note are kept; adding more staff is refused.
    expect(sub.usage.staff).toBe(1);
    const customer = (await owner.http.get('/vendors/me/customers').expect(200)).body.items[0];
    expect((await owner.http.get(`/vendors/me/customers/${customer._id}`).expect(200)).body.notes).toHaveLength(1);
    await owner.http.post('/vendors/me/staff').send({ name: 'Arun', phone: '+919844444411', role: 'groomer' }).expect(402);
  });
});

describe('reports', () => {
  it('counts bookings, revenue, top services, repeat customers and no-shows, and exports CSV', async () => {
    const neha = (await owner.http.get('/vendors/me/customers').expect(200)).body.items[0];
    const ravi = (await owner.http.post('/vendors/me/customers').send({ name: 'Ravi' }).expect(201)).body;
    const at = (daysAgo, hour) => new Date(Date.now() - daysAgo * DAY + hour * 3_600_000).toISOString();
    const visit = async (customer, serviceName, pricePaise, scheduledAt, status) => {
      const created = (await owner.http.post('/vendors/me/appointments').send({ customerId: customer._id, serviceName, pricePaise, scheduledAt }).expect(201)).body;
      await owner.http.post(`/vendors/me/appointments/${created._id}/status`).send({ status }).expect(200);
    };
    await visit(neha, 'Consultation', 50000, at(5, 0), 'completed');
    await visit(neha, 'Consultation', 50000, at(3, 0), 'completed');
    await visit(ravi, 'Grooming', 80000, at(4, 1), 'completed');
    await visit(ravi, 'Grooming', 80000, at(2, 1), 'no_show');

    // A Nurvia booking from a pet parent.
    const parent = await signUpByPhone('Asha');
    const pet = (await parent.http.post('/pets').send({ name: 'Bruno', species: 'dog' }).expect(201)).body;
    const parentId = (await parent.http.get('/users/me').expect(200)).body._id;
    const when = new Date(Date.now() - DAY);
    await tenantRun(() =>
      Booking.create({
        code: 'NVREPORT1', user: parentId, pet: pet._id, vendor: vendor._id, vendorOwner: vendor.owner, service: vendor._id,
        serviceSnapshot: { name: 'Consultation', pricePaise: 60000, durationMin: 30 }, scheduledAt: when, endsAt: new Date(when.getTime() + 30 * 60_000), status: 'completed',
      }),
    );

    const range = { from: new Date(Date.now() - 10 * DAY).toISOString(), to: new Date(Date.now() + DAY).toISOString() };
    const report = (await owner.http.get('/vendors/me/reports').query(range).expect(200)).body;
    expect(report.summary).toMatchObject({ bookings: 5, completed: 4, noShows: 1 });
    expect(report.revenue.visitsPaise).toBe(240000);
    expect(report.topServices[0]).toMatchObject({ name: 'Consultation', count: 3, valuePaise: 160000, nurvia: 1, own: 2 });
    expect(report.customers).toMatchObject({ unique: 3, repeat: 1, repeatPct: 33.3 });
    expect(report.customers.topRepeat[0]).toMatchObject({ name: 'Neha', visits: 2 });
    expect(report.noShows).toMatchObject({ count: 1, ratePct: 20 });
    expect(report.noShows.items[0]).toMatchObject({ customer: 'Ravi', service: 'Grooming' });

    const csv = await owner.http.get('/vendors/me/reports/export').query({ ...range, kind: 'customers' }).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    const lines = csv.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toMatch(/^Customer,Phone,Completed visits,Repeat customer/);
    expect(lines).toHaveLength(4);
    const bookings = await owner.http.get('/vendors/me/reports/export').query(range).expect(200);
    expect(bookings.text).toMatch(/NVREPORT1/);
    await owner.http.get('/vendors/me/reports').query({ from: range.from, to: new Date(Date.now() + 400 * DAY).toISOString() }).expect(400);
  });
});
