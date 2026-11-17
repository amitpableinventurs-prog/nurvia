import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mockSignature } from '../src/integrations/payments.js';
import { Category } from '../src/modules/categories/category.model.js';
import { CommissionConfig } from '../src/modules/finance/finance.model.js';
import { buildLines } from '../src/modules/finance/finance.service.js';
import { Notification } from '../src/modules/notifications/notification.model.js';
import { Coupon, Product, ShopOrder, StockMovement } from '../src/modules/shop/shop.model.js';
import { remindUnconfirmed } from '../src/modules/shop/shop.service.js';
import { User } from '../src/modules/users/user.model.js';
import { Vendor } from '../src/modules/vendors/vendor.model.js';
import { createAdmin, signUpByPhone, startDb, stopDb, tenantRun } from './helpers.js';

const ADDRESS = { name: 'Asha Rao', phone: '+919845000000', line1: '12 MG Road', city: 'Bengaluru', pincode: '560001' };
let admin, buyer, ownerA, ownerB, vendorA, vendorB, food, meds, kibble, treats, syrup;

const item = (product, sku, qty = 1) => ({ productId: String(product._id), sku, qty });
const stockOf = async (product, sku) => (await tenantRun(() => Product.findById(product._id).lean())).variants.find((v) => v.sku === sku).stock;
const notesFor = (userId, type) => tenantRun(() => Notification.find({ user: userId, type }).lean());

async function seller(name, city, extra = {}) {
  const owner = await signUpByPhone(name);
  const vendor = await tenantRun(async () => {
    await User.updateOne({ _id: owner.user._id }, { $addToSet: { roles: 'vendor' } });
    return Vendor.create({
      owner: owner.user._id, businessName: `${name} Pets`, address: { line1: 'x', city },
      location: { type: 'Point', coordinates: [77.59, 12.97] }, status: 'active', seller: { status: 'approved' }, ...extra,
    });
  });
  return { owner, vendor };
}

async function payOnline(http, orderId, n) {
  const gw = await http.post(`/payments/shop-orders/${orderId}/order`).expect(201);
  const paymentId = `pay_mkt_${n}`;
  return http.post('/payments/verify').send({ orderId: gw.body.orderId, paymentId, signature: mockSignature(`${gw.body.orderId}|${paymentId}`) }).expect(200);
}

beforeAll(async () => {
  await startDb();
  admin = await createAdmin();
  buyer = await signUpByPhone('Asha');
  ({ owner: ownerA, vendor: vendorA } = await seller('Rohit', 'Bengaluru'));
  // Store B only offers pickup, in another city.
  ({ owner: ownerB, vendor: vendorB } = await seller('Meera', 'Mysuru', { store: { type: 'pharmacy', inStorePickup: true }, seller: { status: 'approved', shipping: { delivers: false } } }));
  await tenantRun(async () => {
    food = await Category.create({ kind: 'product', name: 'Food', slug: 'food' });
    meds = await Category.create({ kind: 'product', name: 'Medicines', slug: 'medicines', returnWindowDays: 0 });
    kibble = await Product.create({
      seller: vendorA._id, name: 'Chicken Kibble', slug: 'chicken-kibble', category: food._id, petTypes: ['dog'],
      variants: [{ sku: 'CK-1', label: '1 kg', mrpPaise: 50000, pricePaise: 40000, stock: 20, lowStockAt: 3 }],
    });
    treats = await Product.create({
      seller: vendorA._id, name: 'Liver Treats', slug: 'liver-treats', category: food._id, returnable: false,
      variants: [{ sku: 'LT-1', label: '200 g', mrpPaise: 30000, pricePaise: 30000, stock: 10 }],
    });
    syrup = await Product.create({
      seller: vendorB._id, name: 'Deworm Syrup', slug: 'deworm-syrup', category: meds._id,
      variants: [{ sku: 'DS-1', label: '30 ml', mrpPaise: 25000, pricePaise: 20000, stock: 5 }],
    });
  });
});
afterAll(stopDb);

describe('checkout with several sellers', () => {
  it('prices delivery per seller and says who cannot deliver', async () => {
    const q = await buyer.http.post('/shop/quote').send({ items: [item(kibble, 'CK-1'), item(syrup, 'DS-1')], address: ADDRESS }).expect(200);
    const bySeller = Object.fromEntries(q.body.sellers.map((s) => [String(s.seller), s]));
    expect(bySeller[vendorA._id]).toMatchObject({ method: 'delivery', deliveryPaise: 4900, deliverable: true });
    // B does not deliver, so it defaults to pickup.
    expect(bySeller[vendorB._id]).toMatchObject({ method: 'pickup', deliveryPaise: 0, pickupAvailable: true });
    expect(q.body.pricing).toMatchObject({ subtotalPaise: 60000, deliveryPaise: 4900, totalPaise: 64900 });

    const forced = await buyer.http
      .post('/shop/orders')
      .send({ items: [item(syrup, 'DS-1')], address: ADDRESS, paymentMethod: 'cod', fulfilment: { [vendorB._id]: 'delivery' } })
      .expect(409);
    expect(forced.body.error.message).toMatch(/does not deliver/);
  });

  it('tracks each seller separately, and the order follows the slowest part', async () => {
    const { body: order } = await buyer.http.post('/shop/orders').send({ items: [item(kibble, 'CK-1', 2), item(syrup, 'DS-1')], address: ADDRESS, paymentMethod: 'cod' }).expect(201);
    expect(order.fulfilments).toHaveLength(2);
    expect(order.items.find((i) => i.sku === 'CK-1').commissionPct).toBe(12);

    for (const status of ['confirmed', 'packed', 'shipped', 'delivered']) await ownerA.http.post(`/shop/seller/orders/${order._id}/status`).send({ status }).expect(200);
    let mine = await buyer.http.get(`/shop/orders/${order._id}`).expect(200);
    expect(mine.body.status).toBe('placed'); // B has not confirmed yet
    expect(mine.body.payment.status).toBe('unpaid');

    // Pickup goes ready_for_pickup, never shipped.
    await ownerB.http.post(`/shop/seller/orders/${order._id}/status`).send({ status: 'confirmed' }).expect(200);
    await ownerB.http.post(`/shop/seller/orders/${order._id}/status`).send({ status: 'shipped' }).expect(409);
    const ready = await ownerB.http.post(`/shop/seller/orders/${order._id}/status`).send({ status: 'ready_for_pickup' }).expect(200);
    expect(ready.body).toMatchObject({ sellerStatus: 'ready_for_pickup', next: ['delivered'], items: [{ sku: 'DS-1' }] });

    // A's delivered items can be returned while B's part is still open; medicines never.
    await buyer.http.post(`/shop/orders/${order._id}/returns`).send({ items: [{ sku: 'CK-1', qty: 1 }], reason: 'damaged' }).expect(201);
    await ownerB.http.post(`/shop/seller/orders/${order._id}/status`).send({ status: 'delivered' }).expect(200);
    const noMeds = await buyer.http.post(`/shop/orders/${order._id}/returns`).send({ items: [{ sku: 'DS-1', qty: 1 }], reason: 'other' }).expect(409);
    expect(noMeds.body.error.message).toMatch(/cannot be returned/);

    mine = await buyer.http.get(`/shop/orders/${order._id}`).expect(200);
    expect(mine.body).toMatchObject({ status: 'delivered', payment: { status: 'paid' } });
  });

  it('refuses returns of non-returnable products', async () => {
    const { body: order } = await buyer.http.post('/shop/orders').send({ items: [item(treats, 'LT-1')], address: ADDRESS, paymentMethod: 'cod' }).expect(201);
    for (const status of ['confirmed', 'shipped', 'delivered']) await ownerA.http.post(`/shop/seller/orders/${order._id}/status`).send({ status }).expect(200);
    const res = await buyer.http.post(`/shop/orders/${order._id}/returns`).send({ items: [{ sku: 'LT-1', qty: 1 }], reason: 'other' }).expect(409);
    expect(res.body.error.message).toMatch(/cannot be returned/);
  });
});

describe('cancellation', () => {
  it('cancels one line of a paid order with a partial refund and puts the stock back', async () => {
    const before = await stockOf(kibble, 'CK-1');
    const { body: order } = await buyer.http.post('/shop/orders').send({ items: [item(kibble, 'CK-1', 2), item(treats, 'LT-1')], address: ADDRESS, paymentMethod: 'online' }).expect(201);
    // Pending payment: only the whole order can be cancelled.
    await buyer.http.post(`/shop/orders/${order._id}/cancel`).send({ skus: ['LT-1'] }).expect(409);
    await payOnline(buyer.http, order._id, 1);

    const partial = await buyer.http.post(`/shop/orders/${order._id}/cancel`).send({ skus: ['CK-1'], reason: 'Changed my mind' }).expect(200);
    // 80000 + 30000 = 110000, free delivery; the kibble's share is refunded in full.
    expect(partial.body.payment).toMatchObject({ status: 'paid', refundedPaise: 80000 });
    expect(partial.body.items.find((i) => i.sku === 'CK-1').cancelled).toBe(true);
    expect(partial.body.status).toBe('placed');
    expect(await stockOf(kibble, 'CK-1')).toBe(before);

    // Once packed, the customer can no longer cancel, but the seller still can.
    await ownerA.http.post(`/shop/seller/orders/${order._id}/status`).send({ status: 'confirmed' }).expect(200);
    await ownerA.http.post(`/shop/seller/orders/${order._id}/status`).send({ status: 'packed' }).expect(200);
    await buyer.http.post(`/shop/orders/${order._id}/cancel`).send({}).expect(409);
    const byStore = await ownerA.http.post(`/shop/seller/orders/${order._id}/status`).send({ status: 'cancelled', note: 'Damaged in packing' }).expect(200);
    expect(byStore.body.sellerStatus).toBe('cancelled');
    const final = await buyer.http.get(`/shop/orders/${order._id}`).expect(200);
    expect(final.body).toMatchObject({ status: 'cancelled', payment: { status: 'refunded', refundedPaise: 110000 } });
    expect(final.body.payment.refunds).toHaveLength(2);
  });

  it('lowers what is owed on a cash-on-delivery order', async () => {
    const { body: order } = await buyer.http.post('/shop/orders').send({ items: [item(kibble, 'CK-1'), item(treats, 'LT-1')], address: ADDRESS, paymentMethod: 'cod' }).expect(201);
    expect(order.payment.amountPaise).toBe(70000);
    const res = await buyer.http.post(`/shop/orders/${order._id}/cancel`).send({ skus: ['LT-1'] }).expect(200);
    expect(res.body.payment.amountPaise).toBe(40000);
  });
});

describe('payment rules', () => {
  it('applies the cash-on-delivery switch and limit', async () => {
    await admin.http.patch('/admin/platform/marketplace').send({ codMaxOrderPaise: 50000 }).expect(200);
    const big = await buyer.http.post('/shop/orders').send({ items: [item(kibble, 'CK-1', 2)], address: ADDRESS, paymentMethod: 'cod' }).expect(400);
    expect(big.body.error.message).toMatch(/up to ₹500/);
    await admin.http.patch('/admin/platform/marketplace').send({ codEnabled: false }).expect(200);
    await buyer.http.post('/shop/orders').send({ items: [item(kibble, 'CK-1')], address: ADDRESS, paymentMethod: 'cod' }).expect(400);
    await admin.http.patch('/admin/platform/marketplace').send({ codEnabled: true, codMaxOrderPaise: 500000 }).expect(200);
  });
});

describe('coupons with limits', () => {
  it('limits use per customer, to first orders, and to categories', async () => {
    await tenantRun(() =>
      Coupon.create([
        { code: 'ONCE', type: 'flat', value: 5000, perCustomerLimit: 1 },
        { code: 'WELCOME', type: 'percent', value: 10, firstOrderOnly: true },
        { code: 'MEDS20', type: 'percent', value: 20, categories: [meds._id] },
      ]),
    );
    const first = await buyer.http.post('/shop/orders').send({ items: [item(kibble, 'CK-1')], address: ADDRESS, paymentMethod: 'cod', couponCode: 'ONCE' }).expect(201);
    expect(first.body.pricing.discountPaise).toBe(5000);
    const again = await buyer.http.post('/shop/quote').send({ items: [item(kibble, 'CK-1')], couponCode: 'ONCE' }).expect(200);
    expect(again.body.couponError).toMatch(/already used/);
    const welcome = await buyer.http.post('/shop/quote').send({ items: [item(kibble, 'CK-1')], couponCode: 'WELCOME' }).expect(200);
    expect(welcome.body.couponError).toMatch(/first order/);

    const scoped = await buyer.http.post('/shop/quote').send({ items: [item(kibble, 'CK-1'), item(syrup, 'DS-1')], couponCode: 'MEDS20' }).expect(200);
    expect(scoped.body.pricing.discountPaise).toBe(4000); // 20% of the syrup only
    const none = await buyer.http.post('/shop/quote').send({ items: [item(kibble, 'CK-1')], couponCode: 'MEDS20' }).expect(200);
    expect(none.body.couponError).toMatch(/does not apply/);
  });
});

describe('inventory', () => {
  it('logs adjustments and alerts the seller at low stock', async () => {
    const res = await ownerA.http.post('/shop/seller/inventory/adjust').send({ productId: String(kibble._id), sku: 'CK-1', set: 4, reason: 'correction', note: 'Shelf count' }).expect(200);
    expect(res.body.stock).toBe(4);
    await ownerA.http.post('/shop/seller/inventory/adjust').send({ productId: String(kibble._id), sku: 'CK-1', delta: -5, reason: 'damaged' }).expect(409);
    await ownerA.http.post('/shop/seller/inventory/adjust').send({ productId: String(kibble._id), sku: 'CK-1', delta: -1, reason: 'damaged' }).expect(200);
    expect(await notesFor(ownerA.user._id, 'seller.low_stock')).toHaveLength(1);

    const log = await ownerA.http.get(`/shop/seller/inventory/log?productId=${kibble._id}`).expect(200);
    expect(log.body.items.slice(0, 2).map((m) => [m.reason, m.stockAfter])).toEqual([['damaged', 3], ['correction', 4]]);
    const low = await ownerA.http.get('/shop/seller/inventory?filter=low').expect(200);
    expect(low.body.items.map((r) => r.sku)).toEqual(['CK-1']);
    // Another seller's variant is not theirs to change.
    await ownerB.http.post('/shop/seller/inventory/adjust').send({ productId: String(kibble._id), sku: 'CK-1', delta: 5, reason: 'received' }).expect(404);
  });

  it('tells customers who saved a product when it is back in stock', async () => {
    await buyer.http.put(`/shop/wishlist/items/${syrup._id}`).send({}).expect(200);
    await ownerB.http.post('/shop/seller/inventory/adjust').send({ productId: String(syrup._id), sku: 'DS-1', set: 0, reason: 'correction' }).expect(200);
    await ownerB.http.post('/shop/seller/inventory/adjust').send({ productId: String(syrup._id), sku: 'DS-1', delta: 6, reason: 'received' }).expect(200);
    expect(await notesFor(buyer.user._id, 'shop.back_in_stock')).toHaveLength(1);
  });

  it('updates stock and prices from a CSV and exports it back', async () => {
    const csv = 'sku,stock,mrp,price\nCK-1,15,520,420\nNOPE,1,,\nLT-1,,300,350\n';
    const res = await ownerA.http.post('/shop/seller/inventory/bulk').send({ csv }).expect(200);
    expect(res.body.updated).toBe(1);
    expect(res.body.errors.map((e) => [e.line, e.message])).toEqual([[3, 'No product has this SKU'], [4, 'Selling price cannot exceed MRP']]);
    const variant = (await tenantRun(() => Product.findById(kibble._id).lean())).variants[0];
    expect(variant).toMatchObject({ stock: 15, mrpPaise: 52000, pricePaise: 42000 });
    expect(await tenantRun(() => StockMovement.exists({ product: kibble._id, reason: 'bulk_update' }))).toBeTruthy();

    const exported = await ownerA.http.get('/shop/seller/inventory/export').expect(200);
    expect(exported.headers['content-type']).toMatch(/text\/csv/);
    expect(exported.text).toContain('CK-1,Chicken Kibble,1 kg,15,3,520.00,420.00,active');
  });
});

describe('product import', () => {
  it('creates products with variants from a CSV and reports bad rows', async () => {
    const csv = [
      'slug,name,category,pet_types,option1,option2,sku,option1_value,option2_value,mrp,price,stock,returnable',
      'salmon-bites,Salmon Bites,food,cat,Size,Flavour,SB-S-SAL,Small,Salmon,200,180,10,no',
      'salmon-bites,,,,,,SB-L-SAL,Large,Salmon,350,300,4,',
      'bad-one,Bad,unknown,dog,,,BAD-1,,,100,90,1,',
    ].join('\n');
    const res = await ownerA.http.post('/shop/seller/products/import').send({ csv }).expect(200);
    expect(res.body).toMatchObject({ products: 2, created: 1, updated: 0 });
    expect(res.body.errors).toEqual([{ line: 4, slug: 'bad-one', message: 'Unknown category "unknown"' }]);
    const product = await tenantRun(() => Product.findOne({ slug: 'salmon-bites' }).lean());
    expect(product).toMatchObject({ options: ['Size', 'Flavour'], returnable: false, petTypes: ['cat'] });
    expect(product.variants.map((v) => [v.label, v.attributes])).toEqual([['Small / Salmon', { Size: 'Small', Flavour: 'Salmon' }], ['Large / Salmon', { Size: 'Large', Flavour: 'Salmon' }]]);
  });

  it('refuses variants that repeat an option combination', async () => {
    const body = {
      name: 'Collar', slug: 'collar', categoryId: String(food._id), options: ['Size'],
      variants: [
        { sku: 'C-1', label: 'S', mrpPaise: 100, pricePaise: 100, stock: 1, attributes: { Size: 'S' } },
        { sku: 'C-2', label: 'S again', mrpPaise: 100, pricePaise: 100, stock: 1, attributes: { Size: 's' } },
      ],
    };
    await ownerA.http.post('/shop/seller/products').send(body).expect(400);
  });
});

describe('staff takedown', () => {
  it('blocks a product until staff lift it', async () => {
    await admin.http.post(`/admin/shop/products/${treats._id}/block`).send({ reason: 'Misleading health claim' }).expect(200);
    await buyer.http.get('/shop/products/liver-treats').expect(404);
    const mine = await ownerA.http.patch(`/shop/seller/products/${treats._id}`).send({ status: 'active' }).expect(200);
    expect(mine.body).toMatchObject({ status: 'blocked', blocked: { reason: 'Misleading health claim' } });
    await admin.http.post(`/admin/shop/products/${treats._id}/unblock`).send({ reason: 'Claim removed' }).expect(200);
    await buyer.http.get('/shop/products/liver-treats').expect(200);
  });

  it('keeps product categories at most 3 levels deep', async () => {
    const dogs = await admin.http.post('/admin/categories').send({ kind: 'product', name: 'Dogs', slug: 'dogs' }).expect(201);
    const dogFood = await admin.http.post('/admin/categories').send({ kind: 'product', name: 'Dog food', slug: 'dog-food', parent: dogs.body._id }).expect(201);
    const dry = await admin.http.post('/admin/categories').send({ kind: 'product', name: 'Dry', slug: 'dry', parent: dogFood.body._id }).expect(201);
    await admin.http.post('/admin/categories').send({ kind: 'product', name: 'Too deep', slug: 'too-deep', parent: dry.body._id }).expect(400);
    await admin.http.patch(`/admin/categories/${dogs.body._id}`).send({ parent: dry.body._id }).expect(400);
  });
});

describe('seller follow-up and money', () => {
  it('reminds the seller once about an order left unconfirmed', async () => {
    const { body: order } = await buyer.http.post('/shop/orders').send({ items: [item(kibble, 'CK-1')], address: ADDRESS, paymentMethod: 'cod' }).expect(201);
    await ShopOrder.collection.updateOne({ _id: new ShopOrder.base.Types.ObjectId(order._id) }, { $set: { createdAt: new Date(Date.now() - 3 * 3_600_000), 'fulfilments.0.statusHistory.0.at': new Date(Date.now() - 3 * 3_600_000) } });
    expect(await tenantRun(() => remindUnconfirmed())).toBeGreaterThanOrEqual(1);
    expect(await tenantRun(() => remindUnconfirmed())).toBe(0);
    expect((await notesFor(ownerA.user._id, 'shop.order_reminder')).length).toBeGreaterThanOrEqual(1);
  });

  it('settles at the commission rate fixed when the order was placed, with Nurvia funding coupons', async () => {
    await tenantRun(() => Coupon.create({ code: 'FLAT50', type: 'flat', value: 5000 }));
    const newBuyer = await signUpByPhone('Kiran');
    const { body: order } = await newBuyer.http.post('/shop/orders').send({ items: [item(kibble, 'CK-1')], address: ADDRESS, paymentMethod: 'cod', couponCode: 'FLAT50' }).expect(201);
    await tenantRun(() => CommissionConfig.updateOne({ key: 'default' }, { marketplacePct: 20 }, { upsert: true }));
    for (const status of ['confirmed', 'shipped', 'delivered']) await ownerA.http.post(`/shop/seller/orders/${order._id}/status`).send({ status }).expect(200);

    const { lines } = await tenantRun(() => buildLines(vendorA._id, new Date(Date.now() - 3_600_000), new Date(Date.now() + 60_000)));
    const line = lines.find((l) => String(l.ref) === order._id);
    // 42000 kibble + 4900 delivery; 12% of 42000 = 5040; the seller collected 41900 cash and is owed the 5000 coupon.
    expect(line).toMatchObject({ grossPaise: 46900, commissionPct: 12, commissionPaise: 5040, collectedBy: 'seller', netPaise: 5000 - 5040 });
  });

  it('reports the seller sales by day', async () => {
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    const res = await ownerA.http.get(`/shop/seller/reports/sales?from=${from}&to=${to}`).expect(200);
    expect(res.body.totals.orders).toBeGreaterThan(0);
    expect(res.body.totals.cancelledUnits).toBeGreaterThan(0);
    const csv = await ownerA.http.get(`/shop/seller/reports/sales?from=${from}&to=${to}&format=csv`).expect(200);
    expect(csv.text.split('\r\n')[0]).toBe('﻿date,orders,units,gross_sales,cancelled_units,cancelled_value,returned_units,returned_value');
  });
});
