import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../../common/auth.js';
import { badRequest, conflict, notFound } from '../../common/errors.js';
import { paginate } from '../../common/paginate.js';
import { PERMISSIONS } from '../../common/roles.js';
import { objectId, pageQuery, validate } from '../../common/validate.js';
import { env } from '../../config/env.js';
import { audit } from '../audit/audit.model.js';
import { User } from '../users/user.model.js';
import { LoyaltyConfig, LoyaltyEntry, Referral } from './loyalty.model.js';
import { loyaltyConfig, movePoints, referralCodeFor } from './loyalty.service.js';

// Mounted at /loyalty.
const router = Router();
router.use(authenticate);

router.get('/me', async (req, res) => {
  const [config, user, recent, referrals] = await Promise.all([
    loyaltyConfig(),
    User.findById(req.user._id).select('loyaltyPoints referralCode referredBy createdAt').lean(),
    LoyaltyEntry.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(20).lean(),
    Referral.aggregate([{ $match: { referrer: req.user._id } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);
  const code = await referralCodeFor({ ...user, name: req.user.name });
  res.json({
    points: user.loyaltyPoints ?? 0,
    pointValuePaise: config.pointValuePaise,
    maxRedeemPct: config.maxRedeemPct,
    referral: {
      code,
      link: `${env.webBaseUrl}/login?ref=${code}`,
      rewardPoints: { you: config.referrerPoints, friend: config.refereePoints },
      counts: Object.fromEntries(referrals.map((r) => [r._id, r.count])),
      canApplyCode: !user.referredBy && Date.now() - new Date(user.createdAt) < config.referralWindowDays * 86_400_000,
    },
    recent,
  });
});

router.get('/history', validate({ query: pageQuery }), async (req, res) => {
  const { page, limit } = req.valid.query;
  res.json(await paginate(LoyaltyEntry, { user: req.user._id }, { page, limit }));
});

// A new user enters a friend's code. Both are rewarded when the new user's first booking or order completes.
router.post('/referrals/apply', validate({ body: { code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{6,12}$/) } }), async (req, res) => {
  const config = await loyaltyConfig();
  if (!config.enabled) throw badRequest('Referrals are paused right now');
  const me = await User.findById(req.user._id).select('referredBy createdAt referralCode').lean();
  if (me.referredBy) throw conflict('You have already used a referral code');
  if (Date.now() - new Date(me.createdAt) > config.referralWindowDays * 86_400_000) throw conflict(`Referral codes must be used within ${config.referralWindowDays} days of joining`);
  const referrer = await User.findOne({ referralCode: req.valid.body.code, status: 'active' }).select('_id').lean();
  if (!referrer) throw notFound('Referral code');
  if (String(referrer._id) === String(req.user._id)) throw badRequest('You cannot use your own code');
  const updated = await User.updateOne({ _id: req.user._id, referredBy: { $exists: false } }, { referredBy: referrer._id });
  if (!updated.modifiedCount) throw conflict('You have already used a referral code');
  const referral = await Referral.create({ referrer: referrer._id, referee: req.user._id, code: req.valid.body.code });
  res.status(201).json({ referral, message: `You and your friend get points after your first completed booking or delivered order.` });
});

export default router;

// ---- Admin (mounted at /admin/loyalty) ----

export const adminLoyaltyRouter = Router();
adminLoyaltyRouter.use(requirePermission(PERMISSIONS.MARKETING_MANAGE));

adminLoyaltyRouter.get('/config', async (_req, res) => {
  res.json(await loyaltyConfig());
});

adminLoyaltyRouter.put(
  '/config',
  validate({
    body: {
      enabled: z.boolean(),
      earnPointsPer100Rupees: z.number().min(0).max(100),
      referrerPoints: z.number().int().min(0).max(100_000),
      refereePoints: z.number().int().min(0).max(100_000),
      pointValuePaise: z.number().int().min(1).max(10_000),
      maxRedeemPct: z.number().min(0).max(100),
      referralWindowDays: z.number().int().min(1).max(90),
      reason: z.string().trim().min(3).max(300),
    },
  }),
  async (req, res) => {
    const { reason, ...body } = req.valid.body;
    const config = await LoyaltyConfig.findOneAndUpdate({ key: 'default' }, { ...body, key: 'default' }, { upsert: true, new: true, runValidators: true });
    await audit(req, 'loyalty.config_update', { type: 'loyalty_config' }, { reason, meta: body });
    res.json(config);
  },
);

adminLoyaltyRouter.post(
  '/adjust',
  validate({ body: { userId: objectId, points: z.number().int().min(-100_000).max(100_000).refine((n) => n !== 0, 'points cannot be 0'), reason: z.string().trim().min(3).max(300) } }),
  async (req, res) => {
    const { userId, points, reason } = req.valid.body;
    if (!(await User.exists({ _id: userId }))) throw notFound('User');
    const entry = await movePoints(userId, points, { reason: 'admin_adjust', note: reason, by: req.user._id });
    await audit(req, 'loyalty.adjust', { type: 'user', id: userId }, { reason, meta: { points } });
    res.status(201).json(entry);
  },
);

adminLoyaltyRouter.get('/ledger', validate({ query: { ...pageQuery, userId: objectId.optional() } }), async (req, res) => {
  const { page, limit, userId } = req.valid.query;
  res.json(await paginate(LoyaltyEntry, { ...(userId && { user: userId }) }, { page, limit, populate: { path: 'user', select: 'name phone' } }));
});

adminLoyaltyRouter.get('/referrals', validate({ query: { ...pageQuery, status: z.enum(['pending', 'rewarded', 'void']).optional() } }), async (req, res) => {
  const { page, limit, status } = req.valid.query;
  res.json(
    await paginate(Referral, { ...(status && { status }) }, { page, limit, populate: [{ path: 'referrer', select: 'name phone' }, { path: 'referee', select: 'name phone' }] }),
  );
});

adminLoyaltyRouter.post('/referrals/:id/void', validate({ body: { reason: z.string().trim().min(3).max(300) } }), async (req, res) => {
  const referral = await Referral.findById(req.valid.params.id);
  if (!referral) throw notFound('Referral');
  if (referral.status !== 'pending') throw conflict(`This referral is ${referral.status}`);
  referral.status = 'void';
  await referral.save();
  await audit(req, 'referral.void', { type: 'referral', id: referral._id }, { reason: req.valid.body.reason });
  res.json(referral);
});
