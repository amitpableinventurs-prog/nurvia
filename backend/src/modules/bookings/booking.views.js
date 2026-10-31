// Screen-shaped views of bookings for the pet parent app: appointment cards (My Appointments),
// the confirmation and appointment details screens, staff profiles and the calendar file.
import mongoose from 'mongoose';
import { careStatus, careUpToDate, ageMonths } from '../pets/care.js';
import { openingState } from '../vendors/availability.js';
import { ACTIVE_STATUSES, Booking } from './booking.model.js';
import { REMINDER_LEAD_MINUTES, careAlerts, changePolicy, checkInToken, passportShare, pricing } from './booking.service.js';

const STATE = { pending: 'requested', accepted: 'confirmed', completed: 'completed', cancelled: 'cancelled', rejected: 'declined', no_show: 'no_show' };
export const appointmentState = (b) => (b.status === 'accepted' && b.checkedInAt ? 'in_progress' : STATE[b.status]);

// Straight-line distance in km, rounded to 0.1.
function distanceKm(from, to) {
  if (!from?.coordinates?.length || !to?.coordinates?.length) return null;
  const [lng1, lat1] = from.coordinates;
  const [lng2, lat2] = to.coordinates;
  const rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return Math.round(12_742 * Math.asin(Math.sqrt(a)) * 10) / 10;
}

const latLng = (location) => (location?.coordinates?.length ? { lat: location.coordinates[1], lng: location.coordinates[0] } : null);

export const VENDOR_CARD_FIELDS = 'businessName address location phone ratingAvg ratingCount operatingHours arrivalInstructions status kyc.licenseCheck.status';

export function vendorSummary(vendor, userLocation) {
  if (!vendor?._id) return null;
  return {
    _id: vendor._id,
    businessName: vendor.businessName,
    verified: vendor.kyc?.licenseCheck?.status === 'verified',
    address: vendor.address,
    location: latLng(vendor.location),
    distanceKm: distanceKm(userLocation, vendor.location),
    ratingAvg: vendor.ratingAvg ?? 0,
    ratingCount: vendor.ratingCount ?? 0,
  };
}

export const petSummary = (pet) =>
  pet?._id ? { _id: pet._id, name: pet.name, species: pet.species, breed: pet.breed ?? null, ageMonths: ageMonths(pet), weightKg: pet.weightKg ?? null, photo: pet.photo?.url ?? null } : null;

// Average rating per staff member, from reviews of bookings they were assigned to.
async function staffRatings(vendorId, staffIds) {
  if (!staffIds.length) return new Map();
  const rows = await Booking.aggregate([
    { $match: { vendor: new mongoose.Types.ObjectId(String(vendorId)), assignedStaff: { $in: staffIds.map((id) => new mongoose.Types.ObjectId(String(id))) }, reviewed: true } },
    { $lookup: { from: 'reviews', localField: '_id', foreignField: 'booking', as: 'review' } },
    { $unwind: '$review' },
    { $match: { 'review.status': 'visible' } },
    { $group: { _id: '$assignedStaff', ratingAvg: { $avg: '$review.rating' }, ratingCount: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), { ratingAvg: Math.round(r.ratingAvg * 10) / 10, ratingCount: r.ratingCount }]));
}

// What a customer sees about the people they can book: no phone numbers or accounts.
export async function staffProfiles(vendorId, staff) {
  const ratings = await staffRatings(vendorId, staff.map((s) => s._id));
  return staff.map((s) => ({
    _id: s._id,
    name: s.name,
    role: s.role,
    title: s.title ?? null,
    experienceYears: s.experienceYears ?? null,
    ...(ratings.get(String(s._id)) ?? { ratingAvg: null, ratingCount: 0 }),
  }));
}

// One card on My Appointments. `booking` has vendor and pet populated.
export function appointmentCard(booking, { userLocation, now = new Date() } = {}) {
  const snapshot = booking.serviceSnapshot ?? {};
  const upcoming = ACTIVE_STATUSES.includes(booking.status) && booking.endsAt >= now;
  const policy = changePolicy(booking, now);
  return {
    _id: booking._id,
    code: booking.code,
    status: booking.status,
    state: appointmentState(booking),
    title: [snapshot.name, ...(snapshot.addOns ?? []).map((a) => a.name)].filter(Boolean).join(' + '),
    vendor: vendorSummary(booking.vendor, userLocation),
    pet: petSummary(booking.pet),
    scheduledAt: booking.scheduledAt,
    endsAt: booking.endsAt,
    durationMin: snapshot.durationMin,
    amountPaise: snapshot.pricePaise,
    paymentMode: booking.paymentMode ?? 'pay_at_provider',
    paymentStatus: booking.payment?.status ?? 'unpaid',
    actions: {
      directions: upcoming,
      reschedule: policy.canReschedule,
      cancel: policy.canCancel,
      bookAgain: !upcoming && booking.vendor?.status === 'active',
      review: booking.status === 'completed' && !booking.reviewed,
    },
    // Prefills "Book again".
    rebook: {
      vendorId: booking.vendor?._id ?? booking.vendor,
      serviceId: booking.service,
      addOnIds: (snapshot.addOns ?? []).map((a) => a.addOn).filter(Boolean),
      petId: booking.pet?._id ?? booking.pet,
    },
  };
}

function progress(booking) {
  const lastAt = (action) => booking.statusHistory?.findLast((h) => h.action === action)?.at ?? null;
  const confirmedAt = ['accepted', 'completed', 'no_show'].includes(booking.status) ? lastAt('accept') ?? booking.updatedAt : null;
  const steps = [
    { key: 'requested', at: booking.createdAt },
    { key: 'confirmed', at: confirmedAt },
    { key: 'checked_in', at: booking.checkedInAt ?? null },
    { key: 'completed', at: booking.status === 'completed' ? lastAt('complete') : null },
  ];
  const ended = ['cancelled', 'rejected', 'no_show'].includes(booking.status) ? booking.status : null;
  // The current step is the latest one reached ("Confirmed by studio · Current", step 2 of 4).
  const reached = steps.findIndex((s) => !s.at);
  const current = (reached === -1 ? steps.length : reached) - 1;
  return {
    step: current + 1,
    total: steps.length,
    ended,
    steps: steps.map((s, i) => ({ ...s, state: i < current ? 'done' : i === current ? 'current' : 'upcoming' })),
  };
}

// Calendar links: Google Calendar needs the times as UTC basic format (20250412T053000Z).
const basicUtc = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const placeOf = (vendor) => [vendor?.businessName, vendor?.address?.line1, vendor?.address?.line2, vendor?.address?.city].filter(Boolean).join(', ');

function googleCalendarUrl(booking) {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `${booking.pet?.name ?? 'Pet'}: ${booking.serviceSnapshot.name}`,
    dates: `${basicUtc(booking.scheduledAt)}/${basicUtc(booking.endsAt)}`,
    location: placeOf(booking.vendor),
    details: `Nurvia booking ${booking.code}`,
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

// The confirmation and appointment details screens. `booking` has vendor, pet and assignedStaff populated.
export async function appointmentDetails(booking, { userLocation, now = new Date() } = {}) {
  const card = appointmentCard(booking, { userLocation, now });
  const vendor = booking.vendor;
  const staff = booking.assignedStaff?._id ? (await staffProfiles(vendor._id, [booking.assignedStaff]))[0] : null;
  const share = passportShare(booking, now);
  const care = booking.pet?._id ? await careStatus(booking.pet, { withReminders: false }) : null;
  const location = latLng(vendor?.location);
  return {
    ...card,
    progress: progress(booking),
    // Shown as a QR code ("Express pass") for the vendor's desk to scan.
    checkIn: {
      code: checkInToken(booking._id),
      available: booking.status === 'accepted' && !booking.checkedInAt,
      checkedInAt: booking.checkedInAt ?? null,
    },
    vendor: vendor?._id && {
      ...card.vendor,
      phone: vendor.phone ?? null,
      hours: openingState(vendor, now),
      arrivalInstructions: vendor.arrivalInstructions ?? null,
      directionsUrl: location && `https://www.google.com/maps/dir/?api=1&destination=${location.lat},${location.lng}`,
    },
    // null staff with staffRequested false: "any available", the vendor assigns someone.
    staff,
    staffRequested: Boolean(booking.staffRequested),
    pricing: pricing(booking.serviceSnapshot),
    careNotes: {
      alerts: booking.pet ? careAlerts(booking.pet) : [],
      instructions: booking.notes ?? null,
      passport: { ...share, upToDate: care ? careUpToDate(care) : false },
    },
    policy: changePolicy(booking, now),
    reminder: {
      at: new Date(booking.scheduledAt.getTime() - REMINDER_LEAD_MINUTES * 60_000),
      sent: Boolean(booking.reminderSentAt),
      // SMS and WhatsApp delivery need a provider (see README); reminders go out as push and in-app.
      channels: ['push', 'in_app'],
    },
    calendar: { ics: `/api/v1/bookings/${booking._id}/calendar.ics`, google: googleCalendarUrl(booking) },
  };
}

// iCalendar text (RFC 5545) for "Add to calendar".
const icsText = (text) => String(text ?? '').replace(/\\/g, '\\\\').replace(/[,;]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\n');

export function calendarFile(booking) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Nurvia Petcare//Bookings//EN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${booking._id}@nurvia`,
    `DTSTAMP:${basicUtc(new Date())}`,
    `DTSTART:${basicUtc(booking.scheduledAt)}`,
    `DTEND:${basicUtc(booking.endsAt)}`,
    `SUMMARY:${icsText(`${booking.pet?.name ?? 'Pet'}: ${booking.serviceSnapshot.name}`)}`,
    `LOCATION:${icsText(placeOf(booking.vendor))}`,
    `DESCRIPTION:${icsText(`Nurvia booking ${booking.code}`)}`,
    'BEGIN:VALARM',
    'TRIGGER:-PT2H',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsText(booking.serviceSnapshot.name)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}
