import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../common/auth.js';
import { encrypt } from '../../common/crypto.js';
import { badRequest, conflict, notFound } from '../../common/errors.js';
import { paginate } from '../../common/paginate.js';
import { PERMISSIONS, ROLES } from '../../common/roles.js';
import { objectId, pageQuery, validate } from '../../common/validate.js';
import { audit } from '../audit/audit.model.js';
import { Category } from '../categories/category.model.js';
import { attachmentsFor } from '../files/file.routes.js';
import { notify } from '../notifications/notify.js';
import { requireCapability, vendorWorkspace } from '../operations/operations.service.js';
import { User } from '../users/user.model.js';
import { Vendor } from '../vendors/vendor.model.js';
import { CommissionConfig, SETTLEMENT_STATUSES, Settlement, SettlementEntry } from './finance.model.js';
import { buildLines, commissionConfig, createSettlement, totalsOf, vendorsWithActivity } from './finance.service.js';

const P = PERMISSIONS;
const reason = z.string().trim().min(3).max(500);
const period = { from: z.coerce.date(), to: z.coerce.date() };
const checkPeriod = ({ from, to }) => {
  if (to <= from) throw badRequest('"to" must be after "from"');
  if (to > new Date(Date.now() + 86_400_000)) throw badRequest('A settlement period cannot end in the future');
};

// ---- Seller onboarding (mounted inside /shop/seller) ----

export const sellerOnboardingRouter = Router();

const sellerBody = {
  legalName: z.string().trim().min(2).max(160),
  gstin: z.string().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/, 'Invalid GSTIN'),
  pan: z.string().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'Invalid PAN').optional(),
  bank: z.object({
    accountName: z.string().trim().min(2).max(120),
    accountNumber: z.string().regex(/^\d{9,18}$/, 'Account number must be 9 to 18 digits'),
    ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC'),
  }),
  pickupAddress: z.object({
    line1: z.string().trim().min(3).max(200),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(2).max(80),
    state: z.string().trim().max(80).optional(),
    pincode: z.string().regex(/^\d{6}$/),
    phone: z.string().trim().max(20).optional(),
  }),
  documents: z.array(z.object({ type: z.enum(['gst_certificate', 'pan', 'cancelled_cheque', 'shop_license', 'other']), fileId: objectId })).min(1).max(10),
};

async function ownSellerVendor(req) {
  const vendor = await Vendor.findOne({ owner: req.user._id });
  if (!vendor) throw notFound('Vendor profile');
  return vendor;
}

sellerOnboardingRouter.get('/profile', async (req, res) => {
  const vendor = await ownSellerVendor(req);
  res.json({ vendorStatus: vendor.status, ...(vendor.toObject().seller ?? { status: 'none' }) });
});

// Applying (or re-applying after a rejection) sends the seller profile to staff for approval.
sellerOnboardingRouter.put('/profile', validate({ body: sellerBody }), async (req, res) => {
  const vendor = await ownSellerVendor(req);
  if (vendor.status !== 'active') throw conflict('Your business must be approved before you can apply to sell');
  if (vendor.seller?.status === 'suspended') throw conflict('Your seller account is suspended; contact Nurvia');
  const { bank, documents, ...body } = req.valid.body;
  const files = await attachmentsFor(req.user._id, documents.map((d) => d.fileId), ['seller_kyc', 'vendor_kyc']);
  const fileById = new Map(files.map((f) => [String(f.file), f]));
  const wasApproved = vendor.seller?.status === 'approved';
  vendor.seller = {
    ...vendor.toObject().seller,
    ...body,
    bank: { accountName: bank.accountName, ifsc: bank.ifsc, accountNumberLast4: bank.accountNumber.slice(-4) },
    documents: documents.map((d) => ({ type: d.type, file: fileById.get(d.fileId).file, name: fileById.get(d.fileId).name })),
    status: 'submitted',
    submittedAt: new Date(),
    reason: undefined,
  };
  vendor.sellerBankAccountEnc = encrypt(bank.accountNumber);
  await vendor.save();
  const reviewers = await User.find({ status: 'active', $or: [{ roles: { $in: [ROLES.ADMIN, ROLES.SUPER_ADMIN] } }, { permissions: P.VENDORS_REVIEW }] }).select('_id').lean();
  await notify(reviewers.map((r) => r._id), {
    type: 'seller.submitted',
    title: `${wasApproved ? 'Updated' : 'New'} seller application: ${vendor.businessName}`,
    body: `GSTIN ${body.gstin}`,
    data: { vendorId: String(vendor._id) },
  });
  res.json(vendor.toObject().seller);
});

// ---- Vendor: own settlements (mounted at /vendors/me) ----

export const vendorSettlementsRouter = Router();
vendorSettlementsRouter.use('/settlements', ...vendorWorkspace, requireCapability('reports.read'));

vendorSettlementsRouter.get('/settlements', validate({ query: { ...pageQuery, status: z.enum(SETTLEMENT_STATUSES).optional() } }), async (req, res) => {
  const { page, limit, status } = req.valid.query;
  res.json(await paginate(Settlement, { vendor: req.vendor._id, status: status ?? { $ne: 'void' } }, { page, limit, select: '-lines -statusHistory', sort: { periodFrom: -1 } }));
});

vendorSettlementsRouter.get('/settlements/:id', validate(), async (req, res) => {
  const settlement = await Settlement.findOne({ _id: req.valid.params.id, vendor: req.vendor._id, status: { $ne: 'void' } }).lean();
  if (!settlement) throw notFound('Settlement');
  res.json(settlement);
});

// What the next settlement would contain, so the vendor can check before staff run it.
vendorSettlementsRouter.get('/settlements-preview', ...vendorWorkspace, requireCapability('reports.read'), validate({ query: period }), async (req, res) => {
  const { lines } = await buildLines(req.vendor._id, req.valid.query.from, req.valid.query.to);
  res.json({ lines, totals: totalsOf(lines) });
});

// ---- Admin: sellers (mounted at /admin/sellers) ----

export const adminSellersRouter = Router();

adminSellersRouter.get(
  '/',
  requirePermission(P.VENDORS_READ),
  validate({ query: { ...pageQuery, status: z.enum(['submitted', 'approved', 'rejected', 'suspended']).optional() } }),
  async (req, res) => {
    const { page, limit, status } = req.valid.query;
    res.json(
      await paginate(Vendor, { 'seller.status': status ?? { $ne: 'none', $exists: true } }, {
        page,
        limit,
        sort: { 'seller.submittedAt': 1 },
        select: 'businessName address.city status seller owner',
        populate: { path: 'owner', select: 'name phone' },
      }),
    );
  },
);

adminSellersRouter.get('/:id', requirePermission(P.VENDORS_READ), validate(), async (req, res) => {
  const vendor = await Vendor.findById(req.valid.params.id).select('businessName status address kyc.status seller owner').populate('owner', 'name phone email').lean();
  if (!vendor?.seller || vendor.seller.status === 'none') throw notFound('Seller application');
  res.json(vendor);
});

const SELLER_ACTIONS = { approve: ['submitted', 'rejected'], reject: ['submitted'], suspend: ['approved'], reactivate: ['suspended'] };

adminSellersRouter.post(
  '/:id/review',
  requirePermission(P.VENDORS_REVIEW),
  validate({ body: { action: z.enum(Object.keys(SELLER_ACTIONS)), reason: reason.optional(), commissionPct: z.number().min(0).max(50).nullable().optional() } }),
  async (req, res) => {
    const vendor = await Vendor.findById(req.valid.params.id);
    if (!vendor) throw notFound('Vendor');
    const { action, reason: why, commissionPct } = req.valid.body;
    if (!SELLER_ACTIONS[action].includes(vendor.seller?.status)) throw conflict(`Cannot ${action} a seller that is ${vendor.seller?.status ?? 'none'}`);
    if (action !== 'approve' && action !== 'reactivate' && !why) throw badRequest('A reason is required');
    vendor.seller.status = { approve: 'approved', reject: 'rejected', suspend: 'suspended', reactivate: 'approved' }[action];
    vendor.seller.reviewedAt = new Date();
    vendor.seller.reviewedBy = req.user._id;
    vendor.seller.reason = why;
    if (commissionPct !== undefined) vendor.seller.commissionPct = commissionPct ?? undefined;
    await vendor.save();
    if (vendor.seller.status === 'approved') await User.updateOne({ _id: vendor.owner }, { $addToSet: { roles: ROLES.SELLER } });
    await audit(req, `seller.${action}`, { type: 'vendor', id: vendor._id }, { reason: why, meta: { commissionPct } });
    await notify([vendor.owner], {
      type: `seller.${action}`,
      title: { approve: 'You can now sell on Nurvia', reject: 'Seller application not approved', suspend: 'Selling paused', reactivate: 'Selling restored' }[action],
      body: why,
      data: { vendorId: String(vendor._id) },
    });
    res.json({ _id: vendor._id, seller: vendor.toObject().seller });
  },
);

// ---- Admin: commission and settlements (mounted at /admin/finance) ----

export const adminFinanceRouter = Router();
adminFinanceRouter.use(requirePermission(P.FINANCE_MANAGE));

adminFinanceRouter.get('/commission', async (_req, res) => {
  res.json(await commissionConfig());
});

adminFinanceRouter.put(
  '/commission',
  validate({
    body: {
      bookingPct: z.number().min(0).max(50),
      marketplacePct: z.number().min(0).max(50),
      categoryOverrides: z.array(z.object({ category: objectId, pct: z.number().min(0).max(50) })).max(100).optional(),
      reason,
    },
  }),
  async (req, res) => {
    const { reason: why, ...body } = req.valid.body;
    const ids = (body.categoryOverrides ?? []).map((o) => o.category);
    if (ids.length && (await Category.countDocuments({ _id: { $in: ids } })) !== new Set(ids).size) throw badRequest('Unknown category in overrides');
    const config = await CommissionConfig.findOneAndUpdate({ key: 'default' }, { ...body, key: 'default', updatedBy: req.user._id }, { upsert: true, new: true, runValidators: true });
    await audit(req, 'finance.commission_update', { type: 'commission' }, { reason: why, meta: body });
    res.json(config);
  },
);

adminFinanceRouter.get('/settlements/preview', validate({ query: { ...period, vendorId: objectId } }), async (req, res) => {
  checkPeriod(req.valid.query);
  const { vendor, lines } = await buildLines(req.valid.query.vendorId, req.valid.query.from, req.valid.query.to);
  if (!vendor) throw notFound('Vendor');
  res.json({ vendor: { _id: vendor._id, businessName: vendor.businessName }, lines, totals: totalsOf(lines) });
});

// Creates draft settlements for one vendor, or for every vendor with activity in the period.
adminFinanceRouter.post('/settlements', validate({ body: { ...period, vendorId: objectId.optional(), note: z.string().trim().max(500).optional() } }), async (req, res) => {
  checkPeriod(req.valid.body);
  const { from, to, vendorId, note } = req.valid.body;
  const vendorIds = vendorId ? [vendorId] : await vendorsWithActivity(from, to);
  const created = [];
  for (const id of vendorIds) {
    const settlement = await createSettlement(id, from, to, { by: req.user._id, note });
    if (settlement) created.push(settlement);
  }
  await audit(req, 'finance.settlements_created', { type: 'settlement_run' }, { meta: { from, to, vendorId, count: created.length } });
  res.status(201).json({ created: created.map((s) => ({ _id: s._id, code: s.code, vendor: s.vendor, totals: s.totals })) });
});

adminFinanceRouter.get(
  '/settlements',
  validate({ query: { ...pageQuery, status: z.enum(SETTLEMENT_STATUSES).optional(), vendorId: objectId.optional() } }),
  async (req, res) => {
    const { page, limit, status, vendorId } = req.valid.query;
    res.json(await paginate(Settlement, { ...(status && { status }), ...(vendorId && { vendor: vendorId }) }, { page, limit, select: '-lines', populate: { path: 'vendor', select: 'businessName' } }));
  },
);

adminFinanceRouter.get('/settlements/:id', validate(), async (req, res) => {
  const settlement = await Settlement.findById(req.valid.params.id).populate('vendor', 'businessName seller.bank.accountName seller.bank.accountNumberLast4 seller.bank.ifsc').populate('statusHistory.by', 'name').lean();
  if (!settlement) throw notFound('Settlement');
  res.json(settlement);
});

const SETTLEMENT_FLOW = { approve: { from: ['draft'], to: 'approved' }, mark_paid: { from: ['approved'], to: 'paid' }, void: { from: ['draft', 'approved'], to: 'void' } };

adminFinanceRouter.post(
  '/settlements/:id/:action',
  validate({ params: { action: z.enum(Object.keys(SETTLEMENT_FLOW)) }, body: { payoutReference: z.string().trim().max(60).optional(), note: z.string().trim().max(500).optional() } }),
  async (req, res) => {
    const settlement = await Settlement.findById(req.valid.params.id);
    if (!settlement) throw notFound('Settlement');
    const { action } = req.valid.params;
    const { payoutReference, note } = req.valid.body;
    const rule = SETTLEMENT_FLOW[action];
    if (!rule.from.includes(settlement.status)) throw conflict(`Cannot ${action.replace('_', ' ')} a ${settlement.status} settlement`);
    if (action === 'mark_paid' && !payoutReference) throw badRequest('Give the payout reference (UTR)');
    if (action === 'void' && !note) throw badRequest('Say why the settlement is void');
    settlement.status = rule.to;
    settlement.statusHistory.push({ status: rule.to, by: req.user._id, note });
    if (action === 'mark_paid') {
      settlement.payoutReference = payoutReference;
      settlement.paidAt = new Date();
    }
    await settlement.save();
    // A void settlement frees its lines for the next run.
    if (action === 'void') await SettlementEntry.deleteMany({ settlement: settlement._id });
    await audit(req, `finance.settlement_${action}`, { type: 'settlement', id: settlement._id }, { reason: note, meta: { payoutReference } });
    if (action !== 'void') {
      const vendor = await Vendor.findById(settlement.vendor).select('owner').lean();
      await notify([vendor?.owner], {
        type: `settlement.${rule.to}`,
        title: action === 'mark_paid' ? 'Settlement paid' : 'Settlement statement ready',
        body: `${settlement.code} · ₹${(settlement.totals.netPaise / 100).toFixed(2)}`,
        data: { settlementId: String(settlement._id) },
      });
    }
    res.json(settlement);
  },
);
