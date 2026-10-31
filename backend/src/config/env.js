import dotenv from 'dotenv';

dotenv.config({ quiet: true });

function required(key) {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable ${key}`);
  return value;
}

const list = (value, fallback) => (value ?? fallback).split(',').map((s) => s.trim()).filter(Boolean);

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT ?? 4000),
  mongoUri: required('MONGODB_URI'),
  corsOrigins: list(process.env.CORS_ORIGINS, 'http://localhost:5280,http://localhost:5281'),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:4000',
  // The pet parent website. NFC/QR tag links (/t/<code>) open its recovery page.
  webBaseUrl: (process.env.WEB_BASE_URL ?? 'http://localhost:5282').replace(/\/$/, ''),
  // Swagger UI at /api-docs. On by default outside production.
  apiDocs: process.env.API_DOCS ? process.env.API_DOCS === 'true' : process.env.NODE_ENV !== 'production',

  defaultTenant: process.env.DEFAULT_TENANT ?? 'nurvia',
  // All Phase 1 operations are in India; operating hours are interpreted in IST.
  utcOffsetMinutes: Number(process.env.UTC_OFFSET_MINUTES ?? 330),

  // Encrypts sensitive fields such as seller bank accounts. Falls back to the JWT secret outside production.
  dataEncryptionKey: process.env.DATA_ENCRYPTION_KEY || (process.env.NODE_ENV === 'production' ? required('DATA_ENCRYPTION_KEY') : required('JWT_ACCESS_SECRET')),

  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET'),
    accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    refreshTtlDays: Number(process.env.REFRESH_TTL_DAYS ?? 30),
    // A rotated refresh token still works this long, for a second tab or a retried request.
    refreshReuseGraceSeconds: Number(process.env.REFRESH_REUSE_GRACE_SECONDS ?? 30),
  },

  otp: {
    provider: process.env.OTP_PROVIDER ?? 'console',
    secret: required('OTP_HASH_SECRET'),
    ttlSeconds: Number(process.env.OTP_TTL_SECONDS ?? 300),
    maxAttempts: Number(process.env.OTP_MAX_ATTEMPTS ?? 5),
    resendCooldownSeconds: Number(process.env.OTP_RESEND_COOLDOWN_SECONDS ?? 30),
    maxSendsPerHour: Number(process.env.OTP_MAX_SENDS_PER_HOUR ?? 5),
    // Phone delivery channels the provider supports. The console provider "sends" on all of them.
    phoneChannels: list(process.env.OTP_PHONE_CHANNELS, 'sms,whatsapp,voice'),
    // Domain-bound codes (iOS autofill): the SMS ends with "@<domain> #<code>".
    appDomain: process.env.OTP_APP_DOMAIN ?? new URL(process.env.WEB_BASE_URL ?? 'http://localhost:5282').hostname,
    // Development only: every code is this value (e.g. 123456), so testers need not read devCode.
    // Ignored unless the provider is console and NODE_ENV is not production.
    fixedCode: process.env.OTP_FIXED_CODE || undefined,
  },


  // Sign in with Google / Apple: the OAuth client IDs whose ID tokens are accepted (web, Android, iOS).
  // A provider with no client IDs is switched off.
  oauth: {
    googleClientIds: list(process.env.GOOGLE_CLIENT_IDS, ''),
    appleClientIds: list(process.env.APPLE_CLIENT_IDS, ''),
  },

  legal: {
    // Bump when the Terms or Privacy Policy change; users who accepted an older version are asked again.
    termsVersion: process.env.TERMS_VERSION ?? '2026-01',
    termsUrl: process.env.TERMS_URL ?? `${(process.env.WEB_BASE_URL ?? 'http://localhost:5282').replace(/\/$/, '')}/terms`,
    privacyUrl: process.env.PRIVACY_URL ?? `${(process.env.WEB_BASE_URL ?? 'http://localhost:5282').replace(/\/$/, '')}/privacy`,
    supportUrl: process.env.SUPPORT_URL ?? `${(process.env.WEB_BASE_URL ?? 'http://localhost:5282').replace(/\/$/, '')}/support`,
  },

  uploads: {
    dir: process.env.UPLOAD_DIR ?? 'storage',
    maxBytes: Number(process.env.UPLOAD_MAX_BYTES ?? 10 * 1024 * 1024),
  },

  payments: {
    gateway: process.env.PAYMENT_GATEWAY ?? 'mock',
    razorpayKeyId: process.env.RAZORPAY_KEY_ID,
    razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET,
    razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
  },

  push: {
    provider: process.env.PUSH_PROVIDER ?? 'console',
  },

  // Masked calls between customers and shops (Explore → Call Store). 'direct' hands out the shop's
  // own number until a masking provider (Exotel, Knowlarity…) is contracted.
  callRelay: {
    provider: process.env.CALL_RELAY_PROVIDER ?? 'direct',
  },

  ai: {
    provider: process.env.AI_PROVIDER ?? 'disabled',
  },

  jobs: {
    enabled: process.env.JOBS_ENABLED !== 'false',
  },
};
