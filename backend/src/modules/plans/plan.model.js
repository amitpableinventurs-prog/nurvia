import mongoose from 'mongoose';

// SaaS subscription plans (Phase 2), set up by Nurvia staff. Like tenants, plans are platform-wide
// rather than tenant-scoped: a white-label tenant itself subscribes to one. Billing and collection
// mechanics are not specified yet, so a subscription records the plan and its dates only.
const planSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, lowercase: true, match: /^[a-z0-9-]{2,40}$/ },
    name: { type: String, required: true, maxlength: 80 },
    audience: { type: String, enum: ['vendor', 'tenant'], required: true },
    description: { type: String, maxlength: 500 },
    pricePaise: { type: Number, required: true, min: 0 },
    interval: { type: String, enum: ['month', 'year'], default: 'month' },
    trialDays: { type: Number, min: 0, max: 90, default: 0 },
    features: [{ type: String, maxlength: 120 }],
    // Empty means unlimited.
    limits: { staff: Number, customers: Number, products: Number, storefronts: Number },
    active: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export const Plan = mongoose.model('Plan', planSchema);
