import mongoose from 'mongoose';
import { pointSchema } from '../../common/schemas.js';
import { tenantPlugin } from '../../common/tenancy.js';

const { ObjectId } = mongoose.Schema.Types;

export const STOCK_CHECK_STATUSES = ['pending', 'available', 'partial', 'unavailable'];

// "Check Rx stock": a customer asks a pharmacy whether it has a medicine or prescription diet in
// stock before travelling; the pharmacy answers in the partner app.
const stockCheckSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    vendor: { type: ObjectId, ref: 'Vendor', required: true },
    pet: { type: ObjectId, ref: 'Pet' },
    items: { type: String, required: true, trim: true, maxlength: 500 }, // "Apoquel 16 mg × 30"
    status: { type: String, enum: STOCK_CHECK_STATUSES, default: 'pending' },
    reply: { type: String, trim: true, maxlength: 500 },
    // How long the pharmacy keeps the items aside for the customer.
    holdUntil: Date,
    repliedAt: Date,
    repliedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
stockCheckSchema.plugin(tenantPlugin);
stockCheckSchema.index({ tenant: 1, vendor: 1, status: 1, createdAt: -1 });
stockCheckSchema.index({ tenant: 1, user: 1, createdAt: -1 });

// "Get notified for your locality": people waiting for in-app shopping to reach their area.
const waitlistSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    locality: { type: String, required: true, trim: true, maxlength: 80 },
    city: { type: String, trim: true, maxlength: 80 }, // the configured city's name, when matched
    citySlug: String,
    location: pointSchema,
    notifiedAt: Date,
  },
  { timestamps: true },
);
waitlistSchema.plugin(tenantPlugin);
waitlistSchema.index({ tenant: 1, user: 1 }, { unique: true });
waitlistSchema.index({ tenant: 1, citySlug: 1, notifiedAt: 1 });

// Calls placed to a shop from the directory, so the shop can see what Nurvia sends its way.
const shopCallSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    vendor: { type: ObjectId, ref: 'Vendor', required: true },
    masked: Boolean,
  },
  { timestamps: true },
);
shopCallSchema.plugin(tenantPlugin);
shopCallSchema.index({ tenant: 1, vendor: 1, createdAt: -1 });
shopCallSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 86_400 });

export const StockCheck = mongoose.model('StockCheck', stockCheckSchema);
export const MarketplaceWaitlist = mongoose.model('MarketplaceWaitlist', waitlistSchema);
export const ShopCall = mongoose.model('ShopCall', shopCallSchema);
