import mongoose from 'mongoose';
import { env } from './env.js';

mongoose.set('strictQuery', true);

export async function connectDb(uri = env.mongoUri) {
  await mongoose.connect(uri, { autoIndex: !env.isProd });
  return mongoose.connection;
}

// Builds every index the registered models declare (unique and TTL indexes included). Indexes that
// already exist are left as they are, and one removed from a model is not dropped.
export async function createIndexes() {
  for (const model of Object.values(mongoose.models)) await model.createIndexes();
}

export async function disconnectDb() {
  await mongoose.disconnect();
}
