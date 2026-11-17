// Vendors listing their own products: what the shop (website and app) shows, a seller's store page,
// suspension hiding products, and deleting or archiving products.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Category } from '../src/modules/categories/category.model.js';
import { User } from '../src/modules/users/user.model.js';
import { Vendor } from '../src/modules/vendors/vendor.model.js';
import { api, signUpByPhone, startDb, stopDb, tenantRun } from './helpers.js';

const ADDRESS = { name: 'Asha Rao', phone: '+919845000000', line1: '12 MG Road', city: 'Bengaluru', pincode: '560001' };
let buyer, owner, other, store, food;

const productBody = (overrides = {}) => ({
  name: 'Salmon Kibble',
  slug: 'salmon-kibble',
  brand: 'Wagz',
  categoryId: food._id,
  petTypes: ['dog'],
  variants: [
    { sku: 'SK-1', label: '1 kg', mrpPaise: 60000, pricePaise: 49900, stock: 10 },
    { sku: 'SK-3', label: '3 kg', mrpPaise: 150000, pricePaise: 129900, stock: 3 },
  ],
  ...overrides,
});

const setSeller = (status) => tenantRun(() => Vendor.updateOne({ _id: store._id }, { 'seller.status': status }));

async function makeSeller(name, phone, sellerStatus = 'approved') {
  const user = await signUpByPhone(name);
  const vendor = await tenantRun(async () => {
    await User.updateOne({ _id: user.user._id }, { $addToSet: { roles: 'vendor' } });
    return Vendor.create({
      owner: user.user._id, businessName: `${name} Pets`, phone, address: { line1: 'x', city: 'Bengaluru' },
      location: { type: 'Point', coordinates: [77.59, 12.97] }, status: 'active', seller: { status: sellerStatus },
    });
  });
  return { ...user, vendor };
}

beforeAll(async () => {
  await startDb();
  food = await tenantRun(() => Category.create({ kind: 'product', name: 'Food', slug: 'food' }));
  buyer = await signUpByPhone('Asha');
  owner = await makeSeller('Rohit', '+919845000011');
  other = await makeSeller('Neha', '+919845000012');
  store = owner.vendor;
});
afterAll(stopDb);

describe('listing products', () => {
  let kibble;

  it('lets a business add products before seller approval, but keeps them out of the shop until then', async () => {
    const pending = await makeSeller('Vikram', '+919845000013', 'submitted');
    await pending.http.post('/shop/seller/products').send(productBody({ name: 'Vikram Kibble', slug: 'vikram-kibble' })).expect(201);
    const { body } = await pending.http.get('/shop/seller/products').expect(200);
    expect(body).toMatchObject({ listing: { live: false, sellerStatus: 'submitted' }, items: [{ slug: 'vikram-kibble', shown: false }] });
    expect((await api().get('/shop/products?q=vikram').expect(200)).body.total).toBe(0);
  });

  it('shows an active product on the shop, the store page and the seller filter', async () => {
    kibble = (await owner.http.post('/shop/seller/products').send(productBody()).expect(201)).body;
    await owner.http.post('/shop/seller/products').send(productBody({ name: 'Puppy Treats', slug: 'puppy-treats', status: 'draft' })).expect(201);
    await other.http.post('/shop/seller/products').send(productBody({ name: 'Cat Litter', slug: 'cat-litter', petTypes: ['cat'] })).expect(201);

    const all = await api().get('/shop/products').expect(200);
    expect(all.body.items.map((p) => p.slug).sort()).toEqual(['cat-litter', 'salmon-kibble']);
    const mine = await api().get(`/shop/products?seller=${store._id}`).expect(200);
    expect(mine.body.items.map((p) => p.slug)).toEqual(['salmon-kibble']);
    await api().get('/shop/products/puppy-treats').expect(404);

    const page = await api().get(`/shop/sellers/${store._id}`).expect(200);
    expect(page.body).toMatchObject({ businessName: 'Rohit Pets', productCount: 1, brands: ['Wagz'] });
    expect(page.body.phone).toBeUndefined();
  });

  it("shows the seller their products, counts and what customers see", async () => {
    const { body } = await owner.http.get('/shop/seller/products').expect(200);
    expect(body.listing).toEqual({ live: true, sellerStatus: 'approved' });
    expect(body.counts).toEqual({ draft: 1, active: 1, hidden: 0, blocked: 0 });
    expect(Object.fromEntries(body.items.map((p) => [p.slug, p.shown]))).toEqual({ 'salmon-kibble': true, 'puppy-treats': false });
    expect(body.items[0].category).toMatchObject({ slug: 'food' });

    expect((await owner.http.get('/shop/seller/products?status=draft').expect(200)).body.items.map((p) => p.slug)).toEqual(['puppy-treats']);
    expect((await owner.http.get('/shop/seller/products?q=salmon').expect(200)).body.total).toBe(1);
    await owner.http.patch(`/shop/seller/products/${kibble._id}`).send({ variants: [{ sku: 'SK-1', label: '1 kg', mrpPaise: 60000, pricePaise: 49900, stock: 2 }] }).expect(200);
    expect((await owner.http.get('/shop/seller/products?lowStock=true&status=active').expect(200)).body.items.map((p) => p.slug)).toEqual(['salmon-kibble']);
    await owner.http.get(`/shop/seller/products/${kibble._id}`).expect(200);
    await other.http.get(`/shop/seller/products/${kibble._id}`).expect(404);
  });

  it('hides a suspended seller everywhere, and brings them back on reinstatement', async () => {
    await setSeller('suspended');
    await api().get(`/shop/products/${kibble.slug}`).expect(404);
    expect((await api().get('/shop/products').expect(200)).body.items.map((p) => p.slug)).toEqual(['cat-litter']);
    await api().get(`/shop/sellers/${store._id}`).expect(404);
    expect((await api().get('/shop/home').expect(200)).body.newArrivals.map((p) => p.slug)).toEqual(['cat-litter']);
    const quote = await api().post('/shop/quote').send({ items: [{ productId: kibble._id, sku: 'SK-1', qty: 1 }] }).expect(200);
    expect(quote.body.issues).toHaveLength(1);
    await buyer.http.put(`/shop/wishlist/items/${kibble._id}`).send({}).expect(404);
    expect((await owner.http.get('/shop/seller/products').expect(200)).body).toMatchObject({ listing: { live: false, sellerStatus: 'suspended' }, items: [{ shown: false }, { shown: false }] });

    await setSeller('approved');
    await api().get(`/shop/products/${kibble.slug}`).expect(200);
  });
});

describe('removing products', () => {
  it('deletes a product nobody ordered', async () => {
    const treats = (await owner.http.get('/shop/seller/products?status=draft').expect(200)).body.items[0];
    await other.http.delete(`/shop/seller/products/${treats._id}`).expect(404);
    await owner.http.delete(`/shop/seller/products/${treats._id}`).expect(204);
    await owner.http.get(`/shop/seller/products/${treats._id}`).expect(404);
  });

  it('archives an ordered product, keeping the order and freeing the slug', async () => {
    const kibble = (await api().get('/shop/products/salmon-kibble').expect(200)).body;
    const order = await buyer.http
      .post('/shop/orders')
      .send({ items: [{ productId: kibble._id, sku: 'SK-1', qty: 1 }], address: ADDRESS, paymentMethod: 'cod' })
      .expect(201);

    await owner.http.delete(`/shop/seller/products/${kibble._id}`).expect(204);
    await api().get('/shop/products/salmon-kibble').expect(404);
    await owner.http.patch(`/shop/seller/products/${kibble._id}`).send({ name: 'Back again' }).expect(404);
    const listed = (await owner.http.get('/shop/seller/products').expect(200)).body;
    expect(listed.total).toBe(0);
    expect((await buyer.http.get(`/shop/orders/${order.body._id}`).expect(200)).body.items[0]).toMatchObject({ name: 'Salmon Kibble', slug: 'salmon-kibble' });

    await owner.http.post('/shop/seller/products').send(productBody()).expect(201);
    await api().get('/shop/products/salmon-kibble').expect(200);
  });
});
