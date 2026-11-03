import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Category } from '../src/modules/categories/category.model.js';
import { Product } from '../src/modules/shop/shop.model.js';
import { User } from '../src/modules/users/user.model.js';
import { Vendor } from '../src/modules/vendors/vendor.model.js';
import { api, createAdmin, signUpByPhone, startDb, stopDb, tenantRun } from './helpers.js';

const ADDRESS = { name: 'Asha Rao', phone: '+919845000000', line1: '12 MG Road', city: 'Bengaluru', pincode: '560001' };
let admin, buyer, product;

const cart = (qty, couponCode) => ({ items: [{ productId: product._id, sku: 'K-1', qty }], ...(couponCode && { couponCode }) });
const quote = (qty, couponCode) => api().post('/shop/quote').send(cart(qty, couponCode)).expect(200);

beforeAll(async () => {
  await startDb();
  admin = await createAdmin();
  buyer = await signUpByPhone('Asha');
  const seller = await signUpByPhone('Rohit');
  await tenantRun(async () => {
    const food = await Category.create({ kind: 'product', name: 'Food', slug: 'food' });
    await User.updateOne({ _id: seller.user._id }, { $addToSet: { roles: 'vendor' } });
    const vendor = await Vendor.create({
      owner: seller.user._id, businessName: 'Rohit Pets', address: { line1: 'x', city: 'Bengaluru' },
      location: { type: 'Point', coordinates: [77.59, 12.97] }, status: 'active', seller: { status: 'approved' },
    });
    product = await Product.create({
      seller: vendor._id, name: 'Kibble', slug: 'kibble', category: food._id, petTypes: ['dog'],
      variants: [{ sku: 'K-1', label: '1 kg', mrpPaise: 50000, pricePaise: 40000, stock: 50 }],
    });
  });
});
afterAll(stopDb);

describe('admin coupons and automatic discounts', () => {
  it('applies the best live automatic discount without a code, and an entered code replaces it', async () => {
    expect((await quote(1)).body.pricing.discountPaise).toBe(0);

    await admin.http.post('/admin/coupons').send({ code: 'AUTO5', description: '5% off every order', type: 'percent', value: 5, autoApply: true }).expect(201);
    await admin.http.post('/admin/coupons').send({ code: 'AUTO200', type: 'flat', value: 20000, minOrderPaise: 100000, autoApply: true }).expect(201);
    await admin.http.post('/admin/coupons').send({ code: 'LATER50', type: 'percent', value: 50, autoApply: true, startsAt: new Date(Date.now() + 86_400_000) }).expect(201);
    await admin.http.post('/admin/coupons').send({ code: 'CODE10', type: 'percent', value: 10 }).expect(201);

    // 5% of ₹400; the ₹200 one needs ₹1,000 and the 50% one has not started.
    const one = await quote(1);
    expect(one.body.pricing).toMatchObject({ discountPaise: 2000, couponCode: 'AUTO5' });
    expect(one.body.coupon).toMatchObject({ code: 'AUTO5', automatic: true });

    // ₹1,200: flat ₹200 beats 5% (₹60).
    expect((await quote(3)).body.pricing).toMatchObject({ discountPaise: 20000, couponCode: 'AUTO200' });

    // A code the customer enters is used instead, even when smaller.
    const coded = await quote(3, 'code10');
    expect(coded.body.pricing).toMatchObject({ discountPaise: 12000, couponCode: 'CODE10' });
    expect(coded.body.coupon.automatic).toBe(false);

    // A bad code says so, and the cart still shows the automatic discount.
    const bad = await quote(1, 'NOPE');
    expect(bad.body.couponError).toBe('This coupon is not valid');
    expect(bad.body.pricing.couponCode).toBe('AUTO5');
  });

  it('edits, clears optional fields, reports usage and only deletes unused codes', async () => {
    const list = await admin.http.get('/admin/coupons').expect(200);
    const auto5 = list.body.find((c) => c.code === 'AUTO5');
    expect(auto5.usage).toEqual({ orders: 0, discountPaise: 0 });

    await buyer.http.post('/shop/orders').send({ ...cart(1), address: ADDRESS, paymentMethod: 'cod' }).expect(201);
    const after = await admin.http.get('/admin/coupons').expect(200);
    expect(after.body.find((c) => c.code === 'AUTO5').usage).toEqual({ orders: 1, discountPaise: 2000 });

    const later = after.body.find((c) => c.code === 'LATER50');
    const edited = await admin.http.patch(`/admin/coupons/${later._id}`).send({ startsAt: null, value: 20, maxDiscountPaise: 5000 }).expect(200);
    expect(edited.body.startsAt).toBeUndefined();
    const cleared = await admin.http.patch(`/admin/coupons/${later._id}`).send({ maxDiscountPaise: null, active: false }).expect(200);
    expect(cleared.body).toMatchObject({ active: false });
    expect(cleared.body.maxDiscountPaise).toBeUndefined();

    const backwards = await admin.http.patch(`/admin/coupons/${later._id}`).send({ startsAt: '2026-12-10', expiresAt: '2026-12-01' }).expect(400);
    expect(backwards.body.error.message).toMatch(/after the start/);

    await admin.http.delete(`/admin/coupons/${auto5._id}`).expect(409);
    await admin.http.delete(`/admin/coupons/${later._id}`).expect(204);
    await admin.http.delete(`/admin/coupons/${later._id}`).expect(404);
    await buyer.http.get('/admin/coupons').expect(403);
  });
});
