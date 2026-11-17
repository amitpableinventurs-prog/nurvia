import mongoose from 'mongoose';
import { tenantPlugin } from '../../common/tenancy.js';

const { ObjectId } = mongoose.Schema.Types;

// Workspace features a vendor plan switches on. A vendor on a plan without one keeps reading what
// it already has, but cannot add to it (see requirePlanFeature in subscription.service.js).
export const PLAN_FEATURES = [
  { key: 'crm', label: 'CRM & follow-ups', description: 'Customer notes and follow-up reminders' },
  { key: 'visit_records', label: 'Visit records', description: 'Vet, grooming, boarding, walk and training reports shared with pet owners' },
  { key: 'marketplace', label: 'Marketplace selling', description: 'Adding products to sell in the Nurvia shop' },
  { key: 'packages', label: 'Service packages', description: 'Creating and selling multi-session packages' },
];
export const PLAN_FEATURE_KEYS = PLAN_FEATURES.map((f) => f.key);

// Counted limits. Empty (null) means unlimited; 0 means none at all.
export const PLAN_LIMIT_KEYS = ['staff', 'services', 'products', 'customers', 'storefronts'];

// Plan prices exclude GST, which is added at checkout.
export const GST_RATE_PCT = 18;
export const PLAN_TERMS_MONTHS = [1, 12];

// SaaS plans, set up by Nurvia staff. Like tenants, plans are platform-wide rather than
// tenant-scoped: a white-label tenant itself subscribes to one.
const planSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, lowercase: true, match: /^[a-z0-9-]{2,40}$/ },
    name: { type: String, required: true, maxlength: 80 },
    audience: { type: String, enum: ['vendor', 'tenant'], required: true },
    description: { type: String, maxlength: 500 },
    // The free plan: every vendor without a running paid plan is on it, including when one expires.
    isFree: { type: Boolean, default: false },
    monthlyPricePaise: { type: Number, required: true, min: 0 },
    yearlyPricePaise: { type: Number, required: true, min: 0 },
    // Selling points for the pricing page, e.g. "Staff calendar for 10".
    highlights: [{ type: String, maxlength: 120 }],
    features: [{ type: String, enum: PLAN_FEATURE_KEYS }],
    limits: Object.fromEntries(PLAN_LIMIT_KEYS.map((k) => [k, { type: Number, min: 0, default: null }])),
    active: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);
// One free plan per audience.
planSchema.index({ audience: 1 }, { unique: true, partialFilterExpression: { isFree: true } });

// A vendor buying 1 or 12 months of a plan. Amounts and the GST split are fixed when the order is
// created, so the invoice matches what the vendor was charged.
const subscriptionOrderSchema = new mongoose.Schema(
  {
    code: { type: String, required: true },
    vendor: { type: ObjectId, ref: 'Vendor', required: true },
    plan: { type: ObjectId, ref: 'Plan', required: true },
    planName: { type: String, required: true },
    months: { type: Number, enum: PLAN_TERMS_MONTHS, required: true },
    amounts: {
      basePaise: { type: Number, required: true, min: 0 },
      gstRatePct: { type: Number, required: true },
      cgstPaise: { type: Number, default: 0 },
      sgstPaise: { type: Number, default: 0 },
      igstPaise: { type: Number, default: 0 },
      totalPaise: { type: Number, required: true, min: 0 },
    },
    supplierState: String, // two-digit GST state codes
    recipientState: String,
    status: { type: String, enum: ['created', 'paid', 'failed'], default: 'created' },
    payment: { gateway: String, orderId: String, paymentId: String, paidAt: Date, failureReason: String },
    period: { from: Date, to: Date },
    invoice: { type: ObjectId, ref: 'SubscriptionInvoice' },
    createdBy: { type: ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);
subscriptionOrderSchema.plugin(tenantPlugin);
subscriptionOrderSchema.index({ tenant: 1, 'payment.orderId': 1 });
subscriptionOrderSchema.index({ tenant: 1, vendor: 1, createdAt: -1 });

// A GST tax invoice for a paid subscription order. Numbered per financial year, e.g. NUR/26-27/000042.
const subscriptionInvoiceSchema = new mongoose.Schema(
  {
    number: { type: String, required: true },
    issuedAt: { type: Date, required: true },
    vendor: { type: ObjectId, ref: 'Vendor', required: true },
    order: { type: ObjectId, ref: 'SubscriptionOrder', required: true },
    supplier: { legalName: String, address: String, gstin: String, stateCode: String, email: String, phone: String },
    recipient: { name: String, address: String, gstin: String, stateCode: String },
    placeOfSupply: String,
    lines: [
      {
        _id: false,
        description: { type: String, required: true },
        sac: String,
        periodFrom: Date,
        periodTo: Date,
        taxablePaise: { type: Number, required: true },
      },
    ],
    taxablePaise: { type: Number, required: true },
    gstRatePct: { type: Number, required: true },
    cgstPaise: { type: Number, default: 0 },
    sgstPaise: { type: Number, default: 0 },
    igstPaise: { type: Number, default: 0 },
    totalPaise: { type: Number, required: true },
    payment: { gateway: String, paymentId: String, paidAt: Date },
  },
  { timestamps: true },
);
subscriptionInvoiceSchema.plugin(tenantPlugin);
subscriptionInvoiceSchema.index({ tenant: 1, number: 1 }, { unique: true });
subscriptionInvoiceSchema.index({ tenant: 1, vendor: 1, issuedAt: -1 });
subscriptionInvoiceSchema.index({ tenant: 1, issuedAt: -1 });

// Gap-free invoice numbering: one counter per tenant and financial year.
const invoiceCounterSchema = new mongoose.Schema({ key: { type: String, required: true }, seq: { type: Number, default: 0 } });
invoiceCounterSchema.plugin(tenantPlugin);
invoiceCounterSchema.index({ tenant: 1, key: 1 }, { unique: true });

export const Plan = mongoose.model('Plan', planSchema);
export const SubscriptionOrder = mongoose.model('SubscriptionOrder', subscriptionOrderSchema);
export const SubscriptionInvoice = mongoose.model('SubscriptionInvoice', subscriptionInvoiceSchema);
export const InvoiceCounter = mongoose.model('InvoiceCounter', invoiceCounterSchema);
