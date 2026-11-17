import mongoose from 'mongoose';
import { pointSchema } from '../../common/schemas.js';
import { tenantPlugin } from '../../common/tenancy.js';

// A city (or metro region) Nurvia operates in. Its status and each city-scoped module's state are
// set by staff in the admin panel, so launching a city needs no code change.
export const MODULE_STATES = ['active', 'coming_soon', 'disabled'];

const moduleState = { type: String, enum: MODULE_STATES, default: 'active' };

const citySchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, lowercase: true, match: /^[a-z0-9-]{2,40}$/ },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    region: { type: String, trim: true, maxlength: 80 }, // state / UT, for display
    // Other names people and addresses use for places inside this city (Gurugram, Noida, …).
    aliases: [{ type: String, trim: true, maxlength: 80 }],
    center: { type: pointSchema, required: true },
    radiusKm: { type: Number, default: 40, min: 1, max: 200 },
    // Neighbourhoods people pick when they do not share their location (Indiranagar, Koramangala…).
    localities: [{ _id: false, name: { type: String, required: true, trim: true, maxlength: 80 }, center: { type: pointSchema, required: true }, popular: { type: Boolean, default: false } }],
    status: { type: String, enum: MODULE_STATES, default: 'coming_soon' },
    modules: { booking: moduleState, marketplace: moduleState },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);
citySchema.plugin(tenantPlugin);
citySchema.index({ tenant: 1, slug: 1 }, { unique: true });

// One document per tenant holding platform-wide switches.
const platformConfigSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'platform' },
    features: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Marketplace payment rules set by staff.
    marketplace: {
      codEnabled: { type: Boolean, default: true },
      codMaxOrderPaise: { type: Number, min: 0, default: 500_000 },
    },
  },
  { timestamps: true, minimize: false },
);
platformConfigSchema.plugin(tenantPlugin);
platformConfigSchema.index({ tenant: 1, key: 1 }, { unique: true });

export const City = mongoose.model('City', citySchema);
export const PlatformConfig = mongoose.model('PlatformConfig', platformConfigSchema);
