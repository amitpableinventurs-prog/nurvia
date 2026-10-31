// Loads the demo data (scripts/demo-data.js) into the database in MONGODB_URI, for local development
// against a real MongoDB. Refuses to touch a database that already has data unless --reset is passed,
// which drops the whole database first.
//   npm run seed:demo            (empty database)
//   npm run seed:demo -- --reset (wipe and reload)
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { DEMO_ADMIN, seedDemoData } from './demo-data.js';

if (env.isProd) throw new Error('Refusing to load demo data with NODE_ENV=production');

await connectDb();
const { db } = mongoose.connection;
const existing = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
if (existing.length && !process.argv.includes('--reset')) {
  console.error(`Database "${db.databaseName}" already has ${existing.length} collections. Run with --reset to wipe and reload it.`);
  await disconnectDb();
  process.exit(1);
}
if (existing.length) {
  await db.dropDatabase();
  console.info(`Dropped database "${db.databaseName}"`);
}

// Build indexes first: geo search ($near) needs the 2dsphere indexes to exist.
await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
await seedDemoData();
console.info(`Loaded demo data into "${db.databaseName}". Admin login: ${DEMO_ADMIN.email} / ${DEMO_ADMIN.password}`);
await disconnectDb();
