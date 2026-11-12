import { Router } from 'express';
import { z } from 'zod';
import { hasRole, requirePermission } from '../../common/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../../common/errors.js';
import { paginate } from '../../common/paginate.js';
import { ADMIN_PANEL_ROLES, ALL_ROLES, PERMISSIONS, ROLES } from '../../common/roles.js';
import { escapeRegex, pageQuery, validate } from '../../common/validate.js';
import { audit } from '../audit/audit.model.js';
import { hashPassword, revokeAllSessions } from '../auth/auth.service.js';
import { Booking } from '../bookings/booking.model.js';
import { Pet } from '../pets/pet.model.js';
import { ShopOrder } from '../shop/shop.model.js';
import { User } from '../users/user.model.js';
import { Vendor } from '../vendors/vendor.model.js';

const router = Router();
const { USERS_READ, USERS_MANAGE, STAFF_MANAGE } = PERMISSIONS;

// What a list row needs. Saved addresses, location and emergency contacts stay on the detail route.
const LIST_FIELDS = 'name phone email avatarUrl city locality roles status statusReason lastLoginAt createdAt';

// Pets, bookings and shop orders for one page of users. An order still waiting for payment was
// never placed, so it does not count.
async function activityCounts(users) {
  const ids = users.map((u) => u._id);
  const countBy = async (Model, key, match = {}) => {
    const rows = await Model.aggregate([{ $match: { [key]: { $in: ids }, ...match } }, { $group: { _id: `$${key}`, count: { $sum: 1 } } }]);
    return new Map(rows.map((r) => [String(r._id), r.count]));
  };
  const [pets, bookings, orders] = await Promise.all([
    countBy(Pet, 'owner', { archivedAt: null }),
    countBy(Booking, 'user'),
    countBy(ShopOrder, 'user', { status: { $ne: 'pending_payment' } }),
  ]);
  const count = (map, user) => map.get(String(user._id)) ?? 0;
  return users.map((u) => ({ ...u, petCount: count(pets, u), bookingCount: count(bookings, u), orderCount: count(orders, u) }));
}

router.get(
  '/',
  requirePermission(USERS_READ),
  validate({
    query: {
      ...pageQuery,
      q: z.string().trim().max(80).optional(),
      status: z.enum(['active', 'suspended', 'deleted']).optional(),
      role: z.enum(ALL_ROLES).optional(),
    },
  }),
  async (req, res) => {
    const { page, limit, q, status, role } = req.valid.query;
    const pattern = q && { $regex: escapeRegex(q), $options: 'i' };
    const filter = {
      ...(status && { status }),
      ...(role && { roles: role }),
      ...(pattern && { $or: [{ name: pattern }, { phone: pattern }, { email: pattern }] }),
    };
    const result = await paginate(User, filter, { page, limit, select: LIST_FIELDS });
    res.json({ ...result, items: await activityCounts(result.items) });
  },
);

router.get('/:id', requirePermission(USERS_READ), validate(), async (req, res) => {
  const user = await User.findById(req.valid.params.id).lean();
  if (!user) throw notFound('User');
  const [pets, bookings, vendor] = await Promise.all([
    Pet.find({ owner: user._id }).select('name species breed archivedAt').lean(),
    Booking.countDocuments({ user: user._id }),
    Vendor.findOne({ owner: user._id }).select('businessName status').lean(),
  ]);
  delete user.passwordHash;
  res.json({ ...user, pets, bookingCount: bookings, vendor });
});

// Staff cannot act on accounts that hold admin-panel roles above their own.
function assertCanManage(actor, target) {
  if (String(actor._id) === String(target._id)) throw badRequest('You cannot change your own account here');
  if (hasRole(target, ROLES.SUPER_ADMIN) && !hasRole(actor, ROLES.SUPER_ADMIN)) throw forbidden();
  if (hasRole(target, ROLES.ADMIN) && !hasRole(actor, ROLES.ADMIN, ROLES.SUPER_ADMIN)) throw forbidden();
}

router.patch(
  '/:id/status',
  requirePermission(USERS_MANAGE),
  validate({ body: { status: z.enum(['active', 'suspended']), reason: z.string().trim().min(3).max(500) } }),
  async (req, res) => {
    const user = await User.findById(req.valid.params.id);
    if (!user || user.status === 'deleted') throw notFound('User');
    assertCanManage(req.user, user);
    const { status, reason } = req.valid.body;
    user.status = status;
    user.statusReason = reason;
    await user.save();
    if (status === 'suspended') await revokeAllSessions(user._id);
    await audit(req, `user.${status === 'suspended' ? 'suspend' : 'reactivate'}`, { type: 'user', id: user._id }, { reason });
    res.json(user);
  },
);

// Only admin-panel roles are assigned here; app roles (vendor, caregiver...) follow from user actions.
router.put(
  '/:id/roles',
  requirePermission(STAFF_MANAGE),
  validate({ body: { panelRoles: z.array(z.enum(ADMIN_PANEL_ROLES)).max(3), permissions: z.array(z.string().max(60)).max(30).optional() } }),
  async (req, res) => {
    const user = await User.findById(req.valid.params.id);
    if (!user || user.status === 'deleted') throw notFound('User');
    assertCanManage(req.user, user);
    const { panelRoles, permissions } = req.valid.body;
    const granting = panelRoles.some((r) => r === ROLES.ADMIN || r === ROLES.SUPER_ADMIN);
    if (granting && !hasRole(req.user, ROLES.SUPER_ADMIN)) throw forbidden('Only a super admin can grant admin roles');

    user.roles = [...user.roles.filter((r) => !ADMIN_PANEL_ROLES.includes(r)), ...panelRoles];
    if (permissions) user.permissions = permissions;
    await user.save();
    await audit(req, 'user.roles', { type: 'user', id: user._id }, { meta: { panelRoles, permissions } });
    res.json(user);
  },
);

router.post(
  '/staff',
  requirePermission(STAFF_MANAGE),
  validate({
    body: {
      name: z.string().trim().min(1).max(120),
      email: z.string().email().toLowerCase(),
      password: z.string().min(12).max(200),
      role: z.enum([ROLES.STAFF, ROLES.ADMIN]).default(ROLES.STAFF),
    },
  }),
  async (req, res) => {
    const { name, email, password, role } = req.valid.body;
    if (role === ROLES.ADMIN && !hasRole(req.user, ROLES.SUPER_ADMIN)) throw forbidden('Only a super admin can create admins');
    if (await User.exists({ email })) throw conflict('An account with that email already exists');
    const user = await User.create({ name, email, passwordHash: await hashPassword(password), roles: [role] });
    await audit(req, 'staff.create', { type: 'user', id: user._id }, { meta: { role } });
    res.status(201).json(user);
  },
);

export default router;
