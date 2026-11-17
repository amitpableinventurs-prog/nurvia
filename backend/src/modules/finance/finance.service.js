import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Booking } from '../bookings/booking.model.js';
import { ReturnRequest } from '../shop/aftercare.model.js';
import { Product, ShopOrder } from '../shop/shop.model.js';
import { Vendor } from '../vendors/vendor.model.js';
import { CommissionConfig, Settlement, SettlementEntry } from './finance.model.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => 'ST' + Array.from(crypto.randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
const oid = (id) => new mongoose.Types.ObjectId(String(id));
// Orders delivered before deliveredAt was recorded fall back to their last update. Orders from
// before per-seller fulfilment have no `fulfilments` and are matched as a whole.
const legacyDeliveredIn = (from, to) => ({ 'fulfilments.0': { $exists: false }, status: 'delivered', $or: [{ deliveredAt: { $gte: from, $lt: to } }, { deliveredAt: null, updatedAt: { $gte: from, $lt: to } }] });
const partDeliveredIn = (from, to, seller) => ({ fulfilments: { $elemMatch: { ...(seller && { seller }), status: 'delivered', deliveredAt: { $gte: from, $lt: to } } } });

export async function commissionConfig() {
  return (await CommissionConfig.findOne({ key: 'default' }).lean()) ?? { bookingPct: 10, marketplacePct: 12, categoryOverrides: [] };
}

export const pctFor = (config, vendor, kind, categoryIds = []) => {
  if (kind === 'order' && vendor.seller?.commissionPct !== undefined && vendor.seller?.commissionPct !== null) return vendor.seller.commissionPct;
  const override = config.categoryOverrides?.find((o) => categoryIds.some((c) => String(c) === String(o.category)));
  if (override) return override.pct;
  return kind === 'booking' ? config.bookingPct : config.marketplacePct;
};
const commissionOf = (gross, pct) => Math.round((gross * pct) / 100);

// Builds the lines one vendor is owed (or owes) for a period, leaving out anything already settled:
//  - completed Nurvia bookings paid online,
//  - the vendor's share of delivered shop orders (online: Nurvia collected; COD: the seller did),
//  - refunds on returns of the vendor's items, which reverse the commission on what was refunded.
export async function buildLines(vendorId, from, to) {
  const vendor = await Vendor.findById(vendorId).lean();
  if (!vendor) return { vendor: null, lines: [] };
  const config = await commissionConfig();
  const settled = new Set((await SettlementEntry.find({ vendor: vendor._id }).select('kind ref').lean()).map((e) => `${e.kind}:${e.ref}`));
  const fresh = (kind, ref) => !settled.has(`${kind}:${ref}`);
  const lines = [];

  const bookings = await Booking.find({ vendor: vendor._id, status: 'completed', 'payment.status': 'paid', scheduledAt: { $gte: from, $lt: to } }).lean();
  for (const b of bookings.filter((b) => fresh('booking', b._id))) {
    const gross = b.payment.amountPaise ?? 0;
    const pct = pctFor(config, vendor, 'booking', vendor.categories);
    const commission = commissionOf(gross, pct);
    lines.push({ kind: 'booking', ref: b._id, code: b.code, date: b.scheduledAt, collectedBy: 'nurvia', grossPaise: gross, commissionPct: pct, commissionPaise: commission, netPaise: gross - commission });
  }

  const orders = await ShopOrder.find({ 'items.seller': vendor._id, $or: [partDeliveredIn(from, to, vendor._id), legacyDeliveredIn(from, to)] }).lean();
  const productIds = orders.flatMap((o) => o.items.filter((i) => String(i.seller) === String(vendor._id)).map((i) => i.product));
  const categoryOf = new Map((await Product.find({ _id: { $in: productIds } }).select('category').lean()).map((p) => [String(p._id), p.category]));
  for (const order of orders.filter((o) => fresh('order', o._id))) {
    const part = order.fulfilments?.find((f) => String(f.seller) === String(vendor._id));
    const mine = order.items.filter((i) => String(i.seller) === String(vendor._id) && !i.cancelled);
    const itemsPaise = mine.reduce((s, i) => s + i.pricePaise * i.qty, 0);
    const { subtotalPaise, discountPaise = 0, deliveryPaise = 0, pointsDiscountPaise = 0 } = order.pricing;
    const share = subtotalPaise ? itemsPaise / subtotalPaise : 1;
    // The seller earns its full item prices plus its delivery fee. Coupons and points are funded by
    // Nurvia, so on cash on delivery Nurvia owes the seller the part the customer did not pay.
    const delivery = part ? part.deliveryPaise ?? 0 : Math.round(deliveryPaise * share);
    const gross = itemsPaise + delivery;
    const nurviaFunded = Math.round((discountPaise + pointsDiscountPaise) * share);
    // Commission is on items only, at the rate fixed when the order was placed.
    const commission = mine.reduce((s, i) => s + commissionOf(i.pricePaise * i.qty, i.commissionPct ?? pctFor(config, vendor, 'order', [i.category ?? categoryOf.get(String(i.product))].filter(Boolean))), 0);
    const pct = itemsPaise ? Math.round((commission / itemsPaise) * 10_000) / 100 : 0;
    const collectedBy = order.paymentMethod === 'online' ? 'nurvia' : 'seller';
    lines.push({ kind: 'order', ref: order._id, code: order.code, date: part?.deliveredAt ?? order.deliveredAt ?? order.updatedAt, collectedBy, grossPaise: gross, commissionPct: pct, commissionPaise: commission, netPaise: (collectedBy === 'nurvia' ? gross : nurviaFunded) - commission });
  }

  const refunds = await ReturnRequest.find({ seller: vendor._id, status: 'refunded', 'refund.at': { $gte: from, $lt: to } }).lean();
  const refundOrders = new Map((await ShopOrder.find({ _id: { $in: refunds.map((r) => r.order) } }).select('items.sku items.seller items.commissionPct').lean()).map((o) => [String(o._id), o]));
  for (const r of refunds.filter((r) => fresh('return_refund', r._id))) {
    const amount = r.refund?.amountPaise ?? 0;
    // The commission reversed is at the rate the returned items were sold at.
    const sold = refundOrders.get(String(r.order))?.items.find((i) => r.items.some((x) => x.sku === i.sku) && String(i.seller) === String(vendor._id));
    const pct = sold?.commissionPct ?? pctFor(config, vendor, 'order', []);
    const reversed = commissionOf(amount, pct);
    // Gateway refunds are paid out by Nurvia, so they come off the vendor's balance; manual (COD)
    // refunds are made by the seller, so only the commission reversal applies.
    const collectedBy = r.refund?.method === 'gateway' ? 'nurvia' : 'seller';
    lines.push({ kind: 'return_refund', ref: r._id, code: r.code, date: r.refund.at, collectedBy, grossPaise: -amount, commissionPct: pct, commissionPaise: -reversed, netPaise: (collectedBy === 'nurvia' ? -amount : 0) + reversed });
  }
  return { vendor, lines: lines.sort((a, b) => a.date - b.date) };
}

export function totalsOf(lines) {
  return {
    grossPaise: lines.filter((l) => l.grossPaise > 0).reduce((s, l) => s + l.grossPaise, 0),
    refundsPaise: -lines.filter((l) => l.grossPaise < 0).reduce((s, l) => s + l.grossPaise, 0),
    commissionPaise: lines.reduce((s, l) => s + l.commissionPaise, 0),
    netPaise: lines.reduce((s, l) => s + l.netPaise, 0),
    lineCount: lines.length,
  };
}

// Creates a draft settlement and reserves its lines. Two runs racing for the same lines: the
// unique entry index lets only one reserve each line, and the loser's settlement is removed.
export async function createSettlement(vendorId, from, to, { by, note } = {}) {
  const { vendor, lines } = await buildLines(vendorId, from, to);
  if (!vendor || !lines.length) return null;
  const settlement = await Settlement.create({
    code: newCode(),
    vendor: vendor._id,
    periodFrom: from,
    periodTo: to,
    lines,
    totals: totalsOf(lines),
    note,
    statusHistory: [{ status: 'draft', by, note }],
  });
  try {
    await SettlementEntry.insertMany(lines.map((l) => ({ vendor: vendor._id, kind: l.kind, ref: l.ref, settlement: settlement._id })), { ordered: true });
  } catch (err) {
    await SettlementEntry.deleteMany({ settlement: settlement._id });
    await settlement.deleteOne();
    if (err.code === 11000) return null;
    throw err;
  }
  return settlement;
}

// Vendors with anything settleable in the period.
export async function vendorsWithActivity(from, to) {
  const [b, o, r] = await Promise.all([
    Booking.distinct('vendor', { status: 'completed', 'payment.status': 'paid', scheduledAt: { $gte: from, $lt: to } }),
    ShopOrder.aggregate([
      { $match: { $or: [partDeliveredIn(from, to), legacyDeliveredIn(from, to)] } },
      { $project: { sellers: { $cond: [{ $gt: [{ $size: { $ifNull: ['$fulfilments', []] } }, 0] }, { $map: { input: { $filter: { input: '$fulfilments', as: 'f', cond: { $and: [{ $eq: ['$$f.status', 'delivered'] }, { $gte: ['$$f.deliveredAt', from] }, { $lt: ['$$f.deliveredAt', to] }] } } }, as: 'f', in: '$$f.seller' } }, '$items.seller'] } } },
      { $unwind: '$sellers' },
      { $group: { _id: '$sellers' } },
    ]).then((rows) => rows.map((r) => r._id)),
    ReturnRequest.distinct('seller', { status: 'refunded', 'refund.at': { $gte: from, $lt: to } }),
  ]);
  return [...new Set([...b, ...o, ...r].map(String))].map(oid);
}
