import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { AiUsage } from '../src/modules/ai/ai.routes.js';
import { api, createAdmin, pdfBuffer, signUpByPhone, startDb, stopDb, tenantRun } from './helpers.js';

// Phase 1 scope 3.6-3.9: community dog care teams, communities with posts, and the AI assistant.

const BLR = { lat: 12.9719, lng: 77.6412 };
let admin, asha, ravi, meera;

beforeAll(async () => {
  await startDb();
  admin = await createAdmin();
  asha = await signUpByPhone('Asha');
  ravi = await signUpByPhone('Ravi');
  meera = await signUpByPhone('Meera');
});

afterAll(stopDb);

describe('community dog care team', () => {
  let dog;

  it('records vet details and behaviour, kept within the team where private', async () => {
    dog = (
      await asha.http
        .post('/community-dogs')
        .send({ name: 'Brownie', nickname: 'Bhura', area: 'Indiranagar 12th Main', location: BLR, behaviour: 'Friendly, wary of bikes', vet: { name: 'Dr. Rao', clinic: 'Paws Clinic', phone: '+919800000001' } })
        .expect(201)
    ).body;
    const own = (await asha.http.get(`/community-dogs/${dog._id}`).expect(200)).body;
    expect(own).toMatchObject({ nickname: 'Bhura', behaviour: 'Friendly, wary of bikes', vet: { clinic: 'Paws Clinic' }, myRole: 'primary', myRoleLabel: 'Admin (primary caregiver)', canManageTeam: true });
    const stranger = (await meera.http.get(`/community-dogs/${dog._id}`).expect(200)).body;
    expect(stranger.vet).toBeUndefined();
    expect(stranger.behaviour).toBe('Friendly, wary of bikes');
  });

  it('lets admins manage the team, while only the primary caregiver can hand over the primary role', async () => {
    // A volunteer cannot invite someone as an admin.
    await ravi.http.post(`/community-dogs/${dog._id}/caregivers`).send({ role: 'volunteer' }).expect(200);
    await ravi.http.post(`/community-dogs/${dog._id}/invites`).send({ role: 'admin' }).expect(403);

    const invite = (await asha.http.post(`/community-dogs/${dog._id}/invites`).send({ role: 'admin' }).expect(201)).body;
    await meera.http.post(`/community-dogs/invites/${invite.code}/accept`).expect(200);
    const ashaId = (await asha.http.get('/users/me').expect(200)).body._id;
    const raviId = (await ravi.http.get('/users/me').expect(200)).body._id;

    // Meera, now an admin, sets Ravi as medical coordinator but cannot take over or remove the primary.
    await meera.http.put(`/community-dogs/${dog._id}/care-team/${raviId}`).send({ role: 'medical_coordinator' }).expect(200);
    await meera.http.put(`/community-dogs/${dog._id}/care-team/${raviId}`).send({ role: 'primary' }).expect(403);
    await meera.http.delete(`/community-dogs/${dog._id}/care-team/${ashaId}`).expect(403);

    const team = (await asha.http.get(`/community-dogs/${dog._id}`).expect(200)).body.team.members.map((m) => [m.user.name, m.roleLabel]);
    expect(team).toEqual([
      ['Asha', 'Admin (primary caregiver)'],
      ['Meera', 'Admin'],
      ['Ravi', 'Medical coordinator'],
    ]);
  });
});

describe('communities', () => {
  let indiranagar, indies;

  it('lets staff set up communities by city, locality and breed', async () => {
    indiranagar = (await admin.http.post('/admin/communities').send({ name: 'Indiranagar pet parents', slug: 'indiranagar', kind: 'locality', city: 'Bengaluru', locality: 'Indiranagar' }).expect(201)).body;
    indies = (await admin.http.post('/admin/communities').send({ name: 'Indie dog lovers', slug: 'indies', kind: 'breed', breed: 'Indie' }).expect(201)).body;
    await admin.http.post('/admin/communities').send({ name: 'Mumbai rescue', slug: 'mumbai-rescue', kind: 'rescue', city: 'Mumbai' }).expect(201);
    await admin.http.post('/admin/communities').send({ name: 'Dup', slug: 'indies', kind: 'breed' }).expect(409);
    await asha.http.post('/admin/communities').send({ name: 'Mine', slug: 'mine', kind: 'city' }).expect(403);

    const inBengaluru = (await asha.http.get('/community/communities?city=bengaluru').expect(200)).body.items.map((c) => c.slug);
    expect(inBengaluru.sort()).toEqual(['indies', 'indiranagar']);
  });

  it('lets members post, react and comment, and delete their own posts', async () => {
    await asha.http.post('/community/posts').send({ text: 'Hello', communityId: indiranagar._id }).expect(403);
    expect((await asha.http.post(`/community/communities/${indiranagar._id}/join`).expect(200)).body).toMatchObject({ joined: true, memberCount: 1 });
    await asha.http.post(`/community/communities/${indiranagar._id}/join`).expect(200);
    const post = (await asha.http.post('/community/posts').send({ text: 'Free vaccination camp on Sunday', communityId: indiranagar._id }).expect(201)).body;
    expect(post.city).toBe('Bengaluru');

    await ravi.http.put(`/community/posts/${post._id}/reaction`).send({ type: 'love' }).expect(200);
    await ravi.http.post(`/community/posts/${post._id}/comments`).send({ text: 'Where exactly?' }).expect(201);
    const inCommunity = (await ravi.http.get(`/community/posts?community=${indiranagar._id}`).expect(200)).body.items;
    expect(inCommunity[0]).toMatchObject({ reactionCount: 1, commentCount: 1, community: { name: 'Indiranagar pet parents' }, myReaction: 'love', mine: false });

    expect((await asha.http.get('/community/posts?feed=joined').expect(200)).body.total).toBe(1);
    expect((await ravi.http.get('/community/posts?feed=joined').expect(200)).body.total).toBe(0);
    expect((await asha.http.get('/community/communities?mine=true').expect(200)).body.items.map((c) => [c.slug, c.joined, c.postCount])).toEqual([['indiranagar', true, 1]]);

    await ravi.http.delete(`/community/posts/${post._id}`).expect(404);
    await asha.http.delete(`/community/posts/${post._id}`).expect(204);
    expect((await asha.http.get(`/community/communities/${indiranagar._id}`).expect(200)).body).toMatchObject({ postCount: 0, joined: true });
    await asha.http.delete(`/community/communities/${indiranagar._id}/join`).expect(204);
    expect((await asha.http.get(`/community/communities/${indiranagar._id}`).expect(200)).body).toMatchObject({ memberCount: 0, joined: false });
  });

  it('hides archived communities', async () => {
    await admin.http.patch(`/admin/communities/${indies._id}`).send({ status: 'archived' }).expect(200);
    await asha.http.get(`/community/communities/${indies._id}`).expect(404);
    expect((await admin.http.get('/admin/communities?status=archived').expect(200)).body.items.map((c) => c.slug)).toEqual(['indies']);
  });
});

describe('AI assistant', () => {
  let pet, dog;
  const saved = { ...env.ai };
  afterEach(() => Object.assign(env.ai, saved));

  beforeAll(async () => {
    pet = (await asha.http.post('/pets').send({ name: 'Bruno', species: 'dog', allergies: ['chicken'] }).expect(201)).body;
    await asha.http.post(`/pets/${pet._id}/records`).send({ type: 'vaccination', title: 'Anti-rabies', date: '2025-01-10', nextDueDate: '2026-01-10' }).expect(201);
    dog = (await ravi.http.post('/community-dogs').send({ name: 'Kaalu', area: 'Domlur', location: BLR }).expect(201)).body;
  });

  it('answers record questions without a model', async () => {
    const status = (await asha.http.get('/ai/status').expect(200)).body;
    expect(status).toMatchObject({ enabled: false, features: { petRecords: true, healthSummary: false } });

    const records = (await asha.http.get(`/ai/pets/${pet._id}/records`).expect(200)).body;
    expect(records.vaccinations[0]).toMatchObject({ title: 'Rabies', status: 'overdue' });
    expect(records.missingCoreVaccines).toEqual(['DHPP (distemper combination)']);
    expect(records.due.overdue.map((d) => d.title)).toEqual(['Rabies']);
    await ravi.http.get(`/ai/pets/${pet._id}/records`).expect(404);

    const insights = (await ravi.http.get('/ai/community-dogs/insights').expect(200)).body;
    // Ravi also helps with Brownie, as medical coordinator.
    const names = (list) => list.map((d) => d.name).sort();
    expect(names(insights.pendingVaccinations)).toEqual(['Brownie', 'Kaalu']);
    expect(names(insights.missingFeedingUpdates)).toEqual(['Brownie', 'Kaalu']);
    expect(names(insights.unknownSterilisation)).toEqual(['Brownie', 'Kaalu']);
    const one = (await ravi.http.get(`/ai/community-dogs/insights?dogId=${dog._id}`).expect(200)).body;
    expect(one.dogs.map((d) => d.name)).toEqual(['Kaalu']);
    await asha.http.get(`/ai/community-dogs/insights?dogId=${dog._id}`).expect(403);

    await asha.http.post(`/ai/pets/${pet._id}/health-summary`).expect(503);
  });

  it('summarises, answers questions and reads documents through the model, within a daily limit', async () => {
    Object.assign(env.ai, { provider: 'mock', dailyLimit: 3 });
    const summary = (await asha.http.post(`/ai/pets/${pet._id}/health-summary`).expect(200)).body;
    expect(summary).toMatchObject({ summary: expect.stringContaining('[mock]'), cached: false, disclaimer: expect.stringContaining('not a veterinarian') });
    // The same request on unchanged records is answered from the cache, without using the daily limit.
    expect((await asha.http.post(`/ai/pets/${pet._id}/health-summary`).expect(200)).body).toMatchObject({ summary: summary.summary, cached: true });
    expect((await asha.http.get('/ai/status').expect(200)).body.remainingToday).toBe(2);
    // A new record changes the data, so the summary is written again.
    await asha.http.post(`/pets/${pet._id}/records`).send({ type: 'deworming', title: 'Drontal', date: '2026-10-01' }).expect(201);
    expect((await asha.http.post(`/ai/pets/${pet._id}/health-summary`).expect(200)).body.cached).toBe(false);
    Object.assign(env.ai, { dailyLimit: 4 });

    await ravi.http.post('/ai/ask').send({ question: 'Is Kaalu due for anything?', communityDogId: dog._id }).expect(200);
    await asha.http.post('/ai/ask').send({ question: 'Is Kaalu due for anything?', communityDogId: dog._id }).expect(403);

    const file = (await asha.http.post('/files').field('purpose', 'health_record').attach('file', pdfBuffer, 'prescription.pdf').expect(201)).body;
    const doc = (await asha.http.post('/ai/documents/summarise').send({ fileId: file._id }).expect(200)).body;
    expect(doc.summary).toMatch(/document, text/);
    await ravi.http.post('/ai/documents/summarise').send({ fileId: file._id }).expect(404);

    await asha.http.post('/ai/ask').send({ question: 'What vaccines does Bruno have?' }).expect(200);
    const limited = await asha.http.post('/ai/ask').send({ question: 'And deworming?' }).expect(429);
    expect(limited.body.error.message).toMatch(/4 times a day/);
    const logged = await tenantRun(() => AiUsage.find({}).lean());
    expect(logged.filter((u) => !u.cached).map((u) => u.feature).sort()).toEqual(['ask', 'ask_community_dog', 'document_summary', 'health_summary', 'health_summary']);
    expect(logged.filter((u) => u.cached).map((u) => u.feature)).toEqual(['health_summary']);
    // Asking the same document again is instant, even at the limit.
    expect((await asha.http.post('/ai/documents/summarise').send({ fileId: file._id }).expect(200)).body.cached).toBe(true);
  });
});
