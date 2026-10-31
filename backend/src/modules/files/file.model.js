import mongoose from 'mongoose';
import { tenantPlugin } from '../../common/tenancy.js';

const fileSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    purpose: {
      type: String,
      enum: ['pet_photo', 'health_record', 'vendor_kyc', 'vendor_photo', 'community', 'adoption', 'avatar', 'visit_report', 'sos', 'seller_kyc', 'banner'],
      required: true,
    },
    visibility: { type: String, enum: ['public', 'private'], required: true },
    key: { type: String, required: true, unique: true },
    url: String, // set for public files only
    originalName: String,
    mime: { type: String, required: true },
    size: { type: Number, required: true },
  },
  { timestamps: true },
);
fileSchema.plugin(tenantPlugin);

export const File = mongoose.model('File', fileSchema);
