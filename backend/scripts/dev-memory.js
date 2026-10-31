// Runs the API against a throwaway in-memory MongoDB filled with demo data, so the admin panel
// and apps can be tried without installing MongoDB. Everything is lost when the process stops.
//   npm run dev:memory
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongo = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongo.getUri('nurvia');
process.env.JWT_ACCESS_SECRET ??= 'dev-only-access-secret';
process.env.OTP_HASH_SECRET ??= 'dev-only-otp-secret';
process.env.CORS_ORIGINS ??= 'http://localhost:5280,http://localhost:5281';

const { env } = await import('../src/config/env.js');
const { connectDb } = await import('../src/config/db.js');
const { createApp } = await import('../src/app.js');
const { DEMO_ADMIN, seedDemoData } = await import('./demo-data.js');

await connectDb();
await seedDemoData();

createApp().listen(env.port, () => {
  console.info(`\nNurvia API (in-memory demo data) on http://localhost:${env.port}/api/v1`);
  console.info(`Admin panel login: ${DEMO_ADMIN.email} / ${DEMO_ADMIN.password}`);
  console.info('Pet parent demo user (mobile app / API): phone 9845000000 (Asha); in dev the OTP is returned as devCode\n');
});
