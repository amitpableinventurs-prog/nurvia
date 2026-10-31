import crypto from 'node:crypto';
import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../common/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../../common/errors.js';
import { paginate } from '../../common/paginate.js';
import { PERMISSIONS } from '../../common/roles.js';
import { objectId, pageQuery, validate } from '../../common/validate.js';
import { paymentGateway } from '../../integrations/payments.js';
import { audit } from '../audit/audit.model.js';
import { attachmentsFor } from '../files/file.routes.js';
import { notify } from '../notifications/notify.js';
import { Vendor } from '../vendors/vendor.model.js';
import { RETURN_REASONS, RETURN_STATUSES, RETURN_WINDOW_DAYS, ProductReview, ReturnRequest, Wishlist } from './aftercare.model.js';
import { Product, ShopOrder } from './shop.model.js';
import { shownProducts } from './shop.service.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => 'RT' + Array.from(crypto.randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
const slug = z.string().regex(/^[a-z0-9-]+$/);
const CARD = 'name slug brand images art pricePaise mrpPaise discountPct inStock ratingAvg ratingCount variants.sku variants.label variants.pricePaise variants.stock status';

// ---- Customer: returns, reviews, wishlist (mounted inside /shop) ----

export const aftercareRouter = Router();

aftercareRouter.post(
  '/orders/:id/returns',
  authenticate,
  validate({
    body: {
      items: z.array(z.object({ sku: z.string().min(1).max(60), qty: z.number().int().min(1).max(10) })).min(1).max(50),
      reason: z.enum(RETURN_REASONS),
      details: z.string().trim().max(1000).optional(),
      photoFileIds: z.array(objectId).max(6).optional(),
    },
  }),
  async (req, res) => {
    const order = await ShopOrder.findOne({ _id: req.valid.params.id, user: req.user._id }).lean();
    if (!order) throw notFound('Order');
    if (order.status !== 'delivered') throw conflict('Only a delivered order can be returned');
    const deliveredAt = order.deliveredAt ?? order.statusHistory.findLast((h) => h.status === 'delivered')?.at ?? order.updatedAt;
    if (Date.now() - deliveredAt > RETURN_WINDOW_DAYS * 86_400_000) throw conflict(`Returns are accepted within ${RETURN_WINDOW_DAYS} days of delivery`);

    // Quantities already in an open or completed return cannot be returned twice.
    const previous = await ReturnRequest.find({ order: order._id, status: { $nin: ['rejected', 'cancelled'] } }).lean();
    const alreadyReturned = (sku) => previous.flatMap((r) => r.items).filter((i) => i.sku === sku).reduce((n, i) => n + i.qty, 0);
    const lines = req.valid.body.items.map(({ sku, qty }) => {
      const line = order.items.find((i) => i.sku === sku);
      if (!line) throw badRequest(`${sku} is not in this order`);
      if (qty + alreadyReturned(sku) > line.qty) throw badRequest(`You can return at most ${line.qty - alreadyReturned(sku)} of ${line.name}`);
      return { product: line.product, sku, name: line.name, variantLabel: line.variantLabel, qty, pricePaise: line.pricePaise, seller: String(line.seller) };
    });
    const photos = await attachmentsFor(req.user._id, req.valid.body.photoFileIds, ['community', 'pet_photo', 'sos']);

    const bySeller = Map.groupBy(lines, (l) => l.seller);
    const created = [];
    for (const [seller, items] of bySeller) {
      created.push(
        await ReturnRequest.create({
          code: newCode(),
          order: order._id,
          orderCode: order.code,
          user: req.user._id,
          seller,
          items: items.map(({ seller: _s, ...i }) => i),
          reason: req.valid.body.reason,
          details: req.valid.body.details,
          photos,
          statusHistory: [{ status: 'requested', by: req.user._id }],
        }),
      );
    }
    const owners = await Vendor.find({ _id: { $in: [...bySeller.keys()] } }).select('owner').lean();
    await notify(owners.map((o) => o.owner), { type: 'shop.return_requested', title: `Return requested for ${order.code}`, body: req.valid.body.reason.replace(/_/g, ' '), data: { orderId: String(order._id) } });
    res.status(201).json(created);
  },
);

aftercareRouter.get('/returns', authenticate, validate({ query: pageQuery }), async (req, res) => {
  const { page, limit } = req.valid.query;
  res.json(await paginate(ReturnRequest, { user: req.user._id }, { page, limit, populate: { path: 'seller', select: 'businessName' } }));
});

aftercareRouter.get('/returns/:id', authenticate, validate(), async (req, res) => {
  const ret = await ReturnRequest.findOne({ _id: req.valid.params.id, user: req.user._id }).populate('seller', 'businessName phone').lean();
  if (!ret) throw notFound('Return');
  res.json(ret);
});

aftercareRouter.post('/returns/:id/cancel', authenticate, validate(), async (req, res) => {
  const ret = await ReturnRequest.findOne({ _id: req.valid.params.id, user: req.user._id });
  if (!ret) throw notFound('Return');
  if (!['requested', 'approved'].includes(ret.status)) throw conflict(`A return that is ${ret.status} cannot be cancelled`);
  ret.status = 'cancelled';
  ret.statusHistory.push({ status: 'cancelled', by: req.user._id });
  res.json(await ret.save());
});

// Reviews are for products the reviewer actually received.
aftercareRouter.get('/products/:slug/reviews', validate({ params: { slug }, query: pageQuery }), async (req, res) => {
  const product = await Product.findOne(await shownProducts({ slug: req.valid.params.slug })).select('_id ratingAvg ratingCount').lean();
  if (!product) throw notFound('Product');
  const { page, limit } = req.valid.query;
  const result = await paginate(ProductReview, { product: product._id, status: 'visible' }, { page, limit, select: '-moderation', populate: { path: 'author', select: 'name avatarUrl' } });
  res.json({ ...result, ratingAvg: product.ratingAvg, ratingCount: product.ratingCount });
});

aftercareRouter.post(
  '/products/:slug/reviews',
  authenticate,
  validate({ params: { slug }, body: { rating: z.number().int().min(1).max(5), title: z.string().trim().max(120).optional(), text: z.string().trim().max(2000).optional() } }),
  async (req, res) => {
    const product = await Product.findOne({ slug: req.valid.params.slug }).select('_id');
    if (!product) throw notFound('Product');
    const order = await ShopOrder.findOne({ user: req.user._id, status: 'delivered', 'items.product': product._id }).select('_id').lean();
    if (!order) throw forbidden('You can review products you have received');
    if (await ProductReview.exists({ product: product._id, author: req.user._id })) throw conflict('You have already reviewed this product');
    const review = await ProductReview.create({ ...req.valid.body, product: product._id, order: order._id, author: req.user._id });
    await refreshProductRating(product._id);
    res.status(201).json(review);
  },
);

export async function refreshProductRating(productId) {
  const [stats] = await ProductReview.aggregate([
    { $match: { product: new mongoose.Types.ObjectId(String(productId)), status: 'visible' } },
    { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  await Product.updateOne({ _id: productId }, { ratingAvg: stats ? Math.round(stats.avg * 10) / 10 : 0, ratingCount: stats?.count ?? 0 });
}

aftercareRouter.get('/wishlist', authenticate, async (req, res) => {
  const list = await Wishlist.findOne({ user: req.user._id }).lean();
  if (!list?.items.length) return res.json({ items: [] });
  // Products a seller removed, hid or can no longer sell drop out of the list until they are back.
  const products = await Product.find(await shownProducts({ _id: { $in: list.items.map((i) => i.product) } })).select(CARD).lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  res.json({ items: list.items.map((i) => ({ ...i, product: byId.get(String(i.product)) ?? null })).filter((i) => i.product) });
});

aftercareRouter.put('/wishlist/items/:productId', authenticate, validate({ params: { productId: objectId }, body: { sku: z.string().max(60).optional() } }), async (req, res) => {
  const { productId } = req.valid.params;
  if (!(await Product.exists(await shownProducts({ _id: productId })))) throw notFound('Product');
  const list = (await Wishlist.findOne({ user: req.user._id })) ?? new Wishlist({ user: req.user._id, items: [] });
  if (!list.items.some((i) => String(i.product) === productId)) {
    if (list.items.length >= 200) throw conflict('Your wishlist is full');
    list.items.push({ product: productId, sku: req.valid.body.sku });
  }
  await list.save();
  res.json({ count: list.items.length });
});

aftercareRouter.delete('/wishlist/items/:productId', authenticate, validate({ params: { productId: objectId } }), async (req, res) => {
  await Wishlist.updateOne({ user: req.user._id }, { $pull: { items: { product: req.valid.params.productId } } });
  res.status(204).end();
});

// ---- Return decisions: shared by the seller and Nurvia staff ----

const DECISIONS = {
  approve: { from: ['requested'], to: 'approved' },
  reject: { from: ['requested'], to: 'rejected' },
  mark_picked_up: { from: ['approved'], to: 'picked_up' },
  mark_received: { from: ['approved', 'picked_up'], to: 'received' },
  refund: { from: ['received'], to: 'refunded' },
};

// The refund covers the returned items' share of what was actually paid (coupon discount applied,
// delivery fee kept), and never more than is left unrefunded on the order.
function refundableAmount(order, ret) {
  const itemsPaise = ret.items.reduce((sum, i) => sum + i.pricePaise * i.qty, 0);
  const { subtotalPaise, discountPaise = 0 } = order.pricing;
  const share = subtotalPaise ? Math.round((itemsPaise * (subtotalPaise - discountPaise)) / subtotalPaise) : itemsPaise;
  const paid = order.payment.amountPaise ?? order.pricing.totalPaise;
  return Math.max(0, Math.min(share, paid - (order.payment.refundedPaise ?? 0)));
}

async function restock(items) {
  for (const { product, sku, qty } of items) {
    await Product.updateOne({ _id: product, 'variants.sku': sku }, { $inc: { 'variants.$.stock': qty }, inStock: true });
  }
}

async function decide(req, ret, { action, note, restock: putBack }) {
  const rule = DECISIONS[action];
  if (!rule.from.includes(ret.status)) throw conflict(`Cannot ${action.replace(/_/g, ' ')} a return that is ${ret.status}`);
  if (action === 'reject' && !note) throw badRequest('Give a reason for rejecting the return');
  if (action === 'refund') {
    const order = await ShopOrder.findById(ret.order);
    if (order.payment.status !== 'paid' && order.payment.status !== 'refunded' && order.payment.status !== 'refund_pending') throw conflict('This order was never paid');
    const amount = refundableAmount(order, ret);
    if (order.paymentMethod === 'online' && amount > 0) {
      const refund = await paymentGateway().refund({ paymentId: order.payment.paymentId, amountPaise: amount, notes: { shopOrderId: String(order._id), returnId: String(ret._id), tenant: order.tenant } });
      ret.refund = { amountPaise: amount, method: 'gateway', status: refund.status === 'processed' ? 'processed' : 'pending', refundId: refund.refundId, at: new Date() };
    } else {
      // Cash-on-delivery money goes back by UPI or bank transfer, outside the gateway.
      ret.refund = { amountPaise: amount, method: 'manual', status: 'pending', at: new Date() };
    }
    order.payment.refundedPaise = (order.payment.refundedPaise ?? 0) + amount;
    if (order.payment.refundedPaise >= (order.payment.amountPaise ?? order.pricing.totalPaise)) {
      order.payment.status = ret.refund.status === 'processed' ? 'refunded' : 'refund_pending';
      order.payment.refundedAt = new Date();
    }
    await order.save();
  }
  if (action === 'mark_received' && putBack && !ret.restocked) {
    await restock(ret.items);
    ret.restocked = true;
  }
  ret.status = rule.to;
  ret.statusHistory.push({ status: rule.to, by: req.user._id, note });
  await ret.save();
  await notify([ret.user], {
    type: `shop.return_${rule.to}`,
    title: { approved: 'Return approved', rejected: 'Return not accepted', picked_up: 'Return picked up', received: 'Return received', refunded: 'Refund issued' }[rule.to],
    body: [ret.code, note, ret.refund?.amountPaise && action === 'refund' && `₹${(ret.refund.amountPaise / 100).toFixed(2)}`].filter(Boolean).join(' · '),
    data: { returnId: String(ret._id), orderId: String(ret.order) },
  });
  return ret;
}

const decisionBody = { action: z.enum(Object.keys(DECISIONS)), note: z.string().trim().max(500).optional(), restock: z.boolean().optional() };

// Mounted inside the seller router (/shop/seller), which has already checked the seller.
export const sellerReturnsRouter = Router();

async function sellerVendor(req) {
  const vendor = await Vendor.findOne({ owner: req.user._id, status: 'active' }).select('_id').lean();
  if (!vendor) throw conflict('Your business must be approved before you can sell');
  return vendor;
}

sellerReturnsRouter.get('/returns', validate({ query: { ...pageQuery, status: z.enum(RETURN_STATUSES).optional() } }), async (req, res) => {
  const vendor = await sellerVendor(req);
  const { page, limit, status } = req.valid.query;
  res.json(await paginate(ReturnRequest, { seller: vendor._id, ...(status && { status }) }, { page, limit, populate: { path: 'user', select: 'name phone' } }));
});

sellerReturnsRouter.post('/returns/:id/decision', validate({ body: decisionBody }), async (req, res) => {
  const vendor = await sellerVendor(req);
  const ret = await ReturnRequest.findOne({ _id: req.valid.params.id, seller: vendor._id });
  if (!ret) throw notFound('Return');
  res.json(await decide(req, ret, req.valid.body));
});

// Mounted at /admin/shop.
export const adminReturnsRouter = Router();

adminReturnsRouter.get('/returns', validate({ query: { ...pageQuery, status: z.enum(RETURN_STATUSES).optional(), seller: objectId.optional() } }), async (req, res) => {
  const { page, limit, status, seller } = req.valid.query;
  res.json(
    await paginate(ReturnRequest, { ...(status && { status }), ...(seller && { seller }) }, { page, limit, populate: [{ path: 'user', select: 'name phone' }, { path: 'seller', select: 'businessName' }] }),
  );
});

adminReturnsRouter.post('/returns/:id/decision', requirePermission(PERMISSIONS.ORDERS_MANAGE), validate({ body: { ...decisionBody, note: z.string().trim().min(3).max(500) } }), async (req, res) => {
  const ret = await ReturnRequest.findById(req.valid.params.id);
  if (!ret) throw notFound('Return');
  await decide(req, ret, req.valid.body);
  await audit(req, `shop_return.${req.valid.body.action}`, { type: 'shop_return', id: ret._id }, { reason: req.valid.body.note });
  res.json(ret);
});
