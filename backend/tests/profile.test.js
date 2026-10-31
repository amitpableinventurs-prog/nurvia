import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccessToken } from '../src/common/auth.js';
import { User } from '../src/modules/users/user.model.js';
import { api, createAdmin, pngBuffer, signUpByPhone, startDb, stopDb, tenantRun } from './helpers.js';

const BENGALURU = { lat: 12.9716, lng: 77.5946 };
const INDIRANAGAR = { lat: 12.9784, lng: 77.6408 };

let user;

beforeAll(async () => {
  await startDb();
  const admin = await createAdmin();
  await admin.http.post('/admin/cities').send({ slug: 'bengaluru', name: 'Bengaluru', aliases: ['Bangalore'], center: BENGALURU, radiusKm: 40, status: 'active' }).expect(201);
  await admin.http.post('/admin/cities').send({ slug: 'mumbai', name: 'Mumbai', center: { lat: 19.076, lng: 72.8777 }, status: 'coming_soon' }).expect(201);
  user = await signUpByPhone();
  await user.http.post('/users/me/terms').send({ version: user.onboarding.termsVersion }).expect(200);
});
afterAll(stopDb);

describe('profile screen', () => {
  it('lists the cities and languages for the pickers', async () => {
    const { body } = await api().get('/config').expect(200);
    expect(body.cities.map((c) => c.slug)).toEqual(['bengaluru', 'mumbai']);
    expect(body.languages.map((l) => l.code)).toContain('kn');
  });

  it('saves the profile and completes the step', async () => {
    const photo = await user.http.post('/files').field('purpose', 'avatar').attach('file', pngBuffer, 'me.png').expect(201);
    const { body } = await user.http
      .patch('/users/me')
      .send({
        name: 'Asha Rao',
        avatarFileId: photo.body._id,
        city: 'Bangalore',
        locality: 'Indiranagar',
        emergencyContact: { name: 'Rahul Rao', phone: '98450 22222' },
        preferences: { language: 'kn', whatsapp: true },
      })
      .expect(200);
    expect(body).toMatchObject({
      name: 'Asha Rao',
      avatarUrl: photo.body.url,
      city: 'Bengaluru',
      citySlug: 'bengaluru',
      locality: 'Indiranagar',
      emergencyContact: { name: 'Rahul Rao', phone: '+919845022222' },
      preferences: { language: 'kn', whatsapp: true },
      onboarding: { profileComplete: true, missing: [], hasLocation: false, nextStep: 'pet' },
    });
    expect(body.preferences.whatsappConsentAt).toBeTruthy();
  });

  it('rejects what the profile cannot hold', async () => {
    await user.http.patch('/users/me').send({ city: 'Atlantis' }).expect(400);
    await user.http.patch('/users/me').send({ preferences: { language: 'xx' } }).expect(400);
    await user.http.patch('/users/me').send({ emergencyContact: { name: 'Me', phone: user.phone } }).expect(400);
    await user.http.patch('/users/me').send({ phone: '+919845033333' }).expect(400);
    const other = await signUpByPhone();
    const theirPhoto = await other.http.post('/files').field('purpose', 'avatar').attach('file', pngBuffer, 'x.png').expect(201);
    await user.http.patch('/users/me').send({ avatarFileId: theirPhoto.body._id }).expect(400);
  });

  it('clears fields with null and withdraws WhatsApp consent', async () => {
    const { body } = await user.http.patch('/users/me').send({ locality: null, preferences: { whatsapp: false } }).expect(200);
    expect(body.locality).toBeUndefined();
    expect(body.preferences.whatsapp).toBe(false);
    expect(body.preferences.whatsappConsentAt).toBeUndefined();
  });
});

describe('mobile number and email', () => {
  it('adds an email once the code sent to it is entered', async () => {
    const email = 'asha@example.com';
    const sent = await user.http.post('/users/me/contact/request').send({ email }).expect(200);
    await user.http.post('/users/me/contact/verify').send({ email, code: sent.body.devCode === '000000' ? '111111' : '000000' }).expect(401);
    const { body } = await user.http.post('/users/me/contact/verify').send({ email, code: sent.body.devCode }).expect(200);
    expect(body.email).toBe(email);
  });

  it('refuses a number that belongs to another account', async () => {
    const other = await signUpByPhone();
    const sent = await user.http.post('/users/me/contact/request').send({ phone: other.phone }).expect(200);
    await user.http.post('/users/me/contact/verify').send({ phone: other.phone, code: sent.body.devCode }).expect(409);
    await user.http.post('/users/me/contact/request').send({ phone: user.phone }).expect(400);
  });

  it('asks a Google or email user for a verified mobile number', async () => {
    const email = 'no-phone@example.com';
    // An email-only account, as Google or Apple sign-in creates it.
    const meera = await tenantRun(() => User.create({ email, name: 'Meera', consents: { termsVersion: user.onboarding.termsVersion, termsAcceptedAt: new Date() } }));
    const http = api(signAccessToken(meera));
    const saved = await http.patch('/users/me').send({ city: 'bengaluru' }).expect(200);
    expect(saved.body.onboarding).toMatchObject({ missing: ['phone'], nextStep: 'profile' });

    const sent = await http.post('/users/me/contact/request').send({ phone: '9845044444' }).expect(200);
    const verified = await http.post('/users/me/contact/verify').send({ phone: '9845044444', code: sent.body.devCode }).expect(200);
    expect(verified.body).toMatchObject({ phone: '+919845044444', onboarding: { profileComplete: true, nextStep: 'pet' } });
  });
});

describe('location screen', () => {
  it('saves a GPS location and says which city it is in', async () => {
    const { body } = await user.http.put('/users/me/location').send({ ...INDIRANAGAR, source: 'gps' }).expect(200);
    expect(body).toMatchObject({
      location: { ...INDIRANAGAR, source: 'gps', approximate: false },
      city: { slug: 'bengaluru', modules: { booking: 'active' } },
      covered: true,
    });
    expect((await user.http.get('/users/me/onboarding')).body.hasLocation).toBe(true);
  });

  it('uses the city centre when only a city is given', async () => {
    const { body } = await user.http.put('/users/me/location').send({ city: 'Mumbai', locality: 'Bandra' }).expect(200);
    expect(body).toMatchObject({ location: { lat: 19.076, lng: 72.8777, source: 'city', locality: 'Bandra', approximate: true }, city: { status: 'coming_soon' } });
  });

  it('says when no city covers the place', async () => {
    const { body } = await user.http.put('/users/me/location').send({ lat: 26.9124, lng: 75.7873, source: 'manual' }).expect(200);
    expect(body).toMatchObject({ city: null, covered: false });
    await user.http.put('/users/me/location').send({ lat: 26.9 }).expect(400);
    await user.http.put('/users/me/location').send({ city: 'Atlantis' }).expect(400);
  });
});

describe('city picker', () => {
  it('lists the cities, finds one by alias and detects the city from a location', async () => {
    const all = await api().get('/config/cities').expect(200);
    expect(all.body.items.map((c) => c.slug).sort()).toEqual(['bengaluru', 'mumbai']);
    expect(all.body.items.find((c) => c.slug === 'mumbai')).toEqual({ slug: 'mumbai', name: 'Mumbai', status: 'coming_soon' });
    expect(all.body.detected).toBeNull();
    expect((await api().get('/config/cities?q=bangalore').expect(200)).body.items.map((c) => c.slug)).toEqual(['bengaluru']);

    const here = await api().get(`/config/cities?lat=${INDIRANAGAR.lat}&lng=${INDIRANAGAR.lng}`).expect(200);
    expect(here.body.detected).toMatchObject({ slug: 'bengaluru', name: 'Bengaluru', status: 'active' });
    expect((await api().get('/config/cities?lat=28.61&lng=77.21').expect(200)).body.detected).toBeNull();
    await api().get('/config/cities?lat=12.97').expect(400);
  });

  it('registers with the slug from the picker, and refuses a city that is not in it', async () => {
    const phone = '9845011111';
    const sent = await api().post('/auth/otp/request').send({ phone }).expect(200);
    const verified = await api().post('/auth/otp/verify').send({ phone, code: sent.body.devCode }).expect(200);
    const { body } = await api().post('/auth/register').send({ registrationToken: verified.body.registrationToken, name: 'Kiran', city: 'bengaluru' }).expect(200);
    expect(body.user).toMatchObject({ city: 'Bengaluru', citySlug: 'bengaluru' });

    const wrongPhone = '9845011112';
    const wrongSent = await api().post('/auth/otp/request').send({ phone: wrongPhone }).expect(200);
    const wrongVerified = await api().post('/auth/otp/verify').send({ phone: wrongPhone, code: wrongSent.body.devCode }).expect(200);
    const wrong = await api().post('/auth/register').send({ registrationToken: wrongVerified.body.registrationToken, name: 'Kiran', city: 'Atlantis' }).expect(400);
    expect(wrong.body.error.message).toBe('Choose a city from the list');
  });

  it('searches every Indian city as the user types', async () => {
    const search = async (query) => (await api().get(`/config/cities?${query}`).expect(200)).body.items;
    expect(await search('q=ind&limit=3')).toEqual([
      { slug: 'indore', name: 'Indore', region: 'Madhya Pradesh', status: 'unavailable' },
      { slug: 'indi', name: 'Indi', region: 'Karnataka', status: 'unavailable' },
      { slug: 'indapur', name: 'Indapur', region: 'Maharashtra', status: 'unavailable' },
    ]);
    // Nurvia's cities come first, also when found by an alias, and keep their status.
    expect((await search('q=ban'))[0]).toEqual({ slug: 'bengaluru', name: 'Bengaluru', status: 'active', matched: 'Bangalore' });
    expect(await search('q=Calcutta')).toEqual([{ slug: 'kolkata', name: 'Kolkata', region: 'West Bengal', status: 'unavailable', matched: 'Calcutta' }]);
    // The place a Nurvia city stands for is listed once, as that city.
    expect((await search('q=mumbai')).filter((c) => c.name === 'Mumbai')).toEqual([{ slug: 'mumbai', name: 'Mumbai', status: 'coming_soon' }]);
    // Same-name towns in different states have their own slugs.
    expect((await search('q=aurangabad')).slice(0, 2).map((c) => c.slug)).toEqual(['aurangabad', 'aurangabad-bihar']);
    expect(await search('q=zzzz')).toEqual([]);
    await api().get('/config/cities?q=ind&limit=51').expect(400);
  });

  it('saves any Indian city from the search, by name only', async () => {
    const phone = '9845011113';
    const sent = await api().post('/auth/otp/request').send({ phone }).expect(200);
    const verified = await api().post('/auth/otp/verify').send({ phone, code: sent.body.devCode }).expect(200);
    const { body } = await api().post('/auth/register').send({ registrationToken: verified.body.registrationToken, name: 'Ravi', city: 'aurangabad-bihar' }).expect(200);
    expect(body.user.city).toBe('Aurangabad');
    expect(body.user.citySlug).toBeUndefined();

    const http = api(body.accessToken);
    expect((await http.patch('/users/me').send({ city: 'Calcutta' }).expect(200)).body).toMatchObject({ city: 'Kolkata' });
    // Picked by its own name, a place a Nurvia city covers is saved as that city.
    expect((await http.patch('/users/me').send({ city: 'bangalore' }).expect(200)).body).toMatchObject({ city: 'Bengaluru', citySlug: 'bengaluru' });
    const moved = await http.patch('/users/me').send({ city: 'indore' }).expect(200);
    expect(moved.body.city).toBe('Indore');
    expect(moved.body.citySlug).toBeUndefined();
  });
});
