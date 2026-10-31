import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mockSignature } from '../src/integrations/payments.js';
import { Category } from '../src/modules/categories/category.model.js';
import { Coupon, Product, ShopOrder } from '../src/modules/shop/shop.model.js';
import { expireUnpaidOrders } from '../src/modules/shop/shop.service.js';
import { User } from '../src/modules/users/user.model.js';
import { Vendor } from '../src/modules/vendors/vendor.model.js';
import { api, signUpByPhone, startDb, stopDb, tenantRun } from './helpers.js';

const ADDRESS = { name: 'Asha Rao', phone: '+919845000000', line1: '12 MG Road', city: 'Bengaluru', pincode: '560001' };
let buyer, seller, product, food;

const stockOf = async (sku) => (await tenantRun(() => Product.findById(product._id).lean())).variants.find((v) => v.sku === sku).stock;

beforeAll(async () => {
  await startDb();
  buyer = await signUpByPhone('Asha');
  seller = await signUpByPhone('Rohit');
  await tenantRun(async () => {
    food = await Category.create({ kind: 'product', name: 'Food', slug: 'food' });
    await User.updateOne({ _id: seller.user._id }, { $addToSet: { roles: 'vendor' } });
    const vendor = await Vendor.create({
      owner: seller.user._id, businessName: 'Rohit Pets', address: { line1: 'x', city: 'Bengaluru' },
      location: { type: 'Point', coordinates: [77.59, 12.97] }, status: 'active', seller: { status: 'approved' },
    });
    product = await Product.create({
      seller: vendor._id, name: 'Chicken Kibble', slug: 'chicken-kibble', brand: 'Wagz', category: food._id, petTypes: ['dog'],
      variants: [
        { sku: 'CK-1', label: '1 kg', mrpPaise: 50000, pricePaise: 40000, stock: 3 },
        { sku: 'CK-3', label: '3 kg', mrpPaise: 140000, pricePaise: 99900, stock: 1 },
      ],
    });
    await Coupon.create({ code: 'SAVE10', type: 'percent', value: 10, minOrderPaise: 50000, maxDiscountPaise: 20000 });
  });
});
afterAll(stopDb);

describe('catalogue', () => {
  it('lists, filters and sorts products with denormalised prices', async () => {
    const list = await api().get('/shop/products?category=food&pet=dog&sort=price_asc').expect(200);
    expect(list.body.items[0]).toMatchObject({ name: 'Chicken Kibble', pricePaise: 40000, discountPct: 29, inStock: true });
    const none = await api().get('/shop/products?pet=cat').expect(200);
    expect(none.body.total).toBe(0);
    const detail = await api().get('/shop/products/chicken-kibble').expect(200);
    expect(detail.body.seller.businessName).toBe('Rohit Pets');
  });
});

describe('cart pricing', () => {
  it('prices from the database, applies coupons and delivery fees', async () => {
    const small = await api().post('/shop/quote').send({ items: [{ productId: product._id, sku: 'CK-1', qty: 1 }] }).expect(200);
    expect(small.body.pricing).toMatchObject({ subtotalPaise: 40000, deliveryPaise: 4900, totalPaise: 44900 });

    const tooSmall = await api().post('/shop/quote').send({ items: [{ productId: product._id, sku: 'CK-1', qty: 1 }], couponCode: 'save10' }).expect(200);
    expect(tooSmall.body.couponError).toMatch(/more to use SAVE10/);

    const big = await api().post('/shop/quote').send({ items: [{ productId: product._id, sku: 'CK-1', qty: 2 }], couponCode: 'SAVE10' }).expect(200);
    expect(big.body.pricing).toMatchObject({ subtotalPaise: 80000, discountPaise: 8000, deliveryPaise: 0, totalPaise: 72000 });

    const over = await api().post('/shop/quote').send({ items: [{ productId: product._id, sku: 'CK-3', qty: 4 }] }).expect(200);
    expect(over.body.issues[0].message).toBe('Only 1 left');
  });
});

describe('orders', () => {
  it('places a cash-on-delivery order and reserves stock', async () => {
    const order = await buyer.http.post('/shop/orders').send({ items: [{ productId: product._id, sku: 'CK-1', qty: 2 }], address: ADDRESS, paymentMethod: 'cod' }).expect(201);
    expect(order.body).toMatchObject({ status: 'placed', paymentMethod: 'cod' });
    expect(await stockOf('CK-1')).toBe(1);
  });

  it('never sells more than is in stock', async () => {
    const results = await Promise.all(
      [1, 2].map(() => buyer.http.post('/shop/orders').send({ items: [{ productId: product._id, sku: 'CK-3', qty: 1 }], address: ADDRESS, paymentMethod: 'cod' })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await stockOf('CK-3')).toBe(0);
    const p = await api().get('/shop/products/chicken-kibble').expect(200);
    expect(p.body.variants.find((v) => v.sku === 'CK-3').stock).toBe(0);
  });

  it('takes online payment, then refunds and restocks on cancel', async () => {
    const order = await buyer.http.post('/shop/orders').send({ items: [{ productId: product._id, sku: 'CK-1', qty: 1 }], address: ADDRESS, paymentMethod: 'online' }).expect(201);
    expect(order.body.status).toBe('pending_payment');
    expect(await stockOf('CK-1')).toBe(0);

    const gw = await buyer.http.post(`/payments/shop-orders/${order.body._id}/order`).expect(201);
    expect(gw.body.amountPaise).toBe(44900);
    const paymentId = 'pay_shop_1';
    const paid = await buyer.http.post('/payments/verify').send({ orderId: gw.body.orderId, paymentId, signature: mockSignature(`${gw.body.orderId}|${paymentId}`) }).expect(200);
    expect(paid.body).toMatchObject({ status: 'placed', payment: { status: 'paid' } });

    const cancelled = await buyer.http.post(`/shop/orders/${order.body._id}/cancel`).send({ reason: 'Ordered by mistake' }).expect(200);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', payment: { status: 'refunded' } });
    expect(await stockOf('CK-1')).toBe(1);
  });

  it('lets the seller fulfil step by step, and only their own orders', async () => {
    const { body: mine } = await seller.http.get('/shop/seller/orders').expect(200);
    expect(mine.counts.placed).toBe(mine.items.filter((o) => o.status === 'placed').length);
    const open = mine.items.find((o) => o.status === 'placed');
    expect(open.sellerTotalPaise).toBe(open.items.reduce((sum, i) => sum + i.pricePaise * i.qty, 0));
    expect((await seller.http.get(`/shop/seller/orders?q=${open.code.toLowerCase()}`).expect(200)).body.items.map((o) => o._id)).toEqual([open._id]);
    await seller.http.post(`/shop/seller/orders/${open._id}/status`).send({ status: 'shipped' }).expect(409);
    await seller.http.post(`/shop/seller/orders/${open._id}/status`).send({ status: 'confirmed' }).expect(200);
    await seller.http.post(`/shop/seller/orders/${open._id}/status`).send({ status: 'shipped' }).expect(200);
    const delivered = await seller.http.post(`/shop/seller/orders/${open._id}/status`).send({ status: 'delivered' }).expect(200);
    expect(delivered.body.payment.status).toBe('paid'); // cash collected on delivery
    await buyer.http.post(`/shop/orders/${open._id}/cancel`).send({}).expect(409);
    await buyer.http.get('/shop/seller/orders').expect(403);
  });

  it('releases stock for online orders that are never paid', async () => {
    const order = await buyer.http.post('/shop/orders').send({ items: [{ productId: product._id, sku: 'CK-1', qty: 1 }], address: ADDRESS, paymentMethod: 'online' }).expect(201);
    expect(await stockOf('CK-1')).toBe(0);
    // createdAt is immutable in Mongoose, so the order is backdated through the raw collection.
    await ShopOrder.collection.updateOne({ _id: new ShopOrder.base.Types.ObjectId(order.body._id) }, { $set: { createdAt: new Date(Date.now() - 31 * 60_000) } });
    await tenantRun(() => expireUnpaidOrders());
    expect(await stockOf('CK-1')).toBe(1);
    const after = await buyer.http.get(`/shop/orders/${order.body._id}`).expect(200);
    expect(after.body.status).toBe('cancelled');
  });
});
