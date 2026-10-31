import mongoose from 'mongoose';
import { tenantPlugin } from '../../common/tenancy.js';

const otpChallengeSchema = new mongoose.Schema(
  {
    channel: { type: String, enum: ['sms', 'whatsapp', 'voice', 'email'], required: true },
    target: { type: String, required: true },
    codeHash: { type: String, required: true },
    // signup: verify a new phone before registration. login: verify a registered phone.
    // contact: adding a number or email to a signed-in account; it never signs anyone in.
    purpose: { type: String, enum: ['signup', 'login', 'contact'], default: 'login' },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
otpChallengeSchema.plugin(tenantPlugin);
otpChallengeSchema.index({ tenant: 1, target: 1, createdAt: -1 });
otpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// One row per OTP sent, kept for an hour, so a number or email cannot be flooded with codes
// (each send costs an SMS) or given unlimited fresh codes to guess.
const otpSendSchema = new mongoose.Schema({ target: { type: String, required: true } }, { timestamps: { createdAt: true, updatedAt: false } });
otpSendSchema.plugin(tenantPlugin);
otpSendSchema.index({ tenant: 1, target: 1, createdAt: -1 });
otpSendSchema.index({ createdAt: 1 }, { expireAfterSeconds: 3600 });

const signupGrantSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    phone: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
signupGrantSchema.plugin(tenantPlugin);
signupGrantSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// A sign-in is a session (`family`). Each refresh replaces the session's token with a new one,
// so a session's active token is the one with no revokedAt.
const refreshTokenSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    family: { type: String, index: true },
    sessionStartedAt: Date,
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
    revokeReason: { type: String, enum: ['rotated', 'logout', 'revoked', 'reuse'] },
    replacedBy: String,
    userAgent: String,
  },
  { timestamps: true },
);
refreshTokenSchema.plugin(tenantPlugin);
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OtpChallenge = mongoose.model('OtpChallenge', otpChallengeSchema);
export const OtpSend = mongoose.model('OtpSend', otpSendSchema);
export const SignupGrant = mongoose.model('SignupGrant', signupGrantSchema);
export const RefreshToken = mongoose.model('RefreshToken', refreshTokenSchema);
