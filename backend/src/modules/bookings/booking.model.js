import mongoose from 'mongoose';
import { tenantPlugin } from '../../common/tenancy.js';

const { ObjectId } = mongoose.Schema.Types;

export const BOOKING_STATUSES = ['pending', 'accepted', 'rejected', 'cancelled', 'completed', 'no_show'];
// Bookings in these states hold their slot.
export const ACTIVE_STATUSES = ['pending', 'accepted'];
export const PAYMENT_STATUSES = ['unpaid', 'pending', 'paid', 'failed', 'refund_pending', 'refunded'];

const bookingSchema = new mongoose.Schema(
  {
    code: { type: String, required: true }, // short human-friendly reference shown to both parties
    user: { type: ObjectId, ref: 'User', required: true },
    pet: { type: ObjectId, ref: 'Pet', required: true },
    vendor: { type: ObjectId, ref: 'Vendor', required: true },
    vendorOwner: { type: ObjectId, ref: 'User', required: true },
    service: { type: ObjectId, ref: 'Service', required: true },
    // Snapshot so later price or name changes don't rewrite past bookings. pricePaise and durationMin
    // are the totals including add-ons; basePricePaise and baseDurationMin are the main service alone.
    serviceSnapshot: {
      name: String,
      pricePaise: Number,
      durationMin: Number,
      mode: String,
      basePricePaise: Number,
      baseDurationMin: Number,
      addOns: [{ _id: false, addOn: ObjectId, name: String, pricePaise: Number, durationMin: Number }],
    },
    scheduledAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    status: { type: String, enum: BOOKING_STATUSES, default: 'pending' },
    statusHistory: [
      {
        _id: false,
        status: String,
        action: String,
        at: { type: Date, default: Date.now },
        by: { type: ObjectId, ref: 'User' },
        note: String,
      },
    ],
    notes: { type: String, maxlength: 1000 },
    // The vendor's staff member handling the booking (vendor workspace calendar).
    assignedStaff: { type: ObjectId, ref: 'VendorStaff' },
    // The customer picked assignedStaff; otherwise they asked for "any available" and the vendor assigns.
    staffRequested: { type: Boolean, default: false },
    // The owner lets the vendor see the pet's passport (vaccines, deworming, allergies, conditions)
    // from a day before the visit until a day after it ends. Health records stay private otherwise.
    sharePassport: { type: Boolean, default: false },
    // pay_at_provider: settled at the counter after the visit; online: paid through /payments.
    paymentMode: { type: String, enum: ['pay_at_provider', 'online'], default: 'pay_at_provider' },
    checkedInAt: Date, // scanned in at the vendor's desk
    reminderSentAt: Date, // the "your appointment is soon" notification
    payment: {
      status: { type: String, enum: PAYMENT_STATUSES, default: 'unpaid' },
      gateway: String,
      orderId: String,
      paymentId: String,
      refundId: String,
      amountPaise: Number,
      paidAt: Date,
      refundedAt: Date,
      failureReason: String,
    },
    reviewed: { type: Boolean, default: false },
  },
  { timestamps: true },
);
bookingSchema.plugin(tenantPlugin);
bookingSchema.index({ tenant: 1, code: 1 }, { unique: true });
bookingSchema.index({ tenant: 1, user: 1, scheduledAt: -1 });
bookingSchema.index({ tenant: 1, vendor: 1, scheduledAt: 1, status: 1 });
bookingSchema.index({ tenant: 1, status: 1, createdAt: -1 });
// Admin list without a status filter, newest first.
bookingSchema.index({ tenant: 1, createdAt: -1 });
bookingSchema.index({ 'payment.orderId': 1 }, { sparse: true });

export const Booking = mongoose.model('Booking', bookingSchema);

// A slot kept for one customer for a few minutes while they confirm, so nobody else can take it.
// Holds count against the vendor's capacity until they expire. A booking made from a hold takes
// the hold's _id, keeping its place in the first-come order (see createBooking).
const slotHoldSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    vendor: { type: ObjectId, ref: 'Vendor', required: true },
    service: { type: ObjectId, ref: 'Service', required: true },
    addOns: [ObjectId],
    pet: { type: ObjectId, ref: 'Pet', required: true },
    staff: { type: ObjectId, ref: 'VendorStaff' },
    scheduledAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
slotHoldSchema.plugin(tenantPlugin);
slotHoldSchema.index({ tenant: 1, vendor: 1, scheduledAt: 1 });
slotHoldSchema.index({ tenant: 1, user: 1 });
// Expired holds are already ignored by every query; this only clears them away.
slotHoldSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SlotHold = mongoose.model('SlotHold', slotHoldSchema);

// Messages between the customer and the business about one booking.
const bookingMessageSchema = new mongoose.Schema(
  {
    booking: { type: ObjectId, ref: 'Booking', required: true },
    sender: { type: ObjectId, ref: 'User', required: true },
    side: { type: String, enum: ['customer', 'vendor'], required: true },
    body: { type: String, required: true, trim: true, maxlength: 2000 },
  },
  { timestamps: true },
);
bookingMessageSchema.plugin(tenantPlugin);
bookingMessageSchema.index({ tenant: 1, booking: 1, createdAt: 1 });

export const BookingMessage = mongoose.model('BookingMessage', bookingMessageSchema);
