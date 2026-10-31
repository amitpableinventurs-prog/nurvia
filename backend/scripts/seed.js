// Creates the default tenant, the first super admin, the starter category taxonomy, the pet breed
// lists and the launch cities.
// Safe to re-run: existing records are left alone.
//   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long password' npm run seed
import '../src/app.js'; // registers every model, so createIndexes() covers them all
import { connectDb, createIndexes, disconnectDb } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { ROLES } from '../src/common/roles.js';
import { runWithTenant } from '../src/common/tenancy.js';
import { hashPassword } from '../src/modules/auth/auth.service.js';
import { Category } from '../src/modules/categories/category.model.js';
import { Tenant } from '../src/modules/tenants/tenant.model.js';
import { User } from '../src/modules/users/user.model.js';
import { City } from '../src/modules/platform/platform.model.js';
import { seedBreeds } from './breeds.js';
import { CITIES, VENDOR_CATEGORIES } from './launch-config.js';

const SERVICE_CATEGORIES = [
  ['Consultation', 'consultation'],
  ['Vaccination', 'vaccination'],
  ['Bath & groom', 'bath-groom'],
  ['Haircut', 'haircut'],
  ['Nail trim', 'nail-trim'],
  ['Overnight boarding', 'overnight-boarding'],
  ['Training session', 'training-session'],
  ['Walk', 'walk'],
];

await connectDb();
await createIndexes();
await Tenant.updateOne(
  { slug: env.defaultTenant },
  { $setOnInsert: { slug: env.defaultTenant, name: 'Nurvia Petcare', plan: 'platform' } },
  { upsert: true },
);

await runWithTenant(env.defaultTenant, async () => {
  for (const [kind, list] of [['vendor', VENDOR_CATEGORIES], ['service', SERVICE_CATEGORIES]]) {
    for (const [i, [name, slug]] of list.entries()) {
      await Category.updateOne({ kind, slug }, { $setOnInsert: { kind, slug, name, sortOrder: i } }, { upsert: true });
    }
  }

  await seedBreeds();

  for (const city of CITIES) {
    await City.updateOne({ slug: city.slug }, { $setOnInsert: city }, { upsert: true });
  }

  const { ADMIN_EMAIL: email, ADMIN_PASSWORD: password } = process.env;
  if (!email || !password) {
    console.warn('ADMIN_EMAIL / ADMIN_PASSWORD not set; skipping super admin creation');
  } else if (password.length < 12) {
    throw new Error('ADMIN_PASSWORD must be at least 12 characters');
  } else if (await User.exists({ email: email.toLowerCase() })) {
    console.info(`User ${email} already exists`);
  } else {
    await User.create({ email, name: 'Super Admin', roles: [ROLES.SUPER_ADMIN], passwordHash: await hashPassword(password) });
    console.info(`Created super admin ${email}`);
  }
});

console.info('Seed complete');
await disconnectDb();
