import { addMinutes, localParts, localToUtc, toMinutes } from '../../common/time.js';
import { ACTIVE_STATUSES, Booking, SlotHold } from '../bookings/booking.model.js';
import { Appointment } from '../operations/operations.model.js';

const SLOT_STEP_MIN = 30;
const DAY_MIN = 24 * 60;

const liveHolds = (filter) => SlotHold.find({ ...filter, expiresAt: { $gt: new Date() } }).select('scheduledAt endsAt').lean();

// Bookings and unexpired holds that overlap [start, end) and still hold capacity. A booking made
// from a hold shares its _id, so the pair is counted once.
export async function overlapping(vendorId, start, end, excludeId) {
  const range = { scheduledAt: { $lt: end }, endsAt: { $gt: start }, ...(excludeId && { _id: { $ne: excludeId } }) };
  const [bookings, holds] = await Promise.all([
    Booking.find({ vendor: vendorId, status: { $in: ACTIVE_STATUSES }, ...range }).select('scheduledAt endsAt').lean(),
    liveHolds({ vendor: vendorId, ...range }),
  ]);
  const booked = new Set(bookings.map((b) => String(b._id)));
  return [...bookings, ...holds.filter((h) => !booked.has(String(h._id)))];
}

// What one staff member is already committed to in [start, end): bookings assigned to them,
// workspace appointments and other customers' holds that asked for them.
export async function staffCommitments(vendorId, staffId, start, end, excludeId) {
  const range = { scheduledAt: { $lt: end }, endsAt: { $gt: start }, ...(excludeId && { _id: { $ne: excludeId } }) };
  const [bookings, appointments, holds] = await Promise.all([
    Booking.find({ vendor: vendorId, assignedStaff: staffId, status: { $in: ACTIVE_STATUSES }, ...range }).select('scheduledAt endsAt').lean(),
    Appointment.find({ vendor: vendorId, staff: staffId, status: { $nin: ['cancelled', 'no_show'] }, ...range }).select('scheduledAt endsAt').lean(),
    liveHolds({ vendor: vendorId, staff: staffId, ...range }),
  ]);
  const booked = new Set(bookings.map((b) => String(b._id)));
  return [...bookings, ...appointments, ...holds.filter((h) => !booked.has(String(h._id)))];
}

const countAt = (bookings, start, end) => bookings.filter((b) => b.scheduledAt < end && b.endsAt > start).length;

// The vendor's city and map pin, for checking whether booking is live there.
export const vendorPlace = (vendor) => ({ city: vendor.address?.city, lat: vendor.location?.coordinates?.[1], lng: vendor.location?.coordinates?.[0] });

// Whether [start, end) falls in blocked time: a time-off block, or a pause on new bookings
// (until a date, or indefinitely when `until` is empty).
export function isBlocked(vendor, start, end) {
  const { pause, timeOff = [] } = vendor;
  if (pause?.active && (!pause.until || start < pause.until)) return true;
  return timeOff.some((t) => t.from < end && t.to > start);
}

// Free start times on one local date for a service of the given duration. With a staff member,
// only times that person is also free.
export async function availableSlots(vendor, dateStr, durationMin, { staffId } = {}) {
  const dayStart = localToUtc(dateStr);
  const weekday = localParts(dayStart).weekday;
  const windows = vendor.operatingHours.filter((w) => w.day === weekday);
  if (!windows.length) return [];

  const dayEnd = addMinutes(dayStart, DAY_MIN);
  const [booked, staffBusy] = await Promise.all([
    overlapping(vendor._id, dayStart, dayEnd),
    staffId ? staffCommitments(vendor._id, staffId, dayStart, dayEnd) : [],
  ]);
  const now = new Date();
  const slots = [];
  for (const window of windows) {
    const close = toMinutes(window.close);
    for (let m = toMinutes(window.open); m + durationMin <= close; m += SLOT_STEP_MIN) {
      const start = addMinutes(dayStart, m);
      const end = addMinutes(start, durationMin);
      if (start > now && !isBlocked(vendor, start, end) && countAt(booked, start, end) < vendor.slotCapacity && !countAt(staffBusy, start, end)) {
        slots.push(start);
      }
    }
  }
  return slots.sort((a, b) => a - b);
}

// Free slots closest to a wanted time, for "that slot was just taken": the same day first, then the
// following days, nearest first. Returned in time order.
export async function nearbySlots(vendor, wanted, durationMin, { staffId, count = 3, days = 7 } = {}) {
  const found = [];
  for (let d = 0; d < days && found.length < count; d++) {
    const date = localParts(addMinutes(wanted, d * DAY_MIN)).date;
    const slots = (await availableSlots(vendor, date, durationMin, { staffId })).filter((s) => s.getTime() !== wanted.getTime());
    found.push(...slots.sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted)).slice(0, count - found.length));
  }
  return found.sort((a, b) => a - b);
}

// Whether a booking of durationMin starting at `start` fits inside one operating window.
export function withinOperatingHours(vendor, start, durationMin) {
  const { weekday, minutes } = localParts(start);
  return vendor.operatingHours.some(
    (w) => w.day === weekday && minutes >= toMinutes(w.open) && minutes + durationMin <= toMinutes(w.close),
  );
}

export async function hasCapacity(vendor, start, end, excludeId) {
  return (await overlapping(vendor._id, start, end, excludeId)).length < vendor.slotCapacity;
}

// Whether the vendor is open now and until when, or when it next opens (within a week).
export function openingState(vendor, now = new Date()) {
  const { weekday, minutes } = localParts(now);
  const current = vendor.operatingHours.find((w) => w.day === weekday && minutes >= toMinutes(w.open) && minutes < toMinutes(w.close));
  if (current) return { open: true, closesAt: current.close };
  for (let d = 0; d < 7; d++) {
    const day = (weekday + d) % 7;
    const next = vendor.operatingHours
      .filter((w) => w.day === day && (d > 0 || toMinutes(w.open) > minutes))
      .sort((a, b) => toMinutes(a.open) - toMinutes(b.open))[0];
    if (next) return { open: false, opensAt: next.open, opensInDays: d };
  }
  return { open: false };
}
