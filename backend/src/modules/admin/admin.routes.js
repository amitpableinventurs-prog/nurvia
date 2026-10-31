import { Router } from 'express';
import { authenticate, requireAdminPanel, requirePermission } from '../../common/auth.js';
import { PERMISSIONS, permissionsFor } from '../../common/roles.js';
import { adminFinanceRouter, adminSellersRouter } from '../finance/finance.routes.js';
import { adminLoyaltyRouter } from '../loyalty/loyalty.routes.js';
import { adminNfcRouter } from '../nfc/nfc.routes.js';
import { adminPlansRouter } from '../plans/plan.routes.js';
import { adminReturnsRouter } from '../shop/aftercare.routes.js';
import { adminBannersRouter } from '../home/home.routes.js';
import { adminSosRouter } from '../sos/sos.routes.js';
import management from './management.routes.js';
import bookings from './bookings.routes.js';
import compliance from './compliance.routes.js';
import dashboard from './dashboard.routes.js';
import moderation, { reportsRouter } from './moderation.routes.js';
import overview from './overview.routes.js';
import platformConfig from './platform-config.routes.js';
import platform from './platform.routes.js';
import users from './users.routes.js';
import vendors from './vendors.routes.js';

const router = Router();
router.use(authenticate, requireAdminPanel);

// Lets the admin panel show only the screens the signed-in staff member can use.
router.get('/session', (req, res) => {
  res.json({ user: req.user, permissions: [...permissionsFor(req.user)] });
});

// Checks permissions per route, so it goes ahead of the routers that guard everything they see.
router.use('/', management);
router.use('/', adminPlansRouter);
router.use('/nfc', requirePermission(PERMISSIONS.NFC_MANAGE), adminNfcRouter);
router.use('/sos', requirePermission(PERMISSIONS.CONTENT_MODERATE), adminSosRouter);
router.use('/sellers', adminSellersRouter);
router.use('/finance', adminFinanceRouter);
router.use('/loyalty', adminLoyaltyRouter);
router.use('/shop', requirePermission(PERMISSIONS.ORDERS_READ), adminReturnsRouter);
router.use('/banners', requirePermission(PERMISSIONS.MARKETING_MANAGE), adminBannersRouter);
router.use('/users', users);
router.use('/bookings', bookings);
router.use('/moderation', moderation);
router.use('/reports', reportsRouter);
router.use('/', dashboard);
router.use('/', overview);
router.use('/', platformConfig);
router.use('/compliance', compliance);
router.use('/', vendors);
router.use('/', platform);

export default router;
