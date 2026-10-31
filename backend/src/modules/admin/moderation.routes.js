import { Router } from 'express';
import { z } from 'zod';
import { can, requirePermission } from '../../common/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../../common/errors.js';
import { paginate } from '../../common/paginate.js';
import { PERMISSIONS } from '../../common/roles.js';
import { pageQuery, validate } from '../../common/validate.js';
import { AdoptionListing } from '../adoption/adoption.model.js';
import { audit } from '../audit/audit.model.js';
import { Comment, Post } from '../community/community.model.js';
import { CommunityDog } from '../community-dogs/community-dog.model.js';
import { notify } from '../notifications/notify.js';
import { QUARANTINE_REASON, Report, REPORT_TARGETS } from '../reports/report.model.js';
import { refreshVendorRating } from '../reviews/review.routes.js';
import { Review } from '../reviews/review.model.js';
import { ProductReview } from '../shop/aftercare.model.js';
import { refreshProductRating } from '../shop/aftercare.routes.js';
import { User } from '../users/user.model.js';
import { Vendor } from '../vendors/vendor.model.js';

const router = Router();
router.use(requirePermission(PERMISSIONS.CONTENT_MODERATE));

const VISIBILITY = ['visible', 'hidden', 'removed'];

// Each moderatable collection: its model, owner field, allowed statuses and what to show in lists.
const TYPES = {
  posts: { model: Post, owner: 'author', statuses: VISIBILITY, populate: { path: 'author', select: 'name phone' } },
  comments: { model: Comment, owner: 'author', statuses: VISIBILITY, populate: { path: 'author', select: 'name phone' } },
  'product-reviews': {
    model: ProductReview,
    owner: 'author',
    statuses: VISIBILITY,
    populate: [{ path: 'author', select: 'name phone' }, { path: 'product', select: 'name slug' }],
  },
  reviews: {
    model: Review,
    owner: 'author',
    statuses: VISIBILITY,
    populate: [{ path: 'author', select: 'name phone' }, { path: 'vendor', select: 'businessName' }],
  },
  // Drafts are private to their creator until submitted.
  'community-dogs': { model: CommunityDog, owner: 'createdBy', statuses: VISIBILITY, populate: { path: 'createdBy', select: 'name phone' }, filter: { draft: { $ne: true } } },
  'adoption-listings': {
    model: AdoptionListing,
    owner: 'postedBy',
    // Moderators approve (open), reject or remove listings; owners manage the other states.
    statuses: ['open', 'rejected', 'removed'],
    populate: { path: 'postedBy', select: 'name phone' },
  },
};

async function afterChange(type, doc) {
  if (type === 'reviews') await refreshVendorRating(doc.vendor);
  if (type === 'product-reviews') await refreshProductRating(doc.product);
  if (type === 'comments') {
    const visible = await Comment.countDocuments({ post: doc.post, status: 'visible' });
    await Post.updateOne({ _id: doc.post }, { commentCount: visible });
  }
}

router.get(
  '/:type',
  validate({ params: { type: z.enum(Object.keys(TYPES)) }, query: { ...pageQuery, status: z.string().max(30).optional() } }),
  async (req, res) => {
    const { model, populate, filter } = TYPES[req.valid.params.type];
    const { page, limit, status } = req.valid.query;
    res.json(await paginate(model, { ...filter, ...(status && { status }) }, { page, limit, populate }));
  },
);

router.patch(
  '/:type/:id',
  validate({
    params: { type: z.enum(Object.keys(TYPES)), id: z.string().regex(/^[a-f\d]{24}$/i) },
    body: { status: z.string().max(30), reason: z.string().trim().max(500).optional() },
  }),
  async (req, res) => {
    const { type, id } = req.valid.params;
    const { status, reason } = req.valid.body;
    const config = TYPES[type];
    if (!config.statuses.includes(status)) throw badRequest(`Status must be one of ${config.statuses.join(', ')}`);
    if (status !== 'visible' && status !== 'open' && !reason) throw badRequest('A reason is required');

    const doc = await config.model.findOne({ _id: id, ...config.filter });
    if (!doc) throw notFound('Item');
    const previous = doc.status;
    if (type === 'adoption-listings' && status === 'open' && !['pending_review', 'rejected', 'removed'].includes(previous)) {
      throw badRequest(`A ${previous} listing is managed by its owner`);
    }
    doc.status = status;
    doc.moderation = { by: req.user._id, at: new Date(), reason };
    await doc.save();
    await afterChange(type, doc);
    await audit(req, `${type}.${status}`, { type, id: doc._id }, { reason, meta: { previous } });

    if (previous !== status) {
      await notify([doc[config.owner]], {
        type: 'moderation',
        title: status === 'open' ? 'Your adoption listing is live' : `Your ${type.replace(/s$/, '').replace('-', ' ')} was ${status}`,
        body: reason,
        data: { targetType: type, targetId: String(doc._id) },
      });
    }
    res.json(doc);
  },
);

export default router;

// ---- Reports queue ----

const TARGET_MODELS = {
  post: Post,
  comment: Comment,
  review: Review,
  community_dog: CommunityDog,
  adoption_listing: AdoptionListing,
  user: User,
  vendor: Vendor,
};

// Attaches a short preview of each reported item so moderators can triage without opening it.
export async function withTargets(reports) {
  const byType = Object.groupBy(reports, (r) => r.targetType);
  const previews = new Map();
  await Promise.all(
    Object.entries(byType).map(async ([type, items]) => {
      const docs = await TARGET_MODELS[type].find({ _id: { $in: items.map((r) => r.targetId) } })
        .select('text name businessName title description status phone')
        .lean();
      for (const d of docs) previews.set(String(d._id), d);
    }),
  );
  return reports.map((r) => ({ ...r, target: previews.get(String(r.targetId)) ?? null }));
}

export const reportsRouter = Router();
reportsRouter.use(requirePermission(PERMISSIONS.REPORTS_MANAGE));

reportsRouter.get(
  '/',
  validate({
    query: { ...pageQuery, status: z.enum(['open', 'actioned', 'dismissed']).default('open'), targetType: z.enum(REPORT_TARGETS).optional() },
  }),
  async (req, res) => {
    const { page, limit, status, targetType } = req.valid.query;
    const result = await paginate(Report, { status, ...(targetType && { targetType }) }, { page, limit, populate: { path: 'reporter', select: 'name phone' } });
    result.items = await withTargets(result.items);
    res.json(result);
  },
);

reportsRouter.patch(
  '/:id',
  validate({ body: { status: z.enum(['actioned', 'dismissed']), resolution: z.string().trim().min(3).max(500) } }),
  async (req, res) => {
    const report = await Report.findById(req.valid.params.id);
    if (!report) throw notFound('Report');
    report.set({ ...req.valid.body, resolvedBy: req.user._id, resolvedAt: new Date() });
    await report.save();
    await audit(req, `report.${report.status}`, { type: 'report', id: report._id }, { reason: report.resolution });
    if (report.status === 'dismissed' && report.quarantined) await liftQuarantine(report);
    res.json(report);
  },
);

// Content hidden automatically by a trusted report goes back on view once no high-severity
// report on it is still open. Anything a moderator hid by hand stays hidden.
async function liftQuarantine({ targetType, targetId }) {
  const type = MODERATION_TYPE[targetType];
  if (!type || (await Report.exists({ targetType, targetId, status: 'open', severity: 'high' }))) return;
  const doc = await TYPES[type].model.findOne({ _id: targetId, status: 'hidden', 'moderation.reason': QUARANTINE_REASON });
  if (!doc) return;
  doc.status = 'visible';
  doc.moderation = undefined;
  await doc.save();
  await afterChange(type, doc);
}

// Reported item type → moderation collection, for items a moderator can take down directly.
const MODERATION_TYPE = { post: 'posts', comment: 'comments', review: 'reviews', community_dog: 'community-dogs', adoption_listing: 'adoption-listings' };

// One step for the safety queue: take the reported content down, tell its author, and close
// every open report on it.
reportsRouter.post(
  '/:id/enforce',
  validate({ body: { resolution: z.string().trim().min(3).max(500) } }),
  async (req, res) => {
    if (!can(req.user, PERMISSIONS.CONTENT_MODERATE)) throw forbidden(`Missing permission ${PERMISSIONS.CONTENT_MODERATE}`);
    const report = await Report.findById(req.valid.params.id);
    if (!report) throw notFound('Report');
    if (report.status !== 'open') throw conflict(`Report is already ${report.status}`);
    const type = MODERATION_TYPE[report.targetType];
    if (!type) throw badRequest(`Suspend the ${report.targetType} from their page, then mark the report actioned`);

    const { resolution } = req.valid.body;
    const config = TYPES[type];
    const doc = await config.model.findById(report.targetId);
    if (doc && doc.status !== 'removed') {
      const previous = doc.status;
      doc.status = 'removed';
      doc.moderation = { by: req.user._id, at: new Date(), reason: resolution };
      await doc.save();
      await afterChange(type, doc);
      await audit(req, `${type}.removed`, { type, id: doc._id }, { reason: resolution, meta: { previous, report: String(report._id) } });
      await notify([doc[config.owner]], {
        type: 'moderation',
        title: `Your ${type.replace(/s$/, '').replace('-', ' ')} was removed`,
        body: resolution,
        data: { targetType: type, targetId: String(doc._id) },
      });
    }
    const closed = await Report.updateMany(
      { targetType: report.targetType, targetId: report.targetId, status: 'open' },
      { status: 'actioned', resolution, resolvedBy: req.user._id, resolvedAt: new Date() },
    );
    await audit(req, 'report.enforce', { type: 'report', id: report._id }, { reason: resolution, meta: { closedReports: closed.modifiedCount } });
    res.json({ removed: Boolean(doc), closedReports: closed.modifiedCount });
  },
);
