import { authenticate } from '../../common/auth.js';
import { forbidden, notFound } from '../../common/errors.js';
import { ROLES } from '../../common/roles.js';
import { Vendor } from '../vendors/vendor.model.js';
import { CAPABILITIES, ROLE_CAPABILITIES, VendorCustomer, VendorStaff } from './operations.model.js';

// Resolves the vendor workspace for the signed-in user: the business they own, or the one they work
// at as active staff. Sets req.vendor, req.staff (null for the owner) and req.capabilities.
async function resolveWorkspace(req, _res, next) {
  const owned = await Vendor.findOne({ owner: req.user._id }).lean();
  if (owned) {
    req.vendor = owned;
    req.staff = null;
    req.capabilities = new Set(CAPABILITIES);
    return next();
  }
  const staff = await VendorStaff.findOne({ user: req.user._id, active: true }).lean();
  const vendor = staff && (await Vendor.findOne({ _id: staff.vendor, status: { $ne: 'rejected' } }).lean());
  if (!vendor) throw notFound('Vendor workspace');
  req.vendor = vendor;
  req.staff = staff;
  req.capabilities = new Set([...(ROLE_CAPABILITIES[staff.role] ?? []), ...(staff.extraCapabilities ?? [])]);
  next();
}

export const vendorWorkspace = [authenticate, Object.assign(resolveWorkspace, { roles: [ROLES.VENDOR, ROLES.VENDOR_STAFF] })];

export function requireCapability(capability) {
  const guard = (req, _res, next) => {
    if (!req.capabilities?.has(capability)) throw forbidden(`Your role cannot do this (${capability})`);
    next();
  };
  return Object.assign(guard, { permission: `vendor:${capability}` });
}

// Keeps the vendor's CRM in step with Nurvia: a Nurvia customer who books becomes (or updates) a CRM
// customer with source "nurvia", and the booked pet is linked to its passport.
export async function syncCustomerFromBooking(vendorId, user, pet) {
  const customer =
    (await VendorCustomer.findOne({ vendor: vendorId, user: user._id })) ??
    (user.phone && (await VendorCustomer.findOne({ vendor: vendorId, phone: user.phone, user: { $exists: false } }))) ??
    new VendorCustomer({ vendor: vendorId, source: 'nurvia', name: user.name || 'Nurvia customer' });
  customer.user = user._id;
  if (user.phone) customer.phone = user.phone;
  if (!customer.email && user.email) customer.email = user.email;
  const linked = customer.pets.find((p) => String(p.pet) === String(pet._id));
  if (!linked) customer.pets.push({ name: pet.name, species: pet.species, breed: pet.breed, sex: pet.sex, pet: pet._id });
  await customer.save();
  return customer;
}

export async function recordVisit(customerId, at) {
  if (!customerId) return;
  await VendorCustomer.updateOne({ _id: customerId }, { $inc: { visitCount: 1 }, $max: { lastVisitAt: at } });
}
