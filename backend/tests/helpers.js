import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import fs from 'node:fs/promises';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { ROLES } from '../src/common/roles.js';
import { runWithTenant } from '../src/common/tenancy.js';
import { hashPassword } from '../src/modules/auth/auth.service.js';
import { Category } from '../src/modules/categories/category.model.js';
import { Tenant } from '../src/modules/tenants/tenant.model.js';
import { User } from '../src/modules/users/user.model.js';

let mongo;
export const app = createApp();

export async function startDb() {
  // Opening storage alone can take several seconds on a busy Windows machine, so allow more than
  // the default 10 s; with every test file starting its own server in parallel, 10 s fails at random.
  mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
  await connectDb(mongo.getUri());
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  await Tenant.create([{ slug: 'nurvia', name: 'Nurvia' }, { slug: 'store-b', name: 'Store B' }]);
}

export async function stopDb() {
  await disconnectDb();
  await mongo?.stop();
  await fs.rm('storage-test', { recursive: true, force: true });
}

// Queries are lazy, so the callback's result is awaited inside the tenant context.
export const tenantRun = (fn, tenant = 'nurvia') => runWithTenant(tenant, async () => await fn());

export function api(token, tenant) {
  const wrap = (method) => (path) => {
    let req = request(app)[method](`/api/v1${path}`);
    if (token) req = req.set('Authorization', `Bearer ${token}`);
    if (tenant) req = req.set('X-Tenant', tenant);
    return req;
  };
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch'), put: wrap('put'), delete: wrap('delete') };
}

let phoneSeq = 0;
export async function signUpByPhone(name = 'Test User') {
  const phone = `+9198${String(10_000_000 + phoneSeq++).slice(-8)}`;
  const requested = await api().post('/auth/otp/request').send({ phone });
  if (requested.status !== 200) throw new Error(JSON.stringify(requested.body));
  const verified = await api().post('/auth/otp/verify').send({ phone, code: requested.body.devCode });
  if (verified.status !== 200) throw new Error(JSON.stringify(verified.body));
  const registered = await api().post('/auth/register').send({ registrationToken: verified.body.registrationToken, name });
  if (registered.status !== 200) throw new Error(JSON.stringify(registered.body));
  return { ...registered.body, phone, http: api(registered.body.accessToken) };
}

export async function createAdmin(role = ROLES.SUPER_ADMIN) {
  const email = `${role}-${Date.now()}@nurvia.test`;
  const password = 'correct horse battery staple';
  await tenantRun(async () => User.create({ email, name: role, roles: [role], passwordHash: await hashPassword(password) }));
  const res = await api().post('/auth/login').send({ email, password });
  return { ...res.body, http: api(res.body.accessToken) };
}

export async function seedCategories() {
  return tenantRun(async () => ({
    vet: await Category.create({ kind: 'vendor', name: 'Vet clinic', slug: 'vet-clinic' }),
    grooming: await Category.create({ kind: 'service', name: 'Grooming', slug: 'grooming' }),
  }));
}

// Smallest valid PDF header, enough for the upload sniffing.
export const pdfBuffer = Buffer.from('%PDF-1.4\n%test\n');
export const pngBuffer = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

// A YYYY-MM-DD date `days` from now in IST.
export function istDate(days) {
  return new Date(Date.now() + 330 * 60_000 + days * 86_400_000).toISOString().slice(0, 10);
}
