import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../common/auth.js';
import { sendCsv } from '../../common/csv.js';
import { badRequest, conflict, notFound } from '../../common/errors.js';
import { paginate } from '../../common/paginate.js';
import { PERMISSIONS } from '../../common/roles.js';
import { currentTenant } from '../../common/tenancy.js';
import { escapeRegex, objectId, pageQuery, validate } from '../../common/validate.js';
import { mockSignature, paymentGateway } from '../../integrations/payments.js';
import { audit } from '../audit/audit.model.js';
import { CustomerPackage } from '../operations/operations.model.js';
import { vendorWorkspace } from '../operations/operations.service.js';
import { Tenant } from '../tenants/tenant.model.js';
import { clearTenantCache } from '../tenants/resolve-tenant.js';
import { Vendor } from '../vendors/vendor.model.js';
import { stateName } from './gst.js';
import { GST_RATE_PCT, PLAN_FEATURES, PLAN_LIMIT_KEYS, PLAN_TERMS_MONTHS, Plan, SubscriptionInvoice, SubscriptionOrder } from './plan.model.js';
import {
  DEFAULT_SAC,
  addMonths,
  assertOwner,
  assignPlan,
  effectivePlan,
  extendPlan,
  isLive,
  quote,
  quoteView,
  startCheckout,
  usage,
  verifyCheckout,
} from './subscription.service.js';

// Kept for the modules that check limits; the logic lives in subscription.service.js.
export { assertPlanFeature, assertWithinPlan, requirePlanFeature } from './subscription.service.js';

const PUBLIC = 'code name audience description isFree monthlyPricePaise yearlyPricePaise highlights features limits sortOrder';
const DAY = 86_400_000;
const daysLeft = (sub, now = new Date()) => (sub?.expiresAt && isLive(sub, now) ? Math.max(0, Math.ceil((sub.expiresAt - now) / DAY)) : null);

// ---- Public: plans for the pricing page (mounted at /plans) ----

const router = Router();

router.get('/', validate({ query: { audience: z.enum(['vendor', 'tenant']).optional() } }), async (req, res) => {
  res.json(await Plan.find({ active: true, ...(req.valid.query.audience && { audience: req.valid.query.audience }) }).select(PUBLIC).sort({ sortOrder: 1, monthlyPricePaise: 1 }).lean());
});

// The features a vendor plan can switch on, with their labels.
router.get('/features', (_req, res) => {
  res.json({ features: PLAN_FEATURES, limits: PLAN_LIMIT_KEYS.filter((k) => k !== 'storefronts'), gstRatePct: GST_RATE_PCT, terms: PLAN_TERMS_MONTHS });
});

export default router;

// ---- Vendor: own plan, usage, purchase and invoices (mounted at /vendors/me) ----

export const vendorSubscriptionRouter = Router();
vendorSubscriptionRouter.use('/subscription', ...vendorWorkspace);

async function subscriptionView(vendor) {
  const now = new Date();
  const [{ plan, onFreePlan }, used, packagesSold, paidPlan] = await Promise.all([
    effectivePlan(vendor, now),
    usage(vendor._id),
    CustomerPackage.countDocuments({ vendor: vendor._id }),
    vendor.subscription?.plan ? Plan.findById(vendor.subscription.plan).select(PUBLIC).lean() : null,
  ]);
  const sub = vendor.subscription;
  return {
    plan: plan && Object.fromEntries(PUBLIC.split(' ').map((k) => [k, plan[k]]).concat([['_id', plan._id]])),
    onFreePlan,
    // Everything is allowed when Nurvia has not set up a free plan yet.
    unlimited: !plan,
    features: Object.fromEntries(PLAN_FEATURES.map((f) => [f.key, !plan || (plan.features ?? []).includes(f.key)])),
    subscription: sub?.plan
      ? { plan: paidPlan ? { _id: paidPlan._id, code: paidPlan.code, name: paidPlan.name } : null, status: isLive(sub, now) ? 'active' : 'expired', source: sub.source, startedAt: sub.startedAt, expiresAt: sub.expiresAt ?? null, expiredAt: sub.expiredAt, daysLeft: daysLeft(sub, now) }
      : null,
    usage: { ...used, packagesSold },
    gstRatePct: GST_RATE_PCT,
  };
}

// Any team member can see the plan and its limits; buying and invoices are for the owner.
vendorSubscriptionRouter.get('/subscription', async (req, res) => {
  res.json(await subscriptionView(req.vendor));
});

const purchaseBody = { planId: objectId, months: z.union([z.literal(1), z.literal(12)]) };

// Price with GST and the dates a purchase would cover, before paying.
vendorSubscriptionRouter.get(
  '/subscription/quote',
  validate({ query: { planId: objectId, months: z.enum(['1', '12']).transform(Number) } }),
  async (req, res) => {
    assertOwner(req);
    res.json(quoteView(await quote(req.vendor, req.valid.query.planId, req.valid.query.months)));
  },
);

// Starts a one-time payment for 1 or 12 months. Open the gateway checkout with the returned order.
vendorSubscriptionRouter.post('/subscription/checkout', validate({ body: purchaseBody }), async (req, res) => {
  assertOwner(req);
  res.status(201).json(await startCheckout(req.vendor, req.user, req.valid.body));
});

// After checkout succeeds. The payment webhook activates the plan as well, so this only makes it show at once.
vendorSubscriptionRouter.post(
  '/subscription/verify',
  validate({ body: { orderId: z.string().min(1).max(100), paymentId: z.string().min(1).max(100), signature: z.string().min(1).max(256) } }),
  async (req, res) => {
    assertOwner(req);
    const order = await verifyCheckout(req.vendor, req.valid.body);
    const vendor = await Vendor.findById(req.vendor._id).lean();
    res.json({ order: { _id: order._id, code: order.code, status: order.status, period: order.period, invoice: order.invoice }, ...(await subscriptionView(vendor)) });
  },
);

// Development only, with the mock gateway: completes a checkout as if the vendor had paid, so the
// panel can be tried without Razorpay keys. The mock gateway refuses to run in production.
vendorSubscriptionRouter.post('/subscription/mock-pay', validate({ body: { orderId: z.string().min(1).max(100) } }), async (req, res) => {
  assertOwner(req);
  if (paymentGateway().name !== 'mock') throw notFound('Route');
  const { orderId } = req.valid.body;
  const paymentId = `pay_mock_${Date.now().toString(36)}`;
  const order = await verifyCheckout(req.vendor, { orderId, paymentId, signature: mockSignature(`${orderId}|${paymentId}`) });
  const vendor = await Vendor.findById(req.vendor._id).lean();
  res.json({ order: { _id: order._id, code: order.code, status: order.status, period: order.period, invoice: order.invoice }, ...(await subscriptionView(vendor)) });
});

vendorSubscriptionRouter.get('/subscription/invoices', validate({ query: pageQuery }), async (req, res) => {
  assertOwner(req);
  const { page, limit } = req.valid.query;
  res.json(await paginate(SubscriptionInvoice, { vendor: req.vendor._id }, { page, limit, sort: { issuedAt: -1 }, select: 'number issuedAt lines.description totalPaise' }));
});

const invoiceView = (invoice) => ({
  ...invoice,
  supplier: { ...invoice.supplier, stateName: stateName(invoice.supplier?.stateCode) },
  recipient: { ...invoice.recipient, stateName: stateName(invoice.recipient?.stateCode) },
  placeOfSupplyName: stateName(invoice.placeOfSupply),
});

vendorSubscriptionRouter.get('/subscription/invoices/:id', validate(), async (req, res) => {
  assertOwner(req);
  const invoice = await SubscriptionInvoice.findOne({ _id: req.valid.params.id, vendor: req.vendor._id }).lean();
  if (!invoice) throw notFound('Invoice');
  res.json(invoiceView(invoice));
});

// ---- Admin (mounted at /admin) ----

export const adminPlansRouter = Router();
const manage = requirePermission(PERMISSIONS.PLANS_MANAGE);

const paise = z.number().int().min(0).max(100_000_000);
const limitValue = z.number().int().min(0).max(1_000_000).nullable();
const planBody = {
  code: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().trim().min(2).max(80),
  audience: z.enum(['vendor', 'tenant']),
  description: z.string().max(500).optional(),
  isFree: z.boolean().optional(),
  monthlyPricePaise: paise,
  yearlyPricePaise: paise,
  highlights: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
  features: z.array(z.enum(PLAN_FEATURES.map((f) => f.key))).max(PLAN_FEATURES.length).optional(),
  limits: z.object(Object.fromEntries(PLAN_LIMIT_KEYS.map((k) => [k, limitValue.optional()]))).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
};

function checkPlan(plan) {
  if (plan.isFree && (plan.monthlyPricePaise || plan.yearlyPricePaise)) throw badRequest('The free plan must have no price');
  if (!plan.isFree && !plan.monthlyPricePaise && !plan.yearlyPricePaise) throw badRequest('A paid plan needs a monthly or a yearly price');
  if (plan.isFree && plan.active === false) throw badRequest('The free plan cannot be switched off: vendors fall back to it');
}

async function assertOneFree(audience, exceptId) {
  const other = await Plan.findOne({ audience, isFree: true, ...(exceptId && { _id: { $ne: exceptId } }) }).select('name').lean();
  if (other) throw conflict(`${other.name} is already the free plan`);
}

// Vendors on each plan right now, for the plan list.
async function subscriberCounts() {
  const now = new Date();
  const rows = await Vendor.aggregate([
    { $match: { 'subscription.status': 'active', $or: [{ 'subscription.expiresAt': null }, { 'subscription.expiresAt': { $gt: now } }] } },
    { $group: { _id: '$subscription.plan', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.count]));
}

adminPlansRouter.get('/plans', manage, async (_req, res) => {
  const [plans, counts] = await Promise.all([Plan.find().sort({ audience: 1, sortOrder: 1, monthlyPricePaise: 1 }).lean(), subscriberCounts()]);
  res.json(plans.map((p) => ({ ...p, subscribers: p.isFree ? null : counts.get(String(p._id)) ?? 0 })));
});

adminPlansRouter.post('/plans', manage, validate({ body: planBody }), async (req, res) => {
  const body = req.valid.body;
  checkPlan(body);
  if (await Plan.exists({ code: body.code })) throw conflict('A plan with this code exists');
  if (body.isFree) await assertOneFree(body.audience);
  const plan = await Plan.create(body);
  await audit(req, 'plan.create', { type: 'plan', id: plan._id }, { meta: { code: plan.code } });
  res.status(201).json(plan);
});

adminPlansRouter.patch(
  '/plans/:id',
  manage,
  validate({ body: Object.fromEntries(Object.entries(planBody).filter(([k]) => !['code', 'audience'].includes(k)).map(([k, v]) => [k, v.optional()])) }),
  async (req, res) => {
    const plan = await Plan.findById(req.valid.params.id);
    if (!plan) throw notFound('Plan');
    const { limits, ...fields } = req.valid.body;
    plan.set(fields);
    // Limits merge, so a form can send only the ones it changed; null makes one unlimited.
    if (limits) for (const [key, value] of Object.entries(limits)) plan.set(`limits.${key}`, value);
    checkPlan(plan);
    if (plan.isFree) await assertOneFree(plan.audience, plan._id);
    await plan.save();
    await audit(req, 'plan.update', { type: 'plan', id: plan._id }, { meta: { fields: Object.keys(req.valid.body) } });
    res.json(plan);
  },
);

// Vendors and where their plan stands.
//   status: paid (a running plan), expiring (ends within 7 days), expired, free (no running plan)
adminPlansRouter.get(
  '/subscriptions',
  manage,
  validate({ query: { ...pageQuery, status: z.enum(['paid', 'expiring', 'expired', 'free']).optional(), planId: objectId.optional(), q: z.string().trim().max(80).optional() } }),
  async (req, res) => {
    const { page, limit, status, planId, q } = req.valid.query;
    const now = new Date();
    const running = { 'subscription.status': 'active', $or: [{ 'subscription.expiresAt': null }, { 'subscription.expiresAt': { $gt: now } }] };
    const byStatus = {
      paid: running,
      expiring: { 'subscription.status': 'active', 'subscription.expiresAt': { $gt: now, $lte: new Date(now.getTime() + 7 * DAY) } },
      expired: { 'subscription.status': 'expired' },
      free: { $nor: [running] },
    };
    const filter = {
      ...(status && byStatus[status]),
      ...(planId && { 'subscription.plan': planId }),
      ...(q && { businessName: new RegExp(escapeRegex(q), 'i') }),
    };
    const result = await paginate(Vendor, filter, {
      page,
      limit,
      sort: status === 'expiring' ? { 'subscription.expiresAt': 1 } : { 'subscription.expiresAt': -1, createdAt: -1 },
      select: 'businessName status address.city subscription',
      populate: { path: 'subscription.plan', select: 'code name' },
    });
    res.json({
      ...result,
      items: result.items.map((v) => ({
        _id: v._id,
        businessName: v.businessName,
        status: v.status,
        city: v.address?.city,
        subscription: v.subscription?.plan ? { ...v.subscription, state: isLive(v.subscription, now) ? 'active' : 'expired', daysLeft: daysLeft(v.subscription, now) } : null,
      })),
    });
  },
);

adminPlansRouter.get('/vendors/:id/subscription', manage, validate(), async (req, res) => {
  const vendor = await Vendor.findById(req.valid.params.id).lean();
  if (!vendor) throw notFound('Vendor');
  const [view, orders, invoices] = await Promise.all([
    subscriptionView(vendor),
    SubscriptionOrder.find({ vendor: vendor._id }).sort({ createdAt: -1 }).limit(20).select('code planName months amounts.totalPaise status payment.paidAt payment.failureReason period createdAt').lean(),
    SubscriptionInvoice.find({ vendor: vendor._id }).sort({ issuedAt: -1 }).limit(20).select('number issuedAt totalPaise').lean(),
  ]);
  res.json({ vendor: { _id: vendor._id, businessName: vendor.businessName, status: vendor.status }, ...view, orders, invoices });
});

const assignBody = {
  // null moves the vendor to the free plan.
  planId: objectId.nullable(),
  // How long the plan runs: months or days from now, or an end date. None of them: until changed.
  months: z.number().int().min(1).max(36).optional(),
  days: z.number().int().min(1).max(1095).optional(),
  expiresAt: z.coerce.date().optional(),
  // Free of charge (e.g. a launch offer). Recorded as the source; no invoice is issued.
  complimentary: z.boolean().optional(),
  reason: z.string().trim().min(3).max(300),
};

adminPlansRouter.put('/vendors/:id/subscription', manage, validate({ body: assignBody }), async (req, res) => {
  const { planId, months, days, expiresAt, complimentary, reason } = req.valid.body;
  if ([months, days, expiresAt].filter((v) => v !== undefined).length > 1) throw badRequest('Give months, days or expiresAt, not more than one');
  const now = new Date();
  const end = expiresAt ?? (months ? addMonths(now, months) : days ? new Date(now.getTime() + days * DAY) : undefined);
  const { subscription } = await assignPlan(req.valid.params.id, { planId, expiresAt: end, complimentary });
  await audit(req, planId ? 'vendor.subscription.assign' : 'vendor.subscription.remove', { type: 'vendor', id: req.valid.params.id }, { reason, meta: { planId, expiresAt: end, complimentary } });
  res.json({ _id: req.valid.params.id, subscription });
});

adminPlansRouter.post(
  '/vendors/:id/subscription/extend',
  manage,
  validate({ body: { days: z.number().int().min(1).max(1095), complimentary: z.boolean().optional(), reason: z.string().trim().min(3).max(300) } }),
  async (req, res) => {
    const { days, complimentary, reason } = req.valid.body;
    const { subscription } = await extendPlan(req.valid.params.id, { days, complimentary });
    await audit(req, 'vendor.subscription.extend', { type: 'vendor', id: req.valid.params.id }, { reason, meta: { days, complimentary, expiresAt: subscription.expiresAt } });
    res.json({ _id: req.valid.params.id, subscription });
  },
);

// The invoice register, as JSON pages or a CSV for the accountant.
adminPlansRouter.get(
  '/subscription-invoices',
  manage,
  validate({ query: { ...pageQuery, from: z.coerce.date().optional(), to: z.coerce.date().optional(), vendorId: objectId.optional(), format: z.enum(['json', 'csv']).default('json') } }),
  async (req, res) => {
    const { page, limit, from, to, vendorId, format } = req.valid.query;
    const filter = { ...((from || to) && { issuedAt: { ...(from && { $gte: from }), ...(to && { $lt: to }) } }), ...(vendorId && { vendor: vendorId }) };
    if (format === 'csv') {
      const rows = await SubscriptionInvoice.find(filter).sort({ issuedAt: 1 }).limit(20_000).lean();
      const rupees = (p) => (p / 100).toFixed(2);
      return sendCsv(res, `subscription-invoices-${new Date().toISOString().slice(0, 10)}.csv`, [
        { label: 'Invoice number', value: 'number' },
        { label: 'Date', value: (r) => r.issuedAt.toISOString().slice(0, 10) },
        { label: 'Customer', value: (r) => r.recipient?.name },
        { label: 'Customer GSTIN', value: (r) => r.recipient?.gstin },
        { label: 'Place of supply', value: (r) => stateName(r.placeOfSupply) ?? r.placeOfSupply },
        { label: 'Description', value: (r) => r.lines.map((l) => l.description).join('; ') },
        { label: 'SAC', value: (r) => r.lines[0]?.sac },
        { label: 'Taxable value', value: (r) => rupees(r.taxablePaise) },
        { label: 'CGST', value: (r) => rupees(r.cgstPaise) },
        { label: 'SGST', value: (r) => rupees(r.sgstPaise) },
        { label: 'IGST', value: (r) => rupees(r.igstPaise) },
        { label: 'Total', value: (r) => rupees(r.totalPaise) },
        { label: 'Payment ID', value: (r) => r.payment?.paymentId },
      ], rows);
    }
    const result = await paginate(SubscriptionInvoice, filter, { page, limit, sort: { issuedAt: -1 }, select: 'number issuedAt recipient.name recipient.gstin vendor taxablePaise cgstPaise sgstPaise igstPaise totalPaise' });
    res.json(result);
  },
);

adminPlansRouter.get('/subscription-invoices/:id', manage, validate(), async (req, res) => {
  const invoice = await SubscriptionInvoice.findById(req.valid.params.id).lean();
  if (!invoice) throw notFound('Invoice');
  res.json(invoiceView(invoice));
});

// Nurvia's details as the supplier on plan invoices: the tenant's business profile.
const billingFields = ['legalName', 'address', 'gstin', 'email', 'phone', 'sacCode'];
const billingProfile = (tenant) => ({ ...Object.fromEntries(billingFields.map((k) => [k, tenant?.business?.[k] ?? ''])), defaultSacCode: DEFAULT_SAC });

adminPlansRouter.get('/billing-profile', manage, async (_req, res) => {
  res.json(billingProfile(await Tenant.findOne({ slug: currentTenant() }).lean()));
});

adminPlansRouter.put(
  '/billing-profile',
  manage,
  validate({
    body: {
      legalName: z.string().trim().max(160).optional(),
      address: z.string().trim().max(300).optional(),
      gstin: z.union([z.literal(''), z.string().trim().toUpperCase().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/, 'Invalid GSTIN')]).optional(),
      email: z.union([z.literal(''), z.string().trim().email()]).optional(),
      phone: z.string().trim().max(20).optional(),
      sacCode: z.union([z.literal(''), z.string().trim().regex(/^\d{4,8}$/, 'SAC is 4 to 8 digits')]).optional(),
    },
  }),
  async (req, res) => {
    const set = Object.fromEntries(Object.entries(req.valid.body).map(([k, v]) => [`business.${k}`, v]));
    const tenant = await Tenant.findOneAndUpdate({ slug: currentTenant() }, { $set: set }, { new: true }).lean();
    if (!tenant) throw notFound('Tenant');
    clearTenantCache();
    await audit(req, 'billing.profile', { type: 'tenant', id: tenant._id }, { meta: { fields: Object.keys(req.valid.body) } });
    res.json(billingProfile(tenant));
  },
);

// White-label tenants subscribe to tenant plans. Collection is outside Nurvia for now, so staff record it.
adminPlansRouter.put(
  '/tenants/:id/subscription',
  requirePermission(PERMISSIONS.TENANTS_MANAGE),
  manage,
  validate({ body: { planId: objectId.nullable(), status: z.enum(['trial', 'active', 'past_due', 'cancelled']).optional(), renewsAt: z.coerce.date().optional(), reason: z.string().trim().min(3).max(300) } }),
  async (req, res) => {
    const { planId, status, renewsAt, reason } = req.valid.body;
    const tenant = await Tenant.findById(req.valid.params.id);
    if (!tenant) throw notFound('Tenant');
    if (planId && !(await Plan.exists({ _id: planId, audience: 'tenant' }))) throw badRequest('Unknown tenant plan');
    tenant.subscription = planId ? { plan: planId, status: status ?? 'active', startedAt: new Date(), renewsAt } : undefined;
    await tenant.save();
    clearTenantCache();
    await audit(req, 'tenant.subscription', { type: 'tenant', id: tenant._id }, { reason, meta: { planId } });
    res.json(tenant);
  },
);

