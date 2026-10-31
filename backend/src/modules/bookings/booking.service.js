import crypto from 'node:crypto';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../../common/errors.js';
import { addMinutes, formatLocalTime, partOfDay } from '../../common/time.js';
import { env } from '../../config/env.js';
import { paymentGateway } from '../../integrations/payments.js';
import { onQualifyingActivity } from '../loyalty/loyalty.service.js';
import { notify } from '../notifications/notify.js';
import { VendorCustomer, VendorStaff } from '../operations/operations.model.js';
import { recordVisit, syncCustomerFromBooking } from '../operations/operations.service.js';
import { careStatus, careUpToDate } from '../pets/care.js';
import { Pet } from '../pets/pet.model.js';
import { assertModuleAt } from '../platform/platform.service.js';
import { hasCapacity, isBlocked, nearbySlots, overlapping, staffCommitments, vendorPlace, withinOperatingHours } from '../vendors/availability.js';
import { Service, Vendor } from '../vendors/vendor.model.js';
import { ACTIVE_STATUSES, Booking, SlotHold } from './booking.model.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => 'NV' + Array.from(crypto.randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');

const MIN_LEAD_MINUTES = 30;
// How long a slot is kept for a customer while they confirm.
export const HOLD_MINUTES = 5;
// Customers can cancel or reschedule free of charge until this long before the visit.
export const FREE_CHANGE_HOURS = 2;
// The "your appointment is soon" notification goes out this long before the visit.
export const REMINDER_LEAD_MINUTES = 120;
// Roles a customer can choose when booking.
export const BOOKABLE_ROLES = ['groomer', 'vet', 'trainer', 'walker', 'boarding_attendant'];
// The vendor sees a shared passport from this long before the visit until this long after it ends.
const PASSPORT_WINDOW_MS = 24 * 3_600_000;
// Check-in at the vendor's desk opens this long before the visit.
const CHECK_IN_OPENS_MIN = 120;

async function assertSlot(vendor, start, durationMin, { excludeId, staffId, skipLead = false } = {}) {
  if (!skipLead && start < addMinutes(new Date(), MIN_LEAD_MINUTES)) throw badRequest(`Bookings must be at least ${MIN_LEAD_MINUTES} minutes ahead`);
  if (!withinOperatingHours(vendor, start, durationMin)) throw badRequest('The vendor is closed at that time');
  const end = addMinutes(start, durationMin);
  if (isBlocked(vendor, start, end)) throw conflict('The vendor is not taking bookings at that time');
  if (!(await hasCapacity(vendor, start, end, excludeId))) throw conflict('That slot is no longer available');
  if (staffId && (await staffCommitments(vendor._id, staffId, start, end, excludeId)).length) throw conflict('The person you chose is not free at that time');
}

// Two requests can pass the capacity check at the same moment. Re-checked after inserting: every
// racer sees the same set, so ordering by id lets exactly the first `slotCapacity` survive (and the
// first claim on a chosen staff member).
async function lostRace(vendor, doc, staffId) {
  const clashing = await overlapping(vendor._id, doc.scheduledAt, doc.endsAt);
  if (clashing.filter((b) => String(b._id) < String(doc._id)).length >= vendor.slotCapacity) return true;
  if (!staffId) return false;
  const busy = await staffCommitments(vendor._id, staffId, doc.scheduledAt, doc.endsAt);
  return busy.some((b) => String(b._id) < String(doc._id));
}

// The vendor, service, add-ons, pet and staff member a customer picked, checked and priced.
async function resolveSelection(user, { vendorId, serviceId, addOnIds = [], petId, staffId }) {
  const vendor = await Vendor.findOne({ _id: vendorId, status: 'active' }).lean();
  if (!vendor) throw notFound('Vendor');
  if (String(vendor.owner) === String(user._id)) throw badRequest('You cannot book your own business');
  await assertModuleAt('booking', vendorPlace(vendor));
  const service = await Service.findOne({ _id: serviceId, vendor: vendor._id, active: true }).lean();
  if (!service) throw notFound('Service');
  const pet = await Pet.findOne({ _id: petId, owner: user._id, archivedAt: null }).lean();
  if (!pet) throw notFound('Pet');
  const species = (service.species ?? []).map((s) => s.toLowerCase());
  if (species.length && !species.includes(pet.species)) throw badRequest(`${service.name} is not offered for ${pet.name}`, { species: service.species });

  const addOns = [...new Set(addOnIds.map(String))].map((id) => service.addOns?.find((a) => String(a._id) === id && a.active !== false));
  if (addOns.some((a) => !a)) throw badRequest('Choose add-ons offered with this service');

  let staff = null;
  if (staffId) {
    staff = await VendorStaff.findOne({ _id: staffId, vendor: vendor._id, active: true, bookable: { $ne: false }, role: { $in: BOOKABLE_ROLES } }).lean();
    if (!staff) throw badRequest('That person cannot be booked here');
  }
  const durationMin = service.durationMin + addOns.reduce((sum, a) => sum + (a.durationMin ?? 0), 0);
  const pricePaise = service.pricePaise + addOns.reduce((sum, a) => sum + a.pricePaise, 0);
  return { vendor, service, addOns, pet, staff, durationMin, pricePaise };
}

const snapshotOf = ({ service, addOns, durationMin, pricePaise }) => ({
  name: service.name,
  pricePaise,
  durationMin,
  mode: service.mode,
  basePricePaise: service.pricePaise,
  baseDurationMin: service.durationMin,
  addOns: addOns.map((a) => ({ addOn: a._id, name: a.name, pricePaise: a.pricePaise, durationMin: a.durationMin ?? 0 })),
});

// The price lines of a booking or quote. Bookings made before add-ons existed have no base fields.
export function pricing(snapshot) {
  return {
    lines: [
      { kind: 'service', name: snapshot.name, pricePaise: snapshot.basePricePaise ?? snapshot.pricePaise, durationMin: snapshot.baseDurationMin ?? snapshot.durationMin },
      ...(snapshot.addOns ?? []).map((a) => ({ kind: 'add_on', addOnId: a.addOn, name: a.name, pricePaise: a.pricePaise, durationMin: a.durationMin })),
    ],
    // Nurvia charges customers no booking fee; shown so the total is explained line by line.
    fees: [{ key: 'convenience_fee', label: 'Convenience & safe salon fee', amountPaise: 0 }],
    totalPaise: snapshot.pricePaise,
    durationMin: snapshot.durationMin,
    taxesIncluded: true,
    currency: 'INR',
  };
}

export function paymentModes(totalPaise) {
  return [
    { key: 'pay_at_provider', default: true, description: 'Pay at the reception desk after the visit: cash, UPI or card' },
    ...(totalPaise > 0 ? [{ key: 'online', default: false, description: 'Pay now through Nurvia' }] : []),
  ];
}

export function changePolicy(booking, now = new Date()) {
  const freeUntil = addMinutes(booking.scheduledAt, -FREE_CHANGE_HOURS * 60);
  const live = !booking.status || (ACTIVE_STATUSES.includes(booking.status) && booking.endsAt > now);
  return {
    hoursBefore: FREE_CHANGE_HOURS,
    freeCancellationUntil: freeUntil,
    freeRescheduleUntil: freeUntil,
    canCancel: live,
    canReschedule: live && now < freeUntil,
  };
}

export function passportShare(booking, now = new Date()) {
  if (!booking.sharePassport) return { shared: false, active: false };
  const from = new Date(booking.scheduledAt.getTime() - PASSPORT_WINDOW_MS);
  const until = new Date(booking.endsAt.getTime() + PASSPORT_WINDOW_MS);
  const live = [...ACTIVE_STATUSES, 'completed'].includes(booking.status);
  return { shared: true, from, until, active: live && now >= from && now <= until };
}

// What sharing the passport would show the vendor, for the summary screen.
export async function passportPreview(pet) {
  const status = await careStatus(pet, { withReminders: false });
  return {
    coreVaccines: status.coreVaccines.map(({ key, label, status: state, verified, nextDueDate }) => ({ key, label, status: state, verified, nextDueDate })),
    deworming: status.deworming,
    upToDate: careUpToDate(status),
    alerts: careAlerts(pet),
  };
}

// Conditions and allergies the person handling the pet must know about.
export const careAlerts = (pet) => [
  ...(pet.conditions ?? []).map((text) => ({ kind: 'condition', text })),
  ...(pet.allergies ?? []).map((text) => ({ kind: 'allergy', text })),
];

// The summary screen: everything the booking would be, priced, before anything is held or booked.
export async function quoteBooking(user, body) {
  const selection = await resolveSelection(user, body);
  const { vendor, staff, durationMin } = selection;
  const snapshot = snapshotOf(selection);
  let slot = { available: true };
  try {
    await assertSlot(vendor, body.scheduledAt, durationMin, { staffId: staff?._id });
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    slot = { available: false, reason: err.message };
  }
  return {
    selection,
    snapshot,
    scheduledAt: body.scheduledAt,
    endsAt: addMinutes(body.scheduledAt, durationMin),
    slot,
    pricing: pricing(snapshot),
    paymentModes: paymentModes(snapshot.pricePaise),
    policy: changePolicy({ scheduledAt: body.scheduledAt }),
    passport: await passportPreview(selection.pet),
  };
}

export const holdView = (hold) => ({
  _id: hold._id,
  scheduledAt: hold.scheduledAt,
  endsAt: hold.endsAt,
  expiresAt: hold.expiresAt,
  secondsLeft: Math.max(0, Math.round((hold.expiresAt - Date.now()) / 1000)),
});

// Holds a slot unless it is taken (null). Invalid times (closed, too soon) still throw.
async function tryHold(user, selection, start) {
  const { vendor, service, addOns, pet, staff, durationMin } = selection;
  try {
    await assertSlot(vendor, start, durationMin, { staffId: staff?._id });
  } catch (err) {
    if (err.status === 409) return null;
    throw err;
  }
  const hold = await SlotHold.create({
    user: user._id,
    vendor: vendor._id,
    service: service._id,
    addOns: addOns.map((a) => a._id),
    pet: pet._id,
    staff: staff?._id,
    scheduledAt: start,
    endsAt: addMinutes(start, durationMin),
    expiresAt: addMinutes(new Date(), HOLD_MINUTES),
  });
  if (await lostRace(vendor, hold, staff?._id)) {
    await hold.deleteOne();
    return null;
  }
  return hold;
}

// Free times near one that was taken. With `hold`, the closest one is held for the customer.
async function alternativesFor(user, selection, wanted, { hold: holdBest = false } = {}) {
  const earliest = addMinutes(new Date(), MIN_LEAD_MINUTES);
  const slots = (await nearbySlots(selection.vendor, wanted, selection.durationMin, { staffId: selection.staff?._id })).filter((s) => s >= earliest);
  let hold = null;
  if (holdBest) {
    for (const start of [...slots].sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted))) {
      hold = await tryHold(user, selection, start);
      if (hold) break;
    }
  }
  return {
    requested: wanted,
    hold: hold && holdView(hold),
    alternatives: slots.map((s) => ({
      scheduledAt: s,
      endsAt: addMinutes(s, selection.durationMin),
      partOfDay: partOfDay(s),
      held: hold?.scheduledAt.getTime() === s.getTime(),
    })),
  };
}

// "Securing your appointment": keeps the slot for HOLD_MINUTES. If it was just taken, the closest
// free time is held instead and the nearby alternatives are listed. A customer has one hold at a time.
export async function holdSlot(user, body) {
  const selection = await resolveSelection(user, body);
  await SlotHold.deleteMany({ user: user._id });
  const hold = await tryHold(user, selection, body.scheduledAt);
  if (hold) return { held: true, hold: holdView(hold), alternatives: [] };
  return { held: false, reason: 'slot_taken', ...(await alternativesFor(user, selection, body.scheduledAt, { hold: true })) };
}

const slotTaken = async (user, selection, wanted) =>
  new ApiError(409, 'SLOT_TAKEN', 'That slot is no longer available', await alternativesFor(user, selection, wanted));

// Books a held slot (holdId), or a slot directly. A booking made from a hold takes the hold's _id,
// so it keeps the place in line the hold had.
export async function createBooking(user, { holdId, sharePassport = false, notes, paymentMode = 'pay_at_provider', ...picked }) {
  let hold = null;
  if (holdId) {
    hold = await SlotHold.findOne({ _id: holdId, user: user._id, expiresAt: { $gt: new Date() } }).lean();
    if (!hold) throw new ApiError(409, 'HOLD_EXPIRED', 'The hold on this slot has ended; choose a time again');
    picked = { vendorId: hold.vendor, serviceId: hold.service, addOnIds: hold.addOns, petId: hold.pet, staffId: hold.staff, scheduledAt: hold.scheduledAt };
  }
  const selection = await resolveSelection(user, picked);
  const { vendor, service, pet, staff, durationMin } = selection;
  if (paymentMode === 'online' && !selection.pricePaise) throw badRequest('There is nothing to pay online for this booking');
  const { scheduledAt } = picked;

  try {
    await assertSlot(vendor, scheduledAt, durationMin, { excludeId: hold?._id, staffId: staff?._id, skipLead: Boolean(hold) });
  } catch (err) {
    if (err.status === 409) throw await slotTaken(user, selection, scheduledAt);
    throw err;
  }

  const booking = await Booking.create({
    ...(hold && { _id: hold._id }),
    code: newCode(),
    user: user._id,
    pet: pet._id,
    vendor: vendor._id,
    vendorOwner: vendor.owner,
    service: service._id,
    serviceSnapshot: snapshotOf(selection),
    scheduledAt,
    endsAt: addMinutes(scheduledAt, durationMin),
    notes,
    assignedStaff: staff?._id,
    staffRequested: Boolean(staff),
    sharePassport,
    paymentMode,
    statusHistory: [{ status: 'pending', action: 'create', by: user._id }],
  });
  if (await lostRace(vendor, booking, staff?._id)) {
    await booking.deleteOne();
    throw await slotTaken(user, selection, scheduledAt);
  }
  // The booking replaces the customer's hold, and any other hold they had.
  await SlotHold.deleteMany({ user: user._id });

  // A CRM hiccup must not lose the booking itself.
  await syncCustomerFromBooking(vendor._id, user, pet).catch((err) => console.error('[crm] customer sync failed', err));
  await notify([vendor.owner], {
    type: 'booking.created',
    title: 'New booking request',
    body: `${service.name} for ${pet.name}`,
    data: { bookingId: String(booking._id) },
  });
  return booking;
}

// Who may perform each action, from which states, and where it leads.
const TRANSITIONS = {
  accept: { from: ['pending'], to: 'accepted', actors: ['vendor'] },
  reject: { from: ['pending'], to: 'rejected', actors: ['vendor'] },
  reschedule: { from: ['pending', 'accepted'], to: null, actors: ['vendor', 'user'] },
  cancel: { from: ['pending', 'accepted'], to: 'cancelled', actors: ['vendor', 'user'] },
  complete: { from: ['accepted'], to: 'completed', actors: ['vendor'], afterStart: true },
  no_show: { from: ['accepted'], to: 'no_show', actors: ['vendor'], afterStart: true },
};
export const BOOKING_ACTIONS = Object.keys(TRANSITIONS);

const MESSAGES = {
  accept: 'Your booking was confirmed',
  reject: 'Your booking request was declined',
  reschedule: 'Your booking was rescheduled',
  cancel: 'A booking was cancelled',
  complete: 'Your booking is complete — leave a review',
  no_show: 'Booking marked as no-show',
};

export function actorRole(booking, user) {
  if (String(booking.vendorOwner) === String(user._id)) return 'vendor';
  if (String(booking.user) === String(user._id)) return 'user';
  return null;
}

export async function applyAction(booking, user, { action, scheduledAt, reason }) {
  const rule = TRANSITIONS[action];
  const actor = actorRole(booking, user);
  if (!actor || !rule.actors.includes(actor)) throw forbidden(`You cannot ${action.replace('_', '-')} this booking`);
  if (!rule.from.includes(booking.status)) throw conflict(`Cannot ${action.replace('_', '-')} a booking that is ${booking.status}`);
  if (rule.afterStart && booking.scheduledAt > new Date()) throw conflict('This can only be done after the appointment time');
  const policy = changePolicy(booking);
  // Customers reschedule themselves only up to the free-change cutoff; after it, they cancel or call.
  if (action === 'reschedule' && actor === 'user' && !policy.canReschedule) {
    throw conflict(`Appointments can be rescheduled up to ${FREE_CHANGE_HOURS} hours before`, { freeRescheduleUntil: policy.freeRescheduleUntil });
  }
  const late = action === 'cancel' && actor === 'user' && new Date() > policy.freeCancellationUntil;

  if (action === 'reschedule') {
    if (!scheduledAt) throw badRequest('scheduledAt is required to reschedule');
    const vendor = await Vendor.findById(booking.vendor).lean();
    await assertSlot(vendor, scheduledAt, booking.serviceSnapshot.durationMin, { excludeId: booking._id, staffId: booking.assignedStaff });
    booking.scheduledAt = scheduledAt;
    booking.endsAt = addMinutes(scheduledAt, booking.serviceSnapshot.durationMin);
    booking.reminderSentAt = undefined;
    // A time the customer picked needs the vendor to confirm it again.
    if (actor === 'user') booking.status = 'pending';
  }
  if (rule.to) booking.status = rule.to;
  booking.statusHistory.push({ status: booking.status, action, by: user._id, note: reason ?? (late ? `Cancelled less than ${FREE_CHANGE_HOURS} hours before the visit` : undefined) });

  // Rejected and cancelled bookings are refunded in full. The refund is confirmed later by the gateway webhook.
  if (['reject', 'cancel'].includes(action) && booking.payment.status === 'paid') {
    const refund = await paymentGateway().refund({
      paymentId: booking.payment.paymentId,
      amountPaise: booking.payment.amountPaise,
      notes: { bookingId: String(booking._id), tenant: booking.tenant },
    });
    booking.payment.refundId = refund.refundId;
    booking.payment.status = refund.status === 'processed' ? 'refunded' : 'refund_pending';
    if (booking.payment.status === 'refunded') booking.payment.refundedAt = new Date();
  }

  await booking.save();
  if (action === 'complete') {
    const customer = await VendorCustomer.findOne({ vendor: booking.vendor, user: booking.user }).select('_id').lean();
    await recordVisit(customer?._id, booking.scheduledAt);
    // Points are earned on what was paid online; any completed booking qualifies a referral.
    const paid = booking.payment.status === 'paid' ? booking.payment.amountPaise ?? 0 : 0;
    await onQualifyingActivity(booking.user, { kind: 'booking', ref: booking._id, amountPaise: paid }).catch((err) => console.error('[loyalty]', err));
  }
  const recipient = actor === 'vendor' ? booking.user : booking.vendorOwner;
  await notify([recipient], {
    type: `booking.${action}`,
    title: MESSAGES[action],
    body: `${booking.serviceSnapshot.name} · ${booking.code}`,
    data: { bookingId: String(booking._id) },
  });
  return booking;
}

export const isActive = (booking) => ACTIVE_STATUSES.includes(booking.status);

// ---- Check-in at the vendor's desk ----

// The QR code on the customer's booking: the booking id signed with a server key, so it cannot be
// made up for another booking. It carries no personal details.
const checkInSignature = (id) => crypto.createHmac('sha256', env.jwt.accessSecret).update(`check-in:${id}`).digest('base64url').slice(0, 22);
export const checkInToken = (bookingId) => `NVC1.${bookingId}.${checkInSignature(bookingId)}`;

export function bookingIdFromCheckIn(token) {
  const [version, id, signature = ''] = String(token).split('.');
  const expected = /^[a-f\d]{24}$/i.test(id ?? '') ? checkInSignature(id) : '';
  if (version !== 'NVC1' || !expected || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw badRequest('This is not a Nurvia check-in code');
  }
  return id;
}

export async function checkIn(booking, user) {
  if (booking.checkedInAt) return booking;
  if (booking.status === 'pending') throw conflict('Accept this booking before checking the pet in');
  if (booking.status !== 'accepted') throw conflict(`Cannot check in a booking that is ${booking.status}`);
  const now = new Date();
  if (now < addMinutes(booking.scheduledAt, -CHECK_IN_OPENS_MIN)) throw conflict(`Check-in opens ${CHECK_IN_OPENS_MIN / 60} hours before the appointment`);
  if (now > booking.endsAt) throw conflict('This appointment has already ended');
  booking.checkedInAt = now;
  booking.statusHistory.push({ status: booking.status, action: 'check_in', by: user._id });
  await booking.save();
  const pet = await Pet.findById(booking.pet).select('name').lean();
  await notify([booking.user], {
    type: 'booking.checked_in',
    title: `${pet?.name ?? 'Your pet'} is checked in`,
    body: `${booking.serviceSnapshot.name} · ${booking.code}`,
    data: { bookingId: String(booking._id) },
  });
  return booking;
}

// ---- Appointment reminders ----

// Claimed one at a time with an atomic update, so several API instances never send one twice.
export async function sendAppointmentReminders(limit = 500) {
  const now = new Date();
  for (let i = 0; i < limit; i++) {
    const booking = await Booking.findOneAndUpdate(
      { status: 'accepted', reminderSentAt: null, scheduledAt: { $gt: now, $lte: addMinutes(now, REMINDER_LEAD_MINUTES) } },
      { reminderSentAt: now },
      { sort: { scheduledAt: 1 }, new: true },
    )
      .populate({ path: 'vendor', model: Vendor, select: 'businessName arrivalInstructions' })
      .populate({ path: 'pet', model: Pet, select: 'name' })
      .lean();
    if (!booking) return;
    await notify([booking.user], {
      type: 'booking.reminder',
      title: `${booking.pet?.name ?? 'Your pet'}'s ${booking.serviceSnapshot.name} is at ${formatLocalTime(booking.scheduledAt)}`,
      body: booking.vendor?.arrivalInstructions || `See you at ${booking.vendor?.businessName ?? 'your appointment'}`,
      data: { bookingId: String(booking._id) },
    });
  }
}
