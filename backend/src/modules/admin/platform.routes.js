import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../common/auth.js';
import { badRequest, notFound } from '../../common/errors.js';
import { paginate } from '../../common/paginate.js';
import { PERMISSIONS, ROLES } from '../../common/roles.js';
import { objectId, pageQuery, validate } from '../../common/validate.js';
import { AuditLog, audit, verifyAuditChain } from '../audit/audit.model.js';
import { Announcement } from '../notifications/notification.model.js';
import { notify } from '../notifications/notify.js';
import { clearTenantCache } from '../tenants/resolve-tenant.js';
import { Tenant } from '../tenants/tenant.model.js';
import { User } from '../users/user.model.js';

const router = Router();

// ---- Announcements ----

const AUDIENCES = {
  all: {},
  pet_parents: { roles: ROLES.PET_PARENT },
  vendors: { roles: ROLES.VENDOR },
};
const BATCH = 500;

router.get('/announcements', requirePermission(PERMISSIONS.ANNOUNCEMENTS_SEND), validate({ query: pageQuery }), async (req, res) => {
  const { page, limit } = req.valid.query;
  res.json(await paginate(Announcement, {}, { page, limit, populate: { path: 'sentBy', select: 'name' } }));
});

// Fans out an in-app notification + push to every matching active user, in batches.
// Past a few hundred thousand users this should move to FCM topics or a queue worker.
router.post(
  '/announcements',
  requirePermission(PERMISSIONS.ANNOUNCEMENTS_SEND),
  validate({
    body: {
      title: z.string().trim().min(3).max(120),
      body: z.string().trim().min(3).max(2000),
      audience: z.enum(Object.keys(AUDIENCES)).default('all'),
    },
  }),
  async (req, res) => {
    const { title, body, audience } = req.valid.body;
    const announcement = await Announcement.create({ title, body, audience, sentBy: req.user._id });

    let count = 0;
    let batch = [];
    const flush = async () => {
      await notify(batch, { type: 'announcement', title, body, data: { announcementId: String(announcement._id) } });
      count += batch.length;
      batch = [];
    };
    for await (const user of User.find({ status: 'active', ...AUDIENCES[audience] }).select('_id').lean().cursor()) {
      batch.push(user._id);
      if (batch.length === BATCH) await flush();
    }
    if (batch.length) await flush();

    announcement.recipientCount = count;
    await announcement.save();
    await audit(req, 'announcement.send', { type: 'announcement', id: announcement._id }, { meta: { audience, count } });
    res.status(201).json(announcement);
  },
);

// ---- Audit log ----

router.get(
  '/audit',
  requirePermission(PERMISSIONS.AUDIT_READ),
  validate({ query: { ...pageQuery, actor: objectId.optional(), targetId: objectId.optional(), action: z.string().max(60).optional() } }),
  async (req, res) => {
    const { page, limit, actor, targetId, action } = req.valid.query;
    const filter = { ...(actor && { actor }), ...(targetId && { targetId }), ...(action && { action }) };
    res.json(await paginate(AuditLog, filter, { page, limit, populate: { path: 'actor', select: 'name email' } }));
  },
);

// Recomputes the SHA-256 chain. With `recent`, only the newest entries are checked (fast enough
// for a status display); without it the whole ledger is walked.
router.get(
  '/audit/verify',
  requirePermission(PERMISSIONS.AUDIT_READ),
  validate({ query: { recent: z.coerce.number().int().min(1).max(5000).optional() } }),
  async (req, res) => {
    res.json({ ...(await verifyAuditChain({ limit: req.valid.query.recent })), algorithm: 'sha256', checkedAt: new Date() });
  },
);

const EXPORT_MAX_ROWS = 50_000;
const csvCell = (value) => {
  if (value === undefined || value === null) return '';
  let text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  // Stop spreadsheet apps from running a cell as a formula.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const csvRow = (cells) => `${cells.map(csvCell).join(',')}\r\n`;

// The audit dossier: every admin action in a date range as CSV, with the chain hashes so an
// auditor can recompute them independently.
router.get(
  '/audit/export',
  requirePermission(PERMISSIONS.AUDIT_READ),
  validate({ query: { from: z.coerce.date().optional(), to: z.coerce.date().optional() } }),
  async (req, res) => {
    const to = req.valid.query.to ?? new Date();
    const from = req.valid.query.from ?? new Date(to.getTime() - 30 * 86_400_000);
    if (from > to || to - from > 366 * 86_400_000) throw badRequest('Choose a range of at most one year');

    const filter = { createdAt: { $gte: from, $lte: to } };
    if ((await AuditLog.countDocuments(filter)) > EXPORT_MAX_ROWS) throw badRequest(`More than ${EXPORT_MAX_ROWS.toLocaleString('en-IN')} entries; choose a shorter range`);
    const chain = await verifyAuditChain();

    const day = (d) => d.toISOString().slice(0, 10);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="nurvia-audit-${day(from)}-to-${day(to)}.csv"`);
    res.set('X-Audit-Chain', chain.ok ? `verified; entries=${chain.checked}` : `broken; seq=${chain.brokenAt.seq}; problem=${chain.brokenAt.problem}`);
    res.set('Access-Control-Expose-Headers', 'Content-Disposition, X-Audit-Chain');
    res.write(csvRow(['seq', 'created_at', 'actor_id', 'actor_name', 'actor_email', 'action', 'target_type', 'target_id', 'reason', 'meta', 'ip', 'prev_hash', 'hash']));
    const cursor = AuditLog.find(filter).sort({ createdAt: 1, seq: 1 }).populate('actor', 'name email').lean().cursor();
    let rows = 0;
    for await (const e of cursor) {
      rows += 1;
      res.write(csvRow([e.seq, e.createdAt.toISOString(), e.actor?._id, e.actor?.name, e.actor?.email, e.action, e.targetType, e.targetId, e.reason, e.meta, e.ip, e.prevHash, e.hash]));
    }
    res.end();
    await audit(req, 'audit.export', {}, { meta: { from, to, rows } });
  },
);

// ---- Tenants (SaaS foundation, super admin only) ----

const tenantBody = {
  slug: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().trim().min(1).max(120),
  status: z.enum(['active', 'suspended']).optional(),
  plan: z.string().max(40).optional(),
  branding: z
    .object({ logoUrl: z.string().url().optional(), faviconUrl: z.string().url().optional(), primaryColor: z.string().max(20).optional(), appName: z.string().max(60).optional() })
    .optional(),
  theme: z.object({ primaryColor: z.string().max(20).optional(), accentColor: z.string().max(20).optional(), fontFamily: z.string().max(60).optional() }).optional(),
  business: z
    .object({ legalName: z.string().max(160).optional(), phone: z.string().max(20).optional(), email: z.string().email().optional(), address: z.string().max(300).optional(), gstin: z.string().max(15).optional() })
    .optional(),
  storefront: z.object({ tagline: z.string().max(160).optional(), about: z.string().max(2000).optional(), heroImageUrl: z.string().url().optional() }).optional(),
  nurviaVisibility: z.object({ listInNurvia: z.boolean().optional(), publishProducts: z.boolean().optional() }).optional(),
  settings: z.record(z.unknown()).optional(),
  domains: z.array(z.string().max(253)).max(10).optional(),
};

router.get('/tenants', requirePermission(PERMISSIONS.TENANTS_MANAGE), async (_req, res) => {
  res.json(await Tenant.find().sort({ createdAt: 1 }).lean());
});

router.post('/tenants', requirePermission(PERMISSIONS.TENANTS_MANAGE), validate({ body: tenantBody }), async (req, res) => {
  const tenant = await Tenant.create(req.valid.body);
  await audit(req, 'tenant.create', { type: 'tenant', id: tenant._id });
  res.status(201).json(tenant);
});

router.patch(
  '/tenants/:id',
  requirePermission(PERMISSIONS.TENANTS_MANAGE),
  validate({ body: Object.fromEntries(Object.entries(tenantBody).filter(([k]) => k !== 'slug').map(([k, v]) => [k, v.optional()])) }),
  async (req, res) => {
    const tenant = await Tenant.findByIdAndUpdate(req.valid.params.id, req.valid.body, { new: true, runValidators: true });
    if (!tenant) throw notFound('Tenant');
    clearTenantCache();
    await audit(req, 'tenant.update', { type: 'tenant', id: tenant._id }, { meta: req.valid.body });
    res.json(tenant);
  },
);

export default router;
