import mongoose from 'mongoose';
import { moderationFields } from '../../common/schemas.js';
import { tenantPlugin } from '../../common/tenancy.js';

const { ObjectId } = mongoose.Schema.Types;

const reviewSchema = new mongoose.Schema(
  {
    vendor: { type: ObjectId, ref: 'Vendor', required: true },
    booking: { type: ObjectId, ref: 'Booking', required: true },
    author: { type: ObjectId, ref: 'User', required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    text: { type: String, maxlength: 2000 },
    vendorReply: { text: String, at: Date },
    ...moderationFields,
  },
  { timestamps: true },
);
reviewSchema.plugin(tenantPlugin);
reviewSchema.index({ tenant: 1, booking: 1 }, { unique: true });
reviewSchema.index({ tenant: 1, vendor: 1, status: 1, createdAt: -1 });

export const Review = mongoose.model('Review', reviewSchema);
