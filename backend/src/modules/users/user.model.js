import mongoose from 'mongoose';
import { ALL_ROLES, ROLES } from '../../common/roles.js';
import { addressSchema, pointSchema } from '../../common/schemas.js';
import { tenantPlugin } from '../../common/tenancy.js';
import { TOPIC_KEYS } from '../notifications/topics.js';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, maxlength: 120 },
    phone: { type: String, trim: true }, // E.164, e.g. +919876543210
    email: { type: String, trim: true, lowercase: true },
    // An email typed at sign-up, not yet verified. It becomes `email` once the code sent to it is
    // entered (/users/me/contact/verify): email is a sign-in identifier and links Google accounts.
    pendingEmail: { type: String, trim: true, lowercase: true },
    passwordHash: { type: String, select: false }, // staff/admin accounts only
    roles: { type: [{ type: String, enum: ALL_ROLES }], default: [ROLES.PET_PARENT] },
    permissions: { type: [String], default: [] },
    status: { type: String, enum: ['active', 'suspended', 'deleted'], default: 'active', index: true },
    statusReason: String,
    avatarUrl: String,
    // Home city (a configured city's name and slug, any other Indian city's name without a slug, or
    // free text before any city is configured) and locality.
    city: { type: String, trim: true },
    citySlug: String,
    locality: { type: String, trim: true },
    // Where the user is, for "near me" discovery: from GPS, a place they picked, or their city's centre.
    // Never shown to vendors.
    location: pointSchema,
    locationSource: { type: String, enum: ['gps', 'manual', 'city'] },
    locationUpdatedAt: Date,
    // Reached if the user is unreachable during a procedure. Shown to a vendor only during an accepted booking.
    emergencyContact: { name: String, phone: String },
    addresses: [addressSchema],
    preferences: {
      language: { type: String, default: 'en' },
      notifications: { type: Boolean, default: true },
      // Vaccination alerts and care advice on WhatsApp: opt-in, with the time consent was given.
      whatsapp: { type: Boolean, default: false },
      whatsappConsentAt: Date,
      // Push per topic (see notifications/topics.js); a missing topic counts as on.
      topics: Object.fromEntries(TOPIC_KEYS.map((key) => [key, { type: Boolean, default: true }])),
    },
    // The answer on the "Turn on notifications" screen, so the app knows whether to ask again.
    // `denied` means the phone blocked it: the system prompt will not show again, only phone Settings can turn it on.
    pushPermission: {
      status: { type: String, enum: ['granted', 'denied', 'later'] },
      platform: { type: String, enum: ['android', 'ios', 'web'] },
      answeredAt: Date,
      laterCount: { type: Number, default: 0 },
      askAgainAt: Date,
    },
    deviceTokens: { type: [String], select: false },
    lastLoginAt: Date,
    // Access tokens issued before this are rejected (sign out everywhere, password change, suspension).
    sessionsRevokedAt: Date,
    // Google / Apple accounts linked to this user, by the provider's stable user id (`sub`).
    identities: [{ _id: false, provider: { type: String, enum: ['google', 'apple'], required: true }, subject: { type: String, required: true }, linkedAt: Date }],
    // Consent to the Terms of Service and Privacy Policy (DPDP Act): which version, and when.
    consents: { termsVersion: String, termsAcceptedAt: Date },
    // Referrals and loyalty (see modules/loyalty). The balance only changes with a ledger entry.
    referralCode: String,
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    loyaltyPoints: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

userSchema.plugin(tenantPlugin);
userSchema.index({ tenant: 1, phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } } });
userSchema.index({ tenant: 1, email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
userSchema.index({ tenant: 1, roles: 1 });
userSchema.index({ tenant: 1, referralCode: 1 }, { unique: true, partialFilterExpression: { referralCode: { $type: 'string' } } });
userSchema.index({ tenant: 1, createdAt: -1 });
userSchema.index({ tenant: 1, 'identities.provider': 1, 'identities.subject': 1 }, { unique: true, partialFilterExpression: { 'identities.subject': { $type: 'string' } } });

userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.passwordHash;
    delete ret.deviceTokens;
    return ret;
  },
});

export const User = mongoose.model('User', userSchema);
