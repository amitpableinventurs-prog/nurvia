import { env } from '../../config/env.js';
import { ApiError } from '../../common/errors.js';
import { runWithTenant } from '../../common/tenancy.js';
import { Tenant } from './tenant.model.js';

const CACHE_MS = 60_000;
const cache = new Map();
const domainCache = new Map();

async function isActive(slug) {
  const hit = cache.get(slug);
  if (hit && hit.expires > Date.now()) return hit.active;
  const tenant = await Tenant.findOne({ slug }).select('status').lean();
  const active = tenant?.status === 'active';
  cache.set(slug, { active, expires: Date.now() + CACHE_MS });
  return active;
}

// A white-label storefront on its own domain: the browser's Origin (or the Host the API is reached
// on) names the tenant when no X-Tenant header is sent.
async function slugForDomain(host) {
  if (!host) return null;
  const domain = host.toLowerCase().replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
  const hit = domainCache.get(domain);
  if (hit && hit.expires > Date.now()) return hit.slug;
  const tenant = await Tenant.findOne({ domains: domain }).select('slug').lean();
  domainCache.set(domain, { slug: tenant?.slug ?? null, expires: Date.now() + CACHE_MS });
  return tenant?.slug ?? null;
}

export const clearTenantCache = () => {
  cache.clear();
  domainCache.clear();
};

// Picks the tenant from the X-Tenant header (white-label apps send it), then a tenant custom domain,
// defaulting to Nurvia, and runs the rest of the request inside that tenant's context.
export async function resolveTenant(req, _res, next) {
  const header = req.get('x-tenant');
  const slug = (header ?? (await slugForDomain(req.get('origin'))) ?? (await slugForDomain(req.get('host'))) ?? env.defaultTenant).toLowerCase();
  if (!/^[a-z0-9-]{2,40}$/.test(slug) || !(await isActive(slug))) {
    throw new ApiError(400, 'UNKNOWN_TENANT', `Unknown or inactive tenant "${slug}"`);
  }
  req.tenant = slug;
  runWithTenant(slug, next);
}
