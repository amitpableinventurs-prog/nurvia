import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../common/auth.js';
import { notFound } from '../../common/errors.js';
import { paginate } from '../../common/paginate.js';
import { PERMISSIONS } from '../../common/roles.js';
import { objectId, pageQuery, validate } from '../../common/validate.js';
import { ACTIVE_STATUSES, BOOKING_STATUSES, Booking, PAYMENT_STATUSES, stateView } from '../bookings/booking.model.js';

const router = Router();
router.use(requirePermission(PERMISSIONS.BOOKINGS_READ));

router.get(
  '/',
  validate({
    query: {
      ...pageQuery,
      // A stored status, or "rescheduled" for active bookings whose time was changed.
      status: z.enum([...BOOKING_STATUSES, 'rescheduled']).optional(),
      paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
      vendor: objectId.optional(),
      user: objectId.optional(),
      code: z.string().trim().max(20).optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    },
  }),
  async (req, res) => {
    const { page, limit, status, paymentStatus, vendor, user, code, from, to } = req.valid.query;
    const filter = {
      ...(status && (status === 'rescheduled' ? { status: { $in: ACTIVE_STATUSES }, 'rescheduled.open': true } : { status })),
      ...(paymentStatus && { 'payment.status': paymentStatus }),
      ...(vendor && { vendor }),
      ...(user && { user }),
      ...(code && { code: code.toUpperCase() }),
      ...((from || to) && { scheduledAt: { ...(from && { $gte: from }), ...(to && { $lte: to }) } }),
    };
    const result = await paginate(Booking, filter, {
      page,
      limit,
      select: '-statusHistory',
      populate: [
        { path: 'user', select: 'name phone' },
        { path: 'vendor', select: 'businessName' },
        { path: 'pet', select: 'name species' },
      ],
    });
    res.json({ ...result, items: result.items.map((b) => ({ ...b, ...stateView(b) })) });
  },
);

router.get('/:id', validate(), async (req, res) => {
  const booking = await Booking.findById(req.valid.params.id)
    .populate([
      { path: 'user', select: 'name phone email' },
      { path: 'vendor', select: 'businessName phone address' },
      { path: 'pet', select: 'name species breed' },
      { path: 'statusHistory.by', select: 'name' },
    ])
    .lean();
  if (!booking) throw notFound('Booking');
  res.json(booking);
});

export default router;
