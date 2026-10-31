export const ROLES = Object.freeze({
  PET_PARENT: 'pet_parent',
  VENDOR: 'vendor',
  // A member of a vendor's team (receptionist, groomer, vet...), see operations.model.js.
  VENDOR_STAFF: 'vendor_staff',
  CAREGIVER: 'caregiver',
  SELLER: 'seller',
  STAFF: 'staff',
  ADMIN: 'admin',
  SUPER_ADMIN: 'super_admin',
});

export const ALL_ROLES = Object.values(ROLES);
export const ADMIN_PANEL_ROLES = [ROLES.STAFF, ROLES.ADMIN, ROLES.SUPER_ADMIN];

export const PERMISSIONS = Object.freeze({
  USERS_READ: 'users.read',
  USERS_MANAGE: 'users.manage',
  STAFF_MANAGE: 'staff.manage',
  VENDORS_READ: 'vendors.read',
  VENDORS_REVIEW: 'vendors.review',
  CATEGORIES_MANAGE: 'categories.manage',
  BOOKINGS_READ: 'bookings.read',
  BOOKINGS_MANAGE: 'bookings.manage', // cancel or refund on a customer's behalf
  PAYMENTS_READ: 'payments.read',
  ORDERS_READ: 'orders.read',
  ORDERS_MANAGE: 'orders.manage',
  MARKETING_MANAGE: 'marketing.manage', // coupons, referrals, loyalty
  FINANCE_MANAGE: 'finance.manage', // commission rules and settlements
  PLANS_MANAGE: 'plans.manage', // SaaS subscription plans
  NFC_MANAGE: 'nfc.manage',
  CONTENT_MODERATE: 'content.moderate',
  REPORTS_MANAGE: 'reports.manage',
  ANNOUNCEMENTS_SEND: 'announcements.send',
  ANALYTICS_READ: 'analytics.read',
  AUDIT_READ: 'audit.read',
  TENANTS_MANAGE: 'tenants.manage',
  PLATFORM_CONFIGURE: 'platform.configure',
});

const P = PERMISSIONS;

const ROLE_PERMISSIONS = {
  [ROLES.STAFF]: [
    P.USERS_READ,
    P.VENDORS_READ,
    P.BOOKINGS_READ,
    P.PAYMENTS_READ,
    P.ORDERS_READ,
    P.CONTENT_MODERATE,
    P.REPORTS_MANAGE,
    P.ANALYTICS_READ,
  ],
  [ROLES.ADMIN]: Object.values(P).filter((p) => p !== P.TENANTS_MANAGE),
  [ROLES.SUPER_ADMIN]: Object.values(P),
};

// A user's effective permissions are the union of their roles' permissions plus any
// individually granted extras (used to give a staff member one extra capability).
export function permissionsFor(user) {
  const granted = new Set(user.permissions ?? []);
  for (const role of user.roles ?? []) {
    for (const permission of ROLE_PERMISSIONS[role] ?? []) granted.add(permission);
  }
  return granted;
}
