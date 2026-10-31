import mongoose from 'mongoose';
import { tenantPlugin } from '../../common/tenancy.js';

const { ObjectId } = mongoose.Schema.Types;

// Referrals and loyalty points (Phase 2). The balance lives on the user (User.loyaltyPoints) and
// moves only together with a ledger entry, so it can always be explained and rebuilt.

const configSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'default' },
    enabled: { type: Boolean, default: true },
    earnPointsPer100Rupees: { type: Number, min: 0, max: 100, default: 1 },
    referrerPoints: { type: Number, min: 0, max: 100_000, default: 100 },
    refereePoints: { type: Number, min: 0, max: 100_000, default: 50 },
    pointValuePaise: { type: Number, min: 1, max: 10_000, default: 100 }, // 1 point = ₹1 by default
    maxRedeemPct: { type: Number, min: 0, max: 100, default: 20 }, // of the order value after coupons
    referralWindowDays: { type: Number, min: 1, max: 90, default: 14 }, // how soon after sign-up a code can be applied
  },
  { timestamps: true },
);
configSchema.plugin(tenantPlugin);
configSchema.index({ tenant: 1, key: 1 }, { unique: true });

export const LEDGER_REASONS = ['booking_completed', 'order_delivered', 'referral_referrer', 'referral_referee', 'redeemed', 'redemption_reversed', 'earn_reversed', 'admin_adjust'];

const ledgerSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    points: { type: Number, required: true }, // positive earns, negative spends
    reason: { type: String, enum: LEDGER_REASONS, required: true },
    refType: String, // booking, shop_order, referral
    ref: ObjectId,
    note: String,
    by: { type: ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
ledgerSchema.plugin(tenantPlugin);
ledgerSchema.index({ tenant: 1, user: 1, createdAt: -1 });
// An activity earns once: the same booking or order can never credit points twice.
ledgerSchema.index({ tenant: 1, user: 1, reason: 1, ref: 1 }, { unique: true, partialFilterExpression: { reason: { $in: ['booking_completed', 'order_delivered', 'referral_referrer', 'referral_referee'] } } });

const referralSchema = new mongoose.Schema(
  {
    referrer: { type: ObjectId, ref: 'User', required: true },
    referee: { type: ObjectId, ref: 'User', required: true },
    code: String,
    status: { type: String, enum: ['pending', 'rewarded', 'void'], default: 'pending' },
    rewardedAt: Date,
    qualifyingRef: { type: { type: String }, id: ObjectId },
  },
  { timestamps: true },
);
referralSchema.plugin(tenantPlugin);
referralSchema.index({ tenant: 1, referee: 1 }, { unique: true });
referralSchema.index({ tenant: 1, referrer: 1, createdAt: -1 });

export const LoyaltyConfig = mongoose.model('LoyaltyConfig', configSchema);
export const LoyaltyEntry = mongoose.model('LoyaltyEntry', ledgerSchema);
export const Referral = mongoose.model('Referral', referralSchema);
