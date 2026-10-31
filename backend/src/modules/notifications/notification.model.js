import mongoose from 'mongoose';
import { tenantPlugin } from '../../common/tenancy.js';

const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true }, // booking.created, reminder.due, announcement, ...
    title: { type: String, required: true },
    body: String,
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    readAt: Date,
  },
  { timestamps: true },
);
notificationSchema.plugin(tenantPlugin);
notificationSchema.index({ tenant: 1, user: 1, createdAt: -1 });
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 86_400 });

const announcementSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, maxlength: 120 },
    body: { type: String, required: true, maxlength: 2000 },
    audience: { type: String, enum: ['all', 'pet_parents', 'vendors'], default: 'all' },
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    recipientCount: Number,
  },
  { timestamps: true },
);
announcementSchema.plugin(tenantPlugin);

export const Notification = mongoose.model('Notification', notificationSchema);
export const Announcement = mongoose.model('Announcement', announcementSchema);
