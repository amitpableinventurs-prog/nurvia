import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../common/auth.js';
import { badRequest } from '../../common/errors.js';
import { PERMISSIONS } from '../../common/roles.js';
import { validate } from '../../common/validate.js';
import { env } from '../../config/env.js';
import { AdoptionListing } from '../adoption/adoption.model.js';
import { Booking } from '../bookings/booking.model.js';
import { Post } from '../community/community.model.js';
import { CommunityDog } from '../community-dogs/community-dog.model.js';
import { Pet } from '../pets/pet.model.js';
import { Report } from '../reports/report.model.js';
import { User } from '../users/user.model.js';
import { SearchLog, Vendor } from '../vendors/vendor.model.js';

const router = Router();
// Mounted at the admin root alongside other routers, so permissions are applied per route.
const analytics = requirePermission(PERMISSIONS.ANALYTICS_READ);

function startOfLocalDay() {
  const offset = env.utcOffsetMinutes * 60_000;
  const local = new Date(Date.now() + offset);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - offset);
}

// The admin sidebar's queue badges, refreshed on every page change: three indexed counts, where
// /dashboard runs a dozen counts and three aggregations over whole collections.
router.get('/badges', analytics, async (_req, res) => {
  const [awaitingApproval, awaitingReview, open] = await Promise.all([
    Vendor.countDocuments({ status: 'pending', 'kyc.status': 'submitted' }),
    AdoptionListing.countDocuments({ status: 'pending_review' }),
    Report.countDocuments({ status: 'open' }),
  ]);
  res.json({ vendors: { awaitingApproval }, adoption: { awaitingReview }, reports: { open } });
});

router.get('/dashboard', analytics, async (_req, res) => {
  const today = startOfLocalDay();
  const [
    users, newUsersToday, pets, vendorsActive, vendorApprovals, bookingsTotal, bookingsToday, bookingsPending,
    communityDogs, adoptionOpen, adoptionReview, posts, openReports,
  ] = await Promise.all([
    User.countDocuments({ status: { $ne: 'deleted' } }),
    User.countDocuments({ createdAt: { $gte: today } }),
    Pet.countDocuments({ archivedAt: null }),
    Vendor.countDocuments({ status: 'active' }),
    Vendor.countDocuments({ status: 'pending', 'kyc.status': 'submitted' }),
    Booking.countDocuments(),
    Booking.countDocuments({ createdAt: { $gte: today } }),
    Booking.countDocuments({ status: 'pending' }),
    CommunityDog.countDocuments({ status: 'visible' }),
    AdoptionListing.countDocuments({ status: 'open' }),
    AdoptionListing.countDocuments({ status: 'pending_review' }),
    Post.countDocuments({ status: 'visible' }),
    Report.countDocuments({ status: 'open' }),
  ]);

  const since30 = new Date(Date.now() - 30 * 86_400_000);
  const [byStatus, money, topVendors] = await Promise.all([
    Booking.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Booking.aggregate([
      { $match: { 'payment.status': { $in: ['paid', 'refunded', 'refund_pending'] } } },
      {
        $group: {
          _id: null,
          paidPaise: { $sum: { $cond: [{ $eq: ['$payment.status', 'paid'] }, '$payment.amountPaise', 0] } },
          refundedPaise: { $sum: { $cond: [{ $ne: ['$payment.status', 'paid'] }, '$payment.amountPaise', 0] } },
          paidCount: { $sum: { $cond: [{ $eq: ['$payment.status', 'paid'] }, 1, 0] } },
        },
      },
    ]),
    // Busiest vendors over the last 30 days, by bookings that were not rejected or cancelled.
    Booking.aggregate([
      { $match: { createdAt: { $gte: since30 }, status: { $nin: ['rejected', 'cancelled'] } } },
      { $group: { _id: '$vendor', bookings: { $sum: 1 }, gmvPaise: { $sum: '$serviceSnapshot.pricePaise' } } },
      { $sort: { bookings: -1, gmvPaise: -1 } },
      { $limit: 5 },
      { $lookup: { from: 'vendors', localField: '_id', foreignField: '_id', as: 'vendor', pipeline: [{ $project: { businessName: 1, ratingAvg: 1, ratingCount: 1 } }] } },
      { $unwind: '$vendor' },
    ]),
  ]);
  res.json({
    users: { total: users, today: newUsersToday },
    pets,
    vendors: { active: vendorsActive, awaitingApproval: vendorApprovals },
    bookings: { total: bookingsTotal, today: bookingsToday, pending: bookingsPending },
    communityDogs,
    adoption: { open: adoptionOpen, awaitingReview: adoptionReview },
    posts,
    reports: { open: openReports },
    bookingStatus: Object.fromEntries(byStatus.map((r) => [r._id, r.count])),
    payments: { paidPaise: money[0]?.paidPaise ?? 0, refundedPaise: money[0]?.refundedPaise ?? 0, paidCount: money[0]?.paidCount ?? 0 },
    topVendors: topVendors.map((t) => ({ _id: t._id, businessName: t.vendor.businessName, ratingAvg: t.vendor.ratingAvg, ratingCount: t.vendor.ratingCount, bookings: t.bookings, gmvPaise: t.gmvPaise })),
  });
});

const SERIES = {
  registrations: User,
  pets: Pet,
  vendors: Vendor,
  searches: SearchLog,
  bookings: Booking,
  communityDogs: CommunityDog,
  adoptionListings: AdoptionListing,
};

// Daily counts per metric between two local dates (inclusive), for the analytics charts.
router.get(
  '/analytics',
  analytics,
  validate({ query: { from: z.coerce.date().optional(), to: z.coerce.date().optional() } }),
  async (req, res) => {
    const to = req.valid.query.to ?? new Date();
    const from = req.valid.query.from ?? new Date(to.getTime() - 29 * 86_400_000);
    if (from > to || to - from > 366 * 86_400_000) throw badRequest('Choose a range of at most one year');

    const tz = `${env.utcOffsetMinutes >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(env.utcOffsetMinutes) / 60)).padStart(2, '0')}:${String(Math.abs(env.utcOffsetMinutes) % 60).padStart(2, '0')}`;
    const entries = await Promise.all(
      Object.entries(SERIES).map(async ([name, model]) => {
        const rows = await model.aggregate([
          { $match: { createdAt: { $gte: from, $lte: to } } },
          { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: tz } }, count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ]);
        return [name, rows.map((r) => ({ date: r._id, count: r.count }))];
      }),
    );
    // Online payments collected per day (by payment date), in paise.
    const revenue = await Booking.aggregate([
      { $match: { 'payment.paidAt': { $gte: from, $lte: to }, 'payment.status': { $in: ['paid', 'refunded', 'refund_pending'] } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$payment.paidAt', timezone: tz } }, amountPaise: { $sum: '$payment.amountPaise' } } },
      { $sort: { _id: 1 } },
    ]);
    res.json({ from, to, series: Object.fromEntries(entries), revenue: revenue.map((r) => ({ date: r._id, amountPaise: r.amountPaise })) });
  },
);

export default router;
