import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mockSignature } from '../src/integrations/payments.js';
import { Category } from '../src/modules/categories/category.model.js';
import { Cart, Product } from '../src/modules/shop/shop.model.js';
import { User } from '../src/modules/users/user.model.js';
import { Vendor } from '../src/modules/vendors/vendor.model.js';
import { api, signUpByPhone, startDb, stopDb, tenantRun } from './helpers.js';

const ADDRESS = { name: 'Asha Rao', phone: '+919845000000', line1: '12 MG Road', city: 'Bengaluru', pincode: '560001' };
let buyer, other, product, soldOut;

const add = (who, body) => who.http.post('/shop/cart/items').send(body);

beforeAll(async () => {
  await startDb();
  buyer = await signUpByPhone('Asha');
  other = await signUpByPhone('Meera');
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
      variants: [
        { sku: 'K-1', label: '1 kg', mrpPaise: 50000, pricePaise: 40000, stock: 30 },
        { sku: 'K-3', label: '3 kg', mrpPaise: 140000, pricePaise: 99900, stock: 30 },
      ],
    });
    soldOut = await Product.create({
      seller: vendor._id, name: 'Rare Treat', slug: 'rare-treat', category: food._id, petTypes: ['dog'],
      variants: [{ sku: 'R-1', label: '100 g', mrpPaise: 10000, pricePaise: 9000, stock: 0 }],
    });
  });
});
afterAll(stopDb);

describe('server-side cart', () => {
  it('needs a signed-in user, and starts empty', async () => {
    await api().get('/shop/cart').expect(401);
    await api().post('/shop/cart/items').send({ productId: product._id, sku: 'K-1' }).expect(401);
    const empty = await buyer.http.get('/shop/cart').expect(200);
    expect(empty.body).toMatchObject({ items: [], lines: [], itemCount: 0, pricing: { totalPaise: 0 } });
  });

  it('adds, merges the same variant, changes quantity and removes', async () => {
    const first = await add(buyer, { productId: product._id, sku: 'K-1' }).expect(200);
    expect(first.body.items).toEqual([{ productId: String(product._id), sku: 'K-1', qty: 1 }]);
    expect(first.body.pricing).toMatchObject({ subtotalPaise: 40000, deliveryPaise: 4900, totalPaise: 44900 });

    const merged = await add(buyer, { productId: product._id, sku: 'K-1', qty: 2 }).expect(200);
    expect(merged.body.items[0].qty).toBe(3);

    const second = await add(buyer, { productId: product._id, sku: 'K-3' }).expect(200);
    expect(second.body).toMatchObject({ itemCount: 4, pricing: { subtotalPaise: 219900 } });

    const set = await buyer.http.patch(`/shop/cart/items/${product._id}`).send({ sku: 'K-1', qty: 1 }).expect(200);
    expect(set.body.itemCount).toBe(2);
    await buyer.http.patch(`/shop/cart/items/${product._id}`).send({ sku: 'NOPE', qty: 1 }).expect(404);
    await buyer.http.patch(`/shop/cart/items/${product._id}`).send({ sku: 'K-1', qty: 0 }).expect(400);

    const one = await buyer.http.delete(`/shop/cart/items/${product._id}?sku=K-3`).expect(200);
    expect(one.body.items.map((i) => i.sku)).toEqual(['K-1']);
    await add(buyer, { productId: product._id, sku: 'K-3' }).expect(200);
    const all = await buyer.http.delete(`/shop/cart/items/${product._id}`).expect(200);
    expect(all.body.items).toEqual([]);
    await buyer.http.delete(`/shop/cart/items/${product._id}`).expect(200);
  });

  it('counts parallel taps, caps a line at 10 and keeps each user\'s cart apart', async () => {
    await Promise.all([1, 2, 3, 4].map(() => add(other, { productId: product._id, sku: 'K-1' }).expect(200)));
    expect((await other.http.get('/shop/cart').expect(200)).body.items).toEqual([{ productId: String(product._id), sku: 'K-1', qty: 4 }]);

    await add(other, { productId: product._id, sku: 'K-1', qty: 10 }).expect(200);
    expect((await other.http.get('/shop/cart').expect(200)).body.items[0].qty).toBe(10);
    expect((await buyer.http.get('/shop/cart').expect(200)).body.items).toEqual([]);
    await other.http.delete(`/shop/cart/items/${product._id}`).expect(200);
  });

  it('refuses what cannot be bought, and reports what changed since it was added', async () => {
    await add(buyer, { productId: product._id, sku: 'NOPE' }).expect(404);
    await add(buyer, { productId: soldOut._id, sku: 'R-1' }).expect(409);

    await add(buyer, { productId: product._id, sku: 'K-1', qty: 5 }).expect(200);
    await tenantRun(() => Product.updateOne({ _id: product._id, 'variants.sku': 'K-1' }, { 'variants.$.stock': 2 }));
    const cart = await buyer.http.get('/shop/cart').expect(200);
    expect(cart.body.issues[0]).toMatchObject({ sku: 'K-1', message: 'Only 2 left', available: 2 });
    expect(cart.body.items[0].qty).toBe(5);

    await tenantRun(() => Product.updateOne({ _id: product._id, 'variants.sku': 'K-1' }, { 'variants.$.stock': 30 }));
    await buyer.http.delete(`/shop/cart/items/${product._id}`).expect(200);
  });

  it('keeps one cart per user, and reports a bad coupon without touching the cart', async () => {
    await add(buyer, { productId: product._id, sku: 'K-1' }).expect(200);
    const bad = await buyer.http.get('/shop/cart?couponCode=NOPE').expect(200);
    expect(bad.body.couponError).toBe('This coupon is not valid');
    expect(await tenantRun(() => Cart.countDocuments({ user: buyer.user._id }))).toBe(1);
  });

  it('empties ordered lines on a cash order, and keeps what was not ordered', async () => {
    await add(buyer, { productId: product._id, sku: 'K-3' }).expect(200);
    const { items } = (await buyer.http.get('/shop/cart').expect(200)).body;
    expect(items).toHaveLength(2);

    await buyer.http.post('/shop/orders').send({ items: [items[0]], address: ADDRESS, paymentMethod: 'cod' }).expect(201);
    const left = await buyer.http.get('/shop/cart').expect(200);
    expect(left.body.items).toEqual([items[1]]);
  });

  it('keeps the cart until an online order is paid', async () => {
    const { items } = (await buyer.http.get('/shop/cart').expect(200)).body;
    const order = await buyer.http.post('/shop/orders').send({ items, address: ADDRESS, paymentMethod: 'online' }).expect(201);
    expect((await buyer.http.get('/shop/cart').expect(200)).body.items).toEqual(items);

    const gw = await buyer.http.post(`/payments/shop-orders/${order.body._id}/order`).expect(201);
    const paymentId = 'pay_cart_test';
    await buyer.http.post('/payments/verify').send({ orderId: gw.body.orderId, paymentId, signature: mockSignature(`${gw.body.orderId}|${paymentId}`) }).expect(200);
    expect((await buyer.http.get('/shop/cart').expect(200)).body.items).toEqual([]);
  });
});
