import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../common/auth.js';
import { conflict, notFound } from '../../common/errors.js';
import { paginate } from '../../common/paginate.js';
import { objectId, pageQuery, validate } from '../../common/validate.js';
import { Booking } from '../bookings/booking.model.js';
import { notify } from '../notifications/notify.js';
import { Vendor } from '../vendors/vendor.model.js';
import { Review } from './review.model.js';

const router = Router();

// Rating aggregates only count visible reviews, so they are recomputed whenever moderation changes one.
export async function refreshVendorRating(vendorId) {
  const [stats] = await Review.aggregate([
    { $match: { vendor: vendorId, status: 'visible' } },
    { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  await Vendor.updateOne({ _id: vendorId }, { ratingAvg: Math.round((stats?.avg ?? 0) * 10) / 10, ratingCount: stats?.count ?? 0 });
}

router.get('/', validate({ query: { ...pageQuery, vendor: objectId } }), async (req, res) => {
  const { page, limit, vendor } = req.valid.query;
  res.json(
    await paginate(Review, { vendor, status: 'visible' }, { page, limit, populate: { path: 'author', select: 'name avatarUrl' }, select: '-moderation -booking' }),
  );
});

// Only the customer of a completed booking can review it, once.
router.post(
  '/',
  authenticate,
  validate({ body: { bookingId: objectId, rating: z.number().int().min(1).max(5), text: z.string().trim().max(2000).optional() } }),
  async (req, res) => {
    const { bookingId, rating, text } = req.valid.body;
    const booking = await Booking.findOne({ _id: bookingId, user: req.user._id });
    if (!booking) throw notFound('Booking');
    if (booking.status !== 'completed') throw conflict('Only completed bookings can be reviewed');

    const review = await Review.create({ vendor: booking.vendor, booking: booking._id, author: req.user._id, rating, text });
    booking.reviewed = true;
    await booking.save();
    await refreshVendorRating(booking.vendor);
    await notify([booking.vendorOwner], { type: 'review.created', title: `New ${rating}★ review`, body: text?.slice(0, 100), data: { reviewId: String(review._id) } });
    res.status(201).json(review);
  },
);

router.post('/:id/reply', authenticate, validate({ body: { text: z.string().trim().min(1).max(1000) } }), async (req, res) => {
  const review = await Review.findOne({ _id: req.valid.params.id, status: 'visible' });
  if (!review) throw notFound('Review');
  if (!(await Vendor.exists({ _id: review.vendor, owner: req.user._id }))) throw notFound('Review');
  review.vendorReply = { text: req.valid.body.text, at: new Date() };
  res.json(await review.save());
});

export default router;
