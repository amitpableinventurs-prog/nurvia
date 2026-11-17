import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../common/auth.js';
import { badRequest, conflict, notFound } from '../../common/errors.js';
import { paginate } from '../../common/paginate.js';
import { PERMISSIONS } from '../../common/roles.js';
import { escapeRegex, pageQuery, validate } from '../../common/validate.js';
import { audit } from '../audit/audit.model.js';
import { Category } from '../categories/category.model.js';
import { notify } from '../notifications/notify.js';
import { Service, Vendor, licenseStatus } from '../vendors/vendor.model.js';

const router = Router();

router.get(
  '/vendors',
  requirePermission(PERMISSIONS.VENDORS_READ),
  validate({
    query: {
      ...pageQuery,
      q: z.string().trim().max(80).optional(),
      status: z.enum(['pending', 'active', 'rejected', 'suspended']).optional(),
      kycStatus: z.enum(['not_submitted', 'submitted', 'approved', 'rejected']).optional(),
      city: z.string().trim().max(80).optional(),
    },
  }),
  async (req, res) => {
    const { page, limit, q, status, kycStatus, city } = req.valid.query;
    const filter = {
      ...(status && { status }),
      ...(kycStatus && { 'kyc.status': kycStatus }),
      ...(q && { businessName: { $regex: escapeRegex(q), $options: 'i' } }),
      ...(city && { 'address.city': { $regex: `^${escapeRegex(city)}$`, $options: 'i' } }),
    };
    res.json(
      await paginate(Vendor, filter, {
        page,
        limit,
        sort: { 'kyc.submittedAt': -1, createdAt: -1 },
        populate: [{ path: 'owner', select: 'name phone email' }, { path: 'categories', select: 'name' }],
      }),
    );
  },
);

router.get('/vendors/:id', requirePermission(PERMISSIONS.VENDORS_READ), validate(), async (req, res) => {
  const vendor = await Vendor.findById(req.valid.params.id)
    .populate([{ path: 'owner', select: 'name phone email status' }, { path: 'categories', select: 'name' }, { path: 'kyc.reviewedBy', select: 'name' }])
    .lean();
  if (!vendor) throw notFound('Vendor');
  const services = await Service.find({ vendor: vendor._id }).lean();
  res.json({ ...vendor, licenseStatus: licenseStatus(vendor.kyc), services });
});

// Records the outcome of checking the uploaded trade licence against the issuing authority.
router.post(
  '/vendors/:id/license-check',
  requirePermission(PERMISSIONS.VENDORS_REVIEW),
  validate({ body: { result: z.enum(['verified', 'failed']), note: z.string().trim().max(500).optional() } }),
  async (req, res) => {
    const { result, note } = req.valid.body;
    const vendor = await Vendor.findById(req.valid.params.id);
    if (!vendor) throw notFound('Vendor');
    if (licenseStatus(vendor.kyc) === 'pending_upload') throw conflict('The vendor has not uploaded a trade or veterinary licence');
    if (result === 'failed' && !note) throw badRequest('Say what did not match');
    vendor.kyc.licenseCheck = { status: result, note, by: req.user._id, at: new Date() };
    await vendor.save();
    await audit(req, `vendor.license_${result}`, { type: 'vendor', id: vendor._id }, { reason: note });
    res.json({ _id: vendor._id, licenseStatus: licenseStatus(vendor.kyc), licenseCheck: vendor.kyc.licenseCheck });
  },
);

// approve/reject decide a pending application; suspend/reactivate apply to live vendors.
const REVIEW = {
  approve: { from: ['pending'], status: 'active', kyc: 'approved', message: 'Your business is approved and now visible on Nurvia' },
  reject: { from: ['pending'], status: 'rejected', kyc: 'rejected', message: 'Your vendor application needs changes' },
  suspend: { from: ['active'], status: 'suspended', message: 'Your business listing has been suspended' },
  reactivate: { from: ['suspended'], status: 'active', message: 'Your business listing is active again' },
};

router.post(
  '/vendors/:id/review',
  requirePermission(PERMISSIONS.VENDORS_REVIEW),
  validate({ body: { action: z.enum(Object.keys(REVIEW)), reason: z.string().trim().max(500).optional() } }),
  async (req, res) => {
    const { action, reason } = req.valid.body;
    const rule = REVIEW[action];
    const vendor = await Vendor.findById(req.valid.params.id);
    if (!vendor) throw notFound('Vendor');
    if (!rule.from.includes(vendor.status)) throw conflict(`Cannot ${action} a vendor that is ${vendor.status}`);
    if (action === 'approve' && vendor.kyc.status !== 'submitted') throw conflict('The vendor has not submitted KYC documents');
    if (action !== 'approve' && action !== 'reactivate' && !reason) throw badRequest('A reason is required');
    // Going live without a checked licence is allowed (some walkers and sitters have none), but the
    // reviewer has to say why, and the reason lands in the audit log.
    const license = licenseStatus(vendor.kyc);
    if (action === 'approve' && license !== 'verified' && !reason) {
      throw badRequest('The trade licence has not been verified. Check it first, or give a reason for approving without it');
    }

    vendor.status = rule.status;
    vendor.statusReason = reason;
    if (rule.kyc) {
      vendor.kyc.status = rule.kyc;
      vendor.kyc.reviewedAt = new Date();
      vendor.kyc.reviewedBy = req.user._id;
      vendor.kyc.rejectionReason = action === 'reject' ? reason : undefined;
    }
    await vendor.save();
    await audit(req, `vendor.${action}`, { type: 'vendor', id: vendor._id }, { reason, meta: { licenseStatus: license } });
    await notify([vendor.owner], { type: `vendor.${action}`, title: rule.message, body: reason, data: { vendorId: String(vendor._id) } });
    res.json(vendor);
  },
);

// ---- Categories ----

const categoryBody = {
  kind: z.enum(['vendor', 'service', 'product']),
  name: z.string().trim().min(1).max(80),
  slug: z.string().trim().regex(/^[a-z0-9-]+$/),
  parent: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  icon: z.string().max(200).optional(),
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional(),
  // Product categories: days after delivery a return can be asked for (0: not returnable).
  returnWindowDays: z.number().int().min(0).max(60).nullable().optional(),
};

// Product categories nest at most 3 levels deep (Dogs › Food › Dry food), and never under themselves.
const MAX_CATEGORY_DEPTH = 3;
async function checkParent(kind, parentId, selfId) {
  if (!parentId) return;
  let depth = 1;
  let current = await Category.findById(parentId).select('kind parent').lean();
  if (!current) throw badRequest('Unknown parent category');
  if (current.kind !== kind) throw badRequest('A category can only sit under a category of the same kind');
  while (current) {
    if (selfId && String(current._id) === String(selfId)) throw badRequest('A category cannot sit under itself');
    depth++;
    current = current.parent ? await Category.findById(current.parent).select('parent').lean() : null;
  }
  // Levels below the moved category count too.
  let below = 0;
  let level = selfId ? [selfId] : [];
  while (level.length) {
    level = (await Category.find({ parent: { $in: level } }).select('_id').lean()).map((c) => c._id);
    if (level.length) below++;
  }
  if (depth + below > MAX_CATEGORY_DEPTH) throw badRequest(`Categories can be at most ${MAX_CATEGORY_DEPTH} levels deep`);
}

router.get('/categories', requirePermission(PERMISSIONS.VENDORS_READ), validate({ query: { kind: categoryBody.kind.optional() } }), async (req, res) => {
  const { kind } = req.valid.query;
  res.json(await Category.find(kind ? { kind } : {}).sort({ kind: 1, sortOrder: 1, name: 1 }).lean());
});

router.post('/categories', requirePermission(PERMISSIONS.CATEGORIES_MANAGE), validate({ body: categoryBody }), async (req, res) => {
  await checkParent(req.valid.body.kind, req.valid.body.parent);
  const category = await Category.create({ ...req.valid.body, returnWindowDays: req.valid.body.returnWindowDays ?? undefined });
  await audit(req, 'category.create', { type: 'category', id: category._id });
  res.status(201).json(category);
});

router.patch(
  '/categories/:id',
  requirePermission(PERMISSIONS.CATEGORIES_MANAGE),
  validate({ body: Object.fromEntries(Object.entries(categoryBody).filter(([k]) => k !== 'kind').map(([k, v]) => [k, v.optional()])) }),
  async (req, res) => {
    const existing = await Category.findById(req.valid.params.id).select('kind').lean();
    if (!existing) throw notFound('Category');
    await checkParent(existing.kind, req.valid.body.parent, existing._id);
    const { returnWindowDays, ...rest } = req.valid.body;
    const update = { ...rest, ...(returnWindowDays !== undefined && (returnWindowDays === null ? { $unset: { returnWindowDays: 1 } } : { returnWindowDays })) };
    const category = await Category.findByIdAndUpdate(req.valid.params.id, update, { new: true, runValidators: true });
    if (!category) throw notFound('Category');
    await audit(req, 'category.update', { type: 'category', id: category._id }, { meta: req.valid.body });
    res.json(category);
  },
);

export default router;
