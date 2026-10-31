// Builds the database indexes. The API builds them by itself only outside production (autoIndex is
// off there, so a deploy never starts a long index build unannounced): run this once on a new
// database and after every deploy that adds an index. `npm run seed` runs it too.
//   npm run db:indexes
import '../src/app.js'; // registers every model
import { connectDb, createIndexes, disconnectDb } from '../src/config/db.js';

await connectDb();
await createIndexes();
console.info('Indexes are up to date');
await disconnectDb();
