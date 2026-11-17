import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { badRequest, conflict, notFound } from '../../common/errors.js';
import { parseCsvObjects, sendCsv } from '../../common/csv.js';
import { escapeRegex, objectId, pageQuery, validate } from '../../common/validate.js';
import { Category } from '../categories/category.model.js';
import { Vendor } from '../vendors/vendor.model.js';
import { ReturnRequest } from './aftercare.model.js';
import { changeStock } from './inventory.service.js';
import { assertPlanFeature, assertWithinPlan } from '../plans/subscription.service.js';
import { ADJUSTMENT_REASONS, DEFAULT_LOW_STOCK, LIFE_STAGES, MAX_VARIANTS, PET_TYPES, Product, ShopOrder, StockMovement } from './shop.model.js';

// Seller inventory, CSV import and export, and the sales report. Mounted inside the seller router
// (/shop/seller), which has already checked that the user is a vendor or seller.
export const sellerInventoryRouter = Router();

const MAX_CSV_ROWS = 1000;
const MAX_CSV_CHARS = 2_000_000;
const csvBody = { csv: z.string().min(1).max(MAX_CSV_CHARS) };
const oid = (id) => new mongoose.Types.ObjectId(String(id));

async function myVendor(req) {
  const vendor = await Vendor.findOne({ owner: req.user._id, status: 'active' }).select('_id businessName subscription').lean();
  if (!vendor) throw conflict('Your business must be approved before you can sell');
  return vendor;
}

// One row per variant, for the inventory screen and its CSV export.
async function variantRows(sellerId, { filter, q } = {}) {
  const lowAt = { $ifNull: ['$variants.lowStockAt', DEFAULT_LOW_STOCK] };
  return Product.aggregate([
    { $match: { seller: oid(sellerId), status: { $ne: 'archived' }, ...(q && { $or: [{ name: { $regex: escapeRegex(q), $options: 'i' } }, { 'variants.sku': q }] }) } },
    { $unwind: '$variants' },
    ...(filter === 'out' ? [{ $match: { 'variants.stock': 0 } }] : []),
    ...(filter === 'low' ? [{ $match: { $expr: { $and: [{ $gt: ['$variants.stock', 0] }, { $lte: ['$variants.stock', lowAt] }] } } }] : []),
    { $sort: { 'variants.stock': 1, name: 1, 'variants.sku': 1 } },
    {
      $project: {
        _id: 0,
        productId: '$_id',
        name: 1,
        slug: 1,
        status: 1,
        sku: '$variants.sku',
        label: '$variants.label',
        stock: '$variants.stock',
        lowStockAt: lowAt,
        mrpPaise: '$variants.mrpPaise',
        pricePaise: '$variants.pricePaise',
      },
    },
  ]);
}

// Variants with their stock, lowest first. filter=low: at or below the low-stock level (and not
// sold out); filter=out: sold out.
sellerInventoryRouter.get(
  '/inventory',
  validate({ query: { ...pageQuery, filter: z.enum(['low', 'out']).optional(), q: z.string().trim().max(80).optional() } }),
  async (req, res) => {
    const vendor = await myVendor(req);
    const { page, limit, filter, q } = req.valid.query;
    const rows = await variantRows(vendor._id, { filter, q });
    const all = filter || q ? await variantRows(vendor._id) : rows;
    res.json({
      items: rows.slice((page - 1) * limit, page * limit),
      page,
      limit,
      total: rows.length,
      pages: Math.ceil(rows.length / limit),
      counts: { all: all.length, low: all.filter((r) => r.stock > 0 && r.stock <= r.lowStockAt).length, out: all.filter((r) => r.stock === 0).length },
    });
  },
);

const INVENTORY_COLUMNS = [
  { label: 'sku', value: 'sku' },
  { label: 'product', value: 'name' },
  { label: 'variant', value: 'label' },
  { label: 'stock', value: 'stock' },
  { label: 'low_stock_at', value: 'lowStockAt' },
  { label: 'mrp', value: (r) => (r.mrpPaise / 100).toFixed(2) },
  { label: 'price', value: (r) => (r.pricePaise / 100).toFixed(2) },
  { label: 'status', value: 'status' },
];

sellerInventoryRouter.get('/inventory/export', validate({ query: { filter: z.enum(['low', 'out']).optional() } }), async (req, res) => {
  const vendor = await myVendor(req);
  sendCsv(res, `inventory-${new Date().toISOString().slice(0, 10)}.csv`, INVENTORY_COLUMNS, await variantRows(vendor._id, { filter: req.valid.query.filter }));
});

// A manual stock change with a reason, kept in the stock log. Give `delta` (+5 received, -2
// damaged) or `set` (the counted stock, for a correction).
sellerInventoryRouter.post(
  '/inventory/adjust',
  validate({
    body: {
      productId: objectId,
      sku: z.string().min(1).max(60),
      delta: z.number().int().min(-100_000).max(100_000).refine((n) => n !== 0, 'Change the stock by at least 1').optional(),
      set: z.number().int().min(0).max(100_000).optional(),
      lowStockAt: z.number().int().min(0).max(100_000).optional(),
      reason: z.enum(ADJUSTMENT_REASONS),
      note: z.string().trim().max(300).optional(),
    },
  }),
  async (req, res) => {
    const vendor = await myVendor(req);
    const { productId, sku, delta, set, lowStockAt, reason, note } = req.valid.body;
    if (delta !== undefined && set !== undefined) throw badRequest('Give either delta or set, not both');
    if (delta === undefined && set === undefined && lowStockAt === undefined) throw badRequest('Give delta, set or lowStockAt');
    const product = await Product.findOne({ _id: productId, seller: vendor._id, status: { $ne: 'archived' }, 'variants.sku': sku }).select('_id').lean();
    if (!product) throw notFound('Product variant');
    if (lowStockAt !== undefined) await Product.updateOne({ _id: productId, 'variants.sku': sku }, { $set: { 'variants.$.lowStockAt': lowStockAt } });
    if (delta !== undefined || set !== undefined) {
      const done = await changeStock({ product: productId, sku, delta: delta ?? 0, set, reason, note, by: req.user._id });
      if (!done) throw conflict('Stock cannot go below zero');
    }
    const fresh = await Product.findById(productId).select('variants').lean();
    res.json(fresh.variants.find((v) => v.sku === sku));
  },
);

sellerInventoryRouter.get('/inventory/log', validate({ query: { ...pageQuery, productId: objectId.optional(), sku: z.string().max(60).optional() } }), async (req, res) => {
  const vendor = await myVendor(req);
  const { page, limit, productId, sku } = req.valid.query;
  const filter = { seller: vendor._id, ...(productId && { product: productId }), ...(sku && { sku }) };
  const [items, total] = await Promise.all([
    StockMovement.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).populate('product', 'name slug').populate('by', 'name').lean(),
    StockMovement.countDocuments(filter),
  ]);
  res.json({ items, page, limit, total, pages: Math.ceil(total / limit) });
});

const paiseOf = (text) => {
  if (text === undefined || text === '') return undefined;
  const n = Number(text.replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN;
};
const intOf = (text) => (text === undefined || text === '' ? undefined : /^\d+$/.test(text) ? Number(text) : NaN);

// Stock and prices for many SKUs at once, from a CSV with the columns sku, stock, mrp, price
// (rupees). Blank cells are left as they are. Each row is applied on its own; failures are listed.
sellerInventoryRouter.post('/inventory/bulk', validate({ body: csvBody }), async (req, res) => {
  const vendor = await myVendor(req);
  const rows = parseCsvObjects(req.valid.body.csv);
  if (!rows.length) throw badRequest('The file has no rows');
  if (rows.length > MAX_CSV_ROWS) throw badRequest(`Upload at most ${MAX_CSV_ROWS} rows at a time`);
  if (!('sku' in rows[0])) throw badRequest('The file needs a sku column');
  const errors = [];
  let updated = 0;
  for (const row of rows) {
    const fail = (message) => errors.push({ line: row.line, sku: row.sku, message });
    const stock = intOf(row.stock);
    const mrp = paiseOf(row.mrp);
    const price = paiseOf(row.price);
    if ([stock, mrp, price].some(Number.isNaN)) {
      fail('Stock must be a whole number and prices must be amounts in rupees');
      continue;
    }
    const matches = await Product.find({ seller: vendor._id, status: { $ne: 'archived' }, 'variants.sku': row.sku }).select('variants').lean();
    if (!matches.length) {
      fail('No product has this SKU');
      continue;
    }
    if (matches.length > 1) {
      fail('Several products use this SKU; update them in the panel');
      continue;
    }
    const variant = matches[0].variants.find((v) => v.sku === row.sku);
    const newMrp = mrp ?? variant.mrpPaise;
    const newPrice = price ?? variant.pricePaise;
    if (newPrice > newMrp) {
      fail('Selling price cannot exceed MRP');
      continue;
    }
    if (mrp !== undefined || price !== undefined) {
      const product = await Product.findById(matches[0]._id);
      const v = product.variants.find((x) => x.sku === row.sku);
      v.mrpPaise = newMrp;
      v.pricePaise = newPrice;
      await product.save();
    }
    if (stock !== undefined) await changeStock({ product: matches[0]._id, sku: row.sku, set: stock, delta: 0, reason: 'bulk_update', by: req.user._id, note: 'CSV upload' });
    updated++;
  }
  res.json({ rows: rows.length, updated, errors });
});

// ---- Product import ----

// One row per variant; rows with the same slug are one product, whose details come from its first
// row. A slug the seller already uses updates that product (its variants are replaced by the file's).
const TEMPLATE = [
  ['slug', 'name', 'brand', 'category', 'pet_types', 'life_stages', 'allergens', 'description', 'hsn', 'gst_rate', 'returnable', 'weight_grams', 'option1', 'option2', 'sku', 'variant_label', 'option1_value', 'option2_value', 'mrp', 'price', 'stock', 'low_stock_at', 'status'],
  ['chicken-kibble-adult', 'Chicken Kibble Adult', 'Wagz', 'dry-food', 'dog', 'adult', 'chicken|wheat', 'Complete food for adult dogs', '2309', '18', 'yes', '3000', 'Pack size', '', 'CKA-3', '3 kg', '3 kg', '', '1400', '999', '25', '5', 'active'],
];

sellerInventoryRouter.get('/products/import/template', async (_req, res) => {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="nurvia-product-template.csv"');
  res.send(TEMPLATE.map((r) => r.join(',')).join('\r\n') + '\r\n');
});

const list = (text) => (text ? text.split('|').map((s) => s.trim()).filter(Boolean) : []);

sellerInventoryRouter.post('/products/import', validate({ body: csvBody }), async (req, res) => {
  const vendor = await myVendor(req);
  const rows = parseCsvObjects(req.valid.body.csv);
  if (!rows.length) throw badRequest('The file has no rows');
  if (rows.length > MAX_CSV_ROWS) throw badRequest(`Upload at most ${MAX_CSV_ROWS} rows at a time`);
  const missing = ['slug', 'name', 'category', 'sku', 'mrp', 'price', 'stock'].filter((c) => !(c in rows[0]));
  if (missing.length) throw badRequest(`The file is missing the column${missing.length > 1 ? 's' : ''} ${missing.join(', ')}`);

  const categories = new Map((await Category.find({ kind: 'product' }).select('slug').lean()).map((c) => [c.slug, c._id]));
  const groups = Map.groupBy(rows, (r) => r.slug.toLowerCase());
  // New products count against the plan; updating existing ones does not.
  const known = new Set((await Product.find({ seller: vendor._id, slug: { $in: [...groups.keys()] }, status: { $ne: 'archived' } }).select('slug').lean()).map((p) => p.slug));
  const adding = [...groups.keys()].filter((slug) => !known.has(slug)).length;
  if (adding) {
    await assertPlanFeature(vendor, 'marketplace');
    await assertWithinPlan(vendor, 'products', adding);
  }
  const errors = [];
  let created = 0;
  let updated = 0;

  for (const [slug, group] of groups) {
    const first = group[0];
    const fail = (message, row = first) => errors.push({ line: row.line, slug, message });
    try {
      if (!/^[a-z0-9-]{1,120}$/.test(slug)) throw new Error('The slug may only use lowercase letters, digits and hyphens');
      const category = categories.get(first.category.toLowerCase());
      if (!category) throw new Error(`Unknown category "${first.category}"`);
      if (group.length > MAX_VARIANTS) throw new Error(`A product can have at most ${MAX_VARIANTS} variants`);
      const options = [first.option1, first.option2].filter(Boolean);
      const petTypes = list(first.pet_types).map((p) => p.toLowerCase());
      const lifeStages = list(first.life_stages).map((p) => p.toLowerCase());
      if (petTypes.some((p) => !PET_TYPES.includes(p))) throw new Error(`Pet types must be from ${PET_TYPES.join(', ')}`);
      if (lifeStages.some((p) => !LIFE_STAGES.includes(p))) throw new Error(`Life stages must be from ${LIFE_STAGES.join(', ')}`);
      const gstRate = first.gst_rate ? Number(first.gst_rate) : undefined;
      if (gstRate !== undefined && ![0, 5, 12, 18, 28].includes(gstRate)) throw new Error('GST rate must be 0, 5, 12, 18 or 28');
      const status = (first.status || 'active').toLowerCase();
      if (!['draft', 'active', 'hidden'].includes(status)) throw new Error('Status must be draft, active or hidden');

      const variants = group.map((r) => {
        const mrpPaise = paiseOf(r.mrp);
        const pricePaise = paiseOf(r.price);
        const stock = intOf(r.stock);
        const lowStockAt = intOf(r.low_stock_at);
        const where = `Line ${r.line}: `;
        if (!r.sku) throw new Error(`${where}every row needs a SKU`);
        if ([mrpPaise, pricePaise, stock].some((n) => n === undefined || Number.isNaN(n)) || Number.isNaN(lowStockAt)) throw new Error(`${where}MRP, price and stock are required numbers`);
        if (pricePaise > mrpPaise) throw new Error(`${where}selling price cannot exceed MRP`);
        const values = [r.option1_value, r.option2_value].slice(0, options.length);
        if (values.some((v) => !v)) throw new Error(`${where}give a value for ${options.join(' and ')}`);
        return {
          sku: r.sku,
          label: r.variant_label || values.join(' / ') || r.sku,
          mrpPaise,
          pricePaise,
          stock,
          ...(lowStockAt !== undefined && { lowStockAt }),
          ...(options.length && { attributes: Object.fromEntries(options.map((o, i) => [o, values[i]])) }),
        };
      });
      if (new Set(variants.map((v) => v.sku)).size !== variants.length) throw new Error('SKUs must be unique within a product');

      const fields = {
        name: first.name,
        brand: first.brand || undefined,
        category,
        petTypes,
        lifeStages,
        allergens: list(first.allergens).map((a) => a.toLowerCase()),
        description: first.description || undefined,
        hsn: first.hsn || undefined,
        ...(gstRate !== undefined && { gstRate }),
        returnable: !/^(no|false|0)$/i.test(first.returnable ?? ''),
        ...(first.weight_grams && { weightGrams: Number(first.weight_grams) }),
        options,
        status,
      };

      const existing = await Product.findOne({ slug });
      if (existing && String(existing.seller) !== String(vendor._id)) throw new Error('This slug is already used by another store');
      if (existing?.status === 'archived') throw new Error('This slug belongs to a deleted product');
      if (existing) {
        // Stock changes on existing variants go through the stock log; new variants start at their stock.
        const stockChanges = variants.filter((v) => existing.variants.some((old) => old.sku === v.sku && old.stock !== v.stock));
        existing.set({
          ...fields,
          status: existing.status === 'blocked' ? 'blocked' : status,
          variants: variants.map((v) => {
            const old = existing.variants.find((o) => o.sku === v.sku);
            return { ...v, stock: old ? old.stock : v.stock, ...(old?.image && { image: old.image }) };
          }),
        });
        await existing.save();
        for (const v of stockChanges) await changeStock({ product: existing._id, sku: v.sku, set: v.stock, delta: 0, reason: 'bulk_update', by: req.user._id, note: 'Product import' });
        updated++;
      } else {
        await Product.create({ ...fields, slug, seller: vendor._id, variants });
        created++;
      }
    } catch (err) {
      fail(err.message);
    }
  }
  res.json({ rows: rows.length, products: groups.size, created, updated, errors });
});

// ---- Sales report ----

// Orders, units and sales for the seller's own lines, by day, with cancellations and returns.
// Days are in IST. format=csv downloads the same rows.
sellerInventoryRouter.get(
  '/reports/sales',
  validate({ query: { from: z.coerce.date(), to: z.coerce.date(), format: z.enum(['json', 'csv']).default('json') } }),
  async (req, res) => {
    const vendor = await myVendor(req);
    const { from, to, format } = req.valid.query;
    if (to <= from) throw badRequest('The end date must be after the start date');
    if (to - from > 366 * 86_400_000) throw badRequest('Choose at most a year');
    const vendorId = oid(vendor._id);
    const day = (field) => ({ $dateToString: { format: '%Y-%m-%d', date: field, timezone: '+05:30' } });

    const [sales, returns] = await Promise.all([
      ShopOrder.aggregate([
        { $match: { createdAt: { $gte: from, $lt: to }, fulfilments: { $elemMatch: { seller: vendorId, status: { $ne: 'pending_payment' } } } } },
        { $unwind: '$items' },
        { $match: { 'items.seller': vendorId } },
        {
          $group: {
            _id: { day: day('$createdAt'), order: '$_id' },
            units: { $sum: { $cond: ['$items.cancelled', 0, '$items.qty'] } },
            grossPaise: { $sum: { $cond: ['$items.cancelled', 0, { $multiply: ['$items.pricePaise', '$items.qty'] }] } },
            cancelledUnits: { $sum: { $cond: ['$items.cancelled', '$items.qty', 0] } },
            cancelledPaise: { $sum: { $cond: ['$items.cancelled', { $multiply: ['$items.pricePaise', '$items.qty'] }, 0] } },
          },
        },
        {
          $group: {
            _id: '$_id.day',
            orders: { $sum: { $cond: [{ $gt: ['$units', 0] }, 1, 0] } },
            units: { $sum: '$units' },
            grossPaise: { $sum: '$grossPaise' },
            cancelledUnits: { $sum: '$cancelledUnits' },
            cancelledPaise: { $sum: '$cancelledPaise' },
          },
        },
      ]),
      ReturnRequest.aggregate([
        { $match: { seller: vendorId, createdAt: { $gte: from, $lt: to }, status: { $nin: ['rejected', 'cancelled'] } } },
        { $unwind: '$items' },
        { $group: { _id: day('$createdAt'), returnedUnits: { $sum: '$items.qty' }, returnedPaise: { $sum: { $multiply: ['$items.pricePaise', '$items.qty'] } } } },
      ]),
    ]);

    const byDay = new Map();
    const empty = (date) => ({ date, orders: 0, units: 0, grossPaise: 0, cancelledUnits: 0, cancelledPaise: 0, returnedUnits: 0, returnedPaise: 0 });
    for (const s of sales) byDay.set(s._id, { ...empty(s._id), ...s, _id: undefined });
    for (const r of returns) byDay.set(r._id, { ...(byDay.get(r._id) ?? empty(r._id)), returnedUnits: r.returnedUnits, returnedPaise: r.returnedPaise });
    const days = [...byDay.values()].map(({ _id, ...d }) => d).sort((a, b) => a.date.localeCompare(b.date));
    const keys = ['orders', 'units', 'grossPaise', 'cancelledUnits', 'cancelledPaise', 'returnedUnits', 'returnedPaise'];
    const totals = Object.fromEntries(keys.map((k) => [k, days.reduce((n, d) => n + d[k], 0)]));

    if (format === 'csv') {
      const rupees = (k) => (r) => (r[k] / 100).toFixed(2);
      return sendCsv(res, `sales-${from.toISOString().slice(0, 10)}-${to.toISOString().slice(0, 10)}.csv`, [
        { label: 'date', value: 'date' },
        { label: 'orders', value: 'orders' },
        { label: 'units', value: 'units' },
        { label: 'gross_sales', value: rupees('grossPaise') },
        { label: 'cancelled_units', value: 'cancelledUnits' },
        { label: 'cancelled_value', value: rupees('cancelledPaise') },
        { label: 'returned_units', value: 'returnedUnits' },
        { label: 'returned_value', value: rupees('returnedPaise') },
      ], [...days, { date: 'Total', ...totals }]);
    }
    res.json({ from, to, days, totals });
  },
);
