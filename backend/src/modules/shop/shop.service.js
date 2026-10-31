import crypto from 'node:crypto';
import { badRequest, conflict } from '../../common/errors.js';
import { paymentGateway } from '../../integrations/payments.js';
import { LoyaltyEntry } from '../loyalty/loyalty.model.js';
import { movePoints, pointsDiscount } from '../loyalty/loyalty.service.js';
import { notify } from '../notifications/notify.js';
import { Vendor } from '../vendors/vendor.model.js';
import { Coupon, Product, ShopOrder } from './shop.model.js';

export const FREE_DELIVERY_FROM_PAISE = 49_900;
export const DELIVERY_FEE_PAISE = 4_900;
export const MAX_QTY_PER_LINE = 10;
const PAYMENT_WINDOW_MINUTES = 30;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => 'OD' + Array.from(crypto.randomBytes(7), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');

async function couponDiscount(code, subtotalPaise) {
  if (!code) return { discountPaise: 0 };
  const coupon = await Coupon.findOne({ code: code.toUpperCase(), active: true }).lean();
  if (!coupon || (coupon.expiresAt && coupon.expiresAt < new Date())) return { discountPaise: 0, couponError: 'This coupon is not valid' };
  if (subtotalPaise < coupon.minOrderPaise) {
    return { discountPaise: 0, couponError: `Add items worth ₹${Math.ceil((coupon.minOrderPaise - subtotalPaise) / 100)} more to use ${coupon.code}` };
  }
  let discountPaise = coupon.type === 'percent' ? Math.floor((subtotalPaise * coupon.value) / 100) : coupon.value;
  if (coupon.maxDiscountPaise) discountPaise = Math.min(discountPaise, coupon.maxDiscountPaise);
  return { discountPaise: Math.min(discountPaise, subtotalPaise), coupon };
}

// Sellers whose products the shop shows and sells: an active business with an approved seller
// profile. Suspending either hides the products at once, without changing them, and reinstating
// brings them back.
export const liveSellerIds = () => Vendor.distinct('_id', { status: 'active', 'seller.status': 'approved' });

// The filter for products customers can see: active, from a live seller.
export async function shownProducts(filter = {}) {
  return { ...filter, status: 'active', seller: { $in: await liveSellerIds() } };
}

// Prices a cart from the database: the client only says what and how many, never how much.
// Lines that are unavailable are returned in `issues` rather than failing the whole quote.
export async function quote(items, couponCode) {
  const ids = [...new Set(items.map((i) => String(i.productId)))];
  const products = await Product.find(await shownProducts({ _id: { $in: ids } })).lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const activeSellers = new Set(products.map((p) => String(p.seller)));

  const lines = [];
  const issues = [];
  for (const item of items) {
    const product = byId.get(String(item.productId));
    const variant = product?.variants.find((v) => v.sku === item.sku);
    if (!product || !variant || !activeSellers.has(String(product.seller))) {
      issues.push({ productId: item.productId, sku: item.sku, message: 'No longer available' });
      continue;
    }
    if (variant.stock < item.qty) {
      issues.push({ productId: item.productId, sku: item.sku, message: variant.stock ? `Only ${variant.stock} left` : 'Out of stock', available: variant.stock });
      if (!variant.stock) continue;
    }
    const qty = Math.min(item.qty, variant.stock, MAX_QTY_PER_LINE);
    lines.push({
      product: product._id,
      seller: product.seller,
      sku: variant.sku,
      name: product.name,
      slug: product.slug,
      variantLabel: variant.label,
      image: product.images?.[0]?.url,
      art: product.art,
      brand: product.brand,
      mrpPaise: variant.mrpPaise,
      pricePaise: variant.pricePaise,
      qty,
    });
  }

  const subtotalPaise = lines.reduce((n, l) => n + l.pricePaise * l.qty, 0);
  const mrpTotalPaise = lines.reduce((n, l) => n + l.mrpPaise * l.qty, 0);
  const { discountPaise, coupon, couponError } = await couponDiscount(couponCode, subtotalPaise);
  const afterDiscount = subtotalPaise - discountPaise;
  const deliveryPaise = lines.length && subtotalPaise < FREE_DELIVERY_FROM_PAISE ? DELIVERY_FEE_PAISE : 0;
  return {
    lines,
    issues,
    pricing: {
      mrpTotalPaise,
      subtotalPaise,
      discountPaise,
      deliveryPaise,
      totalPaise: afterDiscount + deliveryPaise,
      couponCode: coupon?.code,
      savingsPaise: mrpTotalPaise - subtotalPaise + discountPaise,
      freeDeliveryFromPaise: FREE_DELIVERY_FROM_PAISE,
    },
    coupon: coupon ? { code: coupon.code, description: coupon.description } : undefined,
    couponError,
  };
}

// Decrements stock for each line only if enough remains, so two shoppers can never buy the
// last unit twice. Anything already taken is put back if a later line fails.
async function reserveStock(lines) {
  const taken = [];
  for (const line of lines) {
    const result = await Product.updateOne(
      { _id: line.product, variants: { $elemMatch: { sku: line.sku, stock: { $gte: line.qty } } } },
      { $inc: { 'variants.$.stock': -line.qty, soldCount: line.qty } },
    );
    if (!result.modifiedCount) {
      await releaseLines(taken);
      throw conflict(`${line.name} (${line.variantLabel}) just went out of stock`);
    }
    taken.push(line);
    await Product.updateOne({ _id: line.product, variants: { $not: { $elemMatch: { stock: { $gt: 0 } } } } }, { inStock: false });
  }
}

async function releaseLines(lines) {
  for (const line of lines) {
    await Product.updateOne({ _id: line.product, 'variants.sku': line.sku }, { $inc: { 'variants.$.stock': line.qty, soldCount: -line.qty }, inStock: true });
  }
}

export async function placeOrder(user, { items, couponCode, address, paymentMethod, redeemPoints }) {
  const q = await quote(items, couponCode);
  if (q.issues.length) throw conflict('Some items in your cart changed. Please review your cart.', q.issues);
  if (!q.lines.length) throw badRequest('Your cart is empty');
  if (couponCode && q.couponError) throw badRequest(q.couponError);

  // Points come off the value after coupons; the delivery fee is always paid.
  const points = await pointsDiscount(user, redeemPoints, q.pricing.subtotalPaise - q.pricing.discountPaise);
  const pricing = { ...q.pricing, pointsRedeemed: points.points, pointsDiscountPaise: points.discountPaise, totalPaise: q.pricing.totalPaise - points.discountPaise };

  await reserveStock(q.lines);
  const code = newCode();
  const status = paymentMethod === 'cod' ? 'placed' : 'pending_payment';
  let spent = null;
  try {
    if (points.points) spent = await movePoints(user._id, -points.points, { reason: 'redeemed', refType: 'shop_order', note: code });
    const order = await ShopOrder.create({
      code,
      user: user._id,
      items: q.lines,
      address,
      pricing,
      paymentMethod,
      status,
      statusHistory: [{ status, by: user._id }],
      payment: { status: 'unpaid', amountPaise: pricing.totalPaise },
    });
    if (spent) await LoyaltyEntry.updateOne({ _id: spent._id }, { ref: order._id });
    if (status === 'placed') await notifySellers(order);
    return order;
  } catch (err) {
    await releaseLines(q.lines);
    if (spent) await movePoints(user._id, points.points, { reason: 'redemption_reversed', refType: 'shop_order', note: `${code} not placed` });
    throw err;
  }
}

async function notifySellers(order) {
  const sellerIds = [...new Set(order.items.map((i) => String(i.seller)))];
  const owners = await Vendor.find({ _id: { $in: sellerIds } }).select('owner').lean();
  await notify(owners.map((o) => o.owner), { type: 'shop.order', title: 'New order received', body: order.code, data: { orderId: String(order._id) } });
}

export async function markOrderPaid(order, paymentId) {
  if (order.payment.status === 'paid') return order;
  order.payment.status = 'paid';
  order.payment.paymentId = paymentId;
  order.payment.paidAt = new Date();
  if (order.status === 'pending_payment') {
    order.status = 'placed';
    order.statusHistory.push({ status: 'placed', note: 'Payment received' });
  }
  await order.save();
  await notifySellers(order);
  return order;
}

const CANCELLABLE = ['pending_payment', 'placed', 'confirmed'];

export async function cancelOrder(order, { by, reason } = {}) {
  if (!CANCELLABLE.includes(order.status)) throw conflict(`An order that is ${order.status} can no longer be cancelled`);
  order.status = 'cancelled';
  order.statusHistory.push({ status: 'cancelled', by, note: reason });
  if (!order.stockReleased) {
    await releaseLines(order.items);
    order.stockReleased = true;
  }
  if (order.pricing.pointsRedeemed && !order.pointsReturned) {
    await movePoints(order.user, order.pricing.pointsRedeemed, { reason: 'redemption_reversed', refType: 'shop_order', ref: order._id, note: `${order.code} cancelled` });
    order.pointsReturned = true;
  }
  if (order.payment.status === 'paid') {
    const refund = await paymentGateway().refund({
      paymentId: order.payment.paymentId,
      amountPaise: order.payment.amountPaise,
      notes: { shopOrderId: String(order._id), tenant: order.tenant },
    });
    order.payment.refundId = refund.refundId;
    order.payment.status = refund.status === 'processed' ? 'refunded' : 'refund_pending';
    if (order.payment.status === 'refunded') order.payment.refundedAt = new Date();
  }
  await order.save();
  return order;
}

// Online orders that were never paid release their stock after the payment window.
export async function expireUnpaidOrders() {
  const cutoff = new Date(Date.now() - PAYMENT_WINDOW_MINUTES * 60_000);
  const stale = await ShopOrder.find({ status: 'pending_payment', createdAt: { $lt: cutoff }, 'payment.status': { $ne: 'paid' } });
  for (const order of stale) await cancelOrder(order, { reason: 'Payment not completed in time' });
  return stale.length;
}
