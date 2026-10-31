import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import morgan from 'morgan';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import swaggerUi from 'swagger-ui-express';
// Must load before the route modules below register their routers.
import './docs/mount-paths.js';
import { buildOpenApiSpec } from './docs/openapi.js';
import { env } from './config/env.js';
import { errorHandler, notFoundHandler } from './common/error-handler.js';
import { publicDir } from './integrations/storage.js';
import adminRoutes from './modules/admin/admin.routes.js';
import adoptionRoutes from './modules/adoption/adoption.routes.js';
import aiRoutes from './modules/ai/ai.routes.js';
import authRoutes from './modules/auth/auth.routes.js';
import bookingRoutes from './modules/bookings/booking.routes.js';
import categoryRoutes from './modules/categories/category.routes.js';
import communityRoutes from './modules/community/community.routes.js';
import communityDogRoutes from './modules/community-dogs/community-dog.routes.js';
import exploreRoutes, { vendorStockChecksRouter } from './modules/explore/explore.routes.js';
import fileRoutes from './modules/files/file.routes.js';
import homeRoutes from './modules/home/home.routes.js';
import { vendorSettlementsRouter } from './modules/finance/finance.routes.js';
import loyaltyRoutes from './modules/loyalty/loyalty.routes.js';
import nfcRoutes from './modules/nfc/nfc.routes.js';
import notificationRoutes from './modules/notifications/notification.routes.js';
import operationsRoutes, { ownerRouter as recordSharesRouter } from './modules/operations/operations.routes.js';
import paymentRoutes, { paymentWebhook } from './modules/payments/payment.routes.js';
import petRoutes, { remindersRouter } from './modules/pets/pet.routes.js';
import planRoutes, { vendorSubscriptionRouter } from './modules/plans/plan.routes.js';
import platformRoutes from './modules/platform/platform.routes.js';
import sosRoutes from './modules/sos/sos.routes.js';
import storefrontRoutes from './modules/tenants/storefront.routes.js';
import { requireFeature } from './modules/platform/platform.service.js';
import reportRoutes from './modules/reports/report.routes.js';
import reviewRoutes from './modules/reviews/review.routes.js';
import shopRoutes from './modules/shop/shop.routes.js';
import { resolveTenant } from './modules/tenants/resolve-tenant.js';
import userRoutes from './modules/users/user.routes.js';
import vendorPanelRoutes from './modules/vendors/vendor-panel.routes.js';
import vendorRoutes from './modules/vendors/vendor.routes.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

  app.use((req, res, next) => {
    req.id = req.get('x-request-id') ?? crypto.randomUUID();
    res.set('x-request-id', req.id);
    next();
  });
  if (env.apiDocs) {
    // Registered before helmet: its CSP (upgrade-insecure-requests) breaks Swagger UI over plain HTTP on a LAN address.
    // The spec is built on first request, once every route below has been registered.
    let spec;
    app.get('/api-docs.json', (_req, res) => res.json((spec ??= buildOpenApiSpec(app))));
    // filter: a search box over the tags; deepLinking: links such as /api-docs/#/config/getConfigCities.
    const swaggerOptions = { url: '/api-docs.json', persistAuthorization: true, filter: true, deepLinking: true };
    app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(null, { swaggerOptions }));
  }
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: env.corsOrigins, allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant', 'X-Request-Id'] }));
  if (env.nodeEnv !== 'test') app.use(morgan(env.isProd ? 'combined' : 'dev'));

  app.get('/health', (_req, res) => {
    const db = mongoose.connection.readyState === 1;
    res.status(db ? 200 : 503).json({ status: db ? 'ok' : 'degraded', db });
  });
  app.use('/media', express.static(publicDir, { maxAge: '7d', index: false, dotfiles: 'deny' }));

  // The webhook needs the unparsed body for signature checks, so it is registered before express.json().
  app.post('/api/v1/payments/webhook', paymentWebhook);

  app.use(express.json({ limit: '1mb' }));
  const api = express.Router();
  api.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false, skip: () => env.nodeEnv === 'test' }));
  api.use(resolveTenant);

  api.use('/auth', authRoutes);
  api.use('/users', userRoutes);
  api.use('/pets', petRoutes);
  api.use('/reminders', remindersRouter);
  api.use('/files', fileRoutes);
  api.use('/categories', categoryRoutes);
  // The vendor workspace routers come first: they also admit staff members, while the panel
  // router below is for the business owner only.
  api.use('/vendors/me', operationsRoutes);
  api.use('/vendors/me', vendorSettlementsRouter);
  api.use('/vendors/me', vendorSubscriptionRouter);
  api.use('/vendors/me', vendorStockChecksRouter);
  api.use('/vendors/me', vendorPanelRoutes);
  api.use('/vendors', vendorRoutes);
  api.use('/bookings', bookingRoutes);
  api.use('/payments', paymentRoutes);
  api.use('/reviews', reviewRoutes);
  api.use('/config', platformRoutes);
  // Sellers keep managing their catalogue, and customers keep seeing past orders, while the marketplace is off.
  const marketplace = requireFeature('marketplace');
  api.use('/shop', (req, res, next) => (req.path.startsWith('/seller') || (req.method === 'GET' && req.path.startsWith('/orders')) ? next() : marketplace(req, res, next)), shopRoutes);
  api.use('/explore', exploreRoutes);
  api.use('/home', homeRoutes);
  api.use('/community-dogs', requireFeature('communityDogs'), communityDogRoutes);
  api.use('/adoption', requireFeature('adoption'), adoptionRoutes);
  api.use('/community', requireFeature('community'), communityRoutes);
  api.use('/reports', reportRoutes);
  api.use('/notifications', notificationRoutes);
  api.use('/ai', requireFeature('ai'), aiRoutes);
  api.use('/record-shares', recordSharesRouter);
  api.use('/nfc', nfcRoutes);
  api.use('/sos', requireFeature('sos'), sosRoutes);
  api.use('/loyalty', loyaltyRoutes);
  api.use('/plans', planRoutes);
  api.use('/storefront', storefrontRoutes);
  api.use('/admin', adminRoutes);

  app.use('/api/v1', api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
