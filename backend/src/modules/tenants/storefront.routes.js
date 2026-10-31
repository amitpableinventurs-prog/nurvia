import { Router } from 'express';
import { notFound } from '../../common/errors.js';
import { getPlatform } from '../platform/platform.service.js';
import { Product } from '../shop/shop.model.js';
import { Vendor } from '../vendors/vendor.model.js';
import { Tenant } from './tenant.model.js';

// What a branded web storefront needs to render itself: the current tenant's name, branding,
// theme, storefront copy, contact details and which modules are on. Mounted at /storefront.
const router = Router();

router.get('/', async (req, res) => {
  const tenant = await Tenant.findOne({ slug: req.tenant }).select('slug name branding theme business storefront nurviaVisibility').lean();
  if (!tenant) throw notFound('Storefront');
  const [{ features }, vendors, products] = await Promise.all([
    getPlatform(),
    Vendor.countDocuments({ status: 'active' }),
    Product.countDocuments({ status: 'active' }),
  ]);
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ ...tenant, features, counts: { vendors, products } });
});

export default router;
