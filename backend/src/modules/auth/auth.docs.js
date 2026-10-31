import { apiDoc } from '../../docs/api-doc.js';

// Swagger examples for the sign-up and sign-in endpoints, taken from real responses.

const error = (code, message, details) => ({ error: { code, message, ...(details !== undefined && { details }) } });

// What /otp/request answers: where the code went. `devCode` is returned in development only.
const CODE_SENT = { channel: 'sms', sentTo: '+91 98765 •••••', codeLength: 6, expiresInSeconds: 300, resendInSeconds: 30, devCode: '061350' };

const TOO_MANY = {
  description: 'Too many codes: wait before resending, or the hourly limit for this number was reached',
  examples: {
    resend: { summary: 'Resent too soon', value: error('TOO_MANY_REQUESTS', 'Please wait 24 seconds before requesting another code', { retryInSeconds: 24 }) },
    hourly: { summary: 'Hourly limit', value: error('TOO_MANY_REQUESTS', 'Too many codes requested. Please try again in an hour') },
  },
};

const INVALID_PHONE = { summary: 'Invalid mobile number', value: error('VALIDATION_FAILED', 'Request validation failed', [{ path: 'phone', message: 'Enter a valid 10-digit Indian mobile number' }]) };

export const registerDoc = apiDoc({
  summary: 'Complete registration after verifying a phone number',
  description: [
    'Call `POST /auth/otp/request` with a phone number, then `POST /auth/otp/verify`. For a new number, verification returns a short-lived, one-time `registrationToken`. Submit that token with this profile form to create the account and sign in.',
    'Only `name` is required; blank optional fields are ignored. The verified phone is bound to the registration token and must not be sent in this request.',
    '`city`: the `slug` of a city from `GET /config/cities`. Call it with `q` as the user types to search every Indian city and town, or with the phone\'s `lat` and `lng` to preselect the detected Nurvia city. A Nurvia city is saved with its `citySlug`; any other Indian city by name only. A city the search does not know answers 400.',
    'Send JSON, or `multipart/form-data` to include the profile photo in `photo` (JPEG, PNG or WebP). In a form, send the emergency contact as `emergencyContact[name]` and `emergencyContact[phone]`.',
    'The email is saved as `pendingEmail` (shown as `onboarding.emailToVerify`) until the code sent to it is entered through `POST /users/me/contact/request` and `/users/me/contact/verify`.',
    'The token expires after 10 minutes and can be used once.',
  ].join('\n\n'),
  requestExample: {
    registrationToken: 'a-one-time-token-returned-after-phone-verification',
    name: 'Neha Kapoor',
    email: 'neha@example.com',
    city: 'bengaluru',
    locality: 'Indiranagar',
    emergencyContact: { name: 'Rahul', phone: '9123456780' },
    whatsapp: true,
    acceptTerms: true,
  },
  upload: { field: 'photo', description: 'Profile photo (optional): JPEG, PNG or WebP' },
  responses: {
    200: { description: 'Account created and signed in', example: { user: { phone: '+919876543210', name: 'Neha Kapoor' }, accessToken: '******', refreshToken: '******', expiresInSeconds: 900, isNew: true } },
    400: {
      description: 'A field is missing or invalid',
      examples: {
        validation: { summary: 'Invalid registration details', value: error('VALIDATION_FAILED', 'Request validation failed') },
        city: { summary: 'City not found by GET /config/cities', value: error('BAD_REQUEST', 'Choose a city from the list') },
        emergency: { summary: 'Emergency contact is the same number', value: error('BAD_REQUEST', 'The emergency contact needs a different number from yours') },
        photo: { summary: 'Photo is not an image', value: error('BAD_REQUEST', 'The photo must be a JPEG, PNG or WebP image') },
        tooLarge: { summary: 'Photo too large', value: error('UPLOAD_REJECTED', 'File too large') },
      },
    },
    409: {
      description: 'The phone number or email already belongs to an account',
      examples: {
        phone: { summary: 'Number registered', value: error('CONFLICT', 'An account already uses this number. Sign in instead') },
        email: { summary: 'Email taken', value: error('CONFLICT', 'This email is linked to another Nurvia account') },
      },
    },
    401: { description: 'Registration token expired or already used', example: error('UNAUTHORIZED', 'Registration verification expired or already used; verify your phone again') },
    429: TOO_MANY,
  },
});

export const otpRequestDoc = apiDoc({
  summary: 'Send a verification or sign-in code to a mobile number',
  description: 'Send the mobile number. New numbers receive a sign-up code; registered numbers receive a sign-in code. Calling again resends the code. `channel` (sms / whatsapp / voice) and `appHash` are optional. `devCode` is returned in development only.',
  requestExample: { phone: '9876543210' },
  responses: {
    200: { description: 'Code sent', example: CODE_SENT },
    400: { description: 'Invalid mobile number, or a field other than `phone` was sent', examples: { validation: INVALID_PHONE } },
    403: { description: 'A staff account (email and password)', example: error('FORBIDDEN', 'This account signs in with email and password') },
    429: TOO_MANY,
  },
});

const USER = {
  _id: '6adef2bdbc721702b359516f',
  name: 'Neha Kapoor',
  phone: '+919876543210',
  pendingEmail: 'neha@example.com',
  roles: ['pet_parent'],
  status: 'active',
  avatarUrl: 'http://localhost:4000/media/nurvia/avatar/71eb7ade-030b-4097-90a6-c20c55405b9a.png',
  city: 'Bengaluru',
  citySlug: 'bengaluru',
  locality: 'Indiranagar',
  emergencyContact: { name: 'Rahul', phone: '+919123456780' },
  preferences: {
    language: 'en',
    notifications: true,
    whatsapp: true,
    whatsappConsentAt: '2026-10-26T06:27:09.610Z',
    topics: { reminders: true, bookings: true, orders: true, safety: true, community: true, rewards: true },
  },
  consents: { termsVersion: '2026-01', termsAcceptedAt: '2026-10-26T06:27:09.633Z' },
  loyaltyPoints: 0,
  addresses: [],
  lastLoginAt: '2026-10-26T06:27:09.910Z',
  createdAt: '2026-10-26T06:27:09.637Z',
  updatedAt: '2026-10-26T06:27:09.911Z',
};

export const otpVerifyDoc = apiDoc({
  summary: 'Verify the code: continue registration or sign in',
  description:
    'Send the mobile number and the 6-digit code. For a new number, verification returns `{ isNew: true, registrationRequired: true, registrationToken, expiresInSeconds: 600 }` and no account is created yet; open the registration form and submit the token with the profile details to `POST /auth/register`, which does not send another code. For an existing account, verification signs the user in with `isNew: false`. Keep `refreshToken` to renew the 15-minute `accessToken` with `POST /auth/refresh`.',
  requestExample: { phone: '9876543210', code: '061350' },
  responses: {
    200: {
      description: 'An existing account is signed in; a new number receives a registration token',
      examples: {
        existing: {
          summary: 'Registered number: signed in',
          value: {
            user: USER,
            accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…',
            refreshToken: 'cRxS5ZKpuiGgSoH2qiWL…',
            expiresInSeconds: 900,
            isNew: false,
            onboarding: {
              termsAccepted: true,
              termsVersion: '2026-01',
              profileComplete: true,
              missing: [],
              hasLocation: false,
              emailToVerify: 'neha@example.com',
              notificationsAnswered: false,
              hasPet: false,
              nextStep: 'pet',
            },
          },
        },
        new: {
          summary: 'New number: continue to POST /auth/register',
          value: { isNew: true, registrationRequired: true, registrationToken: 'q3V0aF9yZWdpc3RyYXRpb25fdG9rZW5fZXhhbXBsZQ', expiresInSeconds: 600 },
        },
      },
    },
    400: { description: 'Invalid mobile number or code format', examples: { validation: INVALID_PHONE } },
    401: {
      description: 'Wrong or expired code',
      examples: {
        wrong: { summary: 'Wrong code', value: error('UNAUTHORIZED', 'Incorrect code', { attemptsLeft: 4 }) },
        expired: { summary: 'Expired or not requested', value: error('UNAUTHORIZED', 'Code expired or not requested') },
      },
    },
    403: { description: 'The account is suspended', example: error('FORBIDDEN', 'This account is suspended') },
    429: { description: 'Too many wrong codes: request a new one', example: error('TOO_MANY_REQUESTS', 'Too many incorrect attempts; request a new code') },
  },
});
