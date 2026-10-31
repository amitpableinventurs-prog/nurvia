import crypto from 'node:crypto';
import { badRequest } from '../../common/errors.js';
import { notify } from '../notifications/notify.js';
import { User } from '../users/user.model.js';
import { LoyaltyConfig, LoyaltyEntry, Referral } from './loyalty.model.js';

const DEFAULTS = { enabled: true, earnPointsPer100Rupees: 1, referrerPoints: 100, refereePoints: 50, pointValuePaise: 100, maxRedeemPct: 20, referralWindowDays: 14 };

export async function loyaltyConfig() {
  return { ...DEFAULTS, ...((await LoyaltyConfig.findOne({ key: 'default' }).lean()) ?? {}) };
}

// Credits or debits points together with a ledger entry. Debits only succeed when the balance covers them.
export async function movePoints(userId, points, { reason, refType, ref, note, by }) {
  if (!points) return null;
  if (points < 0) {
    const updated = await User.findOneAndUpdate({ _id: userId, loyaltyPoints: { $gte: -points } }, { $inc: { loyaltyPoints: points } });
    if (!updated) throw badRequest('Not enough points');
  }
  let entry;
  try {
    entry = await LoyaltyEntry.create({ user: userId, points, reason, refType, ref, note, by });
  } catch (err) {
    // Already credited for this activity: undo a debit taken above, and report nothing new.
    if (points < 0) await User.updateOne({ _id: userId }, { $inc: { loyaltyPoints: -points } });
    if (err.code === 11000) return null;
    throw err;
  }
  if (points > 0) await User.updateOne({ _id: userId }, { $inc: { loyaltyPoints: points } });
  return entry;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export async function referralCodeFor(user) {
  if (user.referralCode) return user.referralCode;
  for (let i = 0; i < 5; i++) {
    const code = (user.name?.replace(/[^a-z]/gi, '').slice(0, 4).toUpperCase() || 'PAWS') + Array.from(crypto.randomBytes(6), (b) => ALPHABET[b % ALPHABET.length]).join('');
    const res = await User.updateOne({ _id: user._id, referralCode: { $exists: false } }, { referralCode: code }).catch((err) => (err.code === 11000 ? null : Promise.reject(err)));
    if (res?.modifiedCount) return code;
    const fresh = await User.findById(user._id).select('referralCode').lean();
    if (fresh?.referralCode) return fresh.referralCode;
  }
  throw new Error('Could not allocate a referral code');
}

// Earns points for a qualifying activity and, the first time a referred user qualifies, rewards
// both people. Called after a paid booking is completed and after an order is delivered.
export async function onQualifyingActivity(userId, { kind, ref, amountPaise }) {
  const config = await loyaltyConfig();
  if (!config.enabled) return;
  const earned = Math.floor((amountPaise / 100 / 100) * config.earnPointsPer100Rupees);
  const reason = kind === 'booking' ? 'booking_completed' : 'order_delivered';
  const entry = await movePoints(userId, earned, { reason, refType: kind === 'booking' ? 'booking' : 'shop_order', ref });
  if (entry) await notify([userId], { type: 'loyalty.earned', title: `You earned ${earned} Nurvia points`, body: kind === 'booking' ? 'For your completed booking' : 'For your delivered order', data: {} });

  const referral = await Referral.findOneAndUpdate(
    { referee: userId, status: 'pending' },
    { status: 'rewarded', rewardedAt: new Date(), qualifyingRef: { type: kind, id: ref } },
    { new: true },
  );
  if (!referral) return;
  await movePoints(referral.referrer, config.referrerPoints, { reason: 'referral_referrer', refType: 'referral', ref: referral._id });
  await movePoints(referral.referee, config.refereePoints, { reason: 'referral_referee', refType: 'referral', ref: referral._id });
  await notify([referral.referrer], { type: 'referral.rewarded', title: `Your friend joined: ${config.referrerPoints} points for you`, body: 'Thanks for spreading the word.', data: {} });
}

// Points as a discount at checkout: capped by the balance and by maxRedeemPct of the order value.
export async function pointsDiscount(user, requestedPoints, payablePaise) {
  if (!requestedPoints) return { points: 0, discountPaise: 0 };
  const config = await loyaltyConfig();
  if (!config.enabled) throw badRequest('Points cannot be redeemed right now');
  const balance = (await User.findById(user._id).select('loyaltyPoints').lean())?.loyaltyPoints ?? 0;
  const maxByPct = Math.floor((payablePaise * config.maxRedeemPct) / 100 / config.pointValuePaise);
  const points = Math.min(requestedPoints, balance, maxByPct);
  return { points, discountPaise: points * config.pointValuePaise, balance, maxRedeemable: Math.min(balance, maxByPct) };
}
