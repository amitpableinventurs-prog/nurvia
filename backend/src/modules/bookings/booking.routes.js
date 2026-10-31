import { Router } from 'express';
import { z } from 'zod';
import { authenticate, can } from '../../common/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../../common/errors.js';
import { paginate } from '../../common/paginate.js';
import { PERMISSIONS } from '../../common/roles.js';
import { localToUtc } from '../../common/time.js';
import { objectId, pageQuery, validate } from '../../common/validate.js';
import { notify } from '../notifications/notify.js';
import { Pet } from '../pets/pet.model.js';
import { User } from '../users/user.model.js';
import { Vendor } from '../vendors/vendor.model.js';
import { ACTIVE_STATUSES, BOOKING_STATUSES, Booking, BookingMessage, SlotHold } from './booking.model.js';
import { BOOKING_ACTIONS, actorRole, applyAction, createBooking, holdSlot, holdView, quoteBooking } from './booking.service.js';
import { VENDOR_CARD_FIELDS, appointmentCard, appointmentDetails, calendarFile, petSummary, staffProfiles, vendorSummary } from './booking.views.js';

const router = Router();
router.use(authenticate);

// What the customer picked on the booking screens.
const selection = {
  vendorId: objectId,
  serviceId: objectId,
  addOnIds: z.array(objectId).max(20).optional(),
  petId: objectId,
  // Omit for "any available"; the vendor assigns someone.
  staffId: objectId.optional(),
  scheduledAt: z.coerce.date(),
};

// The booking summary screen: vendor, pet, price lines with add-ons, total time, whether the slot is
// still free, the cancellation policy, payment options and what sharing the passport would show.
router.post('/quote', validate({ body: selection }), async (req, res) => {
  const quote = await quoteBooking(req.user, req.valid.body);
  const { vendor, pet, staff } = quote.selection;
  const userLocation = (await User.findById(req.user._id).select('location').lean())?.location;
  res.json({
    vendor: vendorSummary(vendor, userLocation),
    pet: petSummary(pet),
    staff: staff ? (await staffProfiles(vendor._id, [staff]))[0] : null,
    scheduledAt: quote.scheduledAt,
    endsAt: quote.endsAt,
    slot: quote.slot,
    pricing: quote.pricing,
    paymentModes: quote.paymentModes,
    policy: quote.policy,
    passport: quote.passport,
  });
});

// "Securing your appointment": holds the slot for a few minutes. When it was just taken, `held` is
// false, the closest free time is held instead (`hold`) and nearby `alternatives` are listed.
router.post('/holds', validate({ body: selection }), async (req, res) => {
  const result = await holdSlot(req.user, req.valid.body);
  res.status(result.held ? 201 : 200).json(result);
});

router.get('/holds/:id', validate(), async (req, res) => {
  const hold = await SlotHold.findOne({ _id: req.valid.params.id, user: req.user._id, expiresAt: { $gt: new Date() } }).lean();
  if (!hold) throw notFound('Hold');
  res.json(holdView(hold));
});

router.delete('/holds/:id', validate(), async (req, res) => {
  await SlotHold.deleteOne({ _id: req.valid.params.id, user: req.user._id });
  res.status(204).end();
});

// "Confirm & Book": from a hold (holdId), or straight from a selection. A slot taken in the meantime
// answers 409 SLOT_TAKEN with nearby alternatives in error.details.
router.post(
  '/',
  validate({
    body: {
      holdId: objectId.optional(),
      ...Object.fromEntries(Object.entries(selection).map(([key, schema]) => [key, schema.optional()])),
      notes: z.string().max(1000).optional(),
      // Lets the vendor see the pet's vaccines, deworming, allergies and conditions around the visit.
      sharePassport: z.boolean().optional(),
      paymentMode: z.enum(['pay_at_provider', 'online']).optional(),
    },
  }),
  async (req, res) => {
    const { holdId, vendorId, serviceId, petId, scheduledAt } = req.valid.body;
    if (!holdId && !(vendorId && serviceId && petId && scheduledAt)) throw badRequest('Send a holdId, or vendorId, serviceId, petId and scheduledAt');
    res.status(201).json(await createBooking(req.user, req.valid.body));
  },
);

// as=user lists the caller's own bookings; as=vendor lists bookings made with the caller's business.
router.get(
  '/',
  validate({
    query: {
      ...pageQuery,
      as: z.enum(['user', 'vendor']).default('user'),
      status: z.enum(BOOKING_STATUSES).optional(),
      upcoming: z.enum(['true']).optional(),
      // A local calendar day (YYYY-MM-DD), for day-by-day schedules.
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      // as=vendor only: one customer's bookings with this business, for their visit history.
      customer: objectId.optional(),
      pet: objectId.optional(),
    },
  }),
  async (req, res) => {
    const { page, limit, as, status, upcoming, date, customer, pet } = req.valid.query;
    const dayStart = date && localToUtc(date);
    const filter = {
      [as === 'vendor' ? 'vendorOwner' : 'user']: req.user._id,
      ...(as === 'vendor' && customer && { user: customer }),
      ...(pet && { pet }),
      ...(status && { status }),
      ...(upcoming && { scheduledAt: { $gte: new Date() } }),
      ...(date && { scheduledAt: { $gte: dayStart, $lt: new Date(dayStart.getTime() + 86_400_000) } }),
    };
    const populate = as === 'vendor' ? [{ path: 'user', select: 'name phone' }, { path: 'pet', select: 'name species breed' }] : [{ path: 'vendor', select: 'businessName address location' }, { path: 'pet', select: 'name species' }];
    res.json(await paginate(Booking, filter, { page, limit, sort: { scheduledAt: upcoming || date ? 1 : -1 }, populate }));
  },
);

// The tabs on My Appointments. Past includes visits that ended without being marked complete.
const TABS = {
  upcoming: (now) => ({ status: { $in: ACTIVE_STATUSES }, endsAt: { $gte: now } }),
  past: (now) => ({ $or: [{ status: { $in: ['completed', 'no_show'] } }, { status: { $in: ACTIVE_STATUSES }, endsAt: { $lt: now } }] }),
  cancelled: () => ({ status: { $in: ['cancelled', 'rejected'] } }),
};
const PET_CARD_FIELDS = 'name species breed photo dateOfBirth approxAgeMonths weightKg';
const RECENT_COUNT = 3;

// My Appointments: one tab of cards with counts for every tab and per pet, plus recent history
// under the upcoming tab.
router.get(
  '/appointments',
  validate({ query: { ...pageQuery, tab: z.enum(Object.keys(TABS)).default('upcoming'), pet: objectId.optional() } }),
  async (req, res) => {
    const { page, limit, tab, pet } = req.valid.query;
    const now = new Date();
    const mine = { user: req.user._id };
    const petFilter = pet ? { pet } : {};
    const populate = [
      { path: 'vendor', model: Vendor, select: VENDOR_CARD_FIELDS },
      { path: 'pet', model: Pet, select: PET_CARD_FIELDS },
    ];
    const [result, counts, perPet, recent, me] = await Promise.all([
      paginate(Booking, { ...mine, ...petFilter, ...TABS[tab](now) }, { page, limit, sort: { scheduledAt: tab === 'upcoming' ? 1 : -1 }, populate }),
      Promise.all(Object.entries(TABS).map(async ([key, filterFor]) => [key, await Booking.countDocuments({ ...mine, ...petFilter, ...filterFor(now) })])),
      Booking.aggregate([{ $match: { ...mine, ...TABS[tab](now) } }, { $group: { _id: '$pet', count: { $sum: 1 } } }]),
      tab === 'upcoming'
        ? Booking.find({ ...mine, ...petFilter, ...TABS.past(now) }).sort({ scheduledAt: -1 }).limit(RECENT_COUNT).populate(populate).lean()
        : null,
      User.findById(req.user._id).select('location').lean(),
    ]);
    const pets = await Pet.find({ _id: { $in: perPet.map((p) => p._id) } }).select('name photo').lean();
    const countOf = new Map(perPet.map((p) => [String(p._id), p.count]));
    const cardOptions = { userLocation: me?.location, now };
    res.json({
      tab,
      counts: Object.fromEntries(counts),
      // The pet chips: bookings per pet in this tab.
      pets: pets.map((p) => ({ _id: p._id, name: p.name, photo: p.photo?.url ?? null, count: countOf.get(String(p._id)) ?? 0 })),
      ...result,
      items: result.items.map((b, i) => ({ ...appointmentCard(b, cardOptions), next: tab === 'upcoming' && page === 1 && i === 0 })),
      ...(recent && { recent: recent.map((b) => appointmentCard(b, cardOptions)) }),
    });
  },
);

async function visibleBooking(req) {
  const booking = await Booking.findById(req.valid.params.id);
  if (!booking) throw notFound('Booking');
  if (!actorRole(booking, req.user) && !can(req.user, PERMISSIONS.BOOKINGS_READ)) throw forbidden();
  return booking;
}

async function ownBooking(req) {
  const booking = await Booking.findOne({ _id: req.valid.params.id, user: req.user._id });
  if (!booking) throw notFound('Booking');
  return booking;
}

router.get('/:id', validate(), async (req, res) => {
  const booking = await visibleBooking(req);
  await booking.populate([
    { path: 'vendor', model: Vendor, select: 'businessName phone address location' },
    { path: 'user', select: 'name phone' },
    // What a vet or groomer needs before the visit. Health records stay private to the owner.
    { path: 'pet', select: 'name species breed photo sex dateOfBirth weightKg neutered allergies microchipId' },
    { path: 'statusHistory.by', select: 'name' },
  ]);
  res.json({ ...booking.toJSON(), customerEmergencyContact: await emergencyContactFor(booking, req.user) });
});

// The confirmation and appointment details screens (the customer's own booking).
router.get('/:id/details', validate(), async (req, res) => {
  const booking = await ownBooking(req);
  await booking.populate([
    { path: 'vendor', model: Vendor, select: VENDOR_CARD_FIELDS },
    { path: 'pet', model: Pet, select: `${PET_CARD_FIELDS} allergies conditions` },
    { path: 'assignedStaff', select: 'name role title experienceYears' },
  ]);
  const me = await User.findById(req.user._id).select('location').lean();
  res.json(await appointmentDetails(booking.toObject(), { userLocation: me?.location }));
});

// "Add to calendar" as an .ics file, for either side of the booking.
router.get('/:id/calendar.ics', validate(), async (req, res) => {
  const booking = await visibleBooking(req);
  await booking.populate([
    { path: 'vendor', model: Vendor, select: 'businessName address' },
    { path: 'pet', model: Pet, select: 'name' },
  ]);
  res.type('text/calendar; charset=utf-8').set('Content-Disposition', `attachment; filename="nurvia-${booking.code}.ics"`).send(calendarFile(booking));
});

// The owner turns passport sharing for this booking on or off.
router.put('/:id/passport-share', validate({ body: { enabled: z.boolean() } }), async (req, res) => {
  const booking = await ownBooking(req);
  if (!['pending', 'accepted'].includes(booking.status)) throw conflict(`Cannot change sharing on a booking that is ${booking.status}`);
  booking.sharePassport = req.valid.body.enabled;
  await booking.save();
  res.json({ sharePassport: booking.sharePassport });
});

// ---- Messages between the customer and the business ----

// Open from booking until a week after the visit.
const MESSAGES_OPEN_DAYS = 7;

router.get('/:id/messages', validate({ query: { after: z.coerce.date().optional() } }), async (req, res) => {
  const booking = await visibleBooking(req);
  const { after } = req.valid.query;
  const items = await BookingMessage.find({ booking: booking._id, ...(after && { createdAt: { $gt: after } }) })
    .sort({ createdAt: 1 })
    .limit(200)
    .select('side body createdAt sender')
    .lean();
  res.json({ items: items.map(({ sender, ...m }) => ({ ...m, mine: String(sender) === String(req.user._id) })) });
});

router.post('/:id/messages', validate({ body: { body: z.string().trim().min(1).max(2000) } }), async (req, res) => {
  const booking = await visibleBooking(req);
  const side = { user: 'customer', vendor: 'vendor' }[actorRole(booking, req.user)];
  if (!side) throw forbidden('Only the customer and the business can message about a booking');
  if (Date.now() > booking.endsAt.getTime() + MESSAGES_OPEN_DAYS * 86_400_000) throw conflict('Messages for this booking are closed');
  const message = await BookingMessage.create({ booking: booking._id, sender: req.user._id, side, body: req.valid.body.body });
  await notify([side === 'customer' ? booking.vendorOwner : booking.user], {
    type: 'booking.message',
    title: `New message about ${booking.code}`,
    body: message.body.slice(0, 140),
    data: { bookingId: String(booking._id) },
  });
  res.status(201).json({ _id: message._id, side, body: message.body, createdAt: message.createdAt, mine: true });
});

// Users are told their emergency contact is shared only with care providers during active
// appointments: the vendor sees it for an accepted booking, from a day before the visit until
// a day after it ends.
const EMERGENCY_WINDOW_MS = 86_400_000;
async function emergencyContactFor(booking, user) {
  if (actorRole(booking, user) !== 'vendor' || booking.status !== 'accepted') return null;
  const start = booking.scheduledAt.getTime() - EMERGENCY_WINDOW_MS;
  const end = booking.scheduledAt.getTime() + (booking.serviceSnapshot?.durationMin ?? 0) * 60_000 + EMERGENCY_WINDOW_MS;
  if (Date.now() < start || Date.now() > end) return null;
  const customer = await User.findById(booking.user._id ?? booking.user).select('emergencyContact').lean();
  return customer?.emergencyContact?.phone ? customer.emergencyContact : null;
}

// Customers reschedule (up to the free-change cutoff) and cancel; vendors do the rest.
router.post(
  '/:id/actions',
  validate({ body: { action: z.enum(BOOKING_ACTIONS), scheduledAt: z.coerce.date().optional(), reason: z.string().max(500).optional() } }),
  async (req, res) => {
    const booking = await visibleBooking(req);
    res.json(await applyAction(booking, req.user, req.valid.body));
  },
);

export default router;
