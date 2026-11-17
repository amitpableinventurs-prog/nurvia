import mongoose from 'mongoose';
import { attachmentSchema } from '../../common/schemas.js';
import { tenantPlugin } from '../../common/tenancy.js';

const { ObjectId } = mongoose.Schema.Types;

export const PET_TYPES = ['dog', 'cat', 'bird', 'fish', 'small_pet'];
export const LIFE_STAGES = ['puppy_kitten', 'adult', 'senior', 'all'];
export const MAX_VARIANTS = 50;
export const MAX_OPTIONS = 2;
export const DEFAULT_LOW_STOCK = 5;

// One purchasable option of a product (a pack size, a colour). Stock lives here.
const variantSchema = new mongoose.Schema(
  {
    sku: { type: String, required: true, trim: true, maxlength: 60 },
    label: { type: String, required: true, maxlength: 60 }, // "3 kg", "Medium", "Pack of 2"
    mrpPaise: { type: Number, required: true, min: 0 },
    pricePaise: { type: Number, required: true, min: 0 },
    stock: { type: Number, required: true, min: 0, default: 0 },
    // At or below this the seller is alerted and the variant shows under the low-stock filter.
    lowStockAt: { type: Number, min: 0, default: DEFAULT_LOW_STOCK },
    // Values for the product's option names, e.g. { "Pack size": "3 kg", "Flavour": "Chicken" }.
    attributes: { type: Map, of: String },
    image: attachmentSchema,
  },
  { _id: false },
);

const productSchema = new mongoose.Schema(
  {
    seller: { type: ObjectId, ref: 'Vendor', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    slug: { type: String, required: true, lowercase: true, match: /^[a-z0-9-]+$/ },
    brand: { type: String, trim: true, maxlength: 80 },
    category: { type: ObjectId, ref: 'Category', required: true },
    petTypes: [{ type: String, enum: PET_TYPES }],
    lifeStages: [{ type: String, enum: LIFE_STAGES }],
    // Ingredients a pet may be allergic to (chicken, beef, grain...).
    allergens: [{ type: String, lowercase: true, trim: true, maxlength: 40 }],
    weightGrams: { type: Number, min: 0 },
    // false: never returnable (opened food, medicines). Otherwise the category's return window applies.
    returnable: { type: Boolean, default: true },
    // Up to 2 option names the variants are chosen by, e.g. ["Pack size", "Flavour"].
    options: { type: [{ type: String, trim: true, maxlength: 30 }], validate: { validator: (v) => v.length <= MAX_OPTIONS, message: `At most ${MAX_OPTIONS} options` } },
    description: { type: String, maxlength: 5000 },
    highlights: [{ type: String, maxlength: 160 }],
    images: [attachmentSchema],
    // Illustration used until real photos are uploaded: packaging shape and brand colour.
    art: {
      kind: { type: String, enum: ['bag', 'can', 'bottle', 'box', 'ball', 'bone', 'collar', 'bed', 'tube', 'pouch'], default: 'box' },
      color: { type: String, default: '#1f5c4a' },
      accent: { type: String, default: '#ff7a45' },
    },
    variants: { type: [variantSchema], validate: { validator: (v) => v.length > 0 && v.length <= MAX_VARIANTS, message: `A product needs 1 to ${MAX_VARIANTS} variants` } },
    hsn: String,
    gstRate: { type: Number, enum: [0, 5, 12, 18, 28], default: 18 }, // prices are GST-inclusive
    tags: [{ type: String, lowercase: true, maxlength: 40 }],
    // archived: deleted by the seller after it was ordered; kept so past orders still resolve.
    // blocked: taken down by Nurvia staff. Only staff can lift it; the seller sees the reason.
    status: { type: String, enum: ['draft', 'active', 'hidden', 'blocked', 'archived'], default: 'active', index: true },
    archivedAt: Date,
    blocked: { reason: String, by: { type: ObjectId, ref: 'User' }, at: Date, previousStatus: String },
    featured: { type: Boolean, default: false },
    ratingAvg: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
    soldCount: { type: Number, default: 0 },
    // Denormalised from variants for sorting and filtering.
    pricePaise: Number,
    mrpPaise: Number,
    discountPct: Number,
    inStock: Boolean,
  },
  { timestamps: true },
);
productSchema.plugin(tenantPlugin);
productSchema.index({ tenant: 1, slug: 1 }, { unique: true });
productSchema.index({ tenant: 1, status: 1, category: 1, pricePaise: 1 });
productSchema.index({ tenant: 1, status: 1, soldCount: -1 });
productSchema.index({ tenant: 1, status: 1, discountPct: -1 });
productSchema.index({ tenant: 1, seller: 1, 'variants.sku': 1 });

productSchema.pre('validate', function denormalise() {
  if (!this.variants?.length) return;
  const cheapest = this.variants.reduce((a, b) => (b.pricePaise < a.pricePaise ? b : a));
  this.pricePaise = cheapest.pricePaise;
  this.mrpPaise = cheapest.mrpPaise;
  this.discountPct = Math.max(0, ...this.variants.map((v) => (v.mrpPaise ? Math.round((1 - v.pricePaise / v.mrpPaise) * 100) : 0)));
  this.inStock = this.variants.some((v) => v.stock > 0);
});

// A cart discount. A coupon is applied when the customer enters its code; an automatic discount
// (`autoApply`) is applied at checkout without one, and the order still records its code.
// Nurvia funds every coupon: sellers are settled on their full item prices.
const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, uppercase: true, trim: true, match: /^[A-Z0-9]{3,20}$/ },
    description: String,
    type: { type: String, enum: ['percent', 'flat'], required: true },
    value: { type: Number, required: true, min: 0 }, // percent, or paise for flat
    minOrderPaise: { type: Number, default: 0 },
    maxDiscountPaise: Number,
    autoApply: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
    startsAt: Date,
    expiresAt: Date,
    // Orders that may use the code in all, and per customer. Cancelled and unpaid orders do not count.
    usageLimit: { type: Number, min: 1 },
    perCustomerLimit: { type: Number, min: 1 },
    // When set, the discount applies only to items in these categories or from these sellers, and
    // the minimum order value is counted on those items.
    categories: [{ type: ObjectId, ref: 'Category' }],
    sellers: [{ type: ObjectId, ref: 'Vendor' }],
    // Only for a customer with no earlier order that was placed (cancelled and unpaid ones aside).
    firstOrderOnly: { type: Boolean, default: false },
  },
  { timestamps: true },
);
couponSchema.plugin(tenantPlugin);
couponSchema.index({ tenant: 1, code: 1 }, { unique: true });

// Each seller's part of an order moves through these on its own (`fulfilments`). The order's
// `status` is the least advanced of its live parts, or cancelled when every part is.
// `shipped` is shown as "Out for delivery"; store pickup uses `ready_for_pickup` instead, and a
// picked-up part is `delivered`. `packed` is optional: a seller may go from confirmed straight on.
export const ORDER_STATUSES = ['pending_payment', 'placed', 'confirmed', 'packed', 'shipped', 'ready_for_pickup', 'delivered', 'cancelled'];
export const FULFILMENT_METHODS = ['delivery', 'pickup'];

const historyEntry = { _id: false, status: String, at: { type: Date, default: Date.now }, by: { type: ObjectId, ref: 'User' }, note: String };

const fulfilmentSchema = new mongoose.Schema(
  {
    seller: { type: ObjectId, ref: 'Vendor', required: true },
    method: { type: String, enum: FULFILMENT_METHODS, default: 'delivery' },
    deliveryPaise: { type: Number, default: 0 },
    status: { type: String, enum: ORDER_STATUSES, required: true },
    statusHistory: [historyEntry],
    deliveredAt: Date,
    // Set once the seller has been reminded about a placed part it has not confirmed.
    remindedAt: Date,
  },
  { _id: false },
);

const orderSchema = new mongoose.Schema(
  {
    code: { type: String, required: true },
    user: { type: ObjectId, ref: 'User', required: true },
    items: [
      {
        _id: false,
        product: { type: ObjectId, ref: 'Product', required: true },
        seller: { type: ObjectId, ref: 'Vendor', required: true },
        sku: { type: String, required: true },
        name: String,
        slug: String,
        variantLabel: String,
        image: String,
        art: { kind: String, color: String, accent: String },
        brand: String,
        mrpPaise: Number,
        pricePaise: { type: Number, required: true },
        qty: { type: Number, required: true, min: 1 },
        category: { type: ObjectId, ref: 'Category' },
        returnable: { type: Boolean, default: true },
        hsn: String,
        gstRate: Number,
        // Fixed when the order is placed, so a later rate change never alters it.
        commissionPct: Number,
        cancelled: { type: Boolean, default: false },
        cancelledAt: Date,
        cancelReason: String,
      },
    ],
    fulfilments: [fulfilmentSchema],
    address: {
      name: { type: String, required: true },
      phone: { type: String, required: true },
      line1: { type: String, required: true },
      line2: String,
      city: { type: String, required: true },
      state: String,
      pincode: { type: String, required: true },
      lat: Number,
      lng: Number,
    },
    pricing: {
      mrpTotalPaise: Number,
      subtotalPaise: { type: Number, required: true },
      discountPaise: { type: Number, default: 0 },
      deliveryPaise: { type: Number, default: 0 },
      // Loyalty points spent on this order; Nurvia funds this discount, not the seller.
      pointsRedeemed: { type: Number, default: 0 },
      pointsDiscountPaise: { type: Number, default: 0 },
      totalPaise: { type: Number, required: true },
      couponCode: String,
    },
    pointsReturned: { type: Boolean, default: false },
    // Points given back so far for cancelled lines.
    pointsReturnedCount: { type: Number, default: 0 },
    paymentMethod: { type: String, enum: ['online', 'cod'], required: true },
    status: { type: String, enum: ORDER_STATUSES, required: true },
    statusHistory: [historyEntry],
    payment: {
      status: { type: String, enum: ['unpaid', 'pending', 'paid', 'failed', 'refund_pending', 'refunded'], default: 'unpaid' },
      gateway: String,
      orderId: String,
      paymentId: String,
      refundId: String,
      amountPaise: Number,
      // Sum of every refund made, so the total refunded can never exceed what was paid.
      refundedPaise: { type: Number, default: 0 },
      paidAt: Date,
      refundedAt: Date,
      failureReason: String,
      // Each refund: cancelled lines, a return, or the whole order.
      refunds: [{ _id: false, amountPaise: Number, refundId: String, status: { type: String, enum: ['pending', 'processed'] }, reason: String, at: { type: Date, default: Date.now } }],
    },
    deliveredAt: Date,
    stockReleased: { type: Boolean, default: false },
  },
  { timestamps: true },
);
orderSchema.plugin(tenantPlugin);
orderSchema.index({ tenant: 1, code: 1 }, { unique: true });
orderSchema.index({ tenant: 1, user: 1, createdAt: -1 });
orderSchema.index({ tenant: 1, 'items.seller': 1, createdAt: -1 });
// Admin list, newest first.
orderSchema.index({ tenant: 1, createdAt: -1 });
orderSchema.index({ 'payment.orderId': 1 }, { sparse: true });
orderSchema.index({ status: 1, createdAt: 1 });
orderSchema.index({ tenant: 1, 'fulfilments.seller': 1, 'fulfilments.status': 1 });
orderSchema.index({ tenant: 1, 'pricing.couponCode': 1, user: 1 });

// The customer's cart, kept on the server so it survives closing the app and moves between devices.
// Prices are not stored: the cart is priced fresh (quote) every time it is read.
const cartSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    items: [{ _id: false, product: { type: ObjectId, ref: 'Product', required: true }, sku: { type: String, required: true }, qty: { type: Number, required: true, min: 1 }, addedAt: { type: Date, default: Date.now } }],
  },
  { timestamps: true },
);
cartSchema.plugin(tenantPlugin);
cartSchema.index({ tenant: 1, user: 1 }, { unique: true });

// Every change to a variant's stock, for the seller's stock log.
export const STOCK_REASONS = ['order', 'order_cancelled', 'return_restock', 'received', 'damaged', 'correction', 'bulk_update'];
export const ADJUSTMENT_REASONS = ['received', 'damaged', 'correction'];

const stockMovementSchema = new mongoose.Schema(
  {
    seller: { type: ObjectId, ref: 'Vendor', required: true },
    product: { type: ObjectId, ref: 'Product', required: true },
    sku: { type: String, required: true },
    delta: { type: Number, required: true },
    stockAfter: Number,
    reason: { type: String, enum: STOCK_REASONS, required: true },
    note: { type: String, maxlength: 300 },
    ref: String, // order or return code
    by: { type: ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
stockMovementSchema.plugin(tenantPlugin);
stockMovementSchema.index({ tenant: 1, seller: 1, createdAt: -1 });
stockMovementSchema.index({ tenant: 1, product: 1, sku: 1, createdAt: -1 });

export const Product = mongoose.model('Product', productSchema);
export const Cart = mongoose.model('Cart', cartSchema);
export const Coupon = mongoose.model('Coupon', couponSchema);
export const ShopOrder = mongoose.model('ShopOrder', orderSchema);
export const StockMovement = mongoose.model('StockMovement', stockMovementSchema);
