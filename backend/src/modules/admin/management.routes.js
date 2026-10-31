import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../common/auth.js';
import { badRequest, conflict, notFound } from '../../common/errors.js';
import { paginate } from '../../common/paginate.js';
import { PERMISSIONS } from '../../common/roles.js';
import { escapeRegex, objectId, pageQuery, point, validate } from '../../common/validate.js';
import { paymentGateway } from '../../integrations/payments.js';
import { audit } from '../audit/audit.model.js';
import { Booking } from '../bookings/booking.model.js';
import { Category } from '../categories/category.model.js';
import { NfcTag } from '../nfc/nfc.model.js';
import { notify } from '../notifications/notify.js';
import { HealthRecord, Pet, Reminder, SPECIES } from '../pets/pet.model.js';
import { Coupon, ORDER_STATUSES, ShopOrder } from '../shop/shop.model.js';
import { cancelOrder } from '../shop/shop.service.js';
import { Service, Vendor } from '../vendors/vendor.model.js';

// Super Admin operations beyond review and moderation: pets, payments, editing vendors and their
// services, acting on bookings and shop orders, and coupons. Every write is audited.
const router = Router();
const P = PERMISSIONS;
const reason = z.string().trim().min(3).max(500);

// ---- Pets ----
// Staff see a pet's profile and how much is recorded, never the private health records or files.

router.get(
  '/pets',
  requirePermission(P.USERS_READ),
  validate({ query: { ...pageQuery, q: z.string().trim().max(60).optional(), species: z.enum(SPECIES).optional(), owner: objectId.optional(), lost: z.enum(['true']).optional() } }),
  async (req, res) => {
    const { page, limit, q, species, owner, lost } = req.valid.query;
    const filter = {
      archivedAt: null,
      ...(q && { $or: [{ name: { $regex: escapeRegex(q), $options: 'i' } }, { microchipId: q }] }),
      ...(species && { species }),
      ...(owner && { owner }),
      ...(lost && { 'lost.active': true }),
    };
    res.json(await paginate(Pet, filter, { page, limit, select: 'name species breed sex dateOfBirth photo owner microchipId lost createdAt', populate: { path: 'owner', select: 'name phone' } }));
  },
);

router.get('/pets/:id', requirePermission(P.USERS_READ), validate(), async (req, res) => {
  const pet = await Pet.findById(req.valid.params.id).select('-notes -emergencyNotes -conditions -allergies').populate('owner', 'name phone email status').lean();
  if (!pet) throw notFound('Pet');
  const [records, reminders, bookings, tags] = await Promise.all([
    HealthRecord.aggregate([{ $match: { pet: pet._id } }, { $group: { _id: '$type', count: { $sum: 1 } } }]),
    Reminder.countDocuments({ pet: pet._id, completedAt: null }),
    Booking.find({ pet: pet._id }).sort({ scheduledAt: -1 }).limit(20).select('code status scheduledAt serviceSnapshot.name vendor').populate('vendor', 'businessName').lean(),
    NfcTag.find({ pet: pet._id }).select('serial status kind activatedAt scanCount lastScanAt').lean(),
  ]);
  res.json({ ...pet, recordCounts: Object.fromEntries(records.map((r) => [r._id, r.count])), openReminders: reminders, bookings, tags });
});

// ---- Payments: booking and shop payments in one list ----

router.get(
  '/payments',
  requirePermission(P.PAYMENTS_READ),
  validate({
    query: {
      ...pageQuery,
      kind: z.enum(['booking', 'shop']).optional(),
      status: z.enum(['pending', 'paid', 'failed', 'refund_pending', 'refunded']).optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    },
  }),
  async (req, res) => {
    const { page, limit, kind, status, from, to } = req.valid.query;
    const match = {
      'payment.status': status ?? { $in: ['pending', 'paid', 'failed', 'refund_pending', 'refunded'] },
      ...((from || to) && { updatedAt: { ...(from && { $gte: from }), ...(to && { $lt: to }) } }),
    };
    const project = (k) => [{ $match: match }, { $project: { _id: 1, kind: { $literal: k }, code: 1, user: 1, payment: 1, updatedAt: 1, vendor: 1, amountPaise: '$payment.amountPaise' } }];
    // Bookings and shop orders live in different collections; $unionWith merges them for one paged list.
    const pipeline = [
      ...(kind === 'shop' ? [{ $match: { _id: null } }] : project('booking')),
      ...(kind === 'booking' ? [] : [{ $unionWith: { coll: ShopOrder.collection.name, pipeline: [{ $match: { tenant: req.tenant } }, ...project('shop')] } }]),
      { $sort: { updatedAt: -1 } },
      { $facet: { items: [{ $skip: (page - 1) * limit }, { $limit: limit }], total: [{ $count: 'n' }], sums: [{ $group: { _id: '$payment.status', paise: { $sum: '$amountPaise' }, count: { $sum: 1 } } }] } },
    ];
    const [{ items, total, sums }] = await Booking.aggregate(pipeline);
    const count = total[0]?.n ?? 0;
    res.json({ items, page, limit, total: count, pages: Math.ceil(count / limit), totals: Object.fromEntries(sums.map((s) => [s._id, { paise: s.paise, count: s.count }])) });
  },
);

// ---- Vendors: edit the listing and its services ----

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const vendorEdit = {
  businessName: z.string().trim().min(2).max(120).optional(),
  categoryIds: z.array(objectId).min(1).max(5).optional(),
  description: z.string().max(2000).optional(),
  phone: z.string().max(20).optional(),
  email: z.string().email().optional(),
  address: z
    .object({ line1: z.string().trim().min(1).max(200), line2: z.string().trim().max(200).optional(), city: z.string().trim().min(1).max(80), state: z.string().trim().max(80).optional(), pincode: z.string().regex(/^\d{6}$/).optional() })
    .optional(),
  location: point.optional(),
  operatingHours: z.array(z.object({ day: z.number().int().min(0).max(6), open: hhmm, close: hhmm })).max(21).optional(),
  slotCapacity: z.number().int().min(1).max(50).optional(),
  homeVisits: z.boolean().optional(),
  reason,
};

router.patch('/vendors/:id', requirePermission(P.VENDORS_REVIEW), validate({ body: vendorEdit }), async (req, res) => {
  const vendor = await Vendor.findById(req.valid.params.id);
  if (!vendor) throw notFound('Vendor');
  const { reason: why, categoryIds, ...fields } = req.valid.body;
  if (categoryIds) {
    if ((await Category.countDocuments({ _id: { $in: categoryIds }, kind: 'vendor' })) !== new Set(categoryIds).size) throw badRequest('Unknown vendor category');
    fields.categories = categoryIds;
  }
  const changed = Object.keys(fields);
  if (!changed.length) throw badRequest('Nothing to change');
  vendor.set(fields);
  await vendor.save();
  await audit(req, 'vendor.edit', { type: 'vendor', id: vendor._id }, { reason: why, meta: { fields: changed } });
  await notify([vendor.owner], { type: 'vendor.edited', title: 'Nurvia updated your listing', body: why, data: { vendorId: String(vendor._id), fields: changed } });
  res.json(vendor);
});

router.get('/vendors/:id/services', requirePermission(P.VENDORS_READ), validate(), async (req, res) => {
  res.json(await Service.find({ vendor: req.valid.params.id }).sort({ active: -1, createdAt: 1 }).lean());
});

router.patch(
  '/vendors/:id/services/:serviceId',
  requirePermission(P.VENDORS_REVIEW),
  validate({
    params: { serviceId: objectId },
    body: {
      name: z.string().trim().min(1).max(120).optional(),
      description: z.string().max(1000).optional(),
      pricePaise: z.number().int().min(0).max(10_000_000).optional(),
      durationMin: z.number().int().min(5).max(24 * 60).optional(),
      active: z.boolean().optional(),
      reason,
    },
  }),
  async (req, res) => {
    const service = await Service.findOne({ _id: req.valid.params.serviceId, vendor: req.valid.params.id });
    if (!service) throw notFound('Service');
    const { reason: why, ...fields } = req.valid.body;
    service.set(fields);
    await service.save();
    await audit(req, 'vendor.service_edit', { type: 'service', id: service._id }, { reason: why, meta: { vendor: req.valid.params.id, fields: Object.keys(fields) } });
    res.json(service);
  },
);

// ---- Bookings: cancel or refund on the customer's behalf ----

router.post(
  '/bookings/:id/actions',
  requirePermission(P.BOOKINGS_MANAGE),
  validate({ body: { action: z.enum(['cancel', 'refund']), amountPaise: z.number().int().positive().optional(), reason } }),
  async (req, res) => {
    const booking = await Booking.findById(req.valid.params.id);
    if (!booking) throw notFound('Booking');
    const { action, amountPaise, reason: why } = req.valid.body;
    if (action === 'cancel') {
      if (!['pending', 'accepted'].includes(booking.status)) throw conflict(`Cannot cancel a booking that is ${booking.status}`);
      booking.status = 'cancelled';
      booking.statusHistory.push({ status: 'cancelled', action: 'admin_cancel', by: req.user._id, note: why });
    }
    // Cancelling a paid booking refunds it in full; "refund" alone can be partial (e.g. a dispute after the visit).
    const refundDue = booking.payment.status === 'paid' && (action === 'refund' || action === 'cancel');
    if (action === 'refund' && booking.payment.status !== 'paid') throw conflict(`Payment is ${booking.payment.status}; only a paid booking can be refunded`);
    if (refundDue) {
      const amount = action === 'refund' && amountPaise ? amountPaise : booking.payment.amountPaise;
      if (amount > booking.payment.amountPaise) throw badRequest('Refund cannot exceed the amount paid');
      const refund = await paymentGateway().refund({ paymentId: booking.payment.paymentId, amountPaise: amount, notes: { bookingId: String(booking._id), tenant: booking.tenant } });
      booking.payment.refundId = refund.refundId;
      booking.payment.status = refund.status === 'processed' ? 'refunded' : 'refund_pending';
      if (booking.payment.status === 'refunded') booking.payment.refundedAt = new Date();
      booking.statusHistory.push({ status: booking.status, action: 'admin_refund', by: req.user._id, note: `${why} (₹${(amount / 100).toFixed(2)})` });
    }
    await booking.save();
    await audit(req, `booking.admin_${action}`, { type: 'booking', id: booking._id }, { reason: why, meta: { amountPaise: refundDue ? amountPaise ?? booking.payment.amountPaise : undefined } });
    await notify([booking.user, booking.vendorOwner], {
      type: `booking.admin_${action}`,
      title: action === 'cancel' ? 'Booking cancelled by Nurvia support' : 'Refund issued by Nurvia support',
      body: `${booking.serviceSnapshot.name} · ${booking.code}`,
      data: { bookingId: String(booking._id) },
    });
    res.json(booking);
  },
);

// ---- Shop orders ----

router.get(
  '/shop/orders',
  requirePermission(P.ORDERS_READ),
  validate({ query: { ...pageQuery, status: z.enum(ORDER_STATUSES).optional(), code: z.string().trim().max(20).optional(), seller: objectId.optional(), user: objectId.optional() } }),
  async (req, res) => {
    const { page, limit, status, code, seller, user } = req.valid.query;
    const filter = { ...(status && { status }), ...(code && { code: code.toUpperCase() }), ...(seller && { 'items.seller': seller }), ...(user && { user }) };
    res.json(await paginate(ShopOrder, filter, { page, limit, select: '-statusHistory', populate: { path: 'user', select: 'name phone' } }));
  },
);

router.get('/shop/orders/:id', requirePermission(P.ORDERS_READ), validate(), async (req, res) => {
  const order = await ShopOrder.findById(req.valid.params.id).populate('user', 'name phone email').populate('items.seller', 'businessName').populate('statusHistory.by', 'name').lean();
  if (!order) throw notFound('Order');
  res.json(order);
});

router.post('/shop/orders/:id/cancel', requirePermission(P.ORDERS_MANAGE), validate({ body: { reason } }), async (req, res) => {
  const order = await ShopOrder.findById(req.valid.params.id);
  if (!order) throw notFound('Order');
  await cancelOrder(order, { by: req.user._id, reason: req.valid.body.reason });
  await audit(req, 'shop_order.admin_cancel', { type: 'shop_order', id: order._id }, { reason: req.valid.body.reason });
  await notify([order.user], { type: 'shop.order_cancelled', title: 'Your order was cancelled', body: `${order.code} · ${req.valid.body.reason}`, data: { orderId: String(order._id) } });
  res.json(order);
});

// ---- Coupons ----

const couponBody = {
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,20}$/),
  description: z.string().max(200).optional(),
  type: z.enum(['percent', 'flat']),
  value: z.number().int().min(1),
  minOrderPaise: z.number().int().min(0).optional(),
  maxDiscountPaise: z.number().int().min(1).optional(),
  active: z.boolean().optional(),
  expiresAt: z.coerce.date().optional(),
};
const checkCoupon = (c) => {
  if (c.type === 'percent' && c.value > 90) throw badRequest('A percentage coupon can be at most 90%');
};

router.get('/coupons', requirePermission(P.MARKETING_MANAGE), async (_req, res) => {
  res.json(await Coupon.find().sort({ active: -1, createdAt: -1 }).lean());
});

router.post('/coupons', requirePermission(P.MARKETING_MANAGE), validate({ body: couponBody }), async (req, res) => {
  checkCoupon(req.valid.body);
  if (await Coupon.exists({ code: req.valid.body.code })) throw conflict('That code is already in use');
  const coupon = await Coupon.create(req.valid.body);
  await audit(req, 'coupon.create', { type: 'coupon', id: coupon._id }, { meta: { code: coupon.code } });
  res.status(201).json(coupon);
});

router.patch(
  '/coupons/:id',
  requirePermission(P.MARKETING_MANAGE),
  validate({ body: { ...Object.fromEntries(Object.entries(couponBody).filter(([k]) => k !== 'code').map(([k, v]) => [k, v.optional()])) } }),
  async (req, res) => {
    const coupon = await Coupon.findById(req.valid.params.id);
    if (!coupon) throw notFound('Coupon');
    coupon.set(req.valid.body);
    checkCoupon(coupon);
    await coupon.save();
    await audit(req, 'coupon.update', { type: 'coupon', id: coupon._id }, { meta: { fields: Object.keys(req.valid.body) } });
    res.json(coupon);
  },
);

export default router;
