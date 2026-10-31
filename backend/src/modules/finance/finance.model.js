import mongoose from 'mongoose';
import { tenantPlugin } from '../../common/tenancy.js';

const { ObjectId } = mongoose.Schema.Types;

// Commission and settlements (Phase 2). Rates are configurable; payout cadence, reserve periods and
// automatic split payments are not specified, so staff generate, approve and mark settlements paid.

const commissionSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'default' },
    bookingPct: { type: Number, min: 0, max: 50, default: 10 },
    marketplacePct: { type: Number, min: 0, max: 50, default: 12 },
    // Per product or vendor category, e.g. a lower rate for pet food.
    categoryOverrides: [{ _id: false, category: { type: ObjectId, ref: 'Category', required: true }, pct: { type: Number, min: 0, max: 50, required: true } }],
    updatedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
commissionSchema.plugin(tenantPlugin);
commissionSchema.index({ tenant: 1, key: 1 }, { unique: true });

export const SETTLEMENT_STATUSES = ['draft', 'approved', 'paid', 'void'];

const lineSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['booking', 'order', 'return_refund'], required: true },
    ref: { type: ObjectId, required: true },
    code: String,
    date: Date,
    // Who holds the customer's money: Nurvia (online payments) or the seller (cash on delivery).
    collectedBy: { type: String, enum: ['nurvia', 'seller'], required: true },
    grossPaise: { type: Number, required: true }, // negative for refunds
    commissionPct: Number,
    commissionPaise: { type: Number, required: true }, // negative when a refund reverses commission
    netPaise: { type: Number, required: true }, // what Nurvia owes the vendor for this line (negative: vendor owes)
  },
  { _id: false },
);

const settlementSchema = new mongoose.Schema(
  {
    code: { type: String, required: true },
    vendor: { type: ObjectId, ref: 'Vendor', required: true },
    periodFrom: { type: Date, required: true },
    periodTo: { type: Date, required: true },
    lines: [lineSchema],
    totals: { grossPaise: Number, commissionPaise: Number, refundsPaise: Number, netPaise: Number, lineCount: Number },
    status: { type: String, enum: SETTLEMENT_STATUSES, default: 'draft' },
    statusHistory: [{ _id: false, status: String, at: { type: Date, default: Date.now }, by: { type: ObjectId, ref: 'User' }, note: String }],
    payoutReference: String, // UTR / bank reference once paid
    paidAt: Date,
    note: String,
  },
  { timestamps: true },
);
settlementSchema.plugin(tenantPlugin);
settlementSchema.index({ tenant: 1, code: 1 }, { unique: true });
settlementSchema.index({ tenant: 1, vendor: 1, periodFrom: -1 });
settlementSchema.index({ tenant: 1, status: 1, createdAt: -1 });

// One row per booking, order share or refund that has been put in a settlement, so nothing is
// settled twice. Voiding a settlement deletes its entries and frees them for the next run.
const entrySchema = new mongoose.Schema(
  {
    vendor: { type: ObjectId, ref: 'Vendor', required: true },
    kind: { type: String, required: true },
    ref: { type: ObjectId, required: true },
    settlement: { type: ObjectId, ref: 'Settlement', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
entrySchema.plugin(tenantPlugin);
entrySchema.index({ tenant: 1, vendor: 1, kind: 1, ref: 1 }, { unique: true });
entrySchema.index({ tenant: 1, settlement: 1 });

export const CommissionConfig = mongoose.model('CommissionConfig', commissionSchema);
export const Settlement = mongoose.model('Settlement', settlementSchema);
export const SettlementEntry = mongoose.model('SettlementEntry', entrySchema);
