import mongoose from 'mongoose';

// Shared sub-schemas reused across modules.

export const pointSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: {
      type: [Number], // [lng, lat]
      validate: { validator: (c) => c.length === 2, message: 'coordinates must be [lng, lat]' },
    },
  },
  { _id: false },
);

export const addressSchema = new mongoose.Schema(
  {
    label: String,
    line1: { type: String, required: true },
    line2: String,
    city: { type: String, required: true },
    state: String,
    pincode: String,
    location: pointSchema,
  },
  { _id: true },
);

export const attachmentSchema = new mongoose.Schema(
  {
    file: { type: mongoose.Schema.Types.ObjectId, ref: 'File', required: true },
    url: String,
    name: String,
    mime: String,
  },
  { _id: false },
);

export const moderationFields = {
  status: { type: String, enum: ['visible', 'hidden', 'removed'], default: 'visible', index: true },
  moderation: {
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at: Date,
    reason: String,
  },
};
