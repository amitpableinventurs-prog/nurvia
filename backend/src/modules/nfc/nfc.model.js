import mongoose from 'mongoose';
import { pointSchema } from '../../common/schemas.js';
import { tenantPlugin } from '../../common/tenancy.js';

const { ObjectId } = mongoose.Schema.Types;

// Passive NFC (or QR) identity tags. A tag carries only its code; tapping it opens the pet's
// public recovery profile, which shows nothing the owner has not allowed. No GPS or live tracking.
export const TAG_STATUSES = ['unassigned', 'active', 'deactivated'];

const tagSchema = new mongoose.Schema(
  {
    code: { type: String, required: true }, // random, unguessable; encoded in the tag URL
    serial: { type: String, required: true }, // printed on the tag, used for support and activation
    kind: { type: String, enum: ['nfc', 'qr'], default: 'nfc' },
    batch: String,
    status: { type: String, enum: TAG_STATUSES, default: 'unassigned' },
    pet: { type: ObjectId, ref: 'Pet' },
    owner: { type: ObjectId, ref: 'User' },
    activatedAt: Date,
    deactivatedAt: Date,
    deactivationReason: { type: String, enum: ['lost_tag', 'damaged', 'replaced', 'pet_passed', 'admin', 'other'] },
    replacedBy: { type: ObjectId, ref: 'NfcTag' },
    // What the public recovery profile shows. Everything sensitive is off until the owner turns it on.
    profile: {
      showOwnerName: { type: Boolean, default: true },
      showPhone: { type: Boolean, default: false },
      contactPhone: String, // shown instead of the account phone when set
      message: { type: String, maxlength: 300 },
      showAllergies: { type: Boolean, default: true },
      showMedicalNotes: { type: Boolean, default: false },
    },
    scanCount: { type: Number, default: 0 },
    lastScanAt: Date,
  },
  { timestamps: true },
);
tagSchema.plugin(tenantPlugin);
tagSchema.index({ tenant: 1, code: 1 }, { unique: true });
tagSchema.index({ tenant: 1, serial: 1 }, { unique: true });
tagSchema.index({ tenant: 1, owner: 1, status: 1 });
tagSchema.index({ tenant: 1, pet: 1, status: 1 });

const scanSchema = new mongoose.Schema(
  {
    tag: { type: ObjectId, ref: 'NfcTag', required: true },
    pet: { type: ObjectId, ref: 'Pet' },
    owner: { type: ObjectId, ref: 'User' },
    kind: { type: String, enum: ['view', 'found_report'], default: 'view' },
    // Only stored when the person scanning chose to share it.
    location: pointSchema,
    message: { type: String, maxlength: 500 },
    finderPhone: String,
    finderName: String,
    // A salted hash, enough to spot repeat scans without keeping the address.
    ipHash: String,
    userAgent: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
scanSchema.plugin(tenantPlugin);
scanSchema.index({ tenant: 1, tag: 1, createdAt: -1 });
scanSchema.index({ tenant: 1, owner: 1, createdAt: -1 });
scanSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2 * 365 * 86_400 });

export const NfcTag = mongoose.model('NfcTag', tagSchema);
export const NfcScan = mongoose.model('NfcScan', scanSchema);
