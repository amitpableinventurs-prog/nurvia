import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env.js';
import { RefreshToken } from '../src/modules/auth/auth.model.js';
import { buildOpenApiSpec } from '../src/docs/openapi.js';
import { api, app, createAdmin, pdfBuffer, pngBuffer, signUpByPhone, startDb, stopDb, tenantRun } from './helpers.js';

beforeAll(startDb);
afterAll(stopDb);

// Signs an existing phone user in again, which starts a second session.
async function signInAgain(phone) {
  const { body } = await api().post('/auth/otp/request').send({ phone }).expect(200);
  const res = await api().post('/auth/otp/verify').send({ phone, code: body.devCode }).expect(200);
  return { ...res.body, http: api(res.body.accessToken) };
}

async function verifyNewPhoneRequest(phone, options = {}) {
  const { body } = await api().post('/auth/otp/request').send({ phone, ...options }).expect(200);
  return { sent: body };
}

async function verifyNewPhone(phone, options = {}) {
  const { sent } = await verifyNewPhoneRequest(phone, options);
  const verified = await api().post('/auth/otp/verify').send({ phone, code: sent.devCode }).expect(200);
  return { sent, verified: verified.body };
}

// A phone account whose email was added and verified through the profile.
async function userWithEmail(email) {
  const user = await signUpByPhone();
  const sent = await user.http.post('/users/me/contact/request').send({ email }).expect(200);
  await user.http.post('/users/me/contact/verify').send({ email, code: sent.body.devCode }).expect(200);
  return user;
}

// Moves rotated tokens past the reuse grace period.
const ageRotations = () => tenantRun(() => RefreshToken.updateMany({ revokeReason: 'rotated' }, { revokedAt: new Date(Date.now() - 3_600_000) }));

describe('OTP', () => {
  it('counts parallel guesses against the attempt limit', async () => {
    const phone = '+919900000101';
    const { sent } = await verifyNewPhoneRequest(phone);
    await Promise.all(Array.from({ length: 10 }, () => api().post('/auth/otp/verify').send({ phone, code: sent.devCode === '000000' ? '111111' : '000000' })));
    await api().post('/auth/otp/verify').send({ phone, code: sent.devCode }).expect(401);
  });

  it('issues only one registration token per code', async () => {
    const phone = '+919900000102';
    const { sent } = await verifyNewPhoneRequest(phone);
    const results = await Promise.all([0, 1].map(() => api().post('/auth/otp/verify').send({ phone, code: sent.devCode })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(results.find((r) => r.status === 200).body.registrationRequired).toBe(true);
  });

  it('caps the codes sent to one number per hour', async () => {
    const phone = '+919900000103';
    for (let i = 0; i < 5; i++) await api().post('/auth/otp/request').send({ phone }).expect(200);
    const res = await api().post('/auth/otp/request').send({ phone }).expect(429);
    expect(res.body.error.code).toBe('TOO_MANY_REQUESTS');
  });

  it('keeps password accounts out of one-time codes', async () => {
    const admin = await createAdmin('staff');
    const email = admin.user.email;
    await api().post('/auth/otp/request').send({ email }).expect(400);
    const { verified } = await verifyNewPhone('+919900000107');
    await api().post('/auth/register').send({ registrationToken: verified.registrationToken, email, name: 'Staff' }).expect(409);
  });
});

describe('register and sign in', () => {
  it('registers a new number once, then signs it in with a code', async () => {
    const phone = '+919900000104';
    const { verified } = await verifyNewPhone(phone);
    expect(verified).toMatchObject({ isNew: true, registrationRequired: true, expiresInSeconds: 600 });
    expect(verified.accessToken).toBeUndefined();
    const created = await api().post('/auth/register').send({ registrationToken: verified.registrationToken, name: 'Kavya', acceptTerms: true }).expect(200);
    expect(created.body).toMatchObject({ isNew: true, user: { phone, name: 'Kavya' }, onboarding: { termsAccepted: true } });

    await api().post('/auth/register').send({ registrationToken: verified.registrationToken, name: 'Kavya' }).expect(401);
    const again = await signInAgain(phone);
    expect(again).toMatchObject({ isNew: false, user: { _id: created.body.user._id } });
  });

  it('never creates an account from a code that was not sent for sign-up', async () => {
    const user = await signUpByPhone();
    const phone = '+919900000105';
    const sent = await user.http.post('/users/me/contact/request').send({ phone }).expect(200);
    await api().post('/auth/otp/verify').send({ phone, code: sent.body.devCode }).expect(401);
  });

  it('requires a verified registration token and name', async () => {
    await api().post('/auth/register').send({ name: 'Nisha' }).expect(400);
    const { verified } = await verifyNewPhone('+919900000106');
    await api().post('/auth/register').send({ registrationToken: verified.registrationToken }).expect(400);
  });

  it('creates the account from the whole profile screen, photo included', async () => {
    const phone = '+919900000108';
    const { verified: phoneVerified } = await verifyNewPhone(phone);
    const { body } = await api()
      .post('/auth/register')
      .field('registrationToken', phoneVerified.registrationToken)
      .field('name', 'Neha Kapoor')
      .field('email', 'Neha@Example.com')
      .field('city', 'Pune')
      .field('locality', 'Baner')
      .field('emergencyContact[name]', 'Rahul')
      .field('emergencyContact[phone]', '9900000109')
      .field('whatsapp', 'true')
      .field('acceptTerms', 'true')
      .attach('photo', pngBuffer, 'me.png')
      .expect(200);
    expect(body.user).toMatchObject({
      name: 'Neha Kapoor',
      phone,
      pendingEmail: 'neha@example.com',
      city: 'Pune',
      locality: 'Baner',
      preferences: { language: 'en', whatsapp: true },
      emergencyContact: { name: 'Rahul', phone: '+919900000109' },
    });
    expect(body.user.email).toBeUndefined();
    expect(body.user.preferences.whatsappConsentAt).toBeTruthy();
    expect(body.user.avatarUrl).toMatch(/\/avatar\//);
    expect(body.onboarding).toMatchObject({ termsAccepted: true, profileComplete: true, emailToVerify: 'neha@example.com', nextStep: 'pet' });

    // The email joins the account once the code sent to it is entered.
    const http = api(body.accessToken);
    const code = await http.post('/users/me/contact/request').send({ email: 'neha@example.com' }).expect(200);
    const verified = await http.post('/users/me/contact/verify').send({ email: 'neha@example.com', code: code.body.devCode }).expect(200);
    expect(verified.body).toMatchObject({ email: 'neha@example.com', onboarding: { emailToVerify: null } });
    expect(verified.body.pendingEmail).toBeUndefined();
  });

  it('checks profile details after phone verification', async () => {
    const phone = '+919900000110';
    const { verified } = await verifyNewPhone(phone);
    await api().post('/auth/register').field('registrationToken', verified.registrationToken).field('name', 'Om').attach('photo', pdfBuffer, 'me.pdf').expect(400);
    await api().post('/auth/register').send({ registrationToken: verified.registrationToken, name: 'Om', emergencyContact: { name: 'Me', phone } }).expect(400);
    await api().post('/auth/register').send({ registrationToken: verified.registrationToken, name: 'Om', emergencyContact: { name: 'Mum' } }).expect(400);
    // The language is chosen in the profile (PATCH /users/me), not at registration.
    await api().post('/auth/register').send({ registrationToken: verified.registrationToken, name: 'Om', language: 'hi' }).expect(400);
    // Blank optional fields from a form are fine.
    await api().post('/auth/register').field('registrationToken', verified.registrationToken).field('name', 'Om').field('email', '').field('emergencyContact[name]', '').field('emergencyContact[phone]', '').expect(200);
  });
});

describe('sessions', () => {
  it('lets a second tab reuse a just-rotated token, and ends only that session on later reuse', async () => {
    const first = await signUpByPhone();
    const second = await signInAgain(first.phone);

    const rotated = await api().post('/auth/refresh').send({ refreshToken: first.refreshToken }).expect(200);
    const otherTab = await api().post('/auth/refresh').send({ refreshToken: first.refreshToken }).expect(200);
    expect(otherTab.body.refreshToken).not.toBe(rotated.body.refreshToken);

    await ageRotations();
    await api().post('/auth/refresh').send({ refreshToken: first.refreshToken }).expect(401);
    await api().post('/auth/refresh').send({ refreshToken: rotated.body.refreshToken }).expect(401);
    await api().post('/auth/refresh').send({ refreshToken: otherTab.body.refreshToken }).expect(401);
    await api().post('/auth/refresh').send({ refreshToken: second.refreshToken }).expect(200);
  });

  it('signs out one session without touching the others', async () => {
    const first = await signUpByPhone();
    const second = await signInAgain(first.phone);
    await api().post('/auth/logout').send({ refreshToken: first.refreshToken }).expect(204);
    await api().post('/auth/refresh').send({ refreshToken: first.refreshToken }).expect(401);
    await api().post('/auth/refresh').send({ refreshToken: second.refreshToken }).expect(200);
  });
});

describe('password', () => {
  it('changes a staff password and signs out other sessions', async () => {
    const admin = await createAdmin('staff');
    const email = admin.user.email;
    const password = 'correct horse battery staple';
    const newPassword = 'a brand new long password';

    await admin.http.post('/auth/password').send({ currentPassword: 'wrong password', newPassword }).expect(401);
    await new Promise((r) => setTimeout(r, 1100));
    const changed = await admin.http.post('/auth/password').send({ currentPassword: password, newPassword }).expect(200);

    await admin.http.get('/admin/session').expect(401);
    await api(changed.body.accessToken).get('/admin/session').expect(200);
    await api().post('/auth/refresh').send({ refreshToken: admin.refreshToken }).expect(401);
    await api().post('/auth/login').send({ email, password }).expect(401);
    await api().post('/auth/login').send({ email, password: newPassword }).expect(200);
  });

  it('is not available to one-time-code accounts', async () => {
    const user = await signUpByPhone();
    await user.http.post('/auth/password').send({ currentPassword: 'x', newPassword: 'a brand new long password' }).expect(400);
  });
});

describe('sign-in screens', () => {
  it('takes the 10-digit number, masks it, and resends over WhatsApp or a call', async () => {
    const sms = await api().post('/auth/otp/request').send({ phone: '96300 12345', appHash: 'FA+9qCX9VSu' }).expect(200);
    expect(sms.body).toMatchObject({ channel: 'sms', sentTo: '+91 96300 •••••', codeLength: 6, resendInSeconds: 0 });
    const whatsapp = await api().post('/auth/otp/request').send({ phone: '+919630012345', channel: 'whatsapp' }).expect(200);
    expect(whatsapp.body.channel).toBe('whatsapp');
    // A new code replaces the old one.
    await api().post('/auth/otp/verify').send({ phone: '9630012345', code: sms.body.devCode === whatsapp.body.devCode ? '000000' : sms.body.devCode }).expect(401);
    const verified = await api().post('/auth/otp/verify').send({ phone: '9630012345', code: whatsapp.body.devCode }).expect(200);
    expect(verified.body.registrationRequired).toBe(true);
    await api().post('/auth/otp/request').send({ email: 'a@b.co', channel: 'voice' }).expect(400);
  });

  it('sends OTP_FIXED_CODE as every development code', async () => {
    const phone = '+919630012348';
    env.otp.fixedCode = '123456';
    try {
      const { body } = await api().post('/auth/otp/request').send({ phone }).expect(200);
      expect(body.devCode).toBe('123456');
      const verified = await api().post('/auth/otp/verify').send({ phone, code: '123456' }).expect(200);
      expect(verified.body.isNew).toBe(true);
    } finally {
      env.otp.fixedCode = undefined;
    }
  });

  it('tells the app how many attempts are left', async () => {
    const phone = '+919630012346';
    const { sent } = await verifyNewPhoneRequest(phone);
    const res = await api().post('/auth/otp/verify').send({ phone, code: sent.devCode === '000000' ? '111111' : '000000' }).expect(401);
    expect(res.body.error.details).toEqual({ attemptsLeft: 4 });
  });

  it('walks a new pet parent through terms, profile and first pet', async () => {
    const phone = '+919630012347';
    const { verified } = await verifyNewPhone(phone);
    const signedIn = await api().post('/auth/register').send({ registrationToken: verified.registrationToken, name: 'Asha', acceptTerms: true }).expect(200);
    expect(signedIn.body.isNew).toBe(true);
    expect(signedIn.body.onboarding).toMatchObject({ termsAccepted: true, profileComplete: false, hasPet: false, nextStep: 'profile' });

    const http = api(signedIn.body.accessToken);
    await http.patch('/users/me').send({ name: 'Asha', city: 'Pune' }).expect(200);
    expect((await http.get('/users/me/onboarding')).body.nextStep).toBe('pet');
    await http.post('/pets').send({ name: 'Bruno', species: 'dog' }).expect(201);
    expect((await http.get('/users/me/onboarding')).body.nextStep).toBe('done');
  });

  it('asks for the terms when they were not accepted at sign-in', async () => {
    const user = await signUpByPhone('Ravi');
    expect(user.onboarding.nextStep).toBe('terms');
    await user.http.post('/users/me/terms').send({ version: 'old' }).expect(400);
    const { body } = await user.http.post('/users/me/terms').send({ version: user.onboarding.termsVersion }).expect(200);
    expect(body).toMatchObject({ termsAccepted: true, nextStep: 'profile', missing: ['city'] });
  });

  it('asks for the sign-in code with the mobile number alone', async () => {
    const user = await userWithEmail('meera@example.com');
    const { body } = await api().post('/auth/otp/request').send({ phone: user.phone.slice(3) }).expect(200);
    expect(body).toMatchObject({ channel: 'sms', codeLength: 6 });
    await api().post('/auth/otp/request').send({ phone: user.phone, channel: 'sms', appHash: 'AIoOh1GKeq9', acceptTerms: true }).expect(400);
    await api().post('/auth/otp/request').send({ email: 'meera@example.com' }).expect(400);
    await api().post('/auth/otp/verify').send({ email: 'meera@example.com', code: body.devCode }).expect(400);
    const signedIn = await api().post('/auth/otp/verify').send({ phone: user.phone, code: body.devCode }).expect(200);
    expect(signedIn.body).toMatchObject({ isNew: false, user: { _id: user.user._id, email: 'meera@example.com' } });
  });
});

describe('Google and Apple', () => {
  const CLIENT_ID = 'test-client.apps.googleusercontent.com';
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' }] };
  const googleToken = (claims, options = {}) =>
    jwt.sign({ email_verified: true, ...claims }, privateKey, { algorithm: 'RS256', keyid: 'test-key', issuer: 'https://accounts.google.com', audience: CLIENT_ID, expiresIn: '5m', ...options });

  beforeAll(() => vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => jwks })));
  afterAll(() => vi.unstubAllGlobals());

  it('creates an account, then finds it again by the Google user id', async () => {
    const idToken = googleToken({ sub: 'g-100', email: 'Priya@Gmail.com', name: 'Priya' });
    const first = await api().post('/auth/google').send({ idToken, acceptTerms: true }).expect(200);
    expect(first.body).toMatchObject({ isNew: true, user: { email: 'priya@gmail.com', name: 'Priya' } });

    const again = await api().post('/auth/google').send({ idToken: googleToken({ sub: 'g-100', email: 'new-address@gmail.com' }) }).expect(200);
    expect(again.body.isNew).toBe(false);
    expect(again.body.user._id).toBe(first.body.user._id);
  });

  it('links Google to an existing account with the same verified email', async () => {
    const email = 'linked@example.com';
    const existing = await userWithEmail(email);
    const res = await api().post('/auth/google').send({ idToken: googleToken({ sub: 'g-200', email }) }).expect(200);
    expect(res.body.user._id).toBe(existing.user._id);
    expect(res.body.isNew).toBe(false);
  });

  it('does not link an email that was typed at sign-up but never verified', async () => {
    const email = 'typed@example.com';
    const { verified } = await verifyNewPhone('+919900000111');
    const existing = await api().post('/auth/register').send({ registrationToken: verified.registrationToken, name: 'Typed', email }).expect(200);
    const res = await api().post('/auth/google').send({ idToken: googleToken({ sub: 'g-250', email }) }).expect(200);
    expect(res.body.user._id).not.toBe(existing.body.user._id);
  });

  it('does not link an unverified email', async () => {
    const email = 'unverified@example.com';
    const existing = await userWithEmail(email);
    const res = await api().post('/auth/google').send({ idToken: googleToken({ sub: 'g-300', email, email_verified: false }) }).expect(200);
    expect(res.body.user._id).not.toBe(existing.user._id);
  });

  it('rejects forged, mis-addressed and replayed tokens', async () => {
    const forged = jwt.sign({ sub: 'g-400' }, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey, {
      algorithm: 'RS256',
      keyid: 'test-key',
      issuer: 'https://accounts.google.com',
      audience: CLIENT_ID,
    });
    await api().post('/auth/google').send({ idToken: forged }).expect(401);
    await api().post('/auth/google').send({ idToken: googleToken({ sub: 'g-400' }, { audience: 'someone-else' }) }).expect(401);
    await api().post('/auth/google').send({ idToken: googleToken({ sub: 'g-400', nonce: 'nonce-from-app-1' }), nonce: 'nonce-from-app-2' }).expect(401);
    await api().post('/auth/google').send({ idToken: googleToken({ sub: 'g-400', nonce: 'nonce-from-app-1' }), nonce: 'nonce-from-app-1' }).expect(200);
  });

  it('answers 503 for a provider that is not configured', async () => {
    await api().post('/auth/apple').send({ idToken: googleToken({ sub: 'a-1' }) }).expect(503);
  });
});

describe('API docs', () => {
  it('documents sign-up with real request and response examples', () => {
    const spec = buildOpenApiSpec(app);
    const register = spec.paths['/api/v1/auth/register'].post;
    expect(Object.keys(register.requestBody.content)).toEqual(['application/json', 'multipart/form-data']);
    expect(register.requestBody.content['multipart/form-data'].schema.properties).toHaveProperty(['emergencyContact[name]']);
    expect(register.requestBody.content['application/json'].example).toHaveProperty('registrationToken');
    expect(Object.keys(register.responses)).toEqual(expect.arrayContaining(['400', '401', '409']));
    expect(spec.paths['/api/v1/auth/otp/request'].post.requestBody.content['application/json'].example).toEqual({ phone: '9876543210' });

    const ids = Object.values(spec.paths).flatMap((path) => Object.values(path).map((op) => op.operationId));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
