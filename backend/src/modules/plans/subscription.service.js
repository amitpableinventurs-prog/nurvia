import crypto from 'node:crypto';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../../common/errors.js';
import { currentTenant } from '../../common/tenancy.js';
import { paymentGateway } from '../../integrations/payments.js';
import { notify } from '../notifications/notify.js';
import { VendorCustomer, VendorStaff } from '../operations/operations.model.js';
import { Product } from '../shop/shop.model.js';
import { Tenant } from '../tenants/tenant.model.js';
import { Service, Vendor } from '../vendors/vendor.model.js';
import { financialYear, gstSplit, stateCodeOf } from './gst.js';
import { GST_RATE_PCT, InvoiceCounter, PLAN_FEATURES, Plan, SubscriptionInvoice, SubscriptionOrder } from './plan.model.js';

const DAY = 86_400_000;
export const REMINDER_DAYS = [7, 1];
// SAC for software provided as an online service, used until staff set another on the billing profile.
export const DEFAULT_SAC = '998315';

const featureLabel = (key) => PLAN_FEATURES.find((f) => f.key === key)?.label ?? key;
const formatDay = (date) => date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

// Calendar months, clamped to the month's last day: 31 Jan + 1 month is 28 or 29 Feb, not 3 Mar.
export function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

// A subscription is running while it is active and has not reached its end date (none = no end).
export function isLive(subscription, now = new Date()) {
  return Boolean(subscription?.plan) && subscription.status === 'active' && (!subscription.expiresAt || subscription.expiresAt > now);
}

export const freePlan = () => Plan.findOne({ audience: 'vendor', isFree: true }).lean();

// The plan whose limits and features apply to a vendor right now: its running plan, otherwise the
// free plan. `plan` is null when there is neither, and then nothing is limited.
export async function effectivePlan(vendor, now = new Date()) {
  if (isLive(vendor.subscription, now)) {
    const plan = await Plan.findById(vendor.subscription.plan).lean();
    if (plan) return { plan, onFreePlan: false };
  }
  return { plan: await freePlan(), onFreePlan: true };
}

const USAGE = {
  staff: (vendor) => VendorStaff.countDocuments({ vendor, active: true }),
  services: (vendor) => Service.countDocuments({ vendor, active: true }),
  products: (vendor) => Product.countDocuments({ seller: vendor, status: { $ne: 'archived' } }),
  customers: (vendor) => VendorCustomer.countDocuments({ vendor, archivedAt: null }),
};

export async function usage(vendorId) {
  const entries = await Promise.all(Object.entries(USAGE).map(async ([key, count]) => [key, await count(vendorId)]));
  return Object.fromEntries(entries);
}

const LIMIT_NOUNS = { staff: 'staff members', services: 'active services', products: 'products', customers: 'customers' };

// Throws when adding `adding` more of `key` would go over the vendor's plan. Data already over the
// limit (after a downgrade or an expiry) is kept; only additions are refused.
export async function assertWithinPlan(vendor, key, adding = 1) {
  const { plan } = await effectivePlan(vendor);
  const limit = plan?.limits?.[key];
  if (limit === null || limit === undefined) return;
  const used = await USAGE[key](vendor._id);
  if (used + adding > limit) {
    throw new ApiError(402, 'PLAN_LIMIT', `Your ${plan.name} plan allows ${limit} ${LIMIT_NOUNS[key] ?? key}. Upgrade your plan to add more.`, { key, limit, used, plan: plan.code });
  }
}

export async function hasFeature(vendor, feature) {
  const { plan } = await effectivePlan(vendor);
  return !plan || (plan.features ?? []).includes(feature);
}

export async function assertPlanFeature(vendor, feature) {
  if (await hasFeature(vendor, feature)) return;
  const { plan } = await effectivePlan(vendor);
  throw new ApiError(402, 'PLAN_FEATURE', `${featureLabel(feature)} is not included in your ${plan.name} plan. Upgrade your plan to use it.`, { feature, plan: plan.code });
}

// For routes that run after the vendor workspace has set req.vendor.
export function requirePlanFeature(feature) {
  return async (req, _res, next) => {
    await assertPlanFeature(req.vendor, feature);
    next();
  };
}

/* ───────────── Buying a plan ───────────── */

async function billingTenant() {
  return Tenant.findOne({ slug: currentTenant() }).lean();
}

const vendorGstin = (vendor) => vendor.seller?.gstin || vendor.kyc?.gstin || undefined;

// What a purchase costs and which dates it covers. Buying the plan that is already running adds the
// months after its end date; any other plan starts now and replaces the current one.
export async function quote(vendor, planId, months, now = new Date()) {
  const plan = await Plan.findOne({ _id: planId, audience: 'vendor' }).lean();
  if (!plan || !plan.active) throw badRequest('This plan is not available');
  if (plan.isFree) throw badRequest('The free plan does not need to be bought');
  const basePaise = months === 12 ? plan.yearlyPricePaise : plan.monthlyPricePaise;
  if (!basePaise) throw badRequest(`This plan has no ${months === 12 ? 'yearly' : 'monthly'} price`);

  const tenant = await billingTenant();
  const supplierState = stateCodeOf({ gstin: tenant?.business?.gstin });
  const recipientState = stateCodeOf({ gstin: vendorGstin(vendor), state: vendor.address?.state });
  const tax = gstSplit(basePaise, GST_RATE_PCT, supplierState, recipientState);

  const current = vendor.subscription;
  const extends_ = isLive(current, now) && String(current.plan) === String(plan._id) && Boolean(current.expiresAt);
  const from = extends_ ? current.expiresAt : now;
  return {
    plan,
    months,
    amounts: { basePaise, gstRatePct: GST_RATE_PCT, cgstPaise: tax.cgstPaise, sgstPaise: tax.sgstPaise, igstPaise: tax.igstPaise, gstPaise: tax.gstPaise, totalPaise: basePaise + tax.gstPaise },
    supplierState,
    recipientState,
    period: { from, to: addMonths(from, months) },
    replacesCurrent: isLive(current, now) && !extends_,
  };
}

export const quoteView = (q) => ({
  planId: q.plan._id,
  planName: q.plan.name,
  months: q.months,
  amounts: q.amounts,
  interState: q.amounts.igstPaise > 0,
  period: q.period,
  replacesCurrent: q.replacesCurrent,
});

export async function startCheckout(vendor, user, { planId, months }) {
  const q = await quote(vendor, planId, months);
  const { gstPaise, ...amounts } = q.amounts;
  const order = new SubscriptionOrder({
    code: `SUB${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
    vendor: vendor._id,
    plan: q.plan._id,
    planName: q.plan.name,
    months,
    amounts,
    supplierState: q.supplierState,
    recipientState: q.recipientState,
    createdBy: user._id,
  });
  const gateway = paymentGateway();
  const gatewayOrder = await gateway.createOrder({
    amountPaise: amounts.totalPaise,
    receipt: order.code,
    notes: { subscriptionOrderId: String(order._id), tenant: currentTenant() },
  });
  order.payment = { gateway: gateway.name, orderId: gatewayOrder.orderId };
  await order.save();
  return { ...gatewayOrder, subscriptionOrderId: order._id, code: order.code, quote: quoteView(q) };
}

// Called by the panel or app after checkout succeeds; the payment webhook does the same.
export async function verifyCheckout(vendor, { orderId, paymentId, signature }) {
  const order = await SubscriptionOrder.findOne({ 'payment.orderId': orderId, vendor: vendor._id });
  if (!order) throw notFound('Subscription order');
  if (!paymentGateway().verifyPayment({ orderId, paymentId, signature })) throw badRequest('Payment signature is invalid');
  return activateOrder(order, paymentId);
}

// Moves the vendor's subscription only if nobody changed it since it was read, so two payments
// landing together both count.
async function updateSubscription(vendorId, change) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const vendor = await Vendor.findById(vendorId).select('subscription owner businessName').lean();
    if (!vendor) throw notFound('Vendor');
    const next = change(vendor.subscription ?? null);
    const guard = vendor.subscription
      ? { 'subscription.plan': vendor.subscription.plan ?? null, 'subscription.expiresAt': vendor.subscription.expiresAt ?? null, 'subscription.status': vendor.subscription.status ?? null }
      : { subscription: null };
    const update = next ? { $set: { subscription: next } } : { $unset: { subscription: 1 } };
    const result = await Vendor.updateOne({ _id: vendorId, ...guard }, update);
    if (result.matchedCount) return { vendor, subscription: next };
  }
  throw conflict('The subscription changed while it was being updated. Please try again');
}

// Idempotent: the panel's verify call and the webhook can both arrive; only the first one counts.
export async function activateOrder(order, paymentId) {
  const now = new Date();
  const claimed = await SubscriptionOrder.findOneAndUpdate(
    { _id: order._id, status: { $ne: 'paid' } },
    { status: 'paid', 'payment.paymentId': paymentId, 'payment.paidAt': now, $unset: { 'payment.failureReason': 1 } },
    { new: true },
  );
  if (!claimed) return SubscriptionOrder.findById(order._id).lean();

  let period;
  const { vendor } = await updateSubscription(claimed.vendor, (current) => {
    const continuing = isLive(current, now) && String(current.plan) === String(claimed.plan) && current.expiresAt;
    const from = continuing ? current.expiresAt : now;
    period = { from, to: addMonths(from, claimed.months) };
    return { plan: claimed.plan, status: 'active', source: 'purchase', startedAt: continuing ? current.startedAt : now, expiresAt: period.to, remindersSent: [] };
  });
  claimed.period = period;
  claimed.invoice = (await issueInvoice(claimed))._id;
  await claimed.save();

  await notify([vendor.owner], {
    type: 'subscription.activated',
    title: `${claimed.planName} plan active until ${formatDay(period.to)}`,
    body: 'Thank you for your payment. Your GST invoice is in Plan & billing.',
    data: { screen: 'subscription', subscriptionOrderId: String(claimed._id) },
  });
  return claimed.toObject();
}

export async function failOrder(gatewayOrderId, reason) {
  await SubscriptionOrder.updateOne({ 'payment.orderId': gatewayOrderId, status: 'created' }, { status: 'failed', 'payment.failureReason': reason });
}

const addressLine = (a = {}) => [a.line1, a.line2, a.city, a.state, a.pincode].filter(Boolean).join(', ');

async function issueInvoice(order) {
  const [tenant, vendor] = await Promise.all([billingTenant(), Vendor.findById(order.vendor).lean()]);
  const paidAt = order.payment.paidAt;
  const fy = financialYear(paidAt);
  const counter = await InvoiceCounter.findOneAndUpdate({ key: `subscription:${fy}` }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  const prefix = (currentTenant() ?? 'nv').replace(/[^a-z0-9]/gi, '').slice(0, 3).toUpperCase();
  const business = tenant?.business ?? {};
  const { amounts } = order;
  return SubscriptionInvoice.create({
    number: `${prefix}/${fy}/${String(counter.seq).padStart(6, '0')}`,
    issuedAt: paidAt,
    vendor: order.vendor,
    order: order._id,
    supplier: { legalName: business.legalName || tenant?.name, address: business.address, gstin: business.gstin, stateCode: order.supplierState, email: business.email, phone: business.phone },
    recipient: {
      name: vendor.seller?.legalName || vendor.businessName,
      address: addressLine(vendor.address),
      gstin: vendorGstin(vendor),
      stateCode: order.recipientState,
    },
    placeOfSupply: order.recipientState ?? order.supplierState,
    lines: [
      {
        description: `${order.planName} plan, ${order.months === 12 ? '12 months' : '1 month'} (${formatDay(order.period.from)} to ${formatDay(order.period.to)})`,
        sac: business.sacCode || DEFAULT_SAC,
        periodFrom: order.period.from,
        periodTo: order.period.to,
        taxablePaise: amounts.basePaise,
      },
    ],
    taxablePaise: amounts.basePaise,
    gstRatePct: amounts.gstRatePct,
    cgstPaise: amounts.cgstPaise,
    sgstPaise: amounts.sgstPaise,
    igstPaise: amounts.igstPaise,
    totalPaise: amounts.totalPaise,
    payment: { gateway: order.payment.gateway, paymentId: order.payment.paymentId, paidAt },
  });
}

/* ───────────── Nurvia staff ───────────── */

// Puts a vendor on a plan (or back on the free plan with planId null). With no end date the plan
// runs until staff change it.
export async function assignPlan(vendorId, { planId, expiresAt, complimentary }) {
  if (!planId) return updateSubscription(vendorId, () => null);
  const plan = await Plan.findOne({ _id: planId, audience: 'vendor' }).lean();
  if (!plan) throw badRequest('Unknown vendor plan');
  if (plan.isFree) throw badRequest('Choose a paid plan, or no plan to move the vendor to the free plan');
  const now = new Date();
  if (expiresAt && expiresAt <= now) throw badRequest('The end date must be in the future');
  return updateSubscription(vendorId, () => ({ plan: plan._id, status: 'active', source: complimentary ? 'complimentary' : 'staff', startedAt: now, expiresAt, remindersSent: [] }));
}

// Adds time to the vendor's plan: after its end date while it runs, or from today once it has expired.
export async function extendPlan(vendorId, { days, complimentary }) {
  const now = new Date();
  return updateSubscription(vendorId, (current) => {
    if (!current?.plan) throw badRequest('This vendor is on the free plan. Assign a plan first');
    if (!current.expiresAt) throw badRequest('This plan has no end date to extend');
    const base = isLive(current, now) ? current.expiresAt : now;
    return {
      ...current,
      status: 'active',
      source: complimentary ? 'complimentary' : current.source,
      expiresAt: new Date(base.getTime() + days * DAY),
      remindersSent: [],
      expiredAt: undefined,
    };
  });
}

/* ───────────── Reminders and expiry (run every minute by jobs/reminders.js) ───────────── */

const planNames = async (subs) => {
  const plans = await Plan.find({ _id: { $in: [...new Set(subs.map((s) => String(s.plan)))] } }).select('name').lean();
  return new Map(plans.map((p) => [String(p._id), p.name]));
};

export async function runSubscriptionJobs(limit = 200, now = new Date()) {
  // Ended plans fall back to the free plan. Nothing is deleted: limits only stop new additions.
  const ended = await Vendor.find({ 'subscription.status': 'active', 'subscription.expiresAt': { $lte: now } }).select('owner subscription').limit(limit).lean();
  const endedNames = await planNames(ended.map((v) => v.subscription));
  for (const v of ended) {
    const result = await Vendor.updateOne(
      { _id: v._id, 'subscription.status': 'active', 'subscription.expiresAt': v.subscription.expiresAt },
      { 'subscription.status': 'expired', 'subscription.expiredAt': now },
    );
    if (!result.modifiedCount) continue;
    const name = endedNames.get(String(v.subscription.plan));
    await notify([v.owner], {
      type: 'subscription.expired',
      title: name ? `Your ${name} plan has ended` : 'Your plan has ended',
      body: 'You are on the free plan now. Your data is safe; renew to get your plan features and limits back.',
      data: { screen: 'subscription' },
    });
  }

  // The 1-day reminder goes first, so a plan with under a day left gets only that one.
  for (const days of [...REMINDER_DAYS].sort((a, b) => a - b)) {
    const due = await Vendor.find({
      'subscription.status': 'active',
      'subscription.expiresAt': { $gt: now, $lte: new Date(now.getTime() + days * DAY) },
      'subscription.remindersSent': { $ne: days },
    })
      .select('owner subscription')
      .limit(limit)
      .lean();
    const names = await planNames(due.map((v) => v.subscription));
    for (const v of due) {
      const covered = REMINDER_DAYS.filter((d) => d >= days);
      const claimed = await Vendor.updateOne({ _id: v._id, 'subscription.remindersSent': { $ne: days } }, { $addToSet: { 'subscription.remindersSent': { $each: covered } } });
      if (!claimed.modifiedCount) continue;
      const plan = names.has(String(v.subscription.plan)) ? `Your ${names.get(String(v.subscription.plan))} plan` : 'Your plan';
      const end = v.subscription.expiresAt;
      const left = Math.ceil((end - now) / DAY);
      await notify([v.owner], {
        type: 'subscription.renewal_due',
        title: `${plan} ends ${left <= 1 ? 'within a day' : `in ${left} days`}, on ${formatDay(end)}`,
        body: 'Renew in Plan & billing to keep your features and limits. If it ends, you move to the free plan and keep all your data.',
        data: { screen: 'subscription', expiresAt: end.toISOString(), daysBefore: String(days) },
      });
    }
  }
}

export function assertOwner(req) {
  if (req.staff) throw forbidden('Only the business owner can manage the plan and billing');
}
