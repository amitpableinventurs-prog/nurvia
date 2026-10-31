import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { authenticate, requireRoles } from '../../common/auth.js';
import { badRequest, conflict, notFound } from '../../common/errors.js';
import { paginate } from '../../common/paginate.js';
import { ROLES } from '../../common/roles.js';
import { escapeRegex, objectId, pageQuery, partialShape, validate } from '../../common/validate.js';
import { Category } from '../categories/category.model.js';
import { attachmentsFor } from '../files/file.routes.js';
import { notify } from '../notifications/notify.js';
import { assertModuleAt } from '../platform/platform.service.js';
import { Vendor } from '../vendors/vendor.model.js';
import { sellerOnboardingRouter } from '../finance/finance.routes.js';
import { onQualifyingActivity } from '../loyalty/loyalty.service.js';
import { Wishlist } from './aftercare.model.js';
import { aftercareRouter, sellerReturnsRouter } from './aftercare.routes.js';
import { ORDER_STATUSES, PET_TYPES, Product, ShopOrder } from './shop.model.js';
import { cancelOrder, liveSellerIds, placeOrder, quote, shownProducts } from './shop.service.js';

const router = Router();

export const CARD_FIELDS = 'name slug brand images art pricePaise mrpPaise discountPct inStock ratingAvg ratingCount petTypes variants.sku variants.label variants.pricePaise variants.mrpPaise variants.stock category';

export const SORTS = {
  popular: { soldCount: -1, ratingAvg: -1, _id: 1 },
  new: { createdAt: -1, _id: 1 },
  price_asc: { pricePaise: 1, _id: 1 },
  price_desc: { pricePaise: -1, _id: 1 },
  discount: { discountPct: -1, soldCount: -1, _id: 1 },
  rating: { ratingAvg: -1, ratingCount: -1, _id: 1 },
};

// ---- Catalogue (public) ----

// Everything the storefront home page needs in one round trip.
router.get('/home', async (_req, res) => {
  const active = await shownProducts();
  const [categories, featured, deals, bestsellers, newArrivals, brands] = await Promise.all([
    Category.find({ kind: 'product', active: true }).sort({ sortOrder: 1, name: 1 }).lean(),
    Product.find({ ...active, featured: true }).select(CARD_FIELDS).sort(SORTS.popular).limit(8).lean(),
    Product.find({ ...active, inStock: true, discountPct: { $gte: 15 } }).select(CARD_FIELDS).sort(SORTS.discount).limit(8).lean(),
    Product.find({ ...active, inStock: true }).select(CARD_FIELDS).sort(SORTS.popular).limit(8).lean(),
    Product.find(active).select(CARD_FIELDS).sort(SORTS.new).limit(8).lean(),
    Product.distinct('brand', { ...active, brand: { $ne: null } }),
  ]);
  res.json({ categories, featured, deals, bestsellers, newArrivals, brands: brands.filter(Boolean).sort() });
});

router.get('/categories', async (_req, res) => {
  res.json(await Category.find({ kind: 'product', active: true }).sort({ sortOrder: 1, name: 1 }).lean());
});

router.get(
  '/products',
  validate({
    query: {
      ...pageQuery,
      q: z.string().trim().max(80).optional(),
      category: z.string().max(60).optional(), // slug
      pet: z.enum(PET_TYPES).optional(),
      brand: z.string().max(80).optional(),
      minPrice: z.coerce.number().int().min(0).optional(), // rupees
      maxPrice: z.coerce.number().int().min(0).optional(),
      inStock: z.enum(['true']).optional(),
      sort: z.enum(Object.keys(SORTS)).default('popular'),
      // One seller's products, for their store page.
      seller: objectId.optional(),
    },
  }),
  async (req, res) => {
    const { page, limit, q, category, pet, brand, minPrice, maxPrice, inStock, sort, seller } = req.valid.query;
    const filter = await shownProducts();
    if (seller) {
      if (!filter.seller.$in.some((id) => String(id) === seller)) return res.json({ items: [], page, limit, total: 0, pages: 0 });
      filter.seller = seller;
    }
    if (category) {
      const cat = await Category.findOne({ kind: 'product', slug: category }).lean();
      if (!cat) return res.json({ items: [], page, limit, total: 0, pages: 0 });
      filter.category = cat._id;
    }
    if (q) {
      const pattern = { $regex: escapeRegex(q), $options: 'i' };
      filter.$or = [{ name: pattern }, { brand: pattern }, { tags: q.toLowerCase() }];
    }
    if (pet) filter.petTypes = pet;
    if (brand) filter.brand = brand;
    if (inStock) filter.inStock = true;
    if (minPrice != null || maxPrice != null) {
      filter.pricePaise = { ...(minPrice != null && { $gte: minPrice * 100 }), ...(maxPrice != null && { $lte: maxPrice * 100 }) };
    }
    res.json(await paginate(Product, filter, { page, limit, sort: SORTS[sort], select: CARD_FIELDS }));
  },
);

router.get('/products/:slug', validate({ params: { slug: z.string().regex(/^[a-z0-9-]+$/) } }), async (req, res) => {
  const shown = await shownProducts();
  const product = await Product.findOne({ ...shown, slug: req.valid.params.slug }).populate('category', 'name slug').lean();
  if (!product) throw notFound('Product');
  const [seller, related] = await Promise.all([
    Vendor.findById(product.seller).select('businessName address.city ratingAvg ratingCount').lean(),
    Product.find({ ...shown, category: product.category._id, _id: { $ne: product._id } }).select(CARD_FIELDS).sort(SORTS.popular).limit(8).lean(),
  ]);
  res.json({ ...product, seller, related });
});

// A seller's store page header; its products come from GET /products?seller=<id>.
router.get('/sellers/:id', validate(), async (req, res) => {
  const live = await liveSellerIds();
  if (!live.some((id) => String(id) === req.valid.params.id)) throw notFound('Seller');
  const [seller, productCount, brands] = await Promise.all([
    Vendor.findById(req.valid.params.id).select('businessName description address.city ratingAvg ratingCount photos').lean(),
    Product.countDocuments({ seller: req.valid.params.id, status: 'active' }),
    Product.distinct('brand', { seller: req.valid.params.id, status: 'active', brand: { $ne: null } }),
  ]);
  res.json({ ...seller, productCount, brands: brands.filter(Boolean).sort() });
});

// ---- Cart & checkout ----

const cartItems = z
  .array(z.object({ productId: objectId, sku: z.string().min(1).max(60), qty: z.number().int().min(1).max(10) }))
  .max(50);

router.post('/quote', validate({ body: { items: cartItems, couponCode: z.string().trim().max(20).optional() } }), async (req, res) => {
  res.json(await quote(req.valid.body.items, req.valid.body.couponCode));
});

const address = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.string().regex(/^(\+91)?[6-9]\d{9}$/, 'Enter a valid Indian mobile number'),
  line1: z.string().trim().min(3).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().max(80).optional(),
  pincode: z.string().regex(/^\d{6}$/, 'Enter a 6-digit pincode'),
});

router.post(
  '/orders',
  authenticate,
  validate({
    body: { items: cartItems.min(1), couponCode: z.string().trim().max(20).optional(), address, paymentMethod: z.enum(['online', 'cod']), redeemPoints: z.number().int().min(0).max(1_000_000).optional() },
  }),
  async (req, res) => {
    await assertModuleAt('marketplace', { city: req.valid.body.address.city });
    res.status(201).json(await placeOrder(req.user, req.valid.body));
  },
);

router.get('/orders', authenticate, validate({ query: pageQuery }), async (req, res) => {
  const { page, limit } = req.valid.query;
  res.json(await paginate(ShopOrder, { user: req.user._id }, { page, limit }));
});

router.get('/orders/:id', authenticate, validate(), async (req, res) => {
  const order = await ShopOrder.findOne({ _id: req.valid.params.id, user: req.user._id }).lean();
  if (!order) throw notFound('Order');
  res.json(order);
});

router.post('/orders/:id/cancel', authenticate, validate({ body: { reason: z.string().trim().max(300).optional() } }), async (req, res) => {
  const order = await ShopOrder.findOne({ _id: req.valid.params.id, user: req.user._id });
  if (!order) throw notFound('Order');
  res.json(await cancelOrder(order, { by: req.user._id, reason: req.valid.body.reason }));
});

// ---- Seller self-service (Vendor app) ----

const seller = Router();
// A variant at or below this stock shows up under the low-stock filter.
const LOW_STOCK = 5;
seller.use(authenticate, requireRoles(ROLES.VENDOR, ROLES.SELLER));

async function mySellerProfile(req) {
  const vendor = await Vendor.findOne({ owner: req.user._id, status: 'active' }).lean();
  if (!vendor) throw conflict('Your business must be approved before you can sell');
  return vendor;
}

const productBody = {
  name: z.string().trim().min(2).max(160),
  slug: z.string().regex(/^[a-z0-9-]+$/).max(120),
  brand: z.string().trim().max(80).optional(),
  categoryId: objectId,
  petTypes: z.array(z.enum(PET_TYPES)).max(5).optional(),
  description: z.string().max(5000).optional(),
  highlights: z.array(z.string().max(160)).max(8).optional(),
  imageFileIds: z.array(objectId).max(8).optional(),
  variants: z
    .array(
      z
        .object({
          sku: z.string().trim().min(1).max(60),
          label: z.string().trim().min(1).max(60),
          mrpPaise: z.number().int().min(0),
          pricePaise: z.number().int().min(0),
          stock: z.number().int().min(0).max(100_000),
        })
        .refine((v) => v.pricePaise <= v.mrpPaise, 'Selling price cannot exceed MRP'),
    )
    .min(1)
    .max(20),
  hsn: z.string().max(10).optional(),
  gstRate: z.union([z.literal(0), z.literal(5), z.literal(12), z.literal(18), z.literal(28)]).optional(),
  tags: z.array(z.string().max(40)).max(15).optional(),
  status: z.enum(['draft', 'active', 'hidden']).optional(),
};

async function productFields(userId, { categoryId, imageFileIds, variants, ...body }) {
  const fields = { ...body };
  if (categoryId) {
    if (!(await Category.exists({ _id: categoryId, kind: 'product' }))) throw badRequest('Unknown product category');
    fields.category = categoryId;
  }
  if (variants && new Set(variants.map((v) => v.sku)).size !== variants.length) throw badRequest('SKUs must be unique');
  if (variants) fields.variants = variants;
  if (imageFileIds) fields.images = await attachmentsFor(userId, imageFileIds, ['vendor_photo']);
  return fields;
}

// The seller's own products, archived ones excluded. `listing` says whether the shop shows them at
// all (seller approved and business active), and each product's `shown` whether customers see it.
seller.get(
  '/products',
  validate({ query: { ...pageQuery, status: z.enum(['draft', 'active', 'hidden']).optional(), q: z.string().trim().max(80).optional(), lowStock: z.enum(['true']).optional() } }),
  async (req, res) => {
    const vendor = await mySellerProfile(req);
    const { page, limit, status, q, lowStock } = req.valid.query;
    const filter = {
      seller: vendor._id,
      status: status ?? { $ne: 'archived' },
      ...(q && { $or: [{ name: { $regex: escapeRegex(q), $options: 'i' } }, { 'variants.sku': q }] }),
      ...(lowStock && { variants: { $elemMatch: { stock: { $lte: LOW_STOCK } } } }),
    };
    const result = await paginate(Product, filter, { page, limit, sort: { updatedAt: -1 }, populate: { path: 'category', select: 'name slug' } });
    const live = vendor.status === 'active' && vendor.seller?.status === 'approved';
    const counts = await Product.aggregate([{ $match: { seller: vendor._id, status: { $ne: 'archived' } } }, { $group: { _id: '$status', count: { $sum: 1 } } }]);
    res.json({
      ...result,
      items: result.items.map((p) => ({ ...p, shown: live && p.status === 'active' })),
      counts: Object.fromEntries(['draft', 'active', 'hidden'].map((s) => [s, counts.find((c) => c._id === s)?.count ?? 0])),
      listing: { live, sellerStatus: vendor.seller?.status ?? 'none' },
    });
  },
);

seller.get('/products/:id', validate(), async (req, res) => {
  const vendor = await mySellerProfile(req);
  const product = await Product.findOne({ _id: req.valid.params.id, seller: vendor._id, status: { $ne: 'archived' } }).populate('category', 'name slug').lean();
  if (!product) throw notFound('Product');
  res.json(product);
});

// Any approved business can build its catalogue straight away. The shop only shows the products
// once the seller profile (GST, bank and pickup details) is approved: see liveSellerIds().
seller.post('/products', validate({ body: productBody }), async (req, res) => {
  const vendor = await mySellerProfile(req);
  res.status(201).json(await Product.create({ ...(await productFields(req.user._id, req.valid.body)), seller: vendor._id }));
});

seller.patch('/products/:id', validate({ body: partialShape(productBody) }), async (req, res) => {
  const vendor = await mySellerProfile(req);
  const product = await Product.findOne({ _id: req.valid.params.id, seller: vendor._id, status: { $ne: 'archived' } });
  if (!product) throw notFound('Product');
  product.set(await productFields(req.user._id, req.valid.body));
  res.json(await product.save());
});

// A product nobody has ordered is deleted. One that was ordered is archived instead, so past
// orders, returns and reviews still resolve; its slug is freed for a new listing.
seller.delete('/products/:id', validate(), async (req, res) => {
  const vendor = await mySellerProfile(req);
  const product = await Product.findOne({ _id: req.valid.params.id, seller: vendor._id, status: { $ne: 'archived' } });
  if (!product) throw notFound('Product');
  if (await ShopOrder.exists({ 'items.product': product._id })) {
    product.set({ status: 'archived', archivedAt: new Date(), featured: false, slug: `${product.slug.slice(0, 90)}-archived-${product._id}` });
    await product.save();
  } else {
    await product.deleteOne();
  }
  res.status(204).end();
});

// Orders holding the seller's items. Each order lists only this seller's lines and their total
// (`sellerTotalPaise`), so a shared cart never shows another seller's products. Unpaid online orders stay hidden.
seller.get('/orders', validate({ query: { ...pageQuery, status: z.enum(ORDER_STATUSES).optional(), q: z.string().trim().max(20).optional() } }), async (req, res) => {
  const vendor = await mySellerProfile(req);
  const { page, limit, status, q } = req.valid.query;
  const mine = { 'items.seller': vendor._id, status: { $ne: 'pending_payment' } };
  const result = await paginate(ShopOrder, { ...mine, ...(status && { status }), ...(q && { code: q.toUpperCase() }) }, { page, limit });
  const counts = await ShopOrder.aggregate([{ $match: mine }, { $group: { _id: '$status', count: { $sum: 1 } } }]);
  res.json({
    ...result,
    items: result.items.map((o) => {
      const items = o.items.filter((i) => String(i.seller) === String(vendor._id));
      return { ...o, items, sellerTotalPaise: items.reduce((sum, i) => sum + i.pricePaise * i.qty, 0) };
    }),
    counts: Object.fromEntries(ORDER_STATUSES.filter((s) => s !== 'pending_payment').map((s) => [s, counts.find((c) => c._id === s)?.count ?? 0])),
  });
});

// Fulfilment moves forward one step at a time.
const NEXT = { placed: 'confirmed', confirmed: 'shipped', shipped: 'delivered' };

seller.post('/orders/:id/status', validate({ body: { status: z.enum(['confirmed', 'shipped', 'delivered', 'cancelled']), note: z.string().max(300).optional() } }), async (req, res) => {
  const vendor = await mySellerProfile(req);
  const order = await ShopOrder.findOne({ _id: req.valid.params.id, 'items.seller': new mongoose.Types.ObjectId(String(vendor._id)) });
  if (!order) throw notFound('Order');
  const { status, note } = req.valid.body;
  if (status === 'cancelled') {
    await cancelOrder(order, { by: req.user._id, reason: note ?? 'Cancelled by seller' });
  } else {
    if (NEXT[order.status] !== status) throw conflict(`Cannot move an order from ${order.status} to ${status}`);
    order.status = status;
    order.statusHistory.push({ status, by: req.user._id, note });
    if (status === 'delivered') order.deliveredAt = new Date();
    if (status === 'delivered' && order.paymentMethod === 'cod') {
      order.payment.status = 'paid';
      order.payment.paidAt = new Date();
    }
    await order.save();
    if (status === 'delivered') {
      await onQualifyingActivity(order.user, { kind: 'order', ref: order._id, amountPaise: order.pricing.totalPaise }).catch((err) => console.error('[loyalty]', err));
    }
  }
  await notify([order.user], { type: `shop.${status}`, title: `Your order ${order.code} is ${status}`, data: { orderId: String(order._id) } });
  res.json(order);
});

// How many customers saved each of the seller's products, most wanted first. Counts only: the
// seller never sees who saved what.
seller.get('/wishlist', validate({ query: pageQuery }), async (req, res) => {
  const vendor = await mySellerProfile(req);
  const { page, limit } = req.valid.query;
  const ids = (await Product.find({ seller: vendor._id, status: { $ne: 'archived' } }).select('_id').lean()).map((p) => p._id);
  const [{ rows = [], total = [] } = {}] = await Wishlist.aggregate([
    { $match: { 'items.product': { $in: ids } } },
    { $unwind: '$items' },
    { $match: { 'items.product': { $in: ids } } },
    { $group: { _id: '$items.product', savedCount: { $sum: 1 }, lastSavedAt: { $max: '$items.addedAt' } } },
    { $sort: { savedCount: -1, lastSavedAt: -1, _id: 1 } },
    { $facet: { rows: [{ $skip: (page - 1) * limit }, { $limit: limit }], total: [{ $count: 'n' }] } },
  ]);
  const products = await Product.find({ _id: { $in: rows.map((r) => r._id) } }).select('name slug brand images status variants pricePaise inStock').lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const count = total[0]?.n ?? 0;
  res.json({
    items: rows.map((r) => ({ _id: r._id, product: byId.get(String(r._id)), savedCount: r.savedCount, lastSavedAt: r.lastSavedAt })),
    page,
    limit,
    total: count,
    pages: Math.ceil(count / limit),
  });
});

seller.use(sellerReturnsRouter);
seller.use(sellerOnboardingRouter);
router.use('/seller', seller);
router.use(aftercareRouter);

export default router;
