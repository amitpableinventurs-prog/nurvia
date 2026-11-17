import mongoose from 'mongoose';
import { attachmentSchema, pointSchema } from '../../common/schemas.js';
import { tenantPlugin } from '../../common/tenancy.js';

const { ObjectId } = mongoose.Schema.Types;
const hhmm = { type: String, match: /^([01]\d|2[0-3]):[0-5]\d$/, required: true };

export const STORE_TYPES = ['pet_store', 'pharmacy', 'boutique'];
export const KYC_DOCUMENT_TYPES =['pan', 'gst_certificate', 'shop_license', 'aadhaar', 'vet_license', 'bank_proof', 'other'];
// A trade licence (BBMP shop & establishment) or a veterinary council registration.
export const LICENSE_DOCUMENT_TYPES = ['shop_license', 'vet_license'];

// Where a vendor's trade licence stands: not uploaded, uploaded and awaiting a manual check,
// or checked by staff. There is no government verification API yet, so every check is manual.
export function licenseStatus(kyc = {}) {
  if (kyc.licenseCheck?.status) return kyc.licenseCheck.status;
  return kyc.documents?.some((d) => LICENSE_DOCUMENT_TYPES.includes(d.type)) ? 'manual_review' : 'pending_upload';
}

const vendorSchema = new mongoose.Schema(
  {
    owner: { type: ObjectId, ref: 'User', required: true },
    businessName: { type: String, required: true, trim: true, maxlength: 120 },
    categories: [{ type: ObjectId, ref: 'Category' }],
    description: { type: String, maxlength: 2000 },
    phone: String,
    email: String,
    address: {
      line1: { type: String, required: true },
      line2: String,
      city: { type: String, required: true },
      state: String,
      pincode: String,
    },
    location: { type: pointSchema, required: true },
    // Several windows per weekday allow split shifts; a weekday with no window is closed.
    operatingHours: [{ _id: false, day: { type: Number, min: 0, max: 6, required: true }, open: hhmm, close: hhmm }],
    slotCapacity: { type: Number, default: 1, min: 1, max: 50 }, // concurrent bookings per slot
    // Blocked dates or times (holiday, training day, a doctor's leave). No new bookings overlap them.
    timeOff: [{ from: { type: Date, required: true }, to: { type: Date, required: true }, reason: { type: String, maxlength: 200 } }],
    // Temporary unavailability: no new bookings until `until`, or until switched off when it is empty.
    pause: { active: { type: Boolean, default: false }, until: Date, reason: { type: String, maxlength: 200 }, since: Date },
    homeVisits: { type: Boolean, default: false },
    // Shown to customers on their booking, e.g. "Please arrive 10 minutes early with your pet on a leash".
    arrivalInstructions: { type: String, trim: true, maxlength: 300 },
    // A shop or pharmacy in the Explore directory (Local Pet Shops). Listed while `type` is set.
    store: {
      type: { type: String, enum: STORE_TYPES },
      locality: { type: String, trim: true, maxlength: 80 },
      // The one-line pitch on the directory card, e.g. "Vet-run pharmacy with a vaccine fridge and home delivery".
      note: { type: String, trim: true, maxlength: 160 },
      tags: [{ type: String, trim: true, maxlength: 40 }], // "Curated treats & food", "Prescription diet shelf"
      inStorePickup: { type: Boolean, default: false },
      coldChain: { type: Boolean, default: false }, // vaccine fridge / cold-chain medication
      vetTechOnSite: { type: Boolean, default: false },
      stockVerifiedAt: Date, // the shop's last "shelf checked" tap, shown as "Stock verified 20m ago"
    },
    photos: [attachmentSchema],

    status: { type: String, enum: ['pending', 'active', 'rejected', 'suspended'], default: 'pending', index: true },
    statusReason: String,
    kyc: {
      status: { type: String, enum: ['not_submitted', 'submitted', 'approved', 'rejected'], default: 'not_submitted' },
      gstin: String,
      pan: String,
      documents: [{ _id: false, type: { type: String, enum: KYC_DOCUMENT_TYPES }, file: { type: ObjectId, ref: 'File' }, name: String }],
      submittedAt: Date,
      reviewedAt: Date,
      reviewedBy: { type: ObjectId, ref: 'User' },
      rejectionReason: String,
      licenseCheck: {
        status: { type: String, enum: ['verified', 'failed'] },
        note: String,
        by: { type: ObjectId, ref: 'User' },
        at: Date,
      },
    },

    // Marketplace seller onboarding (Phase 2): separate from the service KYC above, approved by staff.
    seller: {
      status: { type: String, enum: ['none', 'submitted', 'approved', 'rejected', 'suspended'], default: 'none' },
      legalName: String,
      gstin: String,
      pan: String,
      bank: { accountName: String, accountNumberLast4: String, ifsc: String },
      pickupAddress: { line1: String, line2: String, city: String, state: String, pincode: String, phone: String },
      documents: [{ _id: false, type: { type: String, enum: ['gst_certificate', 'pan', 'cancelled_cheque', 'shop_license', 'other'] }, file: { type: ObjectId, ref: 'File' }, name: String }],
      commissionPct: { type: Number, min: 0, max: 50 }, // overrides the platform rate when set
      // Home delivery by the seller itself. Store pickup is `store.inStorePickup`.
      shipping: {
        delivers: { type: Boolean, default: true },
        radiusKm: { type: Number, min: 1, max: 100, default: 10 },
        feePaise: { type: Number, min: 0, default: 4900 },
        freeFromPaise: { type: Number, min: 0, default: 49900 },
      },
      returnAddress: { line1: String, line2: String, city: String, state: String, pincode: String, phone: String },
      submittedAt: Date,
      reviewedAt: Date,
      reviewedBy: { type: ObjectId, ref: 'User' },
      reason: String,
    },
    // The seller's full bank account number, AES-GCM encrypted (common/crypto.js) and never selected by
    // default. Kept outside `seller` so queries can still exclude the whole seller block.
    sellerBankAccountEnc: { type: String, select: false },
    // The vendor's paid plan (plans/subscription.service.js). Without one, or once it expires, the
    // vendor is on the free plan. Bought by the vendor, or assigned or extended by Nurvia staff.
    subscription: {
      plan: { type: ObjectId, ref: 'Plan' },
      status: { type: String, enum: ['active', 'expired'] },
      source: { type: String, enum: ['purchase', 'staff', 'complimentary'] },
      startedAt: Date,
      expiresAt: Date, // none: runs until staff change it
      expiredAt: Date,
      remindersSent: [Number], // renewal reminders already sent for this end date, in days before it
    },

    ratingAvg: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);
vendorSchema.plugin(tenantPlugin);
vendorSchema.index({ tenant: 1, 'seller.status': 1, 'seller.submittedAt': 1 });
vendorSchema.index({ location: '2dsphere' });
vendorSchema.index({ tenant: 1, status: 1, 'store.type': 1 });
vendorSchema.index({ tenant: 1, owner: 1 }, { unique: true });
vendorSchema.index({ tenant: 1, status: 1, categories: 1 });
vendorSchema.index({ tenant: 1, status: 1, 'kyc.status': 1, 'kyc.submittedAt': 1 });
vendorSchema.index({ tenant: 1, 'subscription.status': 1, 'subscription.expiresAt': 1 });

const serviceSchema = new mongoose.Schema(
  {
    vendor: { type: ObjectId, ref: 'Vendor', required: true },
    category: { type: ObjectId, ref: 'Category' },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, maxlength: 1000 },
    pricePaise: { type: Number, required: true, min: 0 }, // INR amounts are stored in paise
    durationMin: { type: Number, required: true, min: 5, max: 24 * 60 },
    species: [String],
    mode: { type: String, enum: ['at_store', 'home_visit'], default: 'at_store' },
    // Optional extras booked with the service (e.g. teeth cleaning), each adding to its price and time.
    addOns: [
      {
        name: { type: String, required: true, trim: true, maxlength: 120 },
        description: { type: String, maxlength: 300 },
        pricePaise: { type: Number, required: true, min: 0 },
        durationMin: { type: Number, default: 0, min: 0, max: 240 },
        active: { type: Boolean, default: true },
      },
    ],
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
serviceSchema.plugin(tenantPlugin);
serviceSchema.index({ tenant: 1, vendor: 1, active: 1 });

const searchLogSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User' },
    q: String,
    category: { type: ObjectId, ref: 'Category' },
    city: String,
    hasLocation: Boolean,
    resultCount: Number,
  },
  { timestamps: true },
);
searchLogSchema.plugin(tenantPlugin);
searchLogSchema.index({ tenant: 1, createdAt: -1 });
searchLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 86_400 });

export const Vendor = mongoose.model('Vendor', vendorSchema);
export const Service = mongoose.model('Service', serviceSchema);
export const SearchLog = mongoose.model('SearchLog', searchLogSchema);
