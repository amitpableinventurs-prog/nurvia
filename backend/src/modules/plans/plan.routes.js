import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../common/auth.js';
import { ApiError, badRequest, conflict, notFound } from '../../common/errors.js';
import { PERMISSIONS } from '../../common/roles.js';
import { objectId, validate } from '../../common/validate.js';
import { audit } from '../audit/audit.model.js';
import { CustomerPackage, VendorCustomer, VendorStaff } from '../operations/operations.model.js';
import { requireCapability, vendorWorkspace } from '../operations/operations.service.js';
import { Product } from '../shop/shop.model.js';
import { Tenant } from '../tenants/tenant.model.js';
import { clearTenantCache } from '../tenants/resolve-tenant.js';
import { Vendor } from '../vendors/vendor.model.js';
import { Plan } from './plan.model.js';

const PUBLIC = 'code name audience description pricePaise interval trialDays features limits sortOrder';

// Usage of each plan limit for a vendor workspace.
async function usage(vendorId) {
  const [staff, customers, products] = await Promise.all([
    VendorStaff.countDocuments({ vendor: vendorId, active: true }),
    VendorCustomer.countDocuments({ vendor: vendorId, archivedAt: null }),
    Product.countDocuments({ seller: vendorId, status: { $ne: 'hidden' } }),
  ]);
  return { staff, customers, products };
}

// Throws when adding one more `key` would go over the vendor's plan. No plan means no limits.
export async function assertWithinPlan(vendor, key) {
  if (!vendor.subscription?.plan || ['cancelled'].includes(vendor.subscription.status)) return;
  const plan = await Plan.findById(vendor.subscription.plan).select('name limits').lean();
  const limit = plan?.limits?.[key];
  if (!limit) return;
  const used = (await usage(vendor._id))[key];
  if (used >= limit) throw new ApiError(402, 'PLAN_LIMIT', `Your ${plan.name} plan allows ${limit} ${key}. Upgrade to add more.`, { key, limit, used });
}

// ---- Public: plans for the pricing page (mounted at /plans) ----

const router = Router();

router.get('/', validate({ query: { audience: z.enum(['vendor', 'tenant']).optional() } }), async (req, res) => {
  res.json(await Plan.find({ active: true, ...(req.valid.query.audience && { audience: req.valid.query.audience }) }).select(PUBLIC).sort({ sortOrder: 1, pricePaise: 1 }).lean());
});

export default router;

// ---- Vendor: own subscription and usage (mounted at /vendors/me) ----

export const vendorSubscriptionRouter = Router();

vendorSubscriptionRouter.get('/subscription', ...vendorWorkspace, requireCapability('reports.read'), async (req, res) => {
  const plan = req.vendor.subscription?.plan ? await Plan.findById(req.vendor.subscription.plan).select(PUBLIC).lean() : null;
  const packagesSold = await CustomerPackage.countDocuments({ vendor: req.vendor._id });
  res.json({ subscription: req.vendor.subscription ?? null, plan, usage: { ...(await usage(req.vendor._id)), packagesSold } });
});

// ---- Admin (mounted at /admin) ----

export const adminPlansRouter = Router();
const manage = requirePermission(PERMISSIONS.PLANS_MANAGE);

const planBody = {
  code: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().trim().min(2).max(80),
  audience: z.enum(['vendor', 'tenant']),
  description: z.string().max(500).optional(),
  pricePaise: z.number().int().min(0).max(100_000_000),
  interval: z.enum(['month', 'year']).optional(),
  trialDays: z.number().int().min(0).max(90).optional(),
  features: z.array(z.string().trim().max(120)).max(30).optional(),
  limits: z.object({ staff: z.number().int().min(1).optional(), customers: z.number().int().min(1).optional(), products: z.number().int().min(1).optional(), storefronts: z.number().int().min(1).optional() }).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
};

adminPlansRouter.get('/plans', manage, async (_req, res) => {
  res.json(await Plan.find().sort({ audience: 1, sortOrder: 1 }).lean());
});

adminPlansRouter.post('/plans', manage, validate({ body: planBody }), async (req, res) => {
  if (await Plan.exists({ code: req.valid.body.code })) throw conflict('A plan with this code exists');
  const plan = await Plan.create(req.valid.body);
  await audit(req, 'plan.create', { type: 'plan', id: plan._id }, { meta: { code: plan.code } });
  res.status(201).json(plan);
});

adminPlansRouter.patch(
  '/plans/:id',
  manage,
  validate({ body: Object.fromEntries(Object.entries(planBody).filter(([k]) => !['code', 'audience'].includes(k)).map(([k, v]) => [k, v.optional()])) }),
  async (req, res) => {
    const plan = await Plan.findByIdAndUpdate(req.valid.params.id, req.valid.body, { new: true, runValidators: true });
    if (!plan) throw notFound('Plan');
    await audit(req, 'plan.update', { type: 'plan', id: plan._id }, { meta: { fields: Object.keys(req.valid.body) } });
    res.json(plan);
  },
);

const subscriptionBody = {
  planId: objectId.nullable(),
  status: z.enum(['trial', 'active', 'past_due', 'cancelled']).optional(),
  renewsAt: z.coerce.date().optional(),
  reason: z.string().trim().min(3).max(300),
};

async function subscriptionFor(audience, { planId, status, renewsAt }) {
  if (!planId) return undefined;
  const plan = await Plan.findOne({ _id: planId, audience }).lean();
  if (!plan) throw badRequest(`Unknown ${audience} plan`);
  const now = new Date();
  const trialEnds = plan.trialDays ? new Date(now.getTime() + plan.trialDays * 86_400_000) : undefined;
  return { plan: plan._id, status: status ?? (plan.trialDays ? 'trial' : 'active'), startedAt: now, renewsAt: renewsAt ?? trialEnds };
}

adminPlansRouter.put('/vendors/:id/subscription', manage, validate({ body: subscriptionBody }), async (req, res) => {
  const vendor = await Vendor.findById(req.valid.params.id);
  if (!vendor) throw notFound('Vendor');
  vendor.subscription = await subscriptionFor('vendor', req.valid.body);
  await vendor.save();
  await audit(req, 'vendor.subscription', { type: 'vendor', id: vendor._id }, { reason: req.valid.body.reason, meta: { planId: req.valid.body.planId } });
  res.json({ _id: vendor._id, subscription: vendor.subscription });
});

adminPlansRouter.put('/tenants/:id/subscription', requirePermission(PERMISSIONS.TENANTS_MANAGE), manage, validate({ body: subscriptionBody }), async (req, res) => {
  const tenant = await Tenant.findById(req.valid.params.id);
  if (!tenant) throw notFound('Tenant');
  tenant.subscription = await subscriptionFor('tenant', req.valid.body);
  await tenant.save();
  clearTenantCache();
  await audit(req, 'tenant.subscription', { type: 'tenant', id: tenant._id }, { reason: req.valid.body.reason, meta: { planId: req.valid.body.planId } });
  res.json(tenant);
});
