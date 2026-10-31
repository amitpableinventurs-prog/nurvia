import { Router } from 'express';
import { z } from 'zod';
import { authenticate, hasRole } from '../../common/auth.js';
import { ADMIN_PANEL_ROLES } from '../../common/roles.js';
import { objectId, validate } from '../../common/validate.js';
import { Comment, Post } from '../community/community.model.js';
import { Vendor } from '../vendors/vendor.model.js';
import { QUARANTINE_REASON, REPORT_REASONS, REPORT_TARGETS, Report, SEVERITY_BY_REASON } from './report.model.js';

const router = Router();

// Feed content that a trusted reporter can pull from view straight away.
const QUARANTINABLE = { post: Post, comment: Comment };

// Staff, and verified providers (vets, groomers) whose listing is live, are trusted to flag
// dangerous content; one of their high-severity reports hides it until a moderator decides.
async function isTrustedReporter(user) {
  if (hasRole(user, ...ADMIN_PANEL_ROLES)) return true;
  return Boolean(await Vendor.exists({ owner: user._id, status: 'active' }));
}

// Reporting the same item twice is idempotent rather than an error.
router.post(
  '/',
  authenticate,
  validate({
    body: {
      targetType: z.enum(REPORT_TARGETS),
      targetId: objectId,
      reason: z.enum(REPORT_REASONS),
      details: z.string().trim().max(1000).optional(),
    },
  }),
  async (req, res) => {
    const { targetType, targetId, reason, details } = req.valid.body;
    const severity = SEVERITY_BY_REASON[reason];
    const result = await Report.updateOne(
      { targetType, targetId, reporter: req.user._id },
      { $setOnInsert: { reason, details, severity, status: 'open' } },
      { upsert: true },
    );

    const model = QUARANTINABLE[targetType];
    if (result.upsertedCount && severity === 'high' && model && (await isTrustedReporter(req.user))) {
      const hidden = await model.updateOne({ _id: targetId, status: 'visible' }, { status: 'hidden', moderation: { at: new Date(), reason: QUARANTINE_REASON } });
      if (hidden.modifiedCount) {
        await Report.updateOne({ _id: result.upsertedId }, { quarantined: true });
        if (targetType === 'comment') {
          const comment = await Comment.findById(targetId).select('post').lean();
          const visible = await Comment.countDocuments({ post: comment.post, status: 'visible' });
          await Post.updateOne({ _id: comment.post }, { commentCount: visible });
        }
      }
    }
    res.status(202).json({ received: true });
  },
);

export default router;
