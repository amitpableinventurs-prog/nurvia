import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { authenticate } from '../../common/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../../common/errors.js';
import { paginate } from '../../common/paginate.js';
import { ROLES } from '../../common/roles.js';
import { sendCsv } from '../../common/csv.js';
import { addMinutes, localParts } from '../../common/time.js';
import { escapeRegex, objectId, pageQuery, partialShape, validate } from '../../common/validate.js';
import { Booking } from '../bookings/booking.model.js';
import { bookingIdFromCheckIn, checkIn, passportShare } from '../bookings/booking.service.js';
import { careStatus, careUpToDate } from '../pets/care.js';
import { staffCommitments } from '../vendors/availability.js';
import { attachmentsFor } from '../files/file.routes.js';
import { notify } from '../notifications/notify.js';
import { HealthRecord, Pet, Reminder } from '../pets/pet.model.js';
import { User } from '../users/user.model.js';
import { Service, Vendor } from '../vendors/vendor.model.js';
import {
  APPOINTMENT_STATUSES,
  Appointment,
  CAPABILITIES,
  CUSTOMER_SOURCES,
  CrmNote,
  CustomerPackage,
  ROLE_CAPABILITIES,
  RecordShare,
  STAFF_ROLES,
  ServicePackage,
  VISIT_KINDS,
  VendorCustomer,
  VendorStaff,
  VisitReport,
  WaitlistEntry,
} from './operations.model.js';
import { assertWithinPlan, requirePlanFeature } from '../plans/plan.routes.js';
import { recordVisit, requireCapability, vendorWorkspace } from './operations.service.js';

// The vendor's business workspace (Phase 2 vendor SaaS), mounted at /vendors/me. The business owner
// and active staff members both use it; each route checks the caller's role capability.
const router = Router();
const PATHS = ['/workspace', '/staff', '/customers', '/notes', '/follow-ups', '/appointments', '/calendar', '/waitlist', '/packages', '/visits', '/reports', '/bookings'];
router.use(PATHS, ...vendorWorkspace);

// Plan features (plans/plan.model.js). Without one, what the business already has stays readable,
// but nothing new can be added; follow-ups are a CRM screen in themselves.
const planGate = (feature, { reads = false } = {}) => {
  const check = requirePlanFeature(feature);
  return (req, res, next) => (req.method === 'GET' && !reads ? next() : check(req, res, next));
};
router.use('/visits', planGate('visit_records'));
router.use('/packages', planGate('packages'));
router.use('/notes', planGate('crm'));
router.use('/follow-ups', planGate('crm', { reads: true }));

const can = (capability) => requireCapability(capability);
const phone = z.string().transform((s) => s.replace(/[\s-]/g, '')).pipe(z.string().regex(/^\+91[6-9]\d{9}$/, 'Phone must be +91XXXXXXXXXX'));
const dateRange = { from: z.coerce.date(), to: z.coerce.date() };
const MAX_RANGE_DAYS = 62;

async function own(Model, id, req, what) {
  const doc = await Model.findOne({ _id: id, vendor: req.vendor._id });
  if (!doc) throw notFound(what);
  return doc;
}

function checkRange({ from, to }) {
  if (to <= from) throw badRequest('"to" must be after "from"');
  if (to - from > MAX_RANGE_DAYS * 86_400_000) throw badRequest(`Ask for at most ${MAX_RANGE_DAYS} days at a time`);
}

// ---- Workspace ----

router.get('/workspace', async (req, res) => {
  res.json({
    vendor: { _id: req.vendor._id, businessName: req.vendor.businessName, status: req.vendor.status, categories: req.vendor.categories },
    role: req.staff?.role ?? 'owner',
    staff: req.staff,
    capabilities: [...req.capabilities],
  });
});

// ---- Staff ----

const staffBody = {
  name: z.string().trim().min(1).max(120),
  phone,
  email: z.string().email().optional(),
  role: z.enum(STAFF_ROLES.filter((r) => r !== 'owner')),
  extraCapabilities: z.array(z.enum(CAPABILITIES)).max(CAPABILITIES.length).optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  title: z.string().trim().max(60).optional(),
  experienceYears: z.number().int().min(0).max(60).optional(),
  bookable: z.boolean().optional(),
};

router.get('/staff', can('calendar.read'), async (req, res) => {
  const staff = await VendorStaff.find({ vendor: req.vendor._id }).sort({ active: -1, name: 1 }).lean();
  res.json(staff.map((s) => ({ ...s, capabilities: [...new Set([...(ROLE_CAPABILITIES[s.role] ?? []), ...(s.extraCapabilities ?? [])])] })));
});

// Staff sign in with their own mobile number. Adding someone creates their Nurvia account if needed.
router.post('/staff', can('staff.manage'), validate({ body: staffBody }), async (req, res) => {
  const body = req.valid.body;
  let user = await User.findOne({ phone: body.phone });
  if (String(user?._id) === String(req.vendor.owner)) throw badRequest('The business owner already has full access');
  if (user && (await VendorStaff.exists({ user: user._id, active: true, vendor: { $ne: req.vendor._id } }))) {
    throw conflict('This person is already active staff at another business');
  }
  user ??= await User.create({ phone: body.phone, name: body.name, email: body.email });
  await User.updateOne({ _id: user._id }, { $addToSet: { roles: ROLES.VENDOR_STAFF } });
  const existing = await VendorStaff.findOne({ vendor: req.vendor._id, user: user._id });
  if (existing?.active) throw conflict('This person is already on your team');
  await assertWithinPlan(req.vendor, 'staff');
  const staff = existing ?? new VendorStaff({ vendor: req.vendor._id, user: user._id });
  staff.set({ ...body, active: true });
  await staff.save();
  await notify([user._id], {
    type: 'staff.added',
    title: `You were added to ${req.vendor.businessName}`,
    body: `Sign in to the Nurvia partner app with ${body.phone} to see your schedule.`,
    data: { vendorId: String(req.vendor._id) },
  });
  res.status(201).json(staff);
});

router.patch(
  '/staff/:id',
  can('staff.manage'),
  validate({ body: { ...partialShape(staffBody), phone: z.never().optional(), active: z.boolean().optional() } }),
  async (req, res) => {
    const staff = await own(VendorStaff, req.valid.params.id, req, 'Staff member');
    if (req.valid.body.active && !staff.active) await assertWithinPlan(req.vendor, 'staff');
    staff.set(req.valid.body);
    res.json(await staff.save());
  },
);

// Staff are deactivated rather than deleted: past appointments and visit records name them.
router.delete('/staff/:id', can('staff.manage'), validate(), async (req, res) => {
  const staff = await own(VendorStaff, req.valid.params.id, req, 'Staff member');
  if (String(staff.user) === String(req.user._id)) throw badRequest('You cannot remove yourself');
  staff.active = false;
  await staff.save();
  res.status(204).end();
});

// ---- Customers (CRM) ----

const customerPetBody = z.object({
  name: z.string().trim().min(1).max(60),
  species: z.string().max(20).optional(),
  breed: z.string().max(80).optional(),
  sex: z.enum(['male', 'female', 'unknown']).optional(),
  notes: z.string().max(1000).optional(),
});
const customerBody = {
  name: z.string().trim().min(1).max(120),
  phone: phone.optional(),
  email: z.string().email().optional(),
  source: z.enum(CUSTOMER_SOURCES.filter((s) => s !== 'nurvia')).optional(),
  pets: z.array(customerPetBody).max(20).optional(),
  tags: z.array(z.string().trim().toLowerCase().max(40)).max(20).optional(),
  notes: z.string().max(2000).optional(),
};

router.get(
  '/customers',
  can('customers.read'),
  validate({ query: { ...pageQuery, q: z.string().trim().max(80).optional(), source: z.enum(CUSTOMER_SOURCES).optional(), tag: z.string().max(40).optional() } }),
  async (req, res) => {
    const { page, limit, q, source, tag } = req.valid.query;
    const rx = q && new RegExp(escapeRegex(q), 'i');
    const filter = {
      vendor: req.vendor._id,
      archivedAt: null,
      ...(source && { source }),
      ...(tag && { tags: tag.toLowerCase() }),
      ...(rx && { $or: [{ name: rx }, { phone: rx }, { 'pets.name': rx }] }),
    };
    res.json(await paginate(VendorCustomer, filter, { page, limit, sort: { lastVisitAt: -1, createdAt: -1 } }));
  },
);

router.post('/customers', can('customers.manage'), validate({ body: customerBody }), async (req, res) => {
  const body = req.valid.body;
  if (body.phone && (await VendorCustomer.exists({ vendor: req.vendor._id, phone: body.phone }))) throw conflict('A customer with this phone number already exists');
  await assertWithinPlan(req.vendor, 'customers');
  res.status(201).json(await VendorCustomer.create({ ...body, vendor: req.vendor._id }));
});

// One customer with everything this business knows about them.
router.get('/customers/:id', can('customers.read'), validate(), async (req, res) => {
  const customer = await own(VendorCustomer, req.valid.params.id, req, 'Customer');
  const [appointments, bookings, notes, packages, visits] = await Promise.all([
    Appointment.find({ vendor: req.vendor._id, customer: customer._id }).sort({ scheduledAt: -1 }).limit(50).lean(),
    customer.user
      ? Booking.find({ vendor: req.vendor._id, user: customer.user }).sort({ scheduledAt: -1 }).limit(50).select('code status scheduledAt serviceSnapshot pet payment.status').lean()
      : [],
    CrmNote.find({ vendor: req.vendor._id, customer: customer._id }).sort({ createdAt: -1 }).limit(50).populate('author', 'name').lean(),
    CustomerPackage.find({ vendor: req.vendor._id, customer: customer._id }).sort({ purchasedAt: -1 }).lean(),
    VisitReport.find({ vendor: req.vendor._id, customer: customer._id }).sort({ createdAt: -1 }).limit(50).select('kind status summary createdAt petName').lean(),
  ]);
  res.json({ ...customer.toJSON(), appointments, bookings, notes, packages, visits });
});

router.patch('/customers/:id', can('customers.manage'), validate({ body: partialShape(customerBody) }), async (req, res) => {
  const customer = await own(VendorCustomer, req.valid.params.id, req, 'Customer');
  const { pets, ...fields } = req.valid.body;
  if (pets) throw badRequest('Use /customers/:id/pets to change pets');
  // Nurvia customers' contact details come from their account.
  if (customer.source === 'nurvia') delete fields.phone;
  customer.set(fields);
  res.json(await customer.save());
});

router.delete('/customers/:id', can('customers.manage'), validate(), async (req, res) => {
  const customer = await own(VendorCustomer, req.valid.params.id, req, 'Customer');
  customer.archivedAt = new Date();
  await customer.save();
  res.status(204).end();
});

router.post('/customers/:id/pets', can('customers.manage'), validate({ body: customerPetBody.shape }), async (req, res) => {
  const customer = await own(VendorCustomer, req.valid.params.id, req, 'Customer');
  customer.pets.push(req.valid.body);
  await customer.save();
  res.status(201).json(customer.pets.at(-1));
});

router.patch(
  '/customers/:id/pets/:petId',
  can('customers.manage'),
  validate({ params: { petId: objectId }, body: partialShape(customerPetBody.shape) }),
  async (req, res) => {
    const customer = await own(VendorCustomer, req.valid.params.id, req, 'Customer');
    const pet = customer.pets.id(req.valid.params.petId);
    if (!pet) throw notFound('Pet');
    pet.set(req.valid.body);
    await customer.save();
    res.json(pet);
  },
);

// ---- Notes and follow-ups ----

const noteBody = { text: z.string().trim().min(1).max(2000), petId: objectId.optional(), followUpAt: z.coerce.date().optional() };

router.post('/customers/:id/notes', can('customers.read'), requirePlanFeature('crm'), validate({ body: noteBody }), async (req, res) => {
  const customer = await own(VendorCustomer, req.valid.params.id, req, 'Customer');
  res.status(201).json(await CrmNote.create({ ...req.valid.body, vendor: req.vendor._id, customer: customer._id, author: req.user._id }));
});

router.patch(
  '/notes/:id',
  can('customers.read'),
  validate({ body: { ...partialShape(noteBody), done: z.boolean().optional() } }),
  async (req, res) => {
    const note = await own(CrmNote, req.valid.params.id, req, 'Note');
    const { done, ...fields } = req.valid.body;
    note.set(fields);
    if (done !== undefined) note.doneAt = done ? new Date() : undefined;
    res.json(await note.save());
  },
);

router.get('/follow-ups', can('customers.read'), validate({ query: { days: z.coerce.number().int().min(0).max(90).default(7) } }), async (req, res) => {
  const until = new Date(Date.now() + req.valid.query.days * 86_400_000);
  res.json(
    await CrmNote.find({ vendor: req.vendor._id, doneAt: null, followUpAt: { $ne: null, $lte: until } })
      .sort({ followUpAt: 1 })
      .limit(200)
      .populate('customer', 'name phone pets')
      .lean(),
  );
});

// ---- Appointments ----

// Includes slots customers are holding for this person while they confirm.
async function assertStaffFree(req, staffId, start, end, excludeId) {
  if (!staffId) return;
  if ((await staffCommitments(req.vendor._id, staffId, start, end, excludeId)).length) throw conflict('That staff member is already booked at this time');
}

async function activeStaff(req, staffId) {
  if (!staffId) return undefined;
  if (!(await VendorStaff.exists({ _id: staffId, vendor: req.vendor._id, active: true }))) throw badRequest('Unknown staff member');
  return staffId;
}

const appointmentBody = {
  customerId: objectId,
  petId: objectId.optional(),
  serviceId: objectId.optional(),
  serviceName: z.string().trim().max(120).optional(),
  pricePaise: z.number().int().min(0).max(10_000_000).optional(),
  scheduledAt: z.coerce.date(),
  durationMin: z.number().int().min(5).max(24 * 60).optional(),
  staffId: objectId.optional(),
  customerPackageId: objectId.optional(),
  paidOffline: z.boolean().optional(),
  notes: z.string().max(1000).optional(),
  recurrence: z.object({ rule: z.enum(['weekly', 'fortnightly', 'monthly']), count: z.number().int().min(2).max(52) }).optional(),
};

function nextOccurrence(date, rule, n) {
  const d = new Date(date);
  if (rule === 'weekly') d.setUTCDate(d.getUTCDate() + 7 * n);
  if (rule === 'fortnightly') d.setUTCDate(d.getUTCDate() + 14 * n);
  if (rule === 'monthly') d.setUTCMonth(d.getUTCMonth() + n);
  return d;
}

router.get(
  '/appointments',
  can('calendar.read'),
  validate({ query: { ...dateRange, staffId: objectId.optional(), status: z.enum(APPOINTMENT_STATUSES).optional(), customerId: objectId.optional() } }),
  async (req, res) => {
    const { from, to, staffId, status, customerId } = req.valid.query;
    checkRange({ from, to });
    const filter = { vendor: req.vendor._id, scheduledAt: { $gte: from, $lt: to }, ...(staffId && { staff: staffId }), ...(status && { status }), ...(customerId && { customer: customerId }) };
    res.json(await Appointment.find(filter).sort({ scheduledAt: 1 }).populate('customer', 'name phone').populate('staff', 'name role color').lean());
  },
);

router.post('/appointments', can('bookings.manage'), validate({ body: appointmentBody }), async (req, res) => {
  const { customerId, petId, serviceId, durationMin, staffId, customerPackageId, recurrence, ...body } = req.valid.body;
  const customer = await own(VendorCustomer, customerId, req, 'Customer');
  const pet = petId ? customer.pets.id(petId) : customer.pets[0];
  if (petId && !pet) throw badRequest('That pet is not on this customer record');
  const service = serviceId ? await Service.findOne({ _id: serviceId, vendor: req.vendor._id }).lean() : null;
  if (serviceId && !service) throw badRequest('Unknown service');
  const serviceName = body.serviceName ?? service?.name;
  if (!serviceName) throw badRequest('Give a serviceId or a serviceName');
  const minutes = durationMin ?? service?.durationMin ?? 30;
  if (customerPackageId && !(await CustomerPackage.exists({ _id: customerPackageId, vendor: req.vendor._id, customer: customer._id }))) {
    throw badRequest('That package does not belong to this customer');
  }
  const staff = await activeStaff(req, staffId);

  const seriesId = recurrence ? new mongoose.Types.ObjectId() : undefined;
  const starts = recurrence ? Array.from({ length: recurrence.count }, (_, n) => nextOccurrence(body.scheduledAt, recurrence.rule, n)) : [body.scheduledAt];
  for (const start of starts) await assertStaffFree(req, staff, start, addMinutes(start, minutes));

  const created = await Appointment.create(
    starts.map((start) => ({
      ...body,
      vendor: req.vendor._id,
      customer: customer._id,
      petId: pet?._id,
      petName: pet?.name,
      service: service?._id,
      serviceName,
      pricePaise: body.pricePaise ?? service?.pricePaise ?? 0,
      scheduledAt: start,
      endsAt: addMinutes(start, minutes),
      staff,
      customerPackage: customerPackageId,
      seriesId,
      recurrence,
      createdBy: req.user._id,
      statusHistory: [{ status: 'scheduled', by: req.user._id }],
    })),
  );
  res.status(201).json(recurrence ? created : created[0]);
});

router.patch(
  '/appointments/:id',
  can('bookings.manage'),
  validate({
    body: {
      scheduledAt: z.coerce.date().optional(),
      durationMin: z.number().int().min(5).max(24 * 60).optional(),
      staffId: objectId.nullable().optional(),
      pricePaise: z.number().int().min(0).max(10_000_000).optional(),
      paidOffline: z.boolean().optional(),
      notes: z.string().max(1000).optional(),
    },
  }),
  async (req, res) => {
    const appointment = await own(Appointment, req.valid.params.id, req, 'Appointment');
    if (['completed', 'cancelled', 'no_show'].includes(appointment.status)) throw conflict(`This appointment is ${appointment.status}`);
    const { scheduledAt, durationMin, staffId, ...fields } = req.valid.body;
    const start = scheduledAt ?? appointment.scheduledAt;
    const minutes = durationMin ?? (appointment.endsAt - appointment.scheduledAt) / 60_000;
    const staff = staffId === undefined ? appointment.staff : staffId === null ? undefined : await activeStaff(req, staffId);
    await assertStaffFree(req, staff, start, addMinutes(start, minutes), appointment._id);
    appointment.set({ ...fields, scheduledAt: start, endsAt: addMinutes(start, minutes), staff: staff ?? null });
    res.json(await appointment.save());
  },
);

const APPOINTMENT_FLOW = {
  confirmed: ['scheduled'],
  checked_in: ['scheduled', 'confirmed'],
  completed: ['scheduled', 'confirmed', 'checked_in'],
  cancelled: ['scheduled', 'confirmed'],
  no_show: ['scheduled', 'confirmed'],
};

router.post(
  '/appointments/:id/status',
  can('calendar.read'),
  validate({ body: { status: z.enum(Object.keys(APPOINTMENT_FLOW)), note: z.string().max(300).optional(), series: z.boolean().optional() } }),
  async (req, res) => {
    const { status, note, series } = req.valid.body;
    // Care staff can move their own appointments along; changing other people's needs bookings.manage.
    const appointment = await own(Appointment, req.valid.params.id, req, 'Appointment');
    const mine = req.staff && String(appointment.staff) === String(req.staff._id);
    if (!req.capabilities.has('bookings.manage') && !mine) throw forbidden('You can only update your own appointments');
    if (!APPOINTMENT_FLOW[status].includes(appointment.status)) throw conflict(`Cannot mark a ${appointment.status} appointment as ${status}`);

    if (series && status === 'cancelled' && appointment.seriesId) {
      const result = await Appointment.updateMany(
        { vendor: req.vendor._id, seriesId: appointment.seriesId, scheduledAt: { $gte: appointment.scheduledAt }, status: { $in: APPOINTMENT_FLOW.cancelled } },
        { status: 'cancelled', $push: { statusHistory: { status: 'cancelled', by: req.user._id, note, at: new Date() } } },
      );
      return res.json({ cancelled: result.modifiedCount });
    }

    if (status === 'completed' && appointment.customerPackage) {
      const used = await CustomerPackage.findOneAndUpdate(
        { _id: appointment.customerPackage, $expr: { $lt: ['$sessionsUsed', '$sessionsTotal'] }, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] },
        { $inc: { sessionsUsed: 1 } },
        { new: true },
      );
      if (!used) throw conflict('The customer package has no sessions left or has expired');
    }
    appointment.status = status;
    appointment.statusHistory.push({ status, by: req.user._id, note });
    await appointment.save();
    if (status === 'completed') await recordVisit(appointment.customer, appointment.scheduledAt);
    res.json(appointment);
  },
);

// ---- Calendar: Nurvia bookings and the vendor's own appointments together ----

router.get('/calendar', can('calendar.read'), validate({ query: { ...dateRange, staffId: objectId.optional() } }), async (req, res) => {
  const { from, to, staffId } = req.valid.query;
  checkRange({ from, to });
  const window = { vendor: req.vendor._id, scheduledAt: { $gte: from, $lt: to } };
  const [bookings, appointments] = await Promise.all([
    Booking.find({ ...window, status: { $in: ['pending', 'accepted', 'completed', 'no_show'] }, ...(staffId && { assignedStaff: staffId }) })
      .populate('user', 'name phone')
      .populate('pet', 'name species breed')
      .populate('assignedStaff', 'name role color')
      .lean(),
    Appointment.find({ ...window, status: { $ne: 'cancelled' }, ...(staffId && { staff: staffId }) })
      .populate('customer', 'name phone')
      .populate('staff', 'name role color')
      .lean(),
  ]);
  const items = [
    ...bookings.map((b) => ({
      source: 'nurvia', id: b._id, code: b.code, status: b.status, start: b.scheduledAt, end: b.endsAt,
      title: b.serviceSnapshot?.name, customer: b.user, pet: b.pet, staff: b.assignedStaff ?? null, paymentStatus: b.payment?.status,
    })),
    ...appointments.map((a) => ({
      source: 'vendor', id: a._id, status: a.status, start: a.scheduledAt, end: a.endsAt,
      title: a.serviceName, customer: a.customer, pet: a.petName ? { name: a.petName } : null, staff: a.staff ?? null, seriesId: a.seriesId ?? null,
    })),
  ].sort((a, b) => a.start - b.start);
  res.json({ from, to, items });
});

router.put('/bookings/:id/staff', can('bookings.manage'), validate({ body: { staffId: objectId.nullable() } }), async (req, res) => {
  const booking = await Booking.findOne({ _id: req.valid.params.id, vendor: req.vendor._id });
  if (!booking) throw notFound('Booking');
  const staff = req.valid.body.staffId ? await activeStaff(req, req.valid.body.staffId) : undefined;
  await assertStaffFree(req, staff, booking.scheduledAt, booking.endsAt, booking._id);
  booking.assignedStaff = staff ?? null;
  await booking.save();
  res.json({ _id: booking._id, assignedStaff: booking.assignedStaff });
});

// The front desk scans the customer's QR code ("Express pass"), or types the booking code.
router.post(
  '/bookings/check-in',
  can('bookings.manage'),
  validate({ body: { token: z.string().max(200).optional(), code: z.string().trim().toUpperCase().max(20).optional() } }),
  async (req, res) => {
    const { token, code } = req.valid.body;
    if (!token === !code) throw badRequest('Send the scanned token or the booking code');
    const booking = await Booking.findOne({ vendor: req.vendor._id, ...(token ? { _id: bookingIdFromCheckIn(token) } : { code }) });
    if (!booking) throw notFound('Booking');
    await checkIn(booking, req.user);
    await booking.populate([{ path: 'pet', select: 'name species breed' }, { path: 'user', select: 'name' }]);
    res.json({ _id: booking._id, code: booking.code, status: booking.status, checkedInAt: booking.checkedInAt, scheduledAt: booking.scheduledAt, service: booking.serviceSnapshot.name, pet: booking.pet, customer: booking.user });
  },
);

// The pet's passport, when the owner shared it with this booking: from a day before the visit until
// a day after. Vaccines, deworming, allergies, conditions and handling notes; never other records.
router.get('/bookings/:id/passport', can('customers.read'), validate(), async (req, res) => {
  const booking = await Booking.findOne({ _id: req.valid.params.id, vendor: req.vendor._id }).lean();
  if (!booking) throw notFound('Booking');
  const share = passportShare(booking);
  if (!share.shared) throw forbidden('The owner has not shared the passport for this booking');
  if (!share.active) throw forbidden('The shared passport is only available from a day before the visit until a day after');
  const pet = await Pet.findById(booking.pet).lean();
  if (!pet) throw notFound('Pet');
  const { reminders: _private, ...care } = await careStatus(pet, { withReminders: false });
  res.json({
    ...care,
    pet: { _id: pet._id, name: pet.name, species: pet.species, breed: pet.breed, sex: pet.sex, dateOfBirth: pet.dateOfBirth, weightKg: pet.weightKg, neutered: pet.neutered, microchipId: pet.microchipId },
    behaviour: pet.behaviour ?? null,
    emergencyNotes: pet.emergencyNotes ?? null,
    instructions: booking.notes ?? null,
    upToDate: careUpToDate(care),
    sharedUntil: share.until,
  });
});

// ---- Waitlist ----

router.get('/waitlist', can('calendar.read'), validate({ query: { status: z.enum(['waiting', 'offered', 'booked', 'removed']).default('waiting') } }), async (req, res) => {
  res.json(await WaitlistEntry.find({ vendor: req.vendor._id, status: req.valid.query.status }).sort({ createdAt: 1 }).populate('customer', 'name phone').populate('service', 'name').lean());
});

router.post(
  '/waitlist',
  can('bookings.manage'),
  validate({
    body: {
      customerId: objectId,
      petId: objectId.optional(),
      serviceId: objectId.optional(),
      preferredFrom: z.coerce.date().optional(),
      preferredTo: z.coerce.date().optional(),
      note: z.string().max(500).optional(),
    },
  }),
  async (req, res) => {
    const { customerId, serviceId, ...body } = req.valid.body;
    await own(VendorCustomer, customerId, req, 'Customer');
    if (serviceId && !(await Service.exists({ _id: serviceId, vendor: req.vendor._id }))) throw badRequest('Unknown service');
    res.status(201).json(await WaitlistEntry.create({ ...body, vendor: req.vendor._id, customer: customerId, service: serviceId }));
  },
);

router.patch(
  '/waitlist/:id',
  can('bookings.manage'),
  validate({ body: { status: z.enum(['waiting', 'offered', 'booked', 'removed']), appointmentId: objectId.optional(), note: z.string().max(500).optional() } }),
  async (req, res) => {
    const entry = await own(WaitlistEntry, req.valid.params.id, req, 'Waitlist entry');
    const { appointmentId, ...fields } = req.valid.body;
    if (appointmentId) await own(Appointment, appointmentId, req, 'Appointment');
    entry.set({ ...fields, ...(appointmentId && { appointment: appointmentId }) });
    res.json(await entry.save());
  },
);

// ---- Packages ----

const packageBody = {
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).optional(),
  serviceIds: z.array(objectId).max(20).optional(),
  sessions: z.number().int().min(1).max(365),
  pricePaise: z.number().int().min(0).max(100_000_000),
  validityDays: z.number().int().min(1).max(1095).optional(),
  active: z.boolean().optional(),
};

async function packageFields(req, { serviceIds, ...body }) {
  if (serviceIds) {
    const count = await Service.countDocuments({ _id: { $in: serviceIds }, vendor: req.vendor._id });
    if (count !== new Set(serviceIds).size) throw badRequest('Unknown service in package');
  }
  return { ...body, ...(serviceIds && { services: serviceIds }) };
}

router.get('/packages', can('calendar.read'), async (req, res) => {
  res.json(await ServicePackage.find({ vendor: req.vendor._id }).sort({ active: -1, createdAt: -1 }).populate('services', 'name').lean());
});

router.post('/packages', can('services.manage'), validate({ body: packageBody }), async (req, res) => {
  res.status(201).json(await ServicePackage.create({ ...(await packageFields(req, req.valid.body)), vendor: req.vendor._id }));
});

router.patch('/packages/:id', can('services.manage'), validate({ body: partialShape(packageBody) }), async (req, res) => {
  const pkg = await own(ServicePackage, req.valid.params.id, req, 'Package');
  pkg.set(await packageFields(req, req.valid.body));
  res.json(await pkg.save());
});

router.post('/customers/:id/packages', can('bookings.manage'), requirePlanFeature('packages'), validate({ body: { packageId: objectId, paidOffline: z.boolean().optional() } }), async (req, res) => {
  const customer = await own(VendorCustomer, req.valid.params.id, req, 'Customer');
  const pkg = await ServicePackage.findOne({ _id: req.valid.body.packageId, vendor: req.vendor._id, active: true });
  if (!pkg) throw notFound('Package');
  const now = new Date();
  res.status(201).json(
    await CustomerPackage.create({
      vendor: req.vendor._id,
      customer: customer._id,
      package: pkg._id,
      name: pkg.name,
      sessionsTotal: pkg.sessions,
      pricePaise: pkg.pricePaise,
      purchasedAt: now,
      expiresAt: pkg.validityDays ? new Date(now.getTime() + pkg.validityDays * 86_400_000) : undefined,
      paidOffline: req.valid.body.paidOffline ?? true,
    }),
  );
});

// ---- Visit records per business type ----

const at = z.coerce.date();
const VISIT_DATA = {
  vet: z.object({
    complaint: z.string().max(1000).optional(),
    diagnosis: z.string().max(1000).optional(),
    medicalNotes: z.string().max(4000).optional(),
    weightKg: z.number().min(0).max(200).optional(),
    temperatureC: z.number().min(30).max(45).optional(),
    prescriptions: z
      .array(z.object({ drug: z.string().max(120), dose: z.string().max(60).optional(), frequency: z.string().max(60).optional(), durationDays: z.number().int().min(1).max(365).optional(), instructions: z.string().max(300).optional() }))
      .max(20)
      .optional(),
    vaccinationsGiven: z.array(z.object({ name: z.string().max(120), batch: z.string().max(60).optional(), nextDueDate: at.optional() })).max(10).optional(),
    followUpAt: at.optional(),
  }),
  grooming: z.object({
    notes: z.string().max(2000).optional(),
    addOns: z.array(z.string().max(80)).max(20).optional(),
    coatCondition: z.string().max(200).optional(),
    skinIssues: z.string().max(500).optional(),
    behaviour: z.string().max(500).optional(),
  }),
  boarding: z.object({
    room: z.string().max(60).optional(),
    checkInAt: at.optional(),
    checkOutAt: at.optional(),
    feedingInstructions: z.string().max(1000).optional(),
    medicineInstructions: z.string().max(1000).optional(),
    emergencyContact: z.object({ name: z.string().max(120).optional(), phone: z.string().max(20).optional() }).optional(),
    belongings: z.string().max(500).optional(),
  }),
  walk: z.object({
    pickupAddress: z.string().max(300).optional(),
    dropAddress: z.string().max(300).optional(),
    distanceKm: z.number().min(0).max(100).optional(),
    activityReport: z.string().max(2000).optional(),
    pee: z.boolean().optional(),
    poop: z.boolean().optional(),
    // Route points are only accepted when the owner has agreed to share the route for this walk.
    routeConsent: z.boolean().optional(),
  }),
  training: z.object({
    sessionNumber: z.number().int().min(1).max(1000).optional(),
    goals: z.array(z.string().max(200)).max(20).optional(),
    progressNotes: z.string().max(2000).optional(),
    behaviourNotes: z.string().max(2000).optional(),
    homework: z.string().max(1000).optional(),
    nextSessionAt: at.optional(),
  }),
  other: z.object({ notes: z.string().max(4000).optional() }),
};
const toJsonData = (data) => JSON.parse(JSON.stringify(data));

const visitBody = {
  kind: z.enum(VISIT_KINDS),
  bookingId: objectId.optional(),
  appointmentId: objectId.optional(),
  customerId: objectId.optional(),
  petId: objectId.optional(), // a pet on the customer record
  staffId: objectId.optional(),
  summary: z.string().trim().max(300).optional(),
  data: z.record(z.unknown()).optional(),
  attachmentFileIds: z.array(objectId).max(10).optional(),
};

// Works out who the visit is for from a Nurvia booking, a vendor appointment, or a CRM customer.
async function visitSubject(req, { bookingId, appointmentId, customerId, petId }) {
  if (bookingId) {
    const booking = await Booking.findOne({ _id: bookingId, vendor: req.vendor._id }).populate('pet', 'name').lean();
    if (!booking) throw notFound('Booking');
    const customer = await VendorCustomer.findOne({ vendor: req.vendor._id, user: booking.user }).select('_id').lean();
    return { booking: booking._id, pet: booking.pet._id, petOwner: booking.user, petName: booking.pet.name, customer: customer?._id };
  }
  const appointment = appointmentId ? await own(Appointment, appointmentId, req, 'Appointment') : null;
  const customer = await own(VendorCustomer, customerId ?? appointment?.customer, req, 'Customer');
  const pet = customer.pets.id(petId ?? appointment?.petId) ?? (petId ? null : customer.pets[0]);
  if (petId && !pet) throw badRequest('That pet is not on this customer record');
  return { appointment: appointment?._id, customer: customer._id, pet: pet?.pet, petOwner: pet?.pet ? customer.user : undefined, petName: pet?.name };
}

function parseData(kind, data, current = {}) {
  const result = VISIT_DATA[kind].strict().safeParse({ ...current, ...data });
  if (!result.success) throw badRequest('Invalid visit details', result.error.issues);
  return toJsonData(result.data);
}

router.get(
  '/visits',
  can('customers.read'),
  validate({ query: { ...pageQuery, kind: z.enum(VISIT_KINDS).optional(), customerId: objectId.optional(), status: z.enum(['draft', 'in_progress', 'completed']).optional() } }),
  async (req, res) => {
    const { page, limit, kind, customerId, status } = req.valid.query;
    const filter = { vendor: req.vendor._id, ...(kind && { kind }), ...(customerId && { customer: customerId }), ...(status && { status }) };
    res.json(await paginate(VisitReport, filter, { page, limit, populate: [{ path: 'staff', select: 'name role' }, { path: 'customer', select: 'name phone' }] }));
  },
);

router.post('/visits', can('visits.write'), validate({ body: visitBody }), async (req, res) => {
  const { kind, staffId, data = {}, attachmentFileIds, ...rest } = req.valid.body;
  const subject = await visitSubject(req, rest);
  const visit = await VisitReport.create({
    vendor: req.vendor._id,
    kind,
    ...subject,
    staff: (await activeStaff(req, staffId)) ?? req.staff?._id,
    summary: rest.summary,
    data: parseData(kind, data),
    attachments: await attachmentsFor(req.user._id, attachmentFileIds, ['visit_report', 'health_record']),
    createdBy: req.user._id,
  });
  res.status(201).json(visit);
});

router.get('/visits/:id', can('customers.read'), validate(), async (req, res) => {
  const visit = await own(VisitReport, req.valid.params.id, req, 'Visit');
  await visit.populate([{ path: 'staff', select: 'name role' }, { path: 'customer', select: 'name phone' }]);
  res.json(visit);
});

router.patch(
  '/visits/:id',
  can('visits.write'),
  validate({ body: { summary: z.string().trim().max(300).optional(), data: z.record(z.unknown()).optional(), staffId: objectId.optional(), attachmentFileIds: z.array(objectId).max(10).optional() } }),
  async (req, res) => {
    const visit = await own(VisitReport, req.valid.params.id, req, 'Visit');
    const { data, staffId, attachmentFileIds, summary } = req.valid.body;
    if (summary !== undefined) visit.summary = summary;
    if (data) visit.data = parseData(visit.kind, data, visit.data);
    if (staffId) visit.staff = await activeStaff(req, staffId);
    if (attachmentFileIds) visit.attachments = await attachmentsFor(req.user._id, attachmentFileIds, ['visit_report', 'health_record']);
    res.json(await visit.save());
  },
);

// Before/after photos for grooming, or any photo taken during a visit.
router.post(
  '/visits/:id/photos',
  can('visits.write'),
  validate({ body: { stage: z.enum(['before', 'after', 'during']), fileIds: z.array(objectId).min(1).max(10) } }),
  async (req, res) => {
    const visit = await own(VisitReport, req.valid.params.id, req, 'Visit');
    const files = await attachmentsFor(req.user._id, req.valid.body.fileIds, ['visit_report']);
    visit.photos.push(...files.map((f) => ({ stage: req.valid.body.stage, file: f.file, url: f.url })));
    res.json(await visit.save());
  },
);

const ownerNotice = (visit, title, body) =>
  visit.petOwner && notify([visit.petOwner], { type: `visit.${visit.kind}`, title, body, data: { visitId: String(visit._id), petId: visit.pet && String(visit.pet) } });

// A boarding daily update or any progress note. Sharing with the owner pushes it to them.
router.post(
  '/visits/:id/updates',
  can('visits.write'),
  validate({ body: { note: z.string().trim().min(1).max(1000), photoFileIds: z.array(objectId).max(5).optional(), notifyOwner: z.boolean().optional() } }),
  async (req, res) => {
    const visit = await own(VisitReport, req.valid.params.id, req, 'Visit');
    const photos = await attachmentsFor(req.user._id, req.valid.body.photoFileIds, ['visit_report']);
    visit.updates.push({ by: req.user._id, note: req.valid.body.note, photos: photos.map((p) => ({ file: p.file, url: p.url })) });
    if (visit.status === 'draft') visit.status = 'in_progress';
    if (req.valid.body.notifyOwner) {
      visit.sharedWithOwner = true;
      visit.sharedAt ??= new Date();
    }
    await visit.save();
    if (req.valid.body.notifyOwner) await ownerNotice(visit, `Update on ${visit.petName ?? 'your pet'} from ${req.vendor.businessName}`, req.valid.body.note.slice(0, 140));
    res.status(201).json(visit.updates.at(-1));
  },
);

// Walks (and boarding stays) are started and ended; the duration comes from the two times.
router.post('/visits/:id/start', can('visits.write'), validate(), async (req, res) => {
  const visit = await own(VisitReport, req.valid.params.id, req, 'Visit');
  if (visit.startedAt) throw conflict('Already started');
  visit.startedAt = new Date();
  visit.status = 'in_progress';
  if (visit.kind === 'boarding') visit.data = { ...visit.data, checkInAt: visit.startedAt };
  await visit.save();
  await ownerNotice(visit, visit.kind === 'walk' ? `${visit.petName ?? 'Your pet'}'s walk has started` : `${visit.petName ?? 'Your pet'} has checked in`, req.vendor.businessName);
  res.json(visit);
});

router.post('/visits/:id/end', can('visits.write'), validate(), async (req, res) => {
  const visit = await own(VisitReport, req.valid.params.id, req, 'Visit');
  if (!visit.startedAt) throw conflict('Start the visit first');
  if (visit.endedAt) throw conflict('Already ended');
  visit.endedAt = new Date();
  visit.data = {
    ...visit.data,
    durationMin: Math.round((visit.endedAt - visit.startedAt) / 60_000),
    ...(visit.kind === 'boarding' && { checkOutAt: visit.endedAt }),
  };
  await visit.save();
  await ownerNotice(visit, visit.kind === 'walk' ? `${visit.petName ?? 'Your pet'}'s walk is done (${visit.data.durationMin} min)` : `${visit.petName ?? 'Your pet'} is ready`, req.vendor.businessName);
  res.json(visit);
});

router.post(
  '/visits/:id/route',
  can('visits.write'),
  validate({ body: { points: z.array(z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), at: z.coerce.date() })).min(1).max(500) } }),
  async (req, res) => {
    const visit = await own(VisitReport, req.valid.params.id, req, 'Visit');
    if (visit.kind !== 'walk') throw badRequest('Routes are only recorded for walks');
    if (!visit.data?.routeConsent) throw forbidden('The owner has not agreed to share the route for this walk');
    if (!visit.startedAt || visit.endedAt) throw conflict('Routes can only be recorded while the walk is in progress');
    visit.route.push(...req.valid.body.points.map((p) => ({ at: p.at, location: { type: 'Point', coordinates: [p.lng, p.lat] } })));
    await visit.save();
    res.json({ points: visit.route.length });
  },
);

router.post('/visits/:id/complete', can('visits.write'), validate(), async (req, res) => {
  const visit = await own(VisitReport, req.valid.params.id, req, 'Visit');
  visit.status = 'completed';
  if (visit.startedAt && !visit.endedAt) visit.endedAt = new Date();
  res.json(await visit.save());
});

// Shares the visit report with the pet's owner. A vet visit is also offered to the pet's passport,
// which only receives it when the owner accepts (approved record sync).
router.post('/visits/:id/share', can('visits.write'), validate(), async (req, res) => {
  const visit = await own(VisitReport, req.valid.params.id, req, 'Visit');
  if (!visit.pet || !visit.petOwner) throw badRequest('This pet has no Nurvia passport to share with');
  visit.sharedWithOwner = true;
  visit.sharedAt ??= new Date();
  await visit.save();

  let share = null;
  if (visit.kind === 'vet' && !(await RecordShare.exists({ visit: visit._id }))) {
    const d = visit.data ?? {};
    share = await RecordShare.create({
      vendor: req.vendor._id,
      visit: visit._id,
      pet: visit.pet,
      owner: visit.petOwner,
      record: {
        type: d.prescriptions?.length ? 'prescription' : 'vet_visit',
        title: visit.summary || d.diagnosis || `Visit at ${req.vendor.businessName}`,
        date: visit.endedAt ?? visit.createdAt,
        nextDueDate: d.followUpAt,
        details: toJsonData({ diagnosis: d.diagnosis, complaint: d.complaint, weightKg: d.weightKg, prescriptions: d.prescriptions, vaccinationsGiven: d.vaccinationsGiven }),
        notes: d.medicalNotes,
        attachments: visit.attachments,
      },
    });
  }
  await ownerNotice(
    visit,
    share ? `${req.vendor.businessName} sent a record for ${visit.petName}` : `Visit report for ${visit.petName} from ${req.vendor.businessName}`,
    share ? 'Review it and add it to the pet passport.' : visit.summary,
  );
  res.json({ visit, recordShare: share });
});

// ---- Reports ----

const MAX_REPORT_DAYS = 366;
const MAX_REPORT_ROWS = 20_000;
const OPEN_STATUSES = ['pending', 'accepted', 'scheduled', 'confirmed', 'checked_in'];

function checkReportRange({ from, to }) {
  if (to <= from) throw badRequest('"to" must be after "from"');
  if (to - from > MAX_REPORT_DAYS * 86_400_000) throw badRequest(`Ask for at most ${MAX_REPORT_DAYS} days at a time`);
}

// Every Nurvia booking and own appointment scheduled in the range, as one list. A customer is the
// Nurvia account when there is one, so a pet parent who books online and also as a walk-in counts once.
async function visitRows(vendorId, from, to) {
  const window = { vendor: vendorId, scheduledAt: { $gte: from, $lt: to } };
  const [bookings, appointments] = await Promise.all([
    Booking.find(window)
      .sort({ scheduledAt: 1 })
      .limit(MAX_REPORT_ROWS)
      .select('code user pet serviceSnapshot scheduledAt status assignedStaff payment.status')
      .populate('user', 'name phone')
      .populate('pet', 'name')
      .populate('assignedStaff', 'name')
      .lean(),
    Appointment.find(window)
      .sort({ scheduledAt: 1 })
      .limit(MAX_REPORT_ROWS)
      .select('customer petName serviceName pricePaise scheduledAt status staff customerPackage paidOffline')
      .populate('customer', 'name phone user')
      .populate('staff', 'name')
      .lean(),
  ]);
  const rows = [
    ...bookings.map((b) => ({
      source: 'nurvia',
      reference: b.code,
      at: b.scheduledAt,
      status: b.status,
      customerKey: b.user ? `u:${b.user._id}` : `b:${b._id}`,
      customer: b.user?.name || 'Nurvia customer',
      phone: b.user?.phone,
      pet: b.pet?.name,
      service: b.serviceSnapshot?.name || 'Service',
      staff: b.assignedStaff?.name,
      valuePaise: b.serviceSnapshot?.pricePaise ?? 0,
      payment: b.payment?.status,
    })),
    ...appointments.map((a) => ({
      source: 'own',
      reference: '',
      at: a.scheduledAt,
      status: a.status,
      customerKey: a.customer?.user ? `u:${a.customer.user}` : `c:${a.customer?._id ?? a._id}`,
      customer: a.customer?.name || 'Customer',
      phone: a.customer?.phone,
      pet: a.petName,
      service: a.serviceName,
      staff: a.staff?.name,
      // Sessions from a package were paid for when the package was sold.
      valuePaise: a.customerPackage ? 0 : a.pricePaise ?? 0,
      payment: a.customerPackage ? 'package' : a.paidOffline ? 'paid_offline' : '',
    })),
  ].sort((x, y) => x.at - y.at);
  return { rows, truncated: bookings.length === MAX_REPORT_ROWS || appointments.length === MAX_REPORT_ROWS };
}

const pct = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);

// Bookings, revenue, top services, repeat customers and no-shows from the rows above.
function reportInsights(rows, packagesPaise) {
  const completed = rows.filter((r) => r.status === 'completed');
  const noShows = rows.filter((r) => r.status === 'no_show');
  const services = new Map();
  const customers = new Map();
  for (const r of completed) {
    const s = services.get(r.service) ?? { name: r.service, count: 0, valuePaise: 0, nurvia: 0, own: 0 };
    s.count++;
    s.valuePaise += r.valuePaise;
    s[r.source]++;
    services.set(r.service, s);
    const c = customers.get(r.customerKey) ?? { name: r.customer, phone: r.phone, visits: 0, valuePaise: 0, firstAt: r.at, lastAt: r.at };
    c.visits++;
    c.valuePaise += r.valuePaise;
    c.lastAt = r.at;
    customers.set(r.customerKey, c);
  }
  const noShowCounts = new Map();
  for (const r of noShows) noShowCounts.set(r.customerKey, (noShowCounts.get(r.customerKey) ?? 0) + 1);
  const customerList = [...customers.entries()].map(([key, c]) => ({ ...c, noShows: noShowCounts.get(key) ?? 0 })).sort((a, b) => b.visits - a.visits || b.valuePaise - a.valuePaise);
  const repeat = customerList.filter((c) => c.visits >= 2);
  const visitsPaise = completed.reduce((sum, r) => sum + r.valuePaise, 0);
  return {
    summary: {
      bookings: rows.length,
      completed: completed.length,
      cancelled: rows.filter((r) => r.status === 'cancelled' || r.status === 'rejected').length,
      noShows: noShows.length,
      upcoming: rows.filter((r) => OPEN_STATUSES.includes(r.status)).length,
    },
    revenue: { visitsPaise, packagesPaise, totalPaise: visitsPaise + packagesPaise },
    services: [...services.values()].sort((a, b) => b.count - a.count || b.valuePaise - a.valuePaise),
    customers: customerList,
    repeat,
    noShows,
    rates: { repeatPct: pct(repeat.length, customerList.length), noShowPct: pct(noShows.length, completed.length + noShows.length) },
  };
}

// Revenue is the value of completed visits plus packages sold; online payments are listed separately.
router.get('/reports', can('reports.read'), validate({ query: dateRange }), async (req, res) => {
  const { from, to } = req.valid.query;
  checkReportRange({ from, to });
  const vendor = req.vendor._id;
  const inRange = { vendor, scheduledAt: { $gte: from, $lt: to } };
  const [bookingsByStatus, bookingRevenue, bookingsByService, appointmentsByStatus, appointmentRevenue, byStaff, packageSales, newCustomers] = await Promise.all([
    Booking.aggregate([{ $match: inRange }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Booking.aggregate([
      { $match: { vendor, 'payment.status': 'paid', 'payment.paidAt': { $gte: from, $lt: to } } },
      { $group: { _id: null, paise: { $sum: '$payment.amountPaise' }, count: { $sum: 1 } } },
    ]),
    Booking.aggregate([
      { $match: { ...inRange, status: 'completed' } },
      { $group: { _id: '$serviceSnapshot.name', count: { $sum: 1 }, valuePaise: { $sum: '$serviceSnapshot.pricePaise' } } },
      { $sort: { count: -1 } },
    ]),
    Appointment.aggregate([{ $match: inRange }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Appointment.aggregate([{ $match: { ...inRange, status: 'completed' } }, { $group: { _id: null, paise: { $sum: '$pricePaise' }, count: { $sum: 1 } } }]),
    Appointment.aggregate([
      { $match: { ...inRange, status: 'completed', staff: { $ne: null } } },
      { $group: { _id: '$staff', completed: { $sum: 1 }, valuePaise: { $sum: '$pricePaise' } } },
      { $lookup: { from: 'vendorstaffs', localField: '_id', foreignField: '_id', as: 'staff', pipeline: [{ $project: { name: 1, role: 1 } }] } },
      { $unwind: '$staff' },
    ]),
    CustomerPackage.aggregate([{ $match: { vendor, purchasedAt: { $gte: from, $lt: to } } }, { $group: { _id: null, count: { $sum: 1 }, paise: { $sum: '$pricePaise' } } }]),
    VendorCustomer.aggregate([{ $match: { vendor, createdAt: { $gte: from, $lt: to } } }, { $group: { _id: '$source', count: { $sum: 1 } } }]),
  ]);
  const { rows, truncated } = await visitRows(vendor, from, to);
  const insight = reportInsights(rows, packageSales[0]?.paise ?? 0);
  const toMap = (rows) => Object.fromEntries(rows.map((r) => [r._id, r.count]));
  res.json({
    from,
    to,
    nurviaBookings: { byStatus: toMap(bookingsByStatus), paidOnlinePaise: bookingRevenue[0]?.paise ?? 0, paidOnlineCount: bookingRevenue[0]?.count ?? 0, completedByService: bookingsByService },
    appointments: { byStatus: toMap(appointmentsByStatus), completedValuePaise: appointmentRevenue[0]?.paise ?? 0, completedCount: appointmentRevenue[0]?.count ?? 0 },
    byStaff: byStaff.map((r) => ({ staff: r.staff, completed: r.completed, valuePaise: r.valuePaise })),
    packages: { sold: packageSales[0]?.count ?? 0, valuePaise: packageSales[0]?.paise ?? 0 },
    newCustomers: toMap(newCustomers),
    summary: insight.summary,
    revenue: insight.revenue,
    topServices: insight.services.slice(0, 10),
    customers: { unique: insight.customers.length, repeat: insight.repeat.length, repeatPct: insight.rates.repeatPct, topRepeat: insight.repeat.slice(0, 10) },
    noShows: {
      count: insight.noShows.length,
      ratePct: insight.rates.noShowPct,
      items: insight.noShows.slice(-50).reverse().map(({ customerKey, valuePaise, payment, ...r }) => r),
    },
    truncated,
  });
});

// The same report as CSV: every booking, services, customers, or no-shows.
const istStamp = (date) => {
  const { date: day, minutes } = localParts(date);
  return `${day} ${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};
const rupees = (paise) => (paise / 100).toFixed(2);
const sourceLabel = (r) => (r.source === 'nurvia' ? 'Nurvia booking' : 'Own appointment');
const EXPORTS = {
  bookings: {
    rows: (r) => r.rows,
    columns: [
      { label: 'Date & time (IST)', value: (r) => istStamp(r.at) },
      { label: 'Source', value: sourceLabel },
      { label: 'Booking code', value: 'reference' },
      { label: 'Customer', value: 'customer' },
      { label: 'Phone', value: 'phone' },
      { label: 'Pet', value: 'pet' },
      { label: 'Service', value: 'service' },
      { label: 'Staff', value: 'staff' },
      { label: 'Status', value: 'status' },
      { label: 'Value (INR)', value: (r) => rupees(r.valuePaise) },
      { label: 'Payment', value: 'payment' },
    ],
  },
  services: {
    rows: (r) => r.services,
    columns: [
      { label: 'Service', value: 'name' },
      { label: 'Completed', value: 'count' },
      { label: 'From Nurvia', value: 'nurvia' },
      { label: 'Own appointments', value: 'own' },
      { label: 'Value (INR)', value: (s) => rupees(s.valuePaise) },
    ],
  },
  customers: {
    rows: (r) => r.customers,
    columns: [
      { label: 'Customer', value: 'name' },
      { label: 'Phone', value: 'phone' },
      { label: 'Completed visits', value: 'visits' },
      { label: 'Repeat customer', value: (c) => (c.visits >= 2 ? 'yes' : 'no') },
      { label: 'No-shows', value: 'noShows' },
      { label: 'Value (INR)', value: (c) => rupees(c.valuePaise) },
      { label: 'First visit (IST)', value: (c) => istStamp(c.firstAt) },
      { label: 'Last visit (IST)', value: (c) => istStamp(c.lastAt) },
    ],
  },
  no_shows: {
    rows: (r) => r.noShows,
    columns: [
      { label: 'Date & time (IST)', value: (r) => istStamp(r.at) },
      { label: 'Source', value: sourceLabel },
      { label: 'Booking code', value: 'reference' },
      { label: 'Customer', value: 'customer' },
      { label: 'Phone', value: 'phone' },
      { label: 'Pet', value: 'pet' },
      { label: 'Service', value: 'service' },
      { label: 'Staff', value: 'staff' },
    ],
  },
};

router.get(
  '/reports/export',
  can('reports.read'),
  validate({ query: { ...dateRange, kind: z.enum(Object.keys(EXPORTS)).default('bookings') } }),
  async (req, res) => {
    const { from, to, kind } = req.valid.query;
    checkReportRange({ from, to });
    const [{ rows }, packages] = await Promise.all([
      visitRows(req.vendor._id, from, to),
      CustomerPackage.aggregate([{ $match: { vendor: req.vendor._id, purchasedAt: { $gte: from, $lt: to } } }, { $group: { _id: null, paise: { $sum: '$pricePaise' } } }]),
    ]);
    const insight = { rows, ...reportInsights(rows, packages[0]?.paise ?? 0) };
    const { rows: pick, columns } = EXPORTS[kind];
    const last = localParts(new Date(to.getTime() - 1)).date;
    sendCsv(res, `nurvia-${kind.replace('_', '-')}-${localParts(from).date}-to-${last}.csv`, columns, pick(insight));
  },
);

export default router;

// ---- Pet owners: shared visit reports and record sync requests (mounted at /record-shares) ----

export const ownerRouter = Router();
ownerRouter.use(authenticate);

ownerRouter.get('/', validate({ query: { status: z.enum(['pending', 'accepted', 'declined']).default('pending') } }), async (req, res) => {
  res.json(
    await RecordShare.find({ owner: req.user._id, status: req.valid.query.status })
      .sort({ createdAt: -1 })
      .limit(100)
      .populate('vendor', 'businessName')
      .populate('pet', 'name species')
      .lean(),
  );
});

ownerRouter.post('/:id/accept', validate({ body: { remindFollowUp: z.boolean().optional() } }), async (req, res) => {
  const share = await RecordShare.findOne({ _id: req.valid.params.id, owner: req.user._id });
  if (!share) throw notFound('Record');
  if (share.status !== 'pending') throw conflict(`This record was already ${share.status}`);
  const pet = await Pet.findOne({ _id: share.pet, owner: req.user._id, archivedAt: null }).lean();
  if (!pet) throw notFound('Pet');
  const vendor = await Vendor.findById(share.vendor).select('businessName').lean();
  const record = await HealthRecord.create({
    ...share.toObject().record,
    pet: pet._id,
    owner: req.user._id,
    vet: { clinic: vendor?.businessName, vendor: share.vendor },
    source: 'clinic',
  });
  if (req.valid.body.remindFollowUp && record.nextDueDate) {
    await Reminder.create({ pet: pet._id, owner: req.user._id, kind: 'vet_follow_up', title: `${pet.name}: follow-up at ${vendor?.businessName ?? 'the clinic'}`, dueAt: record.nextDueDate, healthRecord: record._id });
  }
  share.set({ status: 'accepted', decidedAt: new Date(), healthRecord: record._id });
  await share.save();
  res.json({ share, healthRecord: record });
});

ownerRouter.post('/:id/decline', validate(), async (req, res) => {
  const share = await RecordShare.findOne({ _id: req.valid.params.id, owner: req.user._id });
  if (!share) throw notFound('Record');
  if (share.status !== 'pending') throw conflict(`This record was already ${share.status}`);
  share.set({ status: 'declined', decidedAt: new Date() });
  res.json(await share.save());
});
