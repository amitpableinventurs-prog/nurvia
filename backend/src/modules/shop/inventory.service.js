import { notify } from '../notifications/notify.js';
import { Vendor } from '../vendors/vendor.model.js';
import { Wishlist } from './aftercare.model.js';
import { Product, StockMovement } from './shop.model.js';

// Every stock change goes through here, so the stock log, the product's in-stock flag, low-stock
// alerts to the seller and back-in-stock alerts to customers stay in step.
//
// A decrease is refused (returns null) when it would take stock below zero, so two shoppers can
// never buy the last unit twice. `sold` also moves the product's sold count (orders and their
// cancellations). Alerts never fail the change that triggered them.
export async function changeStock({ product, sku, delta, reason, ref, by, note, sold = false, set }) {
  const match = { _id: product, variants: { $elemMatch: { sku, ...(delta < 0 && { stock: { $gte: -delta } }) } } };
  const update = set !== undefined ? { $set: { 'variants.$.stock': set } } : { $inc: { 'variants.$.stock': delta, ...(sold && { soldCount: -delta }) } };
  const before = set !== undefined ? await Product.findOne({ _id: product, 'variants.sku': sku }).select('variants.sku variants.stock').lean() : null;
  const updated = await Product.findOneAndUpdate(match, update, { new: true }).select('seller name variants inStock');
  if (!updated) return null;

  const variant = updated.variants.find((v) => v.sku === sku);
  const after = variant.stock;
  const change = set !== undefined ? after - (before?.variants.find((v) => v.sku === sku)?.stock ?? 0) : delta;
  const inStock = updated.variants.some((v) => v.stock > 0);
  if (inStock !== updated.inStock) await Product.updateOne({ _id: product }, { inStock });
  if (change) await StockMovement.create({ seller: updated.seller, product, sku, delta: change, stockAfter: after, reason, ref, by, note });

  const was = after - change;
  try {
    if (change < 0 && after <= (variant.lowStockAt ?? 0) && was > (variant.lowStockAt ?? 0)) await alertLowStock(updated, variant);
    if (change > 0 && was <= 0 && after > 0) await alertBackInStock(updated, variant);
  } catch (err) {
    console.error('[inventory] alert failed', err);
  }
  return { product: updated, variant, stockAfter: after };
}

async function alertLowStock(product, variant) {
  const vendor = await Vendor.findById(product.seller).select('owner').lean();
  await notify([vendor?.owner], {
    type: variant.stock ? 'seller.low_stock' : 'seller.out_of_stock',
    title: variant.stock ? `Low stock: ${product.name}` : `Out of stock: ${product.name}`,
    body: `${variant.label} (${variant.sku}): ${variant.stock} left`,
    data: { productId: String(product._id), sku: variant.sku },
  });
}

// Customers who saved the product (that variant, or the product as a whole) hear when it is back.
async function alertBackInStock(product, variant) {
  const lists = await Wishlist.find({ items: { $elemMatch: { product: product._id, $or: [{ sku: variant.sku }, { sku: null }, { sku: { $exists: false } }] } } }).select('user').lean();
  await notify(
    lists.map((l) => l.user),
    { type: 'shop.back_in_stock', title: `Back in stock: ${product.name}`, body: variant.label, data: { productId: String(product._id), sku: variant.sku } },
  );
}

// Order lines out of stock, all or nothing: anything already taken is put back if a later line fails.
export async function reserveLines(lines, { ref, by } = {}) {
  const taken = [];
  for (const line of lines) {
    const done = await changeStock({ product: line.product, sku: line.sku, delta: -line.qty, reason: 'order', ref, by, sold: true });
    if (!done) {
      await releaseLines(taken, { ref, by, reason: 'order_cancelled', note: 'Checkout failed' });
      return line;
    }
    taken.push(line);
  }
  return null;
}

export async function releaseLines(lines, { ref, by, reason = 'order_cancelled', note } = {}) {
  for (const line of lines) {
    await changeStock({ product: line.product, sku: line.sku, delta: line.qty, reason, ref, by, note, sold: reason === 'order_cancelled' });
  }
}
