import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { authenticate } from '../../common/auth.js';
import { badRequest } from '../../common/errors.js';
import { indianMobile, validate } from '../../common/validate.js';
import { otpRequestDoc, otpVerifyDoc, registerDoc } from './auth.docs.js';
import * as auth from './auth.service.js';

const router = Router();

// Per-IP limits; the per-number resend cooldown in the service is the other half of OTP abuse protection.
// The in-memory store is per process: use a shared store (e.g. Redis) once running several instances.
const limiter = (limit) =>
  rateLimit({ windowMs: 15 * 60 * 1000, limit, standardHeaders: 'draft-7', legacyHeaders: false, skip: () => env.nodeEnv === 'test' });
export const otpLimiter = limiter(10);
const loginLimiter = limiter(20);

// A mobile number or an email to add to a profile (/users/me/contact/request and /verify).
export const otpTarget = {
  phone: indianMobile.optional(),
  email: z.string().trim().email().toLowerCase().optional(),
};

// Delivery options for a code sent to a phone.
export const otpDelivery = {
  channel: z.enum(['sms', 'whatsapp', 'voice']).optional(),
  // Android SMS Retriever: the app's 11-character hash, added to the SMS so the app can read the code.
  appHash: z.string().regex(/^[A-Za-z0-9+/]{11}$/, 'appHash must be the 11-character app signature hash').optional(),
};

export function targetOf({ phone, email }) {
  if (Boolean(phone) === Boolean(email)) throw badRequest('Provide exactly one of phone or email');
  return phone ? { kind: 'phone', target: phone } : { kind: 'email', target: email };
}

const name = z.string().trim().min(1).max(120).optional();
// "I agree to the Terms of Service and Privacy Policy" was ticked. Recorded with the current version.
const acceptTerms = z.boolean().optional();

const meta = (req) => ({ userAgent: req.get('user-agent') });

// multipart/form-data sends every field as text: true/false and blank fields are read from strings.
const formBool = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());
const blankAsMissing = (schema) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.uploads.maxBytes, files: 1 } }).single('photo');

// Registration details are submitted only after OTP verification.
const registerBody = {
  registrationToken: z.string().min(40).max(100),
  name: z.string().trim().min(1).max(120),
  // Kept as `pendingEmail` until the code sent to it is entered (POST /users/me/contact/request).
  email: blankAsMissing(z.string().trim().email().toLowerCase()),
  // A city's `slug` from GET /config/cities?q= (any Indian city; its name or an alias also works).
  city: blankAsMissing(z.string().trim().min(2).max(80)),
  locality: blankAsMissing(z.string().trim().min(1).max(120)),
  // Reached if the user is unreachable during a procedure; both parts, or neither.
  emergencyContact: z.preprocess(
    (v) => (v && typeof v === 'object' && !v.name && !v.phone ? undefined : v),
    z.object({ name: z.string().trim().min(1).max(120), phone: indianMobile }).optional(),
  ),
  // "Receive vaccination due alerts and care advice on WhatsApp".
  whatsapp: formBool.optional(),
  acceptTerms: formBool.optional(),
};

// Register after verifying a phone number. JSON, or multipart/form-data with an optional photo.
router.post('/register', registerDoc, otpLimiter, photoUpload, validate({ body: registerBody }), async (req, res) => {
  res.json(await auth.completeSignup({ ...req.valid.body, photo: req.file }, meta(req)));
});

// Existing numbers get a sign-in code; new numbers get a code to continue to registration.
router.post('/otp/request', otpRequestDoc, otpLimiter, validate({ body: { phone: indianMobile, ...otpDelivery } }), async (req, res) => {
  res.json(await auth.requestPhoneOtp(req.valid.body));
});

// New numbers receive a one-time registration token; existing users are signed in.
router.post('/otp/verify', otpVerifyDoc, otpLimiter, validate({ body: { phone: indianMobile, code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') } }), async (req, res) => {
  res.json(await auth.verifyOtp(req.valid.body, meta(req)));
});

// The app signs in with the Google / Apple SDK and sends the ID token it got back.
// Apple gives the user's name to the app only on the first sign-in, so pass it as `name`.
for (const provider of ['google', 'apple']) {
  router.post(
    `/${provider}`,
    loginLimiter,
    validate({ body: { idToken: z.string().min(20).max(8192), nonce: z.string().min(8).max(200).optional(), name, acceptTerms } }),
    async (req, res) => {
      const { acceptTerms: termsAccepted, ...body } = req.valid.body;
      res.json(await auth.signInWithProvider(provider, { ...body, termsAccepted }, meta(req)));
    },
  );
}

// Email and password: Nurvia staff (admin panel) only. Customers and partners use a code, Google or Apple.
router.post(
  '/login',
  loginLimiter,
  validate({ body: { email: z.string().email().toLowerCase(), password: z.string().min(1).max(200) } }),
  async (req, res) => {
    res.json(await auth.passwordLogin(req.valid.body, meta(req)));
  },
);

router.post('/refresh', validate({ body: { refreshToken: z.string().min(20) } }), async (req, res) => {
  res.json(await auth.rotateRefreshToken(req.valid.body.refreshToken, meta(req)));
});

router.post('/logout', validate({ body: { refreshToken: z.string().min(20) } }), async (req, res) => {
  await auth.revokeRefreshToken(req.valid.body.refreshToken);
  res.status(204).end();
});

// Staff accounts only. Every other session is signed out; the response holds new tokens for this device.
router.post(
  '/password',
  loginLimiter,
  authenticate,
  validate({ body: { currentPassword: z.string().min(1).max(200), newPassword: z.string().min(12, 'Use at least 12 characters').max(200) } }),
  async (req, res) => {
    res.json(await auth.changePassword(req.user._id, req.valid.body, meta(req)));
  },
);

export default router;
