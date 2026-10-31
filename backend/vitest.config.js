import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 180_000, // first run downloads a MongoDB binary
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://set-by-tests',
      JWT_ACCESS_SECRET: 'test-access-secret',
      OTP_HASH_SECRET: 'test-otp-secret',
      OTP_RESEND_COOLDOWN_SECONDS: '0',
      OTP_FIXED_CODE: '', // tests need random codes; .env may set one for local testing
      GOOGLE_CLIENT_IDS: 'test-client.apps.googleusercontent.com',
      PAYMENT_GATEWAY: 'mock',
      UPLOAD_DIR: 'storage-test',
      JOBS_ENABLED: 'false',
    },
  },
});
