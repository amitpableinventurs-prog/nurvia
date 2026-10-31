// The Explore tab: local pet shops, the marketplace preview and its waitlist, registering and
// looking after a community dog, and adoption browse.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdoptionListing } from '../src/modules/adoption/adoption.model.js';
import { ShopCall } from '../src/modules/explore/explore.model.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { SosResponder } from '../src/modules/sos/sos.model.js';
import { User } from '../src/modules/users/user.model.js';
import { Vendor } from '../src/modules/vendors/vendor.model.js';
import { api, createAdmin, pngBuffer, signUpByPhone, startDb, stopDb, tenantRun } from './helpers.js';

const BENGALURU = { lat: 12.9716, lng: 77.5946 };
const INDIRANAGAR = { lat: 12.9784, lng: 77.6408 };
const KORAMANGALA = { lat: 12.9352, lng: 77.6245 };
const ALWAYS_OPEN = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '00:00', close: '23:59' }));
const DAY = 86_400_000;

let admin, asha, neighbour, volunteer, pharmacyOwner, storeOwner, pharmacy, store, city;
const at = ({ lat, lng }) => ({ type: 'Point', coordinates: [lng, lat] });
const hasNotification = (user, type) => tenantRun(() => Notification.exists({ user: user.user._id, type }));

async function shopOwner(name, fields) {
  const owner = await signUpByPhone(name);
  const vendor = await tenantRun(async () => {
    await User.updateOne({ _id: owner.user._id }, { $addToSet: { roles: 'vendor' } });
    return Vendor.create({ owner: owner.user._id, address: { line1: 'x', city: 'Bengaluru' }, operatingHours: ALWAYS_OPEN, status: 'active', ...fields });
  });
  return [owner, vendor];
}

beforeAll(async () => {
  await startDb();
  admin = await createAdmin();
  city = (
    await admin.http
      .post('/admin/cities')
      .send({
        slug: 'bengaluru', name: 'Bengaluru', center: BENGALURU, radiusKm: 40, status: 'active', modules: { booking: 'active', marketplace: 'coming_soon' },
        localities: [{ name: 'Indiranagar', center: INDIRANAGAR, popular: true }, { name: 'Koramangala', center: KORAMANGALA, popular: true }, { name: 'Domlur', center: { lat: 12.961, lng: 77.6387 } }],
      })
      .expect(201)
  ).body;
  asha = await signUpByPhone('Asha Rao');
  neighbour = await signUpByPhone('Rajesh Kumar');
  volunteer = await signUpByPhone('Ananya K');
  [pharmacyOwner, pharmacy] = await shopOwner('Canine Care', {
    businessName: 'Canine Care Pharmacy', phone: '+919845000071',
    description: 'Licensed pet pharmacy on 100 Feet Road with a vaccine fridge, vet tech on site and home delivery within 3 km. Open late every day, with prescription diets kept in stock for regulars.', location: at({ lat: 12.9719, lng: 77.6412 }), ratingAvg: 4.9, ratingCount: 40,
    kyc: { status: 'approved', licenseCheck: { status: 'verified' } }, store: { type: 'pharmacy', tags: ['Cold-chain vet medication'], coldChain: true, vetTechOnSite: true },
  });
  [storeOwner, store] = await shopOwner('Paws Whiskers', {
    businessName: 'Paws & Whiskers Essentials', phone: '+919845000072', location: at({ lat: 12.9785, lng: 77.641 }), ratingAvg: 4.6, ratingCount: 12,
    seller: { status: 'approved' }, store: { type: 'pet_store', locality: 'Indiranagar', tags: ['Curated treats & food'], inStorePickup: true },
  });
  // A clinic without a shop listing stays out of the directory.
  await shopOwner('Clinic', { businessName: 'Happy Vet Clinic', location: at(INDIRANAGAR) });
  await tenantRun(() => SosResponder.create({ user: volunteer.user._id, kind: 'volunteer', organisation: 'Indiranagar Rescue', location: at(INDIRANAGAR) }));
});
afterAll(stopDb);

describe('local pet shops', () => {
  it('asks for a location, offering popular localities', async () => {
    const { body } = await api().get('/explore/shops').expect(200);
    expect(body.location.source).toBe('none');
    expect(body.popularLocalities.map((l) => l.name)).toEqual(['Indiranagar', 'Koramangala']);
    const all = await api().get('/explore/localities?city=bengaluru&q=dom').expect(200);
    expect(all.body.items).toEqual([expect.objectContaining({ name: 'Domlur', popular: false })]);
  });

  it('lists shops near a picked locality, nearest first, with badges and hours', async () => {
    const { body } = await asha.http.get('/explore/shops?locality=Indiranagar&city=bengaluru').expect(200);
    expect(body.location).toMatchObject({ source: 'locality', locality: 'Indiranagar', city: 'Bengaluru' });
    expect(body.items.map((s) => s.businessName)).toEqual(['Paws & Whiskers Essentials', 'Canine Care Pharmacy']);
    expect(body.items[1]).toMatchObject({
      type: 'pharmacy', badge: 'licensed_dispensary', coldChain: true, vetTechOnSite: true, hours: { open: true },
      actions: { call: true, directions: true, checkStock: true },
    });
    expect(body.items[0]).toMatchObject({ badge: 'nurvia_partner', inStorePickup: true, actions: { checkStock: false } });
    expect(body.items[0].distanceKm).toBeLessThan(0.2);
    expect(body.items[0].phone).toBeUndefined();
    expect(body.marketplace.state).toBe('coming_soon');

    const filtered = await api().get(`/explore/shops?lat=${INDIRANAGAR.lat}&lng=${INDIRANAGAR.lng}&minRating=4.8&openNow=true`).expect(200);
    expect(filtered.body.items.map((s) => s.type)).toEqual(['pharmacy']);
    expect((await api().get(`/explore/shops?lat=${KORAMANGALA.lat}&lng=${KORAMANGALA.lng}&radiusKm=2`).expect(200)).body).toMatchObject({ total: 0, suggestExpand: { radiusKm: 5 } });
  });

  it('lets a shop manage its listing and mark stock as verified', async () => {
    const before = (await api().get(`/explore/shops?lat=${INDIRANAGAR.lat}&lng=${INDIRANAGAR.lng}`).expect(200)).body.items;
    expect(before.map((s) => s.description)).toEqual([null, 'Licensed pet pharmacy on 100 Feet Road with a vaccine fridge, vet tech on site and home delivery within 3 km. Open late every day, with prescription diets kept…']);

    const note = 'Fresh food and treats, packed for pickup in 10 minutes';
    await storeOwner.http.put('/vendors/me/store').send({ type: 'pet_store', locality: 'Indiranagar', note, tags: ['Curated treats & food', 'Organic grooming'], inStorePickup: true }).expect(200);
    const { body } = await storeOwner.http.post('/vendors/me/store/stock-verified').expect(200);
    const listed = (await api().get(`/explore/shops?lat=${INDIRANAGAR.lat}&lng=${INDIRANAGAR.lng}&type=pet_store`).expect(200)).body.items[0];
    expect(listed).toMatchObject({ description: note, tags: ['Curated treats & food', 'Organic grooming'], stockVerifiedAt: body.stockVerifiedAt });
  });

  it('hands out the number to call and records the call', async () => {
    await api().post(`/explore/shops/${store._id}/call`).expect(401);
    const { body } = await asha.http.post(`/explore/shops/${store._id}/call`).expect(200);
    expect(body).toEqual({ masked: false, dial: '+919845000072' });
    expect(await tenantRun(() => ShopCall.countDocuments({ vendor: store._id }))).toBe(1);
  });

  it('asks a pharmacy about stock and shows its answer', async () => {
    await asha.http.post(`/explore/shops/${store._id}/stock-checks`).send({ items: 'Apoquel 16 mg' }).expect(400);
    const check = (await asha.http.post(`/explore/shops/${pharmacy._id}/stock-checks`).send({ items: 'Apoquel 16 mg × 30' }).expect(201)).body;
    expect(await hasNotification(pharmacyOwner, 'stock_check.requested')).toBeTruthy();

    const inbox = await pharmacyOwner.http.get('/vendors/me/stock-checks?status=pending').expect(200);
    expect(inbox.body.items).toEqual([expect.objectContaining({ items: 'Apoquel 16 mg × 30', user: expect.objectContaining({ name: 'Asha Rao' }) })]);
    await storeOwner.http.post(`/vendors/me/stock-checks/${check._id}/reply`).send({ status: 'available' }).expect(404);
    await pharmacyOwner.http.post(`/vendors/me/stock-checks/${check._id}/reply`).send({ status: 'available', reply: 'Kept at the counter', holdHours: 4 }).expect(200);

    const mine = (await asha.http.get('/explore/stock-checks').expect(200)).body.items[0];
    expect(mine).toMatchObject({ status: 'available', reply: 'Kept at the counter', vendor: { businessName: 'Canine Care Pharmacy' } });
    expect(new Date(mine.holdUntil) - Date.now()).toBeGreaterThan(3.9 * 3_600_000);
    expect(await hasNotification(asha, 'stock_check.replied')).toBeTruthy();
  });
});

describe('marketplace preview', () => {
  it('shows what is coming and the shops nearby', async () => {
    const { body } = await asha.http.get('/explore/marketplace?locality=Indiranagar').expect(200);
    expect(body).toMatchObject({ live: false, availability: { state: 'coming_soon' }, nearbyShops: 2, waitlist: { joined: false } });
    expect(body.upcoming.map((u) => u.key)).toEqual(['multi_store_cart', 'same_day_delivery', 'cold_chain', 'pet_wallet']);
  });

  it('keeps one waitlist entry per person and tells them when shopping goes live', async () => {
    await asha.http.put('/explore/marketplace/waitlist').send({ locality: 'Koramangala' }).expect(200);
    const joined = await asha.http.put('/explore/marketplace/waitlist').send({ locality: 'indiranagar' }).expect(200);
    expect(joined.body).toEqual({ joined: true, locality: 'Indiranagar', city: 'Bengaluru', live: false });
    expect((await asha.http.get('/explore/marketplace').expect(200)).body.waitlist).toMatchObject({ joined: true, locality: 'Indiranagar' });

    await asha.http.get('/explore/marketplace/waitlist/summary').expect(403);
    const summary = await admin.http.get('/explore/marketplace/waitlist/summary').expect(200);
    expect(summary.body.items).toEqual([{ city: 'Bengaluru', locality: 'Indiranagar', waiting: 1 }]);

    await admin.http.patch(`/admin/cities/${city._id}`).send({ modules: { marketplace: 'active' } }).expect(200);
    expect(await hasNotification(asha, 'shop.marketplace_live')).toBeTruthy();
    expect((await admin.http.get('/explore/marketplace/waitlist/summary').expect(200)).body.items).toEqual([]);
  });

  it('sums up what is around on the Explore landing', async () => {
    const { body } = await asha.http.get(`/explore?lat=${INDIRANAGAR.lat}&lng=${INDIRANAGAR.lng}`).expect(200);
    expect(body).toMatchObject({ nearby: { shops: 2 }, marketplace: { state: 'active' } });
  });
});

describe('community dog registration and care', () => {
  let rusty;

  it('saves a private draft and lists what is missing before submitting', async () => {
    rusty = (await asha.http.post('/community-dogs/drafts').send({ draft: true, name: 'Rusty of 12th Main', sex: 'male' }).expect(201)).body;
    expect(rusty).toMatchObject({ draft: true, myRole: 'primary' });
    expect((await neighbour.http.get(`/community-dogs?lat=${INDIRANAGAR.lat}&lng=${INDIRANAGAR.lng}`).expect(200)).body.total).toBe(0);
    await neighbour.http.get(`/community-dogs/${rusty._id}`).expect(404);
    expect((await asha.http.get('/community-dogs?mine=true').expect(200)).body.items.map((d) => d.name)).toEqual(['Rusty of 12th Main']);

    const check = await asha.http.get(`/community-dogs/${rusty._id}/submit-check`).expect(200);
    expect(check.body).toMatchObject({ ready: false, missing: ['lifeStage', 'markings', 'size', 'photos', 'area', 'location'] });
    await asha.http.post(`/community-dogs/${rusty._id}/submit`).expect(400);
  });

  it('completes the draft with a nearby liaison and publishes it for review', async () => {
    const liaisons = await asha.http.get(`/community-dogs/liaisons?lat=${INDIRANAGAR.lat}&lng=${INDIRANAGAR.lng}`).expect(200);
    expect(liaisons.body.items).toEqual([{ userId: volunteer.user._id, name: 'Ananya K', kind: 'volunteer', organisation: 'Indiranagar Rescue' }]);
    await asha.http.patch(`/community-dogs/${rusty._id}`).send({ emergencyLiaisonId: neighbour.user._id }).expect(400);

    const photos = [];
    for (const name of ['a.png', 'b.png']) photos.push((await asha.http.post('/files').field('purpose', 'community').attach('file', pngBuffer, name).expect(201)).body._id);
    await asha.http
      .patch(`/community-dogs/${rusty._id}`)
      .send({
        lifeStage: 'young_adult', size: 'medium', markings: 'Light tan with white chest patch', photoFileIds: photos,
        area: 'Indiranagar Defence Colony park corner', city: 'Bengaluru', location: INDIRANAGAR, roamingRadiusM: 350,
        landmarks: 'Rests near the lane 4 banyan tree', earNotch: 'notched', feeding: { schedule: 'Fed at 8 AM by morning walkers', tolerances: 'Boiled chicken and rice' },
        emergencyLiaisonId: volunteer.user._id,
      })
      .expect(200);
    const { body } = await asha.http.post(`/community-dogs/${rusty._id}/submit`).expect(200);
    expect(body).toMatchObject({ draft: false, status: 'visible', sterilized: true, verification: { status: 'pending' } });
    expect(await hasNotification(volunteer, 'community_dog.liaison')).toBeTruthy();
    expect((await admin.http.get('/admin/queues/community-dogs').expect(200)).body.total).toBe(1);
  });

  it('never shows the public where the dog lives', async () => {
    const pub = (await neighbour.http.get(`/community-dogs/${rusty._id}`).expect(200)).body;
    expect(pub.location).toBeUndefined();
    expect(pub.landmarks).toBeUndefined();
    expect(pub.territory).toEqual({ area: 'Indiranagar Defence Colony park corner', city: 'Bengaluru' });
    expect(pub.feeding).toEqual({ tolerances: 'Boiled chicken and rice' });
    expect(pub.emergencyLiaison).toMatchObject({ name: 'Ananya K', organisation: 'Indiranagar Rescue', relayActive: true });
    expect(JSON.stringify(pub)).not.toContain('+91');

    const mine = (await asha.http.get(`/community-dogs/${rusty._id}`).expect(200)).body;
    expect(mine).toMatchObject({ myRole: 'primary', location: { coordinates: [INDIRANAGAR.lng, INDIRANAGAR.lat] }, territory: { radiusM: 350, exact: true }, badges: { earNotched: true, sterilised: true } });
  });

  it('brings a neighbour onto the team with an invite', async () => {
    const invite = (await asha.http.post(`/community-dogs/${rusty._id}/invites`).send({ role: 'feeder' }).expect(201)).body;
    expect(invite.shareText).toContain(invite.code);
    expect((await neighbour.http.get(`/community-dogs/invites/${invite.code}`).expect(200)).body).toMatchObject({ role: 'feeder', invitedBy: 'Asha Rao', dog: { name: 'Rusty of 12th Main' } });
    await neighbour.http.post(`/community-dogs/invites/${invite.code}/accept`).expect(200);
    await neighbour.http.post(`/community-dogs/invites/${invite.code}/accept`).expect(409);
    await neighbour.http.patch(`/community-dogs/${rusty._id}/care-team/me`).send({ title: 'Daily morning feeder' }).expect(200);

    const { body } = await neighbour.http.get(`/community-dogs/${rusty._id}`).expect(200);
    expect(body.team).toMatchObject({ total: 2, members: [{ role: 'primary', user: { name: 'Asha Rao' } }, { role: 'feeder', title: 'Daily morning feeder' }] });
    expect(body).toMatchObject({ myRole: 'feeder', territory: { radiusM: 350, exact: false } });
    expect(body.location).toBeUndefined();
    expect(await hasNotification(asha, 'community_dog.joined')).toBeTruthy();
  });

  it('builds the health matrix and the filtered care log', async () => {
    const http = asha.http;
    const iso = (days) => new Date(Date.now() + days * DAY).toISOString();
    const cert = (await http.post('/files').field('purpose', 'community').attach('file', pngBuffer, 'cert.png').expect(201)).body._id;
    await http.post(`/community-dogs/${rusty._id}/logs`).send({ type: 'rabies_vaccination', note: 'Annual ARV drive', documentFileIds: [cert], details: { authority: 'Indiranagar Animal Welfare', reference: 'ARV-8829', nextDueDate: iso(200) } }).expect(201);
    await http.post(`/community-dogs/${rusty._id}/logs`).send({ type: 'vaccinated', details: { vaccine: '7-in-1 (DHPPi)', nextDueDate: iso(10) } }).expect(201);
    await http.post(`/community-dogs/${rusty._id}/logs`).send({ type: 'dewormed', at: iso(-21) }).expect(201);
    await http.post(`/community-dogs/${rusty._id}/logs`).send({ type: 'sterilized', details: { tag: 'BB-228' } }).expect(201);
    const fed = (await neighbour.http.post(`/community-dogs/${rusty._id}/logs`).send({ type: 'fed', note: 'Boiled rice and chicken broth' }).expect(201)).body;

    const { body } = await neighbour.http.get(`/community-dogs/${rusty._id}`).expect(200);
    const health = Object.fromEntries(body.health.map((h) => [h.key, h]));
    expect(health.rabies).toMatchObject({ status: 'valid', reference: 'ARV-8829', official: false });
    expect(health.combination).toMatchObject({ label: '7-in-1 (DHPPi)', status: 'due_soon' });
    expect(health.deworming.status).toBe('valid');
    expect(health.sterilisation).toMatchObject({ status: 'done', reference: 'BB-228' });
    expect(body.badges.rabiesProtected).toBe(true);
    expect(body.logCounts).toMatchObject({ all: 5, feeding: 1, medical: 4 });

    const feeding = (await asha.http.get(`/community-dogs/${rusty._id}/logs?category=feeding`).expect(200)).body;
    expect(feeding.items.map((l) => l.note)).toEqual(['Boiled rice and chicken broth']);
    await asha.http.post(`/community-dogs/${rusty._id}/logs/${fed._id}/thanks`).expect(200);
    expect((await asha.http.get(`/community-dogs/${rusty._id}/logs?category=feeding`).expect(200)).body.items[0]).toMatchObject({ thanksCount: 1, thankedByMe: true });

    const rabiesLog = (await asha.http.get(`/community-dogs/${rusty._id}/logs?category=medical`).expect(200)).body.items.find((l) => l.type === 'rabies_vaccination');
    await asha.http.post(`/community-dogs/${rusty._id}/logs/${rabiesLog._id}/verify`).expect(403);
    await admin.http.post(`/community-dogs/${rusty._id}/logs/${rabiesLog._id}/verify`).expect(200);
    const after = (await asha.http.get(`/community-dogs/${rusty._id}`).expect(200)).body.health.find((h) => h.key === 'rabies');
    expect(after.official).toBe(true);
  });

  it('discards a draft on cancel', async () => {
    const draft = (await neighbour.http.post('/community-dogs/drafts').send({ draft: true, name: 'Kalu' }).expect(201)).body;
    await asha.http.delete(`/community-dogs/${draft._id}/draft`).expect(404);
    await neighbour.http.delete(`/community-dogs/${draft._id}/draft`).expect(204);
  });
});

describe('adoption browse', () => {
  let milo;

  beforeAll(async () => {
    const foster = await signUpByPhone('Preeti Menon');
    await tenantRun(async () => {
      milo = await AdoptionListing.create({
        postedBy: foster.user._id, name: 'Milo', species: 'dog', breed: 'Indie', ageMonths: 4, description: 'High energy, affectionate pup',
        city: 'Bengaluru', locality: 'Indiranagar', location: at(INDIRANAGAR), vaccinated: true, vaccinationDetails: '1st dose', dewormed: true,
        temperament: 'Great with other dogs', status: 'open', foster: { active: true, by: foster.user._id, locality: 'Indiranagar' },
      });
      await AdoptionListing.create({ postedBy: foster.user._id, name: 'Tara', species: 'cat', breed: 'Calico', ageMonths: 24, description: 'Gentle lap cat', city: 'Bengaluru', location: at(KORAMANGALA), sterilized: true, status: 'open' });
      await AdoptionListing.create({ postedBy: foster.user._id, name: 'Hidden', species: 'dog', ageMonths: 30, description: 'Awaiting review', city: 'Bengaluru', location: at(INDIRANAGAR) });
    });
  });

  it('shows cards with foster, health and age, and filters by chip', async () => {
    const near = `lat=${INDIRANAGAR.lat}&lng=${INDIRANAGAR.lng}`;
    const { body } = await asha.http.get(`/adoption/browse?${near}`).expect(200);
    expect(body).toMatchObject({ rescuesNearby: 2, total: 2, emptyState: null });
    const card = body.items.find((c) => c.name === 'Milo');
    expect(card).toMatchObject({
      ageLabel: 'Puppy · 4 mos', stage: 'available', health: { vaccinationDetails: '1st dose', dewormed: true },
      foster: { name: 'Preeti M.', locality: 'Indiranagar', reviewedByNurvia: true }, saved: false, myApplication: null,
    });
    expect((await asha.http.get(`/adoption/browse?${near}&group=young`).expect(200)).body.items.map((c) => c.name)).toEqual(['Milo']);
    expect((await asha.http.get(`/adoption/browse?${near}&group=cats`).expect(200)).body.items.map((c) => c.name)).toEqual(['Tara']);
    expect((await asha.http.get(`/adoption/browse?${near}&q=cats`).expect(200)).body.items.map((c) => c.name)).toEqual(['Tara']);
    expect((await asha.http.get(`/adoption/browse?${near}&q=indiranagar`).expect(200)).body.items.map((c) => c.name)).toEqual(['Milo']);
  });

  it('points a pedigree search to indie rescues nearby', async () => {
    const { body } = await asha.http.get(`/adoption/browse?lat=${INDIRANAGAR.lat}&lng=${INDIRANAGAR.lng}&radiusKm=10&q=golden%20retriever`).expect(200);
    expect(body).toMatchObject({ total: 0, emptyState: { query: 'golden retriever', indieNearby: 1, broaden: { radiusKm: 25 } } });
  });

  it('saves favourites and shows the application on the card', async () => {
    await asha.http.put(`/adoption/listings/${milo._id}/save`).expect(200);
    await asha.http.post(`/adoption/listings/${milo._id}/applications`).send({ message: 'We have a garden and work from home.' }).expect(201);
    const saved = await asha.http.get('/adoption/saved').expect(200);
    expect(saved.body.items).toEqual([expect.objectContaining({ name: 'Milo', saved: true, stage: 'application_received', myApplication: expect.objectContaining({ status: 'submitted' }) })]);
    await asha.http.delete(`/adoption/listings/${milo._id}/save`).expect(200);
    expect((await asha.http.get('/adoption/saved').expect(200)).body.total).toBe(0);
  });
});
