import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Booking } from '../src/modules/bookings/booking.model.js';
import { Pet } from '../src/modules/pets/pet.model.js';
import { ShopOrder } from '../src/modules/shop/shop.model.js';
import { User } from '../src/modules/users/user.model.js';
import { createAdmin, signUpByPhone, startDb, stopDb, tenantRun } from './helpers.js';

let admin, staff, asha, meera;

beforeAll(async () => {
  await startDb();
  admin = await createAdmin();
  staff = await createAdmin('staff');
  asha = await signUpByPhone('Asha');
  meera = await signUpByPhone('Meera');
  // Raw inserts skip Mongoose casting, and the id from the sign-up response is a string.
  const ashaId = new mongoose.Types.ObjectId(asha.user._id);
  await tenantRun(async () => {
    await User.updateOne({ _id: asha.user._id }, { city: 'Bengaluru', addresses: [{ line1: '12 MG Road', city: 'Bengaluru' }], emergencyContact: { name: 'Ravi', phone: '+919845000001' } });
    await Pet.collection.insertMany([
      { tenant: 'nurvia', owner: ashaId, name: 'Bruno', archivedAt: null },
      { tenant: 'nurvia', owner: ashaId, name: 'Old', archivedAt: new Date() },
    ]);
    await Booking.collection.insertOne({ tenant: 'nurvia', user: ashaId });
    await ShopOrder.collection.insertMany([
      { tenant: 'nurvia', code: 'ODTEST1', user: ashaId, status: 'placed' },
      { tenant: 'nurvia', code: 'ODTEST2', user: ashaId, status: 'pending_payment' },
    ]);
  });
});
afterAll(stopDb);

describe('admin customer list', () => {
  it('lists pet parents only, with their activity and without private details', async () => {
    const list = await admin.http.get('/admin/users?role=pet_parent').expect(200);
    expect(list.body.total).toBe(2);
    const row = list.body.items.find((u) => u.name === 'Asha');
    expect(row).toMatchObject({ city: 'Bengaluru', status: 'active', petCount: 1, bookingCount: 1, orderCount: 1 });
    for (const field of ['addresses', 'emergencyContact', 'location', 'passwordHash', 'deviceTokens']) expect(row).not.toHaveProperty(field);
    expect(list.body.items.find((u) => u.name === 'Meera')).toMatchObject({ petCount: 0, bookingCount: 0, orderCount: 0 });
  });

  it('searches, is open to staff, and is closed to customers', async () => {
    const found = await staff.http.get('/admin/users?role=pet_parent&q=mee').expect(200);
    expect(found.body.items.map((u) => u.name)).toEqual(['Meera']);
    await meera.http.get('/admin/users?role=pet_parent').expect(403);
  });
});
