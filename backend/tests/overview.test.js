import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLES } from '../src/common/roles.js';
import { AdoptionListing } from '../src/modules/adoption/adoption.model.js';
import { AuditLog } from '../src/modules/audit/audit.model.js';
import { Post } from '../src/modules/community/community.model.js';
import { Vendor } from '../src/modules/vendors/vendor.model.js';
import { createAdmin, seedCategories, signUpByPhone, startDb, stopDb, tenantRun } from './helpers.js';

const BANGALORE = { lat: 12.9716, lng: 77.5946 };
const point = { type: 'Point', coordinates: [BANGALORE.lng, BANGALORE.lat] };
const fileId = () => new mongoose.Types.ObjectId();

let categories, admin, staff, member, vet;

async function me(user) {
  return (await user.http.get('/users/me').expect(200)).body;
}

beforeAll(async () => {
  await startDb();
  categories = await seedCategories();
  admin = await createAdmin();
  staff = await createAdmin(ROLES.STAFF);
  member = await signUpByPhone('Asha');
  vet = await signUpByPhone('Dr. Sneha');
  // A live vet clinic: its owner counts as a trusted reporter.
  const vetUser = await me(vet);
  await tenantRun(() =>
    Vendor.create({
      owner: vetUser._id, businessName: 'Sneha Vet Care', categories: [categories.vet._id], status: 'active',
      address: { line1: '1 CMH Road', city: 'Bengaluru' }, location: point, kyc: { status: 'approved' },
    }),
  );
});
afterAll(stopDb);

describe('overview metrics', () => {
  it('returns the snapshot for a window and rejects unknown windows', async () => {
    const res = await admin.http.get('/admin/overview?window=24h').expect(200);
    expect(res.body).toMatchObject({
      window: '24h',
      providers: { verified: 1, pendingKyc: 0 },
      safety: { open: 0, high: 0 },
      bookingsToday: { scheduled: 0, inProgress: 0 },
    });
    expect(res.body.petParents.total).toBeGreaterThanOrEqual(2);
    await admin.http.get('/admin/overview?window=1y').expect(400);
    await member.http.get('/admin/overview').expect(403);
  });
});

describe('queue A: vendor applications', () => {
  let withLicence, withoutLicence;

  beforeAll(async () => {
    const [a, b] = await Promise.all([signUpByPhone('Arvind'), signUpByPhone('Barks')]);
    const [ua, ub] = await Promise.all([me(a), me(b)]);
    [withLicence, withoutLicence] = await tenantRun(() =>
      Vendor.create([
        {
          owner: ua._id, businessName: "Dr. Arvind's Companion Clinic", categories: [categories.vet._id], status: 'pending',
          address: { line1: '5 80 Feet Road', line2: 'Indiranagar Stage II', city: 'Bengaluru' }, location: point,
          kyc: { status: 'submitted', submittedAt: new Date(Date.now() - 30 * 3_600_000), documents: [{ type: 'shop_license', file: fileId() }] },
        },
        {
          owner: ub._id, businessName: 'Barks & Tails Mobile Groomers', status: 'pending',
          address: { line1: 'EPIP Zone, Whitefield', city: 'Bengaluru' }, location: point,
          kyc: { status: 'submitted', submittedAt: new Date(), documents: [{ type: 'pan', file: fileId() }] },
        },
      ]),
    );
  });

  it('lists submitted applications oldest first, with SLA and licence status', async () => {
    const res = await admin.http.get('/admin/queues/vendor-applications').expect(200);
    expect(res.body.total).toBe(2);
    expect(res.body.items[0]).toMatchObject({
      businessName: "Dr. Arvind's Companion Clinic", categories: ['Vet clinic'], locality: 'Indiranagar Stage II', overdue: true, licenseStatus: 'manual_review',
    });
    expect(res.body.items[1]).toMatchObject({ overdue: false, licenseStatus: 'pending_upload' });
    const newest = await admin.http.get('/admin/queues/vendor-applications?sort=newest').expect(200);
    expect(newest.body.items[0].businessName).toBe('Barks & Tails Mobile Groomers');
  });

  it('records a manual licence check', async () => {
    await admin.http.post(`/admin/vendors/${withoutLicence._id}/license-check`).send({ result: 'verified' }).expect(409);
    await admin.http.post(`/admin/vendors/${withLicence._id}/license-check`).send({ result: 'failed' }).expect(400);
    await staff.http.post(`/admin/vendors/${withLicence._id}/license-check`).send({ result: 'verified' }).expect(403);
    const res = await admin.http.post(`/admin/vendors/${withLicence._id}/license-check`).send({ result: 'verified', note: 'Matched BBMP register' }).expect(200);
    expect(res.body.licenseStatus).toBe('verified');
    const detail = await admin.http.get(`/admin/vendors/${withLicence._id}`).expect(200);
    expect(detail.body.licenseStatus).toBe('verified');
  });
});

describe('queue B: safety alerts', () => {
  const newPost = async (text) => tenantRun(async () => Post.create({ author: (await me(member))._id, text }));

  it('quarantines a high-severity report from a verified provider, and lifts it on dismissal', async () => {
    const post = await newPost('Give your puppy half a Crocin for fever');
    await vet.http.post('/reports').send({ targetType: 'post', targetId: post._id, reason: 'harmful_advice', details: 'Paracetamol is toxic to dogs' }).expect(202);
    expect((await tenantRun(() => Post.findById(post._id))).status).toBe('hidden');

    const queue = await admin.http.get('/admin/queues/safety').expect(200);
    expect(queue.body.bySeverity.high).toBe(1);
    expect(queue.body.items[0]).toMatchObject({
      severity: 'high', quarantined: true, details: 'Paracetamol is toxic to dogs', reporter: { name: 'Dr. Sneha', label: 'Vet clinic' },
      target: { text: 'Give your puppy half a Crocin for fever' },
    });
    expect(queue.body.items[0].ref).toMatch(/^MOD-[0-9A-F]{6}$/);

    await admin.http.patch(`/admin/reports/${queue.body.items[0]._id}`).send({ status: 'dismissed', resolution: 'Context was a vet-prescribed dose' }).expect(200);
    expect((await tenantRun(() => Post.findById(post._id))).status).toBe('visible');
  });

  it('does not quarantine on a member report', async () => {
    const post = await newPost('Onions are a great treat');
    await member.http.post('/reports').send({ targetType: 'post', targetId: post._id, reason: 'harmful_advice' }).expect(202);
    expect((await tenantRun(() => Post.findById(post._id))).status).toBe('visible');
  });

  it('takes content down and closes every open report on it', async () => {
    const post = await newPost('Chocolate is fine for dogs in small amounts');
    await vet.http.post('/reports').send({ targetType: 'post', targetId: post._id, reason: 'harmful_advice' }).expect(202);
    await member.http.post('/reports').send({ targetType: 'post', targetId: post._id, reason: 'misinformation' }).expect(202);
    const queue = await admin.http.get('/admin/queues/safety').expect(200);
    const report = queue.body.items.find((r) => String(r.targetId) === String(post._id));

    const res = await admin.http.post(`/admin/reports/${report._id}/enforce`).send({ resolution: 'Toxic advice removed' }).expect(200);
    expect(res.body).toEqual({ removed: true, closedReports: 2 });
    expect((await tenantRun(() => Post.findById(post._id))).status).toBe('removed');
    await admin.http.post(`/admin/reports/${report._id}/enforce`).send({ resolution: 'Again' }).expect(409);
  });
});

describe('queue C: community dog badge', () => {
  it('verifies a profile and re-queues it when the territory moves', async () => {
    const dog = await member.http.post('/community-dogs').send({ name: 'Brownie', area: 'Indiranagar 4th Cross', location: BANGALORE, sterilized: true }).expect(201);
    await member.http.post(`/community-dogs/${dog.body._id}/logs`).send({ type: 'vaccinated', note: 'Anti-rabies' }).expect(201);

    const queue = await admin.http.get('/admin/queues/community-dogs').expect(200);
    expect(queue.body.items[0]).toMatchObject({ name: 'Brownie', caregiverCount: 1, submitter: { name: 'Asha' }, lastVaccination: { note: 'Anti-rabies' } });

    await admin.http.post(`/admin/compliance/community-dogs/${dog.body._id}/verification`).send({ action: 'request_changes' }).expect(400);
    await admin.http.post(`/admin/compliance/community-dogs/${dog.body._id}/verification`).send({ action: 'approve' }).expect(200);
    expect((await admin.http.get('/admin/queues/community-dogs').expect(200)).body.total).toBe(0);

    await member.http.patch(`/community-dogs/${dog.body._id}`).send({ area: 'Indiranagar 4th Cross', location: BANGALORE }).expect(200);
    expect((await admin.http.get('/admin/queues/community-dogs').expect(200)).body.total).toBe(0);
    await member.http.patch(`/community-dogs/${dog.body._id}`).send({ area: 'Domlur Flyover', location: BANGALORE }).expect(200);
    expect((await admin.http.get('/admin/queues/community-dogs').expect(200)).body.total).toBe(1);
  });
});

describe('queue D: adoption compliance', () => {
  it('certifies an approved adoption only after the home check and microchip', async () => {
    const lister = await signUpByPhone('Rescuer');
    const adopter = await signUpByPhone('Vikram Sen');
    const listing = await tenantRun(async () =>
      AdoptionListing.create({ postedBy: (await me(lister))._id, name: 'Milo', species: 'dog', breed: 'Beagle mix', description: 'Rescued beagle mix, one year old.', city: 'Bengaluru', status: 'open' }),
    );
    const application = await adopter.http.post(`/adoption/listings/${listing._id}/applications`).send({ message: 'We have a netted balcony.' }).expect(201);
    const id = application.body._id;
    const url = `/admin/compliance/adoption/applications/${id}/compliance`;

    await admin.http.post(url).send({ action: 'certify' }).expect(409); // lister has not approved yet
    await lister.http.patch(`/adoption/applications/${id}`).send({ status: 'approved' }).expect(200);

    const queue = await admin.http.get('/admin/queues/adoption-audits').expect(200);
    expect(queue.body.items[0]).toMatchObject({ feePaise: 0, microchipRequired: true, listing: { name: 'Milo' }, applicant: { name: 'Vikram Sen' }, compliance: { status: 'pending', homeCheck: { status: 'pending' } } });

    const blocked = await admin.http.post(url).send({ action: 'certify' }).expect(409);
    expect(blocked.body.error.message).toMatch(/home check.*microchip/);
    await admin.http.post(url).send({ action: 'home_check', result: 'passed', note: 'Balcony netted' }).expect(200);
    await admin.http.post(url).send({ action: 'schedule_microchip', scheduledAt: new Date(Date.now() + 7 * 86_400_000).toISOString() }).expect(200);
    const certified = await admin.http.post(url).send({ action: 'certify' }).expect(200);
    expect(certified.body.compliance.status).toBe('certified');
    expect((await tenantRun(() => AdoptionListing.findById(listing._id))).status).toBe('adopted');
    expect((await admin.http.get('/admin/queues/adoption-audits').expect(200)).body.total).toBe(0);
  });
});

describe('search, status and the audit ledger', () => {
  it('searches across records the staff member may see', async () => {
    const res = await admin.http.get('/admin/search?q=arvind').expect(200);
    expect(res.body.results.map((r) => r.type)).toEqual(expect.arrayContaining(['user', 'vendor']));
    await admin.http.get('/admin/search?q=a').expect(400);
  });

  it('reports database health and integration modes', async () => {
    const res = await staff.http.get('/admin/system/status').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', database: { status: 'ok' } });
    expect(res.body.integrations.find((i) => i.key === 'payments').mode).toBe('sandbox');
  });

  it('verifies the hash chain, detects tampering and exports a dossier', async () => {
    const ok = await admin.http.get('/admin/audit/verify').expect(200);
    expect(ok.body).toMatchObject({ ok: true, algorithm: 'sha256' });
    expect(ok.body.checked).toBeGreaterThan(5);

    const csv = await admin.http.get('/admin/audit/export').expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['x-audit-chain']).toMatch(/^verified/);
    const lines = csv.text.trim().split('\r\n');
    expect(lines[0]).toMatch(/^seq,created_at,actor_id/);
    expect(lines.length).toBe(ok.body.checked + 1);
    await staff.http.get('/admin/audit/export').expect(403);

    const victim = await tenantRun(() => AuditLog.findOne({ action: 'vendor.license_verified' }));
    await tenantRun(() => AuditLog.updateOne({ _id: victim._id }, { reason: 'edited later' }));
    const broken = await admin.http.get('/admin/audit/verify').expect(200);
    expect(broken.body).toMatchObject({ ok: false, brokenAt: { seq: victim.seq, problem: 'hash' } });
  });
});
