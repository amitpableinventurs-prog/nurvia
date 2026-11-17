import crypto from 'node:crypto';
import { badRequest, conflict } from '../../common/errors.js';
import { paymentGateway } from '../../integrations/payments.js';
import { commissionConfig, pctFor } from '../finance/finance.service.js';
import { LoyaltyEntry } from '../loyalty/loyalty.model.js';
import { movePoints, onQualifyingActivity, pointsDiscount } from '../loyalty/loyalty.service.js';
import { notify } from '../notifications/notify.js';
import { distanceKm, getPlatform, matchCity } from '../platform/platform.service.js';
import { Vendor } from '../vendors/vendor.model.js';
import { releaseLines, reserveLines } from './inventory.service.js';
import { Cart, Coupon, Product, ShopOrder } from './shop.model.js';

// Defaults for a seller that has not set its own delivery fee (vendor.seller.shipping).
export const FREE_DELIVERY_FROM_PAISE = 49_900;
export const DELIVERY_FEE_PAISE = 4_900;
export const DEFAULT_RADIUS_KM = 10;
export const MAX_QTY_PER_LINE = 10;
export const PAYMENT_WINDOW_MINUTES = 15;
export const CONFIRM_REMINDER_HOURS = 2;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => 'OD' + Array.from(crypto.randomBytes(7), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
const rupees = (paise) => `₹${Math.ceil(paise / 100)}`;

// ---- Coupons ----

const isLive = (c, now = new Date()) => c.active && (!c.startsAt || c.startsAt <= now) && (!c.expiresAt || c.expiresAt > now);
const COUNTED = { status: { $nin: ['cancelled', 'pending_payment'] } };

// The cart value a coupon counts: every line, or only the categories and sellers it is limited to.
function eligiblePaise(coupon, lines) {
  const cats = (coupon.categories ?? []).map(String);
  const sellers = (coupon.sellers ?? []).map(String);
  return lines
    .filter((l) => (!cats.length || cats.includes(String(l.category))) && (!sellers.length || sellers.includes(String(l.seller))))
    .reduce((n, l) => n + l.pricePaise * l.qty, 0);
}

function amountOff(coupon, basePaise) {
  let discountPaise = coupon.type === 'percent' ? Math.floor((basePaise * coupon.value) / 100) : coupon.value;
  if (coupon.maxDiscountPaise) discountPaise = Math.min(discountPaise, coupon.maxDiscountPaise);
  return Math.min(discountPaise, basePaise);
}

// Why this customer cannot use the coupon on these lines, or null. Limits that depend on who is
// buying are checked only when the customer is known (always at checkout).
async function couponProblem(coupon, lines, userId) {
  const base = eligiblePaise(coupon, lines);
  if (!base) return `${coupon.code} does not apply to the items in your cart`;
  if (base < coupon.minOrderPaise) return `Add items worth ${rupees(coupon.minOrderPaise - base)} more to use ${coupon.code}`;
  if (coupon.usageLimit && (await ShopOrder.countDocuments({ 'pricing.couponCode': coupon.code, ...COUNTED })) >= coupon.usageLimit) return `${coupon.code} has been fully used`;
  if (userId) {
    if (coupon.perCustomerLimit && (await ShopOrder.countDocuments({ 'pricing.couponCode': coupon.code, user: userId, ...COUNTED })) >= coupon.perCustomerLimit) {
      return `You have already used ${coupon.code}`;
    }
    if (coupon.firstOrderOnly && (await ShopOrder.exists({ user: userId, ...COUNTED }))) return `${coupon.code} is for your first order only`;
  }
  return null;
}

// The best automatic discount the cart qualifies for, if any.
async function autoDiscount(lines, userId) {
  if (!lines.length) return null;
  const now = new Date();
  const offers = (await Coupon.find({ autoApply: true, active: true }).lean()).filter((c) => isLive(c, now));
  let best = null;
  for (const coupon of offers) {
    if (await couponProblem(coupon, lines, userId)) continue;
    const discountPaise = amountOff(coupon, eligiblePaise(coupon, lines));
    if (discountPaise > (best?.discountPaise ?? 0)) best = { discountPaise, coupon };
  }
  return best;
}

// One offer per order: a valid code the customer entered, otherwise the best automatic discount.
async function couponDiscount(code, lines, userId) {
  const fallback = async (couponError) => ({ ...((await autoDiscount(lines, userId)) ?? { discountPaise: 0 }), couponError });
  if (!code) return fallback();
  const coupon = await Coupon.findOne({ code: code.toUpperCase(), active: true }).lean();
  if (!coupon || !isLive(coupon)) return fallback('This coupon is not valid');
  const problem = await couponProblem(coupon, lines, userId);
  if (problem) return fallback(problem);
  return { discountPaise: amountOff(coupon, eligiblePaise(coupon, lines)), coupon };
}

// ---- Sellers and fulfilment ----

// Sellers whose products the shop shows and sells: an active business with an approved seller
// profile. Suspending either hides the products at once, without changing them, and reinstating
// brings them back.
export const liveSellerIds = () => Vendor.distinct('_id', { status: 'active', 'seller.status': 'approved' });

// The filter for products customers can see: active, from a live seller.
export async function shownProducts(filter = {}) {
  return { ...filter, status: 'active', seller: { $in: await liveSellerIds() } };
}

const shippingOf = (vendor) => ({
  delivers: vendor.seller?.shipping?.delivers ?? true,
  radiusKm: vendor.seller?.shipping?.radiusKm ?? DEFAULT_RADIUS_KM,
  feePaise: vendor.seller?.shipping?.feePaise ?? DELIVERY_FEE_PAISE,
  freeFromPaise: vendor.seller?.shipping?.freeFromPaise ?? FREE_DELIVERY_FROM_PAISE,
  pickup: Boolean(vendor.store?.inStorePickup),
});

// Whether the seller delivers to the address: within its radius when the address has a map pin,
// otherwise when both are in the same city. null when there is no address yet.
async function delivers(vendor, address) {
  const shipping = shippingOf(vendor);
  if (!shipping.delivers) return false;
  if (!address) return null;
  if (address.lat !== undefined && address.lng !== undefined && vendor.location?.coordinates?.length === 2) {
    return distanceKm(vendor.location.coordinates, [address.lng, address.lat]) <= shipping.radiusKm;
  }
  if (!address.city || !vendor.address?.city) return false;
  const norm = (s) => s.trim().toLowerCase();
  if (norm(address.city) === norm(vendor.address.city)) return true;
  const { cities } = await getPlatform();
  const a = matchCity(cities, { city: address.city });
  const b = matchCity(cities, { city: vendor.address.city });
  return Boolean(a && b && String(a._id) === String(b._id));
}

// Prices a cart from the database: the client only says what and how many, never how much.
// Lines that are unavailable are returned in `issues` rather than failing the whole quote.
// `sellers` has one entry per seller in the cart: its items' value, how it fulfils (`method`,
// from `fulfilment[sellerId]`, else delivery when the seller delivers, else pickup), its delivery
// fee, and `problem` when it cannot fulfil that way (checkout refuses the cart until it is fixed).
export async function quote(items, couponCode, options) {
  const { vendors: _vendors, ...priced } = await priceCart(items, couponCode, options);
  return priced;
}

async function priceCart(items, couponCode, { userId, address, fulfilment = {} } = {}) {
  const ids = [...new Set(items.map((i) => String(i.productId)))];
  const products = await Product.find(await shownProducts({ _id: { $in: ids } })).lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));

  const lines = [];
  const issues = [];
  for (const item of items) {
    const product = byId.get(String(item.productId));
    const variant = product?.variants.find((v) => v.sku === item.sku);
    if (!product || !variant) {
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
      image: variant.image?.url ?? product.images?.[0]?.url,
      art: product.art,
      brand: product.brand,
      mrpPaise: variant.mrpPaise,
      pricePaise: variant.pricePaise,
      qty,
      category: product.category,
      returnable: product.returnable !== false,
      hsn: product.hsn,
      gstRate: product.gstRate,
    });
  }

  const sellerIds = [...new Set(lines.map((l) => String(l.seller)))];
  const vendors = await Vendor.find({ _id: { $in: sellerIds } }).select('businessName address.city location seller.shipping seller.commissionPct store.inStorePickup').lean();
  const sellers = [];
  for (const vendor of vendors) {
    const shipping = shippingOf(vendor);
    const mine = lines.filter((l) => String(l.seller) === String(vendor._id));
    const subtotalPaise = mine.reduce((n, l) => n + l.pricePaise * l.qty, 0);
    const method = fulfilment[String(vendor._id)] ?? (shipping.delivers || !shipping.pickup ? 'delivery' : 'pickup');
    const deliverable = await delivers(vendor, address);
    let problem;
    if (method === 'pickup' && !shipping.pickup) problem = `${vendor.businessName} does not offer store pickup`;
    if (method === 'delivery' && deliverable === false) {
      problem = shipping.pickup ? `${vendor.businessName} does not deliver to this address. Choose store pickup instead.` : `${vendor.businessName} does not deliver to this address`;
    }
    sellers.push({
      seller: vendor._id,
      name: vendor.businessName,
      subtotalPaise,
      method,
      deliveryPaise: method === 'delivery' && subtotalPaise < shipping.freeFromPaise ? shipping.feePaise : 0,
      freeDeliveryFromPaise: shipping.delivers ? shipping.freeFromPaise : undefined,
      deliveryAvailable: shipping.delivers,
      deliverable,
      pickupAvailable: shipping.pickup,
      ...(problem && { problem }),
    });
  }

  const subtotalPaise = lines.reduce((n, l) => n + l.pricePaise * l.qty, 0);
  const mrpTotalPaise = lines.reduce((n, l) => n + l.mrpPaise * l.qty, 0);
  const { discountPaise, coupon, couponError } = await couponDiscount(couponCode, lines, userId);
  const deliveryPaise = sellers.reduce((n, s) => n + s.deliveryPaise, 0);
  return {
    lines,
    issues,
    sellers,
    pricing: {
      mrpTotalPaise,
      subtotalPaise,
      discountPaise,
      deliveryPaise,
      totalPaise: subtotalPaise - discountPaise + deliveryPaise,
      couponCode: coupon?.code,
      savingsPaise: mrpTotalPaise - subtotalPaise + discountPaise,
      // With one seller, the order value that makes delivery free.
      freeDeliveryFromPaise: sellers.length === 1 ? sellers[0].freeDeliveryFromPaise : sellers.length ? undefined : FREE_DELIVERY_FROM_PAISE,
    },
    coupon: coupon ? { code: coupon.code, description: coupon.description, automatic: Boolean(coupon.autoApply) } : undefined,
    couponError,
    vendors,
  };
}

// ---- Order status ----

const RANK = { pending_payment: 0, placed: 1, confirmed: 2, packed: 3, shipped: 4, ready_for_pickup: 4, delivered: 5 };
export const CUSTOMER_CANCELLABLE = ['pending_payment', 'placed', 'confirmed'];
export const STAFF_CANCELLABLE = [...CUSTOMER_CANCELLABLE, 'packed'];

// Orders placed before fulfilments existed are given one part per seller, at the order's status.
export function ensureFulfilments(order) {
  if (order.fulfilments?.length) return;
  const sellers = [...new Set(order.items.map((i) => String(i.seller)))];
  order.fulfilments = sellers.map((seller, n) => ({
    seller,
    method: 'delivery',
    deliveryPaise: n === 0 ? order.pricing.deliveryPaise ?? 0 : 0,
    status: order.status,
    statusHistory: [{ status: order.status, at: order.updatedAt ?? new Date() }],
    deliveredAt: order.deliveredAt,
  }));
}

export const fulfilmentOf = (order, sellerId) => order.fulfilments.find((f) => String(f.seller) === String(sellerId));

// The order's status follows its parts: the least advanced live one, or cancelled when all are.
function refreshStatus(order, { by, note } = {}) {
  const live = order.fulfilments.filter((f) => f.status !== 'cancelled');
  const status = live.length ? live.reduce((a, b) => (RANK[b.status] < RANK[a.status] ? b : a)).status : 'cancelled';
  if (status !== order.status) {
    order.status = status;
    order.statusHistory.push({ status, by, note });
  }
  if (status === 'delivered' && !order.deliveredAt) order.deliveredAt = new Date();
  return status;
}

function setFulfilment(f, status, { by, note } = {}) {
  f.status = status;
  f.statusHistory.push({ status, by, note });
  if (status === 'delivered') f.deliveredAt = new Date();
}

// ---- Placing and paying ----

export async function placeOrder(user, { items, couponCode, address, paymentMethod, redeemPoints, fulfilment }) {
  const q = await priceCart(items, couponCode, { userId: user._id, address, fulfilment });
  if (q.issues.length) throw conflict('Some items in your cart changed. Please review your cart.', q.issues);
  if (!q.lines.length) throw badRequest('Your cart is empty');
  if (couponCode && q.couponError) throw badRequest(q.couponError);
  const blocked = q.sellers.filter((s) => s.problem);
  if (blocked.length) throw conflict(blocked[0].problem, blocked.map(({ seller, problem, pickupAvailable }) => ({ seller, message: problem, pickupAvailable })));

  // Points come off the value after coupons; the delivery fee is always paid.
  const points = await pointsDiscount(user, redeemPoints, q.pricing.subtotalPaise - q.pricing.discountPaise);
  const pricing = { ...q.pricing, pointsRedeemed: points.points, pointsDiscountPaise: points.discountPaise, totalPaise: q.pricing.totalPaise - points.discountPaise };
  delete pricing.savingsPaise;
  delete pricing.freeDeliveryFromPaise;

  if (paymentMethod === 'cod') {
    const { marketplace } = await getPlatform();
    if (!marketplace.codEnabled) throw badRequest('Cash on delivery is not available. Please pay online.');
    if (pricing.totalPaise > marketplace.codMaxOrderPaise) throw badRequest(`Cash on delivery is available for orders up to ${rupees(marketplace.codMaxOrderPaise)}. Please pay online.`);
  }

  // Commission is fixed per line now, so a later change of rates never alters this order.
  const config = await commissionConfig();
  const vendorById = new Map(q.vendors.map((v) => [String(v._id), v]));
  const lines = q.lines.map((l) => ({ ...l, commissionPct: pctFor(config, vendorById.get(String(l.seller)), 'order', [l.category]) }));

  const code = newCode();
  const short = await reserveLines(lines, { ref: code, by: user._id });
  if (short) throw conflict(`${short.name} (${short.variantLabel}) just went out of stock`);

  const status = paymentMethod === 'cod' ? 'placed' : 'pending_payment';
  const fulfilments = q.sellers.map((s) => ({ seller: s.seller, method: s.method, deliveryPaise: s.deliveryPaise, status, statusHistory: [{ status, by: user._id }] }));
  let spent = null;
  let order;
  try {
    if (points.points) spent = await movePoints(user._id, -points.points, { reason: 'redeemed', refType: 'shop_order', note: code });
    order = await ShopOrder.create({
      code,
      user: user._id,
      items: lines,
      fulfilments,
      address,
      pricing,
      paymentMethod,
      status,
      statusHistory: [{ status, by: user._id }],
      payment: { status: 'unpaid', amountPaise: pricing.totalPaise },
    });
    if (spent) await LoyaltyEntry.updateOne({ _id: spent._id }, { ref: order._id });
    if (status === 'placed') await notifySellers(order);
  } catch (err) {
    await releaseLines(lines, { ref: code, note: 'Order not placed' });
    if (spent) await movePoints(user._id, points.points, { reason: 'redemption_reversed', refType: 'shop_order', note: `${code} not placed` });
    throw err;
  }
  if (status === 'placed') await removeFromCart(order);
  return order;
}

// Ordered lines leave the customer's cart once the order is really placed, so an online payment
// that is abandoned leaves the cart as it was. The order stands whatever happens here: reporting
// it as failed would invite the customer to order twice.
async function removeFromCart(order) {
  const ordered = order.items.map((i) => ({ product: i.product, sku: i.sku }));
  await Cart.updateOne({ user: order.user }, { $pull: { items: { $or: ordered } } }).catch((err) => console.error('[cart] could not clear ordered items', err));
}

async function ownersOf(sellerIds) {
  const owners = await Vendor.find({ _id: { $in: sellerIds } }).select('owner').lean();
  return owners.map((o) => o.owner);
}

async function notifySellers(order) {
  const sellerIds = [...new Set(order.items.map((i) => String(i.seller)))];
  await notify(await ownersOf(sellerIds), { type: 'shop.order', title: 'New order received', body: order.code, data: { orderId: String(order._id) } });
}

export async function markOrderPaid(order, paymentId) {
  if (order.payment.status === 'paid') return order;
  ensureFulfilments(order);
  order.payment.status = 'paid';
  order.payment.paymentId = paymentId;
  order.payment.paidAt = new Date();
  for (const f of order.fulfilments) if (f.status === 'pending_payment') setFulfilment(f, 'placed', { note: 'Payment received' });
  refreshStatus(order, { note: 'Payment received' });
  await order.save();
  await notifySellers(order);
  await removeFromCart(order);
  return order;
}

// ---- Seller fulfilment ----

// What a seller's part may move to next. Delivery goes out for delivery (`shipped`); pickup becomes
// ready for pickup. Either ends as delivered.
export function nextStatuses(f) {
  const out = f.method === 'pickup' ? 'ready_for_pickup' : 'shipped';
  return { placed: ['confirmed'], confirmed: ['packed', out], packed: [out], [out]: ['delivered'] }[f.status] ?? [];
}

export async function advanceFulfilment(order, sellerId, status, { by, note } = {}) {
  ensureFulfilments(order);
  const f = fulfilmentOf(order, sellerId);
  if (!f) throw conflict('This order has nothing from your store');
  if (!nextStatuses(f).includes(status)) throw conflict(`Cannot move an order from ${f.status} to ${status}`);
  setFulfilment(f, status, { by, note });
  const wasDelivered = order.status === 'delivered';
  refreshStatus(order, { by, note });
  if (order.status === 'delivered' && order.paymentMethod === 'cod' && order.payment.status !== 'paid') {
    order.payment.status = 'paid';
    order.payment.paidAt = new Date();
  }
  await order.save();
  if (order.status === 'delivered' && !wasDelivered) {
    await onQualifyingActivity(order.user, { kind: 'order', ref: order._id, amountPaise: order.pricing.totalPaise }).catch((err) => console.error('[loyalty]', err));
  }
  return order;
}

// ---- Refunds and cancellation ----

// Pays money back through the gateway and records it. The order counts as refunded once everything
// paid has gone back.
export async function refundPayment(order, amountPaise, { reason, notes = {} } = {}) {
  if (amountPaise <= 0) return null;
  const refund = await paymentGateway().refund({ paymentId: order.payment.paymentId, amountPaise, notes: { shopOrderId: String(order._id), tenant: order.tenant, ...notes } });
  const status = refund.status === 'processed' ? 'processed' : 'pending';
  order.payment.refunds.push({ amountPaise, refundId: refund.refundId, status, reason });
  order.payment.refundId = refund.refundId;
  order.payment.refundedPaise = (order.payment.refundedPaise ?? 0) + amountPaise;
  if (order.payment.refundedPaise >= (order.payment.amountPaise ?? order.pricing.totalPaise)) {
    order.payment.status = order.payment.refunds.every((r) => r.status === 'processed') ? 'refunded' : 'refund_pending';
    order.payment.refundedAt = new Date();
  }
  return { ...refund, status };
}

const linePaise = (lines) => lines.reduce((n, i) => n + i.pricePaise * i.qty, 0);

// Cancels some open lines of an order: one seller's (`seller`), some SKUs (`skus`), or all of them.
// Customers can cancel until a part is packed; sellers and staff until it leaves the store.
// Stock goes back, the paid share is refunded (with the delivery fee once a seller's whole part is
// cancelled), and redeemed points come back in the same proportion. Cash-on-delivery orders owe less.
export async function cancelLines(order, { seller, skus, by, reason, actor = 'customer' } = {}) {
  ensureFulfilments(order);
  const allowed = actor === 'customer' ? CUSTOMER_CANCELLABLE : STAFF_CANCELLABLE;
  const open = order.items.filter((i) => !i.cancelled);
  const targets = open.filter((i) => (!seller || String(i.seller) === String(seller)) && (!skus || skus.includes(i.sku)));
  if (!targets.length) throw conflict(open.length ? 'Those items are not in this order' : `An order that is ${order.status} can no longer be cancelled`);
  for (const t of targets) {
    const f = fulfilmentOf(order, t.seller);
    if (!allowed.includes(f.status)) throw conflict(seller || skus ? `${t.name} is ${f.status} and can no longer be cancelled` : `An order that is ${f.status} can no longer be cancelled`);
  }
  const whole = targets.length === open.length;
  if (!whole && order.status === 'pending_payment') throw conflict('Pay for the order or cancel all of it');

  if (!order.stockReleased) await releaseLines(targets, { ref: order.code, by, note: reason });
  const now = new Date();
  for (const t of targets) Object.assign(t, { cancelled: true, cancelledAt: now, cancelReason: reason });
  if (whole) order.stockReleased = true;

  let deliveryBack = 0;
  for (const f of order.fulfilments) {
    if (f.status === 'cancelled') continue;
    if (order.items.every((i) => String(i.seller) !== String(f.seller) || i.cancelled)) {
      setFulfilment(f, 'cancelled', { by, note: reason });
      deliveryBack += f.deliveryPaise ?? 0;
    }
  }

  // The customer's money for these lines: their share of what was paid for goods, coupon and points applied.
  const { subtotalPaise, deliveryPaise = 0, pointsRedeemed = 0 } = order.pricing;
  const due = order.payment.amountPaise ?? order.pricing.totalPaise;
  const remaining = due - (order.payment.refundedPaise ?? 0);
  const goodsPaid = Math.max(0, (order.pricing.totalPaise ?? due) - deliveryPaise);
  const share = whole ? remaining : Math.min(remaining, Math.round((linePaise(targets) * goodsPaid) / subtotalPaise) + deliveryBack);

  if (pointsRedeemed && !order.pointsReturned) {
    const back = whole ? pointsRedeemed - order.pointsReturnedCount : Math.floor((pointsRedeemed * linePaise(targets)) / subtotalPaise);
    if (back > 0) {
      await movePoints(order.user, back, { reason: 'redemption_reversed', refType: 'shop_order', ref: order._id, note: `${order.code} cancelled` });
      order.pointsReturnedCount += back;
    }
    if (whole || order.pointsReturnedCount >= pointsRedeemed) order.pointsReturned = true;
  }

  if (['paid', 'refund_pending', 'refunded'].includes(order.payment.status) && order.paymentMethod === 'online') {
    await refundPayment(order, share, { reason: reason ?? 'Cancelled' });
  } else if (order.paymentMethod === 'cod' && order.payment.status !== 'paid') {
    // Nothing was paid yet: the customer simply owes less on delivery.
    order.payment.amountPaise = Math.max(0, due - share);
  }

  const before = order.status;
  refreshStatus(order, { by, note: reason });
  if (order.status === 'delivered' && before !== 'delivered' && order.paymentMethod === 'cod') {
    order.payment.status = 'paid';
    order.payment.paidAt = new Date();
  }
  await order.save();

  // The other side hears about it: sellers when the customer or staff cancel, the customer otherwise.
  const sellerIds = [...new Set(targets.map((t) => String(t.seller)))];
  if (actor === 'seller') {
    await notify([order.user], { type: 'shop.cancelled', title: `Items in ${order.code} were cancelled by the store`, body: reason, data: { orderId: String(order._id) } });
  } else if (before !== 'pending_payment') {
    await notify(await ownersOf(sellerIds), { type: 'shop.order_cancelled', title: `Order ${order.code} ${whole ? 'cancelled' : 'changed'}`, body: targets.map((t) => `${t.name} (${t.variantLabel})`).join(', '), data: { orderId: String(order._id) } });
  }
  return order;
}

export const cancelOrder = (order, { by, reason, actor } = {}) => cancelLines(order, { by, reason, actor });

// Online orders that were never paid release their stock after the payment window.
export async function expireUnpaidOrders() {
  const cutoff = new Date(Date.now() - PAYMENT_WINDOW_MINUTES * 60_000);
  const stale = await ShopOrder.find({ status: 'pending_payment', createdAt: { $lt: cutoff }, 'payment.status': { $ne: 'paid' } });
  for (const order of stale) await cancelOrder(order, { reason: 'Payment not completed in time', actor: 'system' });
  return stale.length;
}

// Sellers are reminded once about a part of an order they have not confirmed within 2 hours.
export async function remindUnconfirmed(limit = 100) {
  const cutoff = new Date(Date.now() - CONFIRM_REMINDER_HOURS * 3_600_000);
  const orders = await ShopOrder.find({ fulfilments: { $elemMatch: { status: 'placed', remindedAt: null } }, createdAt: { $lt: cutoff } }).limit(limit);
  let sent = 0;
  for (const order of orders) {
    const due = order.fulfilments.filter((f) => f.status === 'placed' && !f.remindedAt && (f.statusHistory.findLast((h) => h.status === 'placed')?.at ?? order.createdAt) < cutoff);
    if (!due.length) continue;
    for (const f of due) f.remindedAt = new Date();
    await order.save();
    await notify(await ownersOf(due.map((f) => f.seller)), { type: 'shop.order_reminder', title: `Order ${order.code} is waiting for you`, body: `Placed over ${CONFIRM_REMINDER_HOURS} hours ago. Confirm or cancel it.`, data: { orderId: String(order._id) } });
    sent += due.length;
  }
  return sent;
}

