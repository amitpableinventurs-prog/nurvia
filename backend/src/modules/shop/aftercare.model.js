import mongoose from 'mongoose';
import { attachmentSchema, moderationFields } from '../../common/schemas.js';
import { tenantPlugin } from '../../common/tenancy.js';

const { ObjectId } = mongoose.Schema.Types;

// Marketplace aftercare: returns and refunds, product reviews, and the wishlist.

export const RETURN_REASONS = ['damaged', 'wrong_item', 'expired', 'not_as_described', 'pet_did_not_like', 'other'];
export const RETURN_STATUSES = ['requested', 'approved', 'rejected', 'picked_up', 'received', 'refunded', 'cancelled'];
export const RETURN_WINDOW_DAYS = 7;

// One request per seller: an order with items from two sellers becomes two return requests.
const returnSchema = new mongoose.Schema(
  {
    code: { type: String, required: true },
    order: { type: ObjectId, ref: 'ShopOrder', required: true },
    orderCode: String,
    user: { type: ObjectId, ref: 'User', required: true },
    seller: { type: ObjectId, ref: 'Vendor', required: true },
    items: [{ _id: false, product: { type: ObjectId, ref: 'Product' }, sku: String, name: String, variantLabel: String, qty: Number, pricePaise: Number }],
    reason: { type: String, enum: RETURN_REASONS, required: true },
    details: { type: String, maxlength: 1000 },
    photos: [attachmentSchema],
    status: { type: String, enum: RETURN_STATUSES, default: 'requested' },
    statusHistory: [{ _id: false, status: String, at: { type: Date, default: Date.now }, by: { type: ObjectId, ref: 'User' }, note: String }],
    // Refund progress is tracked apart from the return itself: an approved return is not yet a refund.
    refund: {
      amountPaise: Number,
      method: { type: String, enum: ['gateway', 'manual'] }, // manual: cash-on-delivery orders refunded by UPI/bank
      status: { type: String, enum: ['none', 'pending', 'processed'], default: 'none' },
      refundId: String,
      at: Date,
    },
    restocked: { type: Boolean, default: false },
  },
  { timestamps: true },
);
returnSchema.plugin(tenantPlugin);
returnSchema.index({ tenant: 1, code: 1 }, { unique: true });
returnSchema.index({ tenant: 1, user: 1, createdAt: -1 });
returnSchema.index({ tenant: 1, seller: 1, status: 1, createdAt: -1 });
returnSchema.index({ tenant: 1, order: 1 });

const productReviewSchema = new mongoose.Schema(
  {
    product: { type: ObjectId, ref: 'Product', required: true },
    order: { type: ObjectId, ref: 'ShopOrder', required: true },
    author: { type: ObjectId, ref: 'User', required: true },
    rating: { type: Number, min: 1, max: 5, required: true },
    title: { type: String, maxlength: 120 },
    text: { type: String, maxlength: 2000 },
    ...moderationFields,
  },
  { timestamps: true },
);
productReviewSchema.plugin(tenantPlugin);
productReviewSchema.index({ tenant: 1, product: 1, author: 1 }, { unique: true });
productReviewSchema.index({ tenant: 1, product: 1, status: 1, createdAt: -1 });

const wishlistSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    items: [{ _id: false, product: { type: ObjectId, ref: 'Product', required: true }, sku: String, addedAt: { type: Date, default: Date.now } }],
  },
  { timestamps: true },
);
wishlistSchema.plugin(tenantPlugin);
wishlistSchema.index({ tenant: 1, user: 1 }, { unique: true });

export const ReturnRequest = mongoose.model('ReturnRequest', returnSchema);
export const ProductReview = mongoose.model('ProductReview', productReviewSchema);
export const Wishlist = mongoose.model('Wishlist', wishlistSchema);
