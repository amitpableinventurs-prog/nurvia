import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRoles } from '../../common/auth.js';
import { badRequest, notFound } from '../../common/errors.js';
import { paginate } from '../../common/paginate.js';
import { ROLES } from '../../common/roles.js';
import { localParts, localToUtc } from '../../common/time.js';
import mongoose from 'mongoose';
import { objectId, pageQuery, queryBool, validate } from '../../common/validate.js';
import { env } from '../../config/env.js';
import { Booking } from '../bookings/booking.model.js';
import { Review } from '../reviews/review.model.js';
import { Service, Vendor, licenseStatus } from './vendor.model.js';

// Read-only summaries for the vendor panel. Mounted at /vendors/me, next to the self-service
// profile, KYC and services endpoints in vendor.routes.js.
const router = Router();
const DAY = 86_400_000;

router.use(authenticate, requireRoles(ROLES.VENDOR), async (req, _res, next) => {
  req.vendor = await Vendor.findOne({ owner: req.user._id }).lean();
  if (!req.vendor) throw notFound('Vendor profile');
  next();
});

const CUSTOMER = [
  { path: 'user', select: 'name phone' },
  { path: 'pet', select: 'name species breed' },
];
const tz = () => {
  const m = env.utcOffsetMinutes;
  return `${m >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(m) / 60)).padStart(2, '0')}:${String(Math.abs(m) % 60).padStart(2, '0')}`;
};
const PAID = ['paid', 'refund_pending', 'refunded'];

// The approval state the panel watches, so an approval or a licence check shows without signing in again.
const vendorSummary = (vendor) => ({
  _id: vendor._id,
  businessName: vendor.businessName,
  status: vendor.status,
  statusReason: vendor.statusReason,
  kycStatus: vendor.kyc?.status,
  licenseStatus: licenseStatus(vendor.kyc ?? {}),
});

// The partner sidebar's badges, refreshed on every page change and once a minute: two indexed
// counts, where /dashboard runs about fifteen queries.
router.get('/badges', async (req, res) => {
  const vendor = req.vendor;
  const [pending, unreplied] = await Promise.all([
    Booking.countDocuments({ vendor: vendor._id, status: 'pending', scheduledAt: { $gte: new Date() } }),
    Review.countDocuments({ vendor: vendor._id, status: 'visible', 'vendorReply.text': { $exists: false } }),
  ]);
  res.json({ vendor: vendorSummary(vendor), pending: { count: pending }, reviews: { unreplied }, pause: vendor.pause?.active ? vendor.pause : null });
});

router.get('/dashboard', async (req, res) => {
  const vendor = req.vendor;
  const now = new Date();
  const today = localToUtc(localParts(now).date);
  const tomorrow = new Date(today.getTime() + DAY);
  const monthStart = localToUtc(`${localParts(now).date.slice(0, 7)}-01`);
  const since30 = new Date(now.getTime() - 30 * DAY);
  const mine = { vendor: vendor._id };

  const [todays, pending, pendingCount, upcomingWeek, money, outcomes, unreplied, recentReviews, activeServices, allTime, upcomingAll, customers] = await Promise.all([
    Booking.find({ ...mine, scheduledAt: { $gte: today, $lt: tomorrow }, status: { $in: ['pending', 'accepted', 'completed', 'no_show'] } })
      .sort({ scheduledAt: 1 }).populate(CUSTOMER).lean(),
    Booking.find({ ...mine, status: 'pending', scheduledAt: { $gte: now } }).sort({ scheduledAt: 1 }).limit(5).populate(CUSTOMER).lean(),
    Booking.countDocuments({ ...mine, status: 'pending', scheduledAt: { $gte: now } }),
    Booking.countDocuments({ ...mine, status: { $in: ['pending', 'accepted'] }, scheduledAt: { $gte: now, $lt: new Date(now.getTime() + 7 * DAY) } }),
    Booking.aggregate([
      { $match: { ...mine, 'payment.status': { $in: PAID }, 'payment.paidAt': { $gte: new Date(Math.min(monthStart, since30)) } } },
      {
        $group: {
          _id: null,
          monthPaise: { $sum: { $cond: [{ $and: [{ $gte: ['$payment.paidAt', monthStart] }, { $eq: ['$payment.status', 'paid'] }] }, '$payment.amountPaise', 0] } },
          last30Paise: { $sum: { $cond: [{ $and: [{ $gte: ['$payment.paidAt', since30] }, { $eq: ['$payment.status', 'paid'] }] }, '$payment.amountPaise', 0] } },
          refunded30Paise: { $sum: { $cond: [{ $and: [{ $gte: ['$payment.paidAt', since30] }, { $ne: ['$payment.status', 'paid'] }] }, '$payment.amountPaise', 0] } },
        },
      },
    ]),
    // How visits scheduled in the last 30 days ended, for the completion rate.
    Booking.aggregate([{ $match: { ...mine, scheduledAt: { $gte: since30, $lt: now } } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Review.countDocuments({ ...mine, status: 'visible', 'vendorReply.text': { $exists: false } }),
    Review.find({ ...mine, status: 'visible' }).sort({ createdAt: -1 }).limit(3).populate('author', 'name').select('-moderation').lean(),
    Service.countDocuments({ ...mine, active: true }),
    Booking.aggregate([{ $match: mine }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Booking.countDocuments({ ...mine, status: { $in: ['pending', 'accepted'] }, scheduledAt: { $gte: now } }),
    // Distinct customers who have booked at least once (any outcome).
    Booking.distinct('user', mine).then((ids) => ids.length),
  ]);
  const byStatus = Object.fromEntries(allTime.map((s) => [s._id, s.count]));

  const ended = Object.fromEntries(outcomes.map((o) => [o._id, o.count]));
  const finished = (ended.completed ?? 0) + (ended.no_show ?? 0) + (ended.cancelled ?? 0) + (ended.rejected ?? 0);
  const kyc = vendor.kyc ?? {};

  res.json({
    vendor: vendorSummary(vendor),
    today: {
      bookings: todays,
      inProgress: todays.filter((b) => b.status === 'accepted' && b.scheduledAt <= now && b.endsAt > now).length,
      remaining: todays.filter((b) => ['pending', 'accepted'].includes(b.status) && b.endsAt > now).length,
    },
    pending: { count: pendingCount, items: pending },
    upcomingWeek,
    counts: {
      upcoming: upcomingAll,
      completed: byStatus.completed ?? 0,
      cancelled: (byStatus.cancelled ?? 0) + (byStatus.rejected ?? 0),
      noShow: byStatus.no_show ?? 0,
      total: allTime.reduce((n, s) => n + s.count, 0),
    },
    customers,
    pause: vendor.pause?.active ? vendor.pause : null,
    nextTimeOff: (vendor.timeOff ?? []).filter((t) => t.to > now).sort((a, b) => a.from - b.from)[0] ?? null,
    earnings: { monthPaise: money[0]?.monthPaise ?? 0, last30Paise: money[0]?.last30Paise ?? 0, refunded30Paise: money[0]?.refunded30Paise ?? 0 },
    completionRate: finished ? Math.round(((ended.completed ?? 0) / finished) * 100) : null,
    reviews: { ratingAvg: vendor.ratingAvg, ratingCount: vendor.ratingCount, unreplied, recent: recentReviews },
    // What is still missing before customers can find and book the business.
    setup: {
      services: activeServices > 0,
      hours: (vendor.operatingHours ?? []).length > 0,
      photos: (vendor.photos ?? []).length > 0,
      kyc: ['submitted', 'approved'].includes(kyc.status),
      license: ['manual_review', 'verified'].includes(licenseStatus(kyc)),
    },
  });
});

// Online payments for the business by payment date, with a daily series for the chart.
router.get(
  '/earnings',
  validate({ query: { from: z.coerce.date().optional(), to: z.coerce.date().optional() } }),
  async (req, res) => {
    const to = req.valid.query.to ?? new Date();
    const from = req.valid.query.from ?? new Date(to.getTime() - 29 * DAY);
    if (from > to || to - from > 366 * DAY) throw badRequest('Choose a range of at most one year');
    const match = { vendor: req.vendor._id, 'payment.status': { $in: PAID }, 'payment.paidAt': { $gte: from, $lte: to } };

    const [daily, transactions] = await Promise.all([
      Booking.aggregate([
        { $match: match },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$payment.paidAt', timezone: tz() } },
            grossPaise: { $sum: '$payment.amountPaise' },
            refundedPaise: { $sum: { $cond: [{ $eq: ['$payment.status', 'paid'] }, 0, '$payment.amountPaise'] } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Booking.find(match).sort({ 'payment.paidAt': -1 }).limit(200).populate('user', 'name').select('code status serviceSnapshot.name payment scheduledAt user').lean(),
    ]);
    const sum = (key) => daily.reduce((n, d) => n + d[key], 0);
    res.json({
      from,
      to,
      totals: { grossPaise: sum('grossPaise'), refundedPaise: sum('refundedPaise'), netPaise: sum('grossPaise') - sum('refundedPaise'), count: sum('count') },
      daily: daily.map((d) => ({ date: d._id, grossPaise: d.grossPaise, refundedPaise: d.refundedPaise, count: d.count })),
      transactions: transactions.map((b) => ({
        _id: b._id,
        code: b.code,
        service: b.serviceSnapshot?.name,
        customer: b.user?.name ?? null,
        scheduledAt: b.scheduledAt,
        bookingStatus: b.status,
        paymentStatus: b.payment.status,
        amountPaise: b.payment.amountPaise,
        paidAt: b.payment.paidAt,
        refundedAt: b.payment.refundedAt,
      })),
      truncated: transactions.length === 200,
    });
  },
);

// ---- Availability: blocked dates/times and pausing new bookings ----

const MAX_BLOCKS = 100;
const blockingBookings = (vendorId, from, to) =>
  Booking.find({ vendor: vendorId, status: { $in: ['pending', 'accepted'] }, scheduledAt: { $lt: to ?? new Date(8.64e15) }, endsAt: { $gt: from } })
    .sort({ scheduledAt: 1 })
    .populate(CUSTOMER)
    .select('code status scheduledAt endsAt serviceSnapshot.name user pet')
    .lean();

router.get('/time-off', async (req, res) => {
  const now = new Date();
  res.json({ timeOff: (req.vendor.timeOff ?? []).filter((t) => t.to > now).sort((a, b) => a.from - b.from), pause: req.vendor.pause ?? { active: false } });
});

// Adding a block never cancels existing bookings: they come back as `conflicts` so the vendor can
// reschedule or cancel each one and the customer is told.
router.post(
  '/time-off',
  validate({ body: { from: z.coerce.date(), to: z.coerce.date(), reason: z.string().trim().max(200).optional() } }),
  async (req, res) => {
    const { from, to, reason } = req.valid.body;
    const now = new Date();
    if (to <= from) throw badRequest('The block must end after it starts');
    if (to <= now) throw badRequest('The block is already over');
    if (to - from > 366 * DAY) throw badRequest('Block at most a year at a time');
    const current = (req.vendor.timeOff ?? []).filter((t) => t.to > now);
    if (current.length >= MAX_BLOCKS) throw badRequest(`Remove some of your ${MAX_BLOCKS} blocks first`);
    const block = { _id: new mongoose.Types.ObjectId(), from, to, reason };
    // Past blocks are dropped as new ones are added, so the list stays short.
    await Vendor.updateOne({ _id: req.vendor._id }, { $set: { timeOff: [...current, block] } });
    res.status(201).json({ block, conflicts: await blockingBookings(req.vendor._id, from, to) });
  },
);

router.delete('/time-off/:blockId', validate({ params: { blockId: objectId } }), async (req, res) => {
  const result = await Vendor.updateOne({ _id: req.vendor._id }, { $pull: { timeOff: { _id: req.valid.params.blockId } } });
  if (!result.modifiedCount) throw notFound('Blocked time');
  res.status(204).end();
});

router.put(
  '/pause',
  validate({ body: { active: z.boolean(), until: z.coerce.date().optional(), reason: z.string().trim().max(200).optional() } }),
  async (req, res) => {
    const { active, until, reason } = req.valid.body;
    if (active && until && until <= new Date()) throw badRequest('Pick a date in the future');
    const pause = active ? { active, until, reason, since: new Date() } : { active: false };
    await Vendor.updateOne({ _id: req.vendor._id }, { $set: { pause } });
    res.json({ pause, conflicts: active ? await blockingBookings(req.vendor._id, new Date(), until) : [] });
  },
);

// The review inbox: everything customers wrote, optionally only what still needs a reply.
router.get('/reviews', validate({ query: { ...pageQuery, unreplied: queryBool.optional() } }), async (req, res) => {
  const { page, limit, unreplied } = req.valid.query;
  const filter = { vendor: req.vendor._id, status: 'visible', ...(unreplied && { 'vendorReply.text': { $exists: false } }) };
  res.json(await paginate(Review, filter, { page, limit, populate: { path: 'author', select: 'name' }, select: '-moderation' }));
});

export default router;
