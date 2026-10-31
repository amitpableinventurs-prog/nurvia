import { Router } from 'express';
import mongoose from 'mongoose';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { can, requirePermission } from '../../common/auth.js';
import { ADMIN_PANEL_ROLES, PERMISSIONS, ROLES } from '../../common/roles.js';
import { localParts, localToUtc } from '../../common/time.js';
import { escapeRegex, validate } from '../../common/validate.js';
import { env } from '../../config/env.js';
import { AdoptionApplication, AdoptionListing } from '../adoption/adoption.model.js';
import { Booking } from '../bookings/booking.model.js';
import { CareLog, CommunityDog } from '../community-dogs/community-dog.model.js';
import { Pet } from '../pets/pet.model.js';
import { Report } from '../reports/report.model.js';
import { User } from '../users/user.model.js';
import { Vendor, licenseStatus } from '../vendors/vendor.model.js';
import { withTargets } from './moderation.routes.js';

const router = Router();
const DAY = 86_400_000;
const { version } = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));

// Short, stable references for people to read out on a call: MOD-3F9A2C, CD-0B71E4.
const ref = (prefix, id) => `${prefix}-${String(id).slice(-6).toUpperCase()}`;
const queueLimit = { limit: z.coerce.number().int().min(1).max(50).default(5) };

// ---- Snapshot metrics ----

const WINDOWS = { '24h': 1, '7d': 7, '30d': 30 };

router.get(
  '/overview',
  requirePermission(PERMISSIONS.ANALYTICS_READ),
  validate({ query: { window: z.enum(Object.keys(WINDOWS)).default('7d') } }),
  async (req, res) => {
    const { window } = req.valid.query;
    const now = new Date();
    const since = new Date(now.getTime() - WINDOWS[window] * DAY);
    const today = localToUtc(localParts(now).date);
    const tomorrow = new Date(today.getTime() + DAY);
    const parents = { roles: ROLES.PET_PARENT, status: { $ne: 'deleted' } };
    const pets = { archivedAt: null };
    const dogs = { status: 'visible' };

    const [
      parentsTotal, parentsNew, petsTotal, petsChipped, petsNew,
      dogsMonitored, dogsVaccinated, dogsSterilized, dogsAwaiting,
      providersVerified, providersPendingKyc, providersNew,
      bookedToday, inProgress, completedToday,
      reportsOpen, reportsHigh, reportsNew, adoptionAudits,
    ] = await Promise.all([
      User.countDocuments(parents),
      User.countDocuments({ ...parents, createdAt: { $gte: since } }),
      Pet.countDocuments(pets),
      Pet.countDocuments({ ...pets, microchipId: { $nin: [null, ''] } }),
      Pet.countDocuments({ ...pets, createdAt: { $gte: since } }),
      CommunityDog.countDocuments(dogs),
      CommunityDog.countDocuments({ ...dogs, vaccinationStatus: 'up_to_date' }),
      CommunityDog.countDocuments({ ...dogs, sterilized: true }),
      CommunityDog.countDocuments({ ...dogs, 'verification.status': { $in: ['pending', null] } }),
      Vendor.countDocuments({ status: 'active' }),
      Vendor.countDocuments({ status: 'pending', 'kyc.status': 'submitted' }),
      Vendor.countDocuments({ status: 'active', 'kyc.reviewedAt': { $gte: since } }),
      Booking.countDocuments({ scheduledAt: { $gte: today, $lt: tomorrow }, status: { $in: ['pending', 'accepted', 'completed'] } }),
      Booking.countDocuments({ status: 'accepted', scheduledAt: { $lte: now }, endsAt: { $gt: now } }),
      Booking.countDocuments({ scheduledAt: { $gte: today, $lt: tomorrow }, status: 'completed' }),
      Report.countDocuments({ status: 'open' }),
      Report.countDocuments({ status: 'open', severity: 'high' }),
      Report.countDocuments({ createdAt: { $gte: since } }),
      AdoptionApplication.countDocuments({ status: 'approved', 'compliance.status': { $ne: 'certified' } }),
    ]);

    res.json({
      window,
      since,
      generatedAt: now,
      petParents: { total: parentsTotal, new: parentsNew },
      pets: { total: petsTotal, microchipped: petsChipped, new: petsNew },
      communityDogs: { monitored: dogsMonitored, vaccinated: dogsVaccinated, sterilized: dogsSterilized, awaitingVerification: dogsAwaiting },
      providers: { verified: providersVerified, pendingKyc: providersPendingKyc, approved: providersNew },
      bookingsToday: { scheduled: bookedToday, inProgress, completed: completedToday },
      safety: { open: reportsOpen, high: reportsHigh, new: reportsNew },
      adoption: { awaitingSignOff: adoptionAudits },
    });
  },
);

// ---- Queue A: vendor applications ----

// Target time from KYC submission to a decision.
export const VENDOR_SLA_HOURS = 24;

router.get(
  '/queues/vendor-applications',
  requirePermission(PERMISSIONS.VENDORS_READ),
  validate({ query: { ...queueLimit, sort: z.enum(['sla', 'newest']).default('sla') } }),
  async (req, res) => {
    const { limit, sort } = req.valid.query;
    const filter = { status: 'pending', 'kyc.status': 'submitted' };
    const [vendors, total] = await Promise.all([
      Vendor.find(filter)
        .sort({ 'kyc.submittedAt': sort === 'sla' ? 1 : -1 })
        .limit(limit)
        .select('businessName categories address kyc.submittedAt kyc.documents.type kyc.licenseCheck')
        .populate('categories', 'name')
        .lean(),
      Vendor.countDocuments(filter),
    ]);
    const now = Date.now();
    res.json({
      slaHours: VENDOR_SLA_HOURS,
      total,
      items: vendors.map((v) => {
        const slaDueAt = v.kyc.submittedAt && new Date(v.kyc.submittedAt.getTime() + VENDOR_SLA_HOURS * 3_600_000);
        return {
          _id: v._id,
          businessName: v.businessName,
          categories: v.categories.map((c) => c.name),
          locality: v.address.line2 || v.address.line1,
          city: v.address.city,
          submittedAt: v.kyc.submittedAt,
          slaDueAt,
          overdue: Boolean(slaDueAt && slaDueAt.getTime() < now),
          licenseStatus: licenseStatus(v.kyc),
        };
      }),
    });
  },
);

// ---- Queue B: safety alerts ----

router.get('/queues/safety', requirePermission(PERMISSIONS.REPORTS_MANAGE), validate({ query: queueLimit }), async (req, res) => {
  const { limit } = req.valid.query;
  const [reports, bySeverity] = await Promise.all([
    Report.aggregate([
      { $match: { status: 'open' } },
      // Reports filed before severity existed count as low.
      { $addFields: { rank: { $indexOfArray: [['high', 'medium', 'low'], { $ifNull: ['$severity', 'low'] }] } } },
      { $sort: { rank: 1, createdAt: 1 } },
      { $limit: limit },
      { $project: { rank: 0 } },
    ]),
    Report.aggregate([{ $match: { status: 'open' } }, { $group: { _id: { $ifNull: ['$severity', 'low'] }, count: { $sum: 1 } } }]),
  ]);

  // Say who raised each report: staff and verified providers carry more weight than members.
  const reporterIds = [...new Set(reports.map((r) => String(r.reporter)))];
  const [reporters, providers] = await Promise.all([
    User.find({ _id: { $in: reporterIds } }).select('name roles').lean(),
    Vendor.find({ owner: { $in: reporterIds }, status: 'active' }).select('owner businessName categories').populate('categories', 'name').lean(),
  ]);
  const people = new Map(reporters.map((u) => [String(u._id), u]));
  const providerOf = new Map(providers.map((v) => [String(v.owner), v]));
  const reporterLabel = (id) => {
    const user = people.get(id);
    if (user?.roles.some((r) => ADMIN_PANEL_ROLES.includes(r))) return 'Staff';
    const vendor = providerOf.get(id);
    if (vendor) return vendor.categories[0]?.name ?? 'Verified provider';
    return 'Member';
  };

  const counts = Object.fromEntries(bySeverity.map((s) => [s._id, s.count]));
  res.json({
    total: Object.values(counts).reduce((n, c) => n + c, 0),
    bySeverity: { high: counts.high ?? 0, medium: counts.medium ?? 0, low: counts.low ?? 0 },
    items: (await withTargets(reports)).map((r) => ({
      ...r,
      ref: ref('MOD', r._id),
      severity: r.severity ?? 'low',
      reporter: { _id: r.reporter, name: people.get(String(r.reporter))?.name ?? null, label: reporterLabel(String(r.reporter)) },
    })),
  });
});

// ---- Queue C: community dog profiles ----

router.get('/queues/community-dogs', requirePermission(PERMISSIONS.CONTENT_MODERATE), validate({ query: queueLimit }), async (req, res) => {
  const { limit } = req.valid.query;
  const filter = { status: 'visible', 'verification.status': { $in: ['pending', null] } };
  const [dogs, total] = await Promise.all([
    CommunityDog.find(filter).sort({ createdAt: 1 }).limit(limit).populate('createdBy', 'name phone').select('-moderation').lean(),
    CommunityDog.countDocuments(filter),
  ]);
  const vaccinations = await CareLog.aggregate([
    { $match: { dog: { $in: dogs.map((d) => d._id) }, type: 'vaccinated' } },
    { $sort: { at: -1 } },
    { $group: { _id: '$dog', at: { $first: '$at' }, note: { $first: '$note' } } },
  ]);
  const lastShot = new Map(vaccinations.map((v) => [String(v._id), v]));
  res.json({
    total,
    items: dogs.map((d) => {
      const shot = lastShot.get(String(d._id));
      return {
        _id: d._id,
        ref: ref('CD', d._id),
        name: d.name,
        sex: d.sex,
        approxAgeMonths: d.approxAgeMonths,
        sterilized: d.sterilized,
        vaccinationStatus: d.vaccinationStatus,
        area: d.area,
        city: d.city,
        description: d.description,
        createdAt: d.createdAt,
        submitter: d.createdBy,
        caregiverCount: d.caregivers.length,
        // Core vaccines are boosted yearly, so a logged shot is treated as valid for a year.
        lastVaccination: shot ? { at: shot.at, note: shot.note ?? null, validUntil: new Date(shot.at.getTime() + 365 * DAY) } : null,
      };
    }),
  });
});

// ---- Queue D: adoption compliance ----

router.get('/queues/adoption-audits', requirePermission(PERMISSIONS.CONTENT_MODERATE), validate({ query: queueLimit }), async (req, res) => {
  const { limit } = req.valid.query;
  const filter = { status: 'approved', 'compliance.status': { $ne: 'certified' } };
  const [applications, total] = await Promise.all([
    AdoptionApplication.find(filter)
      .sort({ updatedAt: 1 })
      .limit(limit)
      .populate([
        { path: 'listing', select: 'name species breed sex ageMonths city status' },
        { path: 'applicant', select: 'name phone' },
        { path: 'lister', select: 'name' },
      ])
      .lean(),
    AdoptionApplication.countDocuments(filter),
  ]);
  res.json({
    total,
    items: applications.map((a) => ({
      _id: a._id,
      ref: `ADP-${a.createdAt.getUTCFullYear()}-${String(a._id).slice(-4).toUpperCase()}`,
      listing: a.listing,
      applicant: a.applicant,
      lister: a.lister,
      home: a.home,
      approvedAt: a.updatedAt,
      // Nurvia takes no adoption fee, and listings have no price field, so this is always zero.
      feePaise: 0,
      microchipRequired: ['dog', 'cat'].includes(a.listing?.species),
      compliance: { status: 'pending', ...a.compliance, homeCheck: { status: 'pending', ...a.compliance?.homeCheck } },
    })),
  });
});

// ---- Global search ----

router.get('/search', validate({ query: { q: z.string().trim().min(2).max(80) } }), async (req, res) => {
  const { q } = req.valid.query;
  const like = { $regex: escapeRegex(q), $options: 'i' };
  const digits = q.replace(/\D/g, '');
  const allowed = (p) => can(req.user, p);
  const LIMIT = 5;

  const sections = await Promise.all([
    allowed(PERMISSIONS.USERS_READ) &&
      User.find({ status: { $ne: 'deleted' }, $or: [{ name: like }, { email: like }, ...(digits.length >= 4 ? [{ phone: { $regex: digits } }] : [])] })
        .limit(LIMIT).select('name phone email roles').lean()
        .then((rows) => rows.map((u) => ({ type: 'user', id: u._id, title: u.name ?? u.phone ?? u.email, subtitle: [u.phone ?? u.email, u.roles.join(', ')].join(' · ') }))),
    allowed(PERMISSIONS.USERS_READ) &&
      Pet.find({ archivedAt: null, $or: [{ name: like }, ...(digits.length >= 9 ? [{ microchipId: digits }] : [])] })
        .limit(LIMIT).select('name species breed owner microchipId').lean()
        .then((rows) => rows.map((p) => ({ type: 'pet', id: p._id, ownerId: p.owner, title: p.name, subtitle: [p.breed ?? p.species, p.microchipId && `Chip ${p.microchipId}`].filter(Boolean).join(' · ') }))),
    allowed(PERMISSIONS.VENDORS_READ) &&
      Vendor.find({ businessName: like }).limit(LIMIT).select('businessName status address.city').lean()
        .then((rows) => rows.map((v) => ({ type: 'vendor', id: v._id, title: v.businessName, subtitle: `${v.address.city} · ${v.status}` }))),
    allowed(PERMISSIONS.BOOKINGS_READ) &&
      Booking.find({ code: { $regex: `^${escapeRegex(q.toUpperCase())}` } }).limit(LIMIT).select('code status serviceSnapshot.name scheduledAt').lean()
        .then((rows) => rows.map((b) => ({ type: 'booking', id: b._id, title: b.code, subtitle: `${b.serviceSnapshot?.name ?? 'Booking'} · ${b.status}` }))),
    allowed(PERMISSIONS.CONTENT_MODERATE) &&
      CommunityDog.find({ $or: [{ name: like }, { area: like }] }).limit(LIMIT).select('name area status').lean()
        .then((rows) => rows.map((d) => ({ type: 'community_dog', id: d._id, title: d.name ?? 'Unnamed dog', subtitle: `${d.area} · ${d.status}` }))),
    allowed(PERMISSIONS.CONTENT_MODERATE) &&
      AdoptionListing.find({ name: like }).limit(LIMIT).select('name species city status').lean()
        .then((rows) => rows.map((l) => ({ type: 'adoption_listing', id: l._id, title: l.name, subtitle: `${l.species} · ${l.city} · ${l.status.replace('_', ' ')}` }))),
  ]);
  res.json({ q, results: sections.filter(Boolean).flat() });
});

// ---- System status ----

const INTEGRATIONS = [
  { key: 'otp', label: 'SMS / OTP', mode: () => (env.otp.provider === 'console' ? 'sandbox' : 'live'), detail: () => env.otp.provider },
  { key: 'payments', label: 'Payments', mode: () => (env.payments.gateway === 'mock' ? 'sandbox' : 'live'), detail: () => env.payments.gateway },
  { key: 'push', label: 'Push notifications', mode: () => (env.push.provider === 'console' ? 'sandbox' : 'live'), detail: () => env.push.provider },
  { key: 'storage', label: 'File storage', mode: () => 'live', detail: () => 'Local disk' },
  { key: 'ai', label: 'AI health summary', mode: () => (env.ai.provider === 'disabled' ? 'disabled' : 'live'), detail: () => env.ai.provider },
];

router.get('/system/status', async (_req, res) => {
  let database;
  try {
    const db = mongoose.connection.db;
    const started = performance.now();
    await db.admin().ping();
    const latencyMs = Math.round((performance.now() - started) * 10) / 10;
    const hello = await db.admin().command({ hello: 1 });
    database = {
      status: 'ok',
      latencyMs,
      name: db.databaseName,
      replicaSet: hello.setName ?? null,
      primary: Boolean(hello.isWritablePrimary),
      host: hello.me ?? null,
    };
  } catch (err) {
    database = { status: 'down', error: err.message };
  }
  const integrations = INTEGRATIONS.map((i) => ({ key: i.key, label: i.label, mode: i.mode(), detail: i.detail() }));
  res.json({
    status: database.status === 'ok' ? 'ok' : 'down',
    checkedAt: new Date(),
    release: version,
    environment: env.nodeEnv,
    node: process.env.INSTANCE_NAME ?? os.hostname(),
    uptimeSec: Math.round(process.uptime()),
    jobs: env.jobs.enabled,
    database,
    integrations,
  });
});

export default router;
