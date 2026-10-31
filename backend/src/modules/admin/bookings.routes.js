import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../common/auth.js';
import { notFound } from '../../common/errors.js';
import { paginate } from '../../common/paginate.js';
import { PERMISSIONS } from '../../common/roles.js';
import { objectId, pageQuery, validate } from '../../common/validate.js';
import { BOOKING_STATUSES, Booking, PAYMENT_STATUSES } from '../bookings/booking.model.js';

const router = Router();
router.use(requirePermission(PERMISSIONS.BOOKINGS_READ));

router.get(
  '/',
  validate({
    query: {
      ...pageQuery,
      status: z.enum(BOOKING_STATUSES).optional(),
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
      ...(status && { status }),
      ...(paymentStatus && { 'payment.status': paymentStatus }),
      ...(vendor && { vendor }),
      ...(user && { user }),
      ...(code && { code: code.toUpperCase() }),
      ...((from || to) && { scheduledAt: { ...(from && { $gte: from }), ...(to && { $lte: to }) } }),
    };
    res.json(
      await paginate(Booking, filter, {
        page,
        limit,
        select: '-statusHistory',
        populate: [
          { path: 'user', select: 'name phone' },
          { path: 'vendor', select: 'businessName' },
          { path: 'pet', select: 'name species' },
        ],
      }),
    );
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
