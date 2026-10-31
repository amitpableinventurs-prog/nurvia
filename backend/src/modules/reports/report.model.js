import mongoose from 'mongoose';
import { tenantPlugin } from '../../common/tenancy.js';

const { ObjectId } = mongoose.Schema.Types;

export const REPORT_TARGETS = ['post', 'comment', 'review', 'community_dog', 'adoption_listing', 'user', 'vendor'];
export const REPORT_REASONS = ['spam', 'abuse', 'harassment', 'animal_cruelty', 'harmful_advice', 'fraud', 'misinformation', 'inappropriate', 'other'];

// Severity decides the order of the safety queue. Animal harm and unsafe health or medication
// advice are high: a pet can be hurt before a moderator gets to them.
export const SEVERITY_BY_REASON = {
  animal_cruelty: 'high',
  harmful_advice: 'high',
  fraud: 'medium',
  harassment: 'medium',
  abuse: 'medium',
  misinformation: 'medium',
  spam: 'low',
  inappropriate: 'low',
  other: 'low',
};
export const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };
export const QUARANTINE_REASON = 'Auto-quarantined pending safety review';

const reportSchema = new mongoose.Schema(
  {
    targetType: { type: String, enum: REPORT_TARGETS, required: true },
    targetId: { type: ObjectId, required: true },
    reporter: { type: ObjectId, ref: 'User', required: true },
    reason: { type: String, enum: REPORT_REASONS, required: true },
    details: { type: String, maxlength: 1000 },
    severity: { type: String, enum: ['high', 'medium', 'low'], default: 'low' },
    // Set when this report hid the reported content until a moderator decides.
    quarantined: { type: Boolean, default: false },
    status: { type: String, enum: ['open', 'actioned', 'dismissed'], default: 'open' },
    resolution: String,
    resolvedBy: { type: ObjectId, ref: 'User' },
    resolvedAt: Date,
  },
  { timestamps: true },
);
reportSchema.plugin(tenantPlugin);
reportSchema.index({ tenant: 1, status: 1, createdAt: -1 });
reportSchema.index({ tenant: 1, targetType: 1, targetId: 1, reporter: 1 }, { unique: true });

export const Report = mongoose.model('Report', reportSchema);
