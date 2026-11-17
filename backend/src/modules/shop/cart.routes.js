import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../common/auth.js';
import { badRequest, conflict, notFound } from '../../common/errors.js';
import { objectId, validate } from '../../common/validate.js';
import { apiDoc } from '../../docs/api-doc.js';
import { Cart, Product } from './shop.model.js';
import { MAX_QTY_PER_LINE, quote, shownProducts } from './shop.service.js';

// The signed-in customer's cart, kept on the server so it survives closing the app and moves
// between devices (mounted inside /shop). Only what and how many is stored; every response prices
// it fresh, so a price change or a sold-out item shows up the next time the cart is read.
const router = Router();

const MAX_LINES = 50;
const sku = z.string().min(1).max(60);
const qty = z.number().int().min(1).max(MAX_QTY_PER_LINE);
const productParam = { productId: objectId };

const CART_EXAMPLE = {
  items: [{ productId: '6ad889a8e6cbea1891b82600', sku: 'DES-5-1', qty: 2 }],
  itemCount: 2,
  lines: [
    {
      product: '6ad889a8e6cbea1891b82600', seller: '6ad889a8e6cbea1891b82700', sku: 'DES-5-1', name: 'Homestyle Curd Rice & Chicken Meal', slug: 'homestyle-curd-rice-chicken-meal',
      variantLabel: 'Pack of 6', image: null, art: { kind: 'pouch', color: '#15803d', accent: '#fef08a' }, brand: 'Desi Dog Co.', mrpPaise: 59400, pricePaise: 49900, qty: 2,
    },
  ],
  issues: [],
  pricing: { mrpTotalPaise: 118800, subtotalPaise: 99800, discountPaise: 0, deliveryPaise: 0, totalPaise: 99800, savingsPaise: 19000, freeDeliveryFromPaise: 49900 },
};
const CART_RESPONSE = { 200: { description: 'The cart, priced now', example: CART_EXAMPLE } };

async function pricedCart(userId, couponCode) {
  const cart = await Cart.findOne({ user: userId }).lean();
  const items = (cart?.items ?? []).map((i) => ({ productId: String(i.product), sku: i.sku, qty: i.qty }));
  return { items, itemCount: items.reduce((n, i) => n + i.qty, 0), ...(await quote(items, couponCode, { userId })) };
}

const lineOf = (userId, product, lineSku) => ({ user: userId, items: { $elemMatch: { product, sku: lineSku } } });

// Adds to the line if the item is already in the cart. Atomic, so two quick taps both count.
async function addLine(userId, product, lineSku, amount) {
  const line = lineOf(userId, product, lineSku);
  const bump = () => Cart.updateOne(line, { $inc: { 'items.$.qty': amount } });
  if (!(await bump()).matchedCount) {
    const cart = await Cart.findOne({ user: userId }).select('items.sku').lean();
    if (cart?.items.length >= MAX_LINES) throw badRequest(`A cart can hold at most ${MAX_LINES} different items`);
    try {
      await Cart.updateOne(
        { user: userId, items: { $not: { $elemMatch: { product, sku: lineSku } } } },
        { $push: { items: { product, sku: lineSku, qty: amount } } },
        { upsert: true },
      );
    } catch (err) {
      // A parallel request created the cart first, so this one's upsert hit the unique index.
      if (err.code !== 11000) throw err;
      if (!(await bump()).matchedCount) await Cart.updateOne({ user: userId }, { $push: { items: { product, sku: lineSku, qty: amount } } });
    }
  }
  await Cart.updateOne({ user: userId, items: { $elemMatch: { product, sku: lineSku, qty: { $gt: MAX_QTY_PER_LINE } } } }, { $set: { 'items.$.qty': MAX_QTY_PER_LINE } });
}

router.get(
  '/cart',
  apiDoc({
    summary: 'The signed-in user\'s cart, priced now',
    description: [
      '`items` is what is stored: send it as `items` to `POST /shop/orders` at checkout. `lines` and `pricing` are the same as in `POST /shop/quote`.',
      '`issues` lists lines that changed since they were added ("Only 2 left", "Out of stock", "No longer available"). They stay in the cart until removed, so show them to the user; `POST /shop/orders` refuses a cart with issues.',
      'Pass `couponCode` to price the cart with a coupon. An empty cart returns empty `items` and `lines`.',
      'Lines the customer orders leave the cart on their own: for cash on delivery when the order is placed, for online payment when it is paid.',
    ].join('\n\n'),
    responses: CART_RESPONSE,
  }),
  authenticate,
  validate({ query: { couponCode: z.string().trim().max(20).optional() } }),
  async (req, res) => {
    res.json(await pricedCart(req.user._id, req.valid.query.couponCode));
  },
);

router.post(
  '/cart/items',
  apiDoc({
    summary: 'Add a product variant to the cart',
    description: `Adds \`qty\` (default 1) to what is already in the cart for this \`sku\`, up to ${MAX_QTY_PER_LINE} per line. Returns the cart, as in \`GET /shop/cart\`. An item that is out of stock cannot be added (409).`,
    requestExample: { productId: '6ad889a8e6cbea1891b82600', sku: 'DES-5-1', qty: 1 },
    responses: CART_RESPONSE,
  }),
  authenticate,
  validate({ body: { productId: objectId, sku, qty: qty.optional() } }),
  async (req, res) => {
    const { productId, sku: lineSku, qty: amount = 1 } = req.valid.body;
    const product = await Product.findOne(await shownProducts({ _id: productId })).select('variants.sku variants.stock').lean();
    const variant = product?.variants.find((v) => v.sku === lineSku);
    if (!variant) throw notFound('Product');
    if (!variant.stock) throw conflict('This item is out of stock');
    await addLine(req.user._id, productId, lineSku, amount);
    res.json(await pricedCart(req.user._id));
  },
);

router.patch(
  '/cart/items/:productId',
  apiDoc({
    summary: 'Set the quantity of a cart line',
    description: 'For the + and - buttons: `qty` replaces the quantity of this `sku`. Remove a line with DELETE rather than a quantity of 0. Returns the cart, as in `GET /shop/cart`.',
    requestExample: { sku: 'DES-5-1', qty: 3 },
    responses: CART_RESPONSE,
  }),
  authenticate,
  validate({ params: productParam, body: { sku, qty } }),
  async (req, res) => {
    const { sku: lineSku, qty: amount } = req.valid.body;
    const updated = await Cart.updateOne(lineOf(req.user._id, req.valid.params.productId, lineSku), { $set: { 'items.$.qty': amount } });
    if (!updated.matchedCount) throw notFound('Cart item');
    res.json(await pricedCart(req.user._id));
  },
);

router.delete(
  '/cart/items/:productId',
  apiDoc({
    summary: 'Remove a product from the cart',
    description: 'Removes the line for `sku`, or every variant of the product when `sku` is left out. Removing something that is not in the cart is not an error. Returns the cart, as in `GET /shop/cart`.',
    responses: CART_RESPONSE,
  }),
  authenticate,
  validate({ params: productParam, query: { sku: sku.optional() } }),
  async (req, res) => {
    const { sku: lineSku } = req.valid.query;
    await Cart.updateOne({ user: req.user._id }, { $pull: { items: { product: req.valid.params.productId, ...(lineSku && { sku: lineSku }) } } });
    res.json(await pricedCart(req.user._id));
  },
);

export default router;
