import mongoose from 'mongoose';

// Tenants are the one collection that is not itself tenant-scoped. Phase 1 runs a single
// tenant ("nurvia"); Phase 2 white-label pet stores each become a tenant with its own data,
// branding and storefront, isolated by the tenancy plugin.
const tenantSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, match: /^[a-z0-9-]{2,40}$/ },
    name: { type: String, required: true, maxlength: 120 },
    status: { type: String, enum: ['active', 'suspended'], default: 'active' },
    plan: { type: String, default: 'platform' },
    branding: { logoUrl: String, primaryColor: String, appName: String, faviconUrl: String },
    theme: { primaryColor: String, accentColor: String, fontFamily: String },
    business: { legalName: String, phone: String, email: String, address: String, gstin: String },
    storefront: { tagline: { type: String, maxlength: 160 }, about: { type: String, maxlength: 2000 }, heroImageUrl: String },
    // Whether this tenant's business also appears inside Nurvia. The branded channel stays independent either way.
    nurviaVisibility: { listInNurvia: { type: Boolean, default: false }, publishProducts: { type: Boolean, default: false } },
    subscription: { plan: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan' }, status: { type: String, enum: ['trial', 'active', 'past_due', 'cancelled'] }, startedAt: Date, renewsAt: Date },
    settings: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Custom domains (where technically feasible) resolve to this tenant when no X-Tenant header is sent.
    domains: [{ type: String, lowercase: true }],
  },
  { timestamps: true },
);
tenantSchema.index({ domains: 1 });

export const Tenant = mongoose.model('Tenant', tenantSchema);
