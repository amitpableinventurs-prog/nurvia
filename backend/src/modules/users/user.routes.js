import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../common/auth.js';
import { badRequest } from '../../common/errors.js';
import { LANGUAGE_CODES } from '../../common/languages.js';
import { indianMobile, objectId, point, validate } from '../../common/validate.js';
import { otpDelivery, otpLimiter, otpTarget, targetOf } from '../auth/auth.routes.js';
import { acceptTerms, onboardingFor, requestOtp, revokeAllSessions, verifyContact } from '../auth/auth.service.js';
import { attachmentsFor } from '../files/file.routes.js';
import { registerDevice } from '../notifications/notify.js';
import { citySummary, getPlatform, matchCity, resolveCity } from '../platform/platform.service.js';
import { User } from './user.model.js';

const router = Router();
router.use(authenticate);

const address = z.object({
  label: z.string().trim().max(40).optional(),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(80),
  state: z.string().trim().max(80).optional(),
  pincode: z.string().regex(/^\d{6}$/).optional(),
  location: point.optional(),
});

router.get('/me', async (req, res) => {
  res.json(await User.findById(req.user._id));
});

// The steps after sign-in: accept the Terms, complete the profile (PATCH /users/me), register a pet (POST /pets).
router.get('/me/onboarding', async (req, res) => {
  res.json(await onboardingFor(await User.findById(req.user._id)));
});

router.post('/me/terms', validate({ body: { version: z.string().min(1).max(40) } }), async (req, res) => {
  const user = await User.findById(req.user._id);
  acceptTerms(user, req.valid.body.version);
  await user.save();
  res.json(await onboardingFor(user));
});

// The profile screen ("Tell us about yourself"). Every field is optional so the same call edits the
// profile later; null clears a field. The mobile number and email are changed through
// /me/contact/request and /me/contact/verify, because they are sign-in identifiers.
router.patch(
  '/me',
  validate({
    body: {
      name: z.string().trim().min(1).max(120).optional(),
      // A file uploaded with purpose "avatar" (POST /files); null removes the photo.
      avatarFileId: objectId.nullable().optional(),
      // A city's `slug` from GET /config/cities (its name or an alias also works).
      city: z.string().trim().min(2).max(80).optional(),
      locality: z.string().trim().min(1).max(120).nullable().optional(),
      emergencyContact: z.object({ name: z.string().trim().min(1).max(120), phone: indianMobile }).nullable().optional(),
      preferences: z
        .object({
          language: z.enum(LANGUAGE_CODES).optional(),
          notifications: z.boolean().optional(),
          // "Receive vaccination due alerts and care advice on WhatsApp".
          whatsapp: z.boolean().optional(),
        })
        .optional(),
    },
  }),
  async (req, res) => {
    const { preferences = {}, avatarFileId, city, emergencyContact, ...rest } = req.valid.body;
    const user = await User.findById(req.user._id);
    const $set = {};
    const $unset = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value === null) $unset[key] = 1;
      else $set[key] = value;
    }
    if (avatarFileId === null) $unset.avatarUrl = 1;
    else if (avatarFileId) $set.avatarUrl = (await attachmentsFor(req.user._id, [avatarFileId], ['avatar']))[0].url;
    if (city) {
      const resolved = await resolveCity(city);
      Object.assign($set, resolved);
      if (!resolved.citySlug) $unset.citySlug = 1;
    }
    if (emergencyContact === null) $unset.emergencyContact = 1;
    else if (emergencyContact) {
      if (emergencyContact.phone === user.phone) throw badRequest('The emergency contact needs a different number from yours');
      $set.emergencyContact = emergencyContact;
    }
    for (const [key, value] of Object.entries(preferences)) $set[`preferences.${key}`] = value;
    // WhatsApp messages need recorded opt-in consent.
    if (preferences.whatsapp === true && !user.preferences?.whatsapp) $set['preferences.whatsappConsentAt'] = new Date();
    if (preferences.whatsapp === false) $unset['preferences.whatsappConsentAt'] = 1;

    const updated = await User.findByIdAndUpdate(req.user._id, { $set, $unset }, { new: true, runValidators: true });
    res.json({ ...updated.toJSON(), onboarding: await onboardingFor(updated) });
  },
);

// Adding or changing the mobile number or email: a code goes to the new one, and
// /me/contact/verify saves it once the code is entered.
router.post('/me/contact/request', otpLimiter, validate({ body: { ...otpTarget, ...otpDelivery } }), async (req, res) => {
  const { channel, appHash } = req.valid.body;
  const target = targetOf(req.valid.body);
  if (target.kind === 'email' && (channel || appHash)) throw badRequest('channel and appHash apply to phone numbers only');
  const user = await User.findById(req.user._id);
  if (user[target.kind] === target.target) throw badRequest(`This is already your ${target.kind === 'phone' ? 'number' : 'email'}`);
  res.json(await requestOtp({ ...target, channel, appHash, purpose: 'contact' }));
});

router.post('/me/contact/verify', otpLimiter, validate({ body: { ...otpTarget, code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') } }), async (req, res) => {
  const user = await verifyContact(await User.findById(req.user._id), { ...targetOf(req.valid.body), code: req.valid.body.code });
  res.json({ ...user.toJSON(), onboarding: await onboardingFor(user) });
});

// "Allow Location Access" (source gps) or a place picked by hand (source manual), as coordinates.
// With only a city, its centre is used. Answers which city that is and what is live there.
router.put(
  '/me/location',
  validate({
    body: {
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
      source: z.enum(['gps', 'manual']).default('gps'),
      locality: z.string().trim().min(1).max(120).optional(),
      city: z.string().trim().min(2).max(80).optional(),
    },
  }),
  async (req, res) => {
    const { lat, lng, source, locality, city: cityName } = req.valid.body;
    const hasPoint = lat !== undefined && lng !== undefined;
    if (!hasPoint && (lat !== undefined || lng !== undefined)) throw badRequest('Send both lat and lng');
    if (!hasPoint && !cityName) throw badRequest('Send lat and lng, or a city');

    const { features, cities } = await getPlatform();
    const city = (hasPoint && matchCity(cities, { lat, lng })) || (cityName && matchCity(cities, { city: cityName })) || null;
    if (!hasPoint && !city) throw badRequest('Choose a city from the list, or share your location');

    const [lngValue, latValue] = hasPoint ? [lng, lat] : city.center.coordinates;
    const user = await User.findById(req.user._id);
    user.location = { type: 'Point', coordinates: [lngValue, latValue] };
    user.locationSource = hasPoint ? source : 'city';
    user.locationUpdatedAt = new Date();
    if (locality) user.locality = locality;
    // The profile city is filled from the location only when the user has not chosen one.
    if (!user.city && city && city.status !== 'disabled') Object.assign(user, { city: city.name, citySlug: city.slug });
    await user.save();

    const live = city && city.status !== 'disabled';
    res.json({
      location: { lat: latValue, lng: lngValue, source: user.locationSource, locality: user.locality ?? null, approximate: !hasPoint },
      city: live ? citySummary(city, features) : null,
      // false: no configured city covers this place yet, so the app shows "coming soon" instead of an empty list.
      covered: !cities.length || Boolean(live),
    });
  },
);

router.put('/me/addresses', validate({ body: { addresses: z.array(address).max(10) } }), async (req, res) => {
  const user = await User.findByIdAndUpdate(req.user._id, { addresses: req.valid.body.addresses }, { new: true, runValidators: true });
  res.json(user.addresses);
});

router.post('/me/devices', validate({ body: { token: z.string().min(10).max(4096) } }), async (req, res) => {
  await registerDevice(req.user._id, req.valid.body.token);
  res.status(204).end();
});

router.delete('/me/devices', validate({ body: { token: z.string().min(10).max(4096) } }), async (req, res) => {
  await User.updateOne({ _id: req.user._id }, { $pull: { deviceTokens: req.valid.body.token } });
  res.status(204).end();
});

// Account deletion: personal identifiers are cleared immediately and every session is revoked.
// Content the user created stays (attributed to a deleted account) so threads remain coherent.
router.delete('/me', async (req, res) => {
  await User.updateOne(
    { _id: req.user._id },
    {
      status: 'deleted',
      $unset: { phone: 1, email: 1, name: 1, avatarUrl: 1, passwordHash: 1, locality: 1, location: 1, emergencyContact: 1 },
      addresses: [],
      deviceTokens: [],
      identities: [],
    },
  );
  await revokeAllSessions(req.user._id);
  res.status(204).end();
});

export default router;
