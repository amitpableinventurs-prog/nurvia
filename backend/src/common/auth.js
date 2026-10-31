import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { User } from '../modules/users/user.model.js';
import { forbidden, unauthorized } from './errors.js';
import { ADMIN_PANEL_ROLES, permissionsFor } from './roles.js';
import { currentTenant } from './tenancy.js';

// `sid` is the session (refresh token family) the token belongs to.
export function signAccessToken(user, sid) {
  return jwt.sign({ sub: String(user._id), tenant: user.tenant, ...(sid && { sid }) }, env.jwt.accessSecret, {
    algorithm: 'HS256',
    expiresIn: env.jwt.accessTtl,
  });
}

async function resolveUser(req) {
  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;

  let payload;
  try {
    payload = jwt.verify(token, env.jwt.accessSecret, { algorithms: ['HS256'] });
  } catch {
    throw unauthorized('Invalid or expired access token');
  }
  if (payload.tenant !== currentTenant()) throw unauthorized('Token was issued for a different tenant');

  // Roles and status are read fresh on every request so suspensions and role changes apply immediately.
  const user = await User.findById(payload.sub).select('roles permissions status name phone email sessionsRevokedAt').lean();
  if (!user || user.status === 'deleted') throw unauthorized('Account not found');
  if (user.status === 'suspended') throw forbidden('This account is suspended');
  // Same-second tokens survive, so tokens issued right after a password change still work.
  if (user.sessionsRevokedAt && payload.iat < Math.floor(user.sessionsRevokedAt.getTime() / 1000)) {
    throw unauthorized('Session has ended; please sign in again');
  }
  const { sessionsRevokedAt, ...rest } = user;
  return { user: rest, session: payload.sid };
}

export async function authenticate(req, _res, next) {
  const resolved = await resolveUser(req);
  if (!resolved) throw unauthorized();
  req.user = resolved.user;
  req.sessionId = resolved.session;
  next();
}

export async function optionalAuth(req, _res, next) {
  const resolved = await resolveUser(req);
  req.user = resolved?.user ?? null;
  req.sessionId = resolved?.session;
  next();
}

export const hasRole = (user, ...roles) => Boolean(user?.roles?.some((role) => roles.includes(role)));

export const can = (user, permission) => Boolean(user) && permissionsFor(user).has(permission);

// The roles and permission tagged onto these guards are listed in the API docs (src/docs/openapi.js).
export function requireRoles(...roles) {
  const guard = (req, _res, next) => {
    if (!hasRole(req.user, ...roles)) throw forbidden();
    next();
  };
  return Object.assign(guard, { roles });
}

export const requireAdminPanel = requireRoles(...ADMIN_PANEL_ROLES);

export function requirePermission(permission) {
  const guard = (req, _res, next) => {
    if (!can(req.user, permission)) throw forbidden(`Missing permission ${permission}`);
    next();
  };
  return Object.assign(guard, { permission });
}
