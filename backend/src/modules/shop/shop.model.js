import mongoose from 'mongoose';
import { attachmentSchema } from '../../common/schemas.js';
import { tenantPlugin } from '../../common/tenancy.js';

const { ObjectId } = mongoose.Schema.Types;

export const PET_TYPES = ['dog', 'cat', 'bird', 'fish', 'small_pet'];

// One purchasable option of a product (a pack size, a colour). Stock lives here.
const variantSchema = new mongoose.Schema(
  {
    sku: { type: String, required: true, trim: true, maxlength: 60 },
    label: { type: String, required: true, maxlength: 60 }, // "3 kg", "Medium", "Pack of 2"
    mrpPaise: { type: Number, required: true, min: 0 },
    pricePaise: { type: Number, required: true, min: 0 },
    stock: { type: Number, required: true, min: 0, default: 0 },
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
    description: { type: String, maxlength: 5000 },
    highlights: [{ type: String, maxlength: 160 }],
    images: [attachmentSchema],
    // Illustration used until real photos are uploaded: packaging shape and brand colour.
    art: {
      kind: { type: String, enum: ['bag', 'can', 'bottle', 'box', 'ball', 'bone', 'collar', 'bed', 'tube', 'pouch'], default: 'box' },
      color: { type: String, default: '#1f5c4a' },
      accent: { type: String, default: '#ff7a45' },
    },
    variants: { type: [variantSchema], validate: { validator: (v) => v.length > 0, message: 'At least one variant is required' } },
    hsn: String,
    gstRate: { type: Number, enum: [0, 5, 12, 18, 28], default: 18 }, // prices are GST-inclusive
    tags: [{ type: String, lowercase: true, maxlength: 40 }],
    // archived: deleted by the seller after it was ordered; kept so past orders still resolve.
    status: { type: String, enum: ['draft', 'active', 'hidden', 'archived'], default: 'active', index: true },
    archivedAt: Date,
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

productSchema.pre('validate', function denormalise() {
  if (!this.variants?.length) return;
  const cheapest = this.variants.reduce((a, b) => (b.pricePaise < a.pricePaise ? b : a));
  this.pricePaise = cheapest.pricePaise;
  this.mrpPaise = cheapest.mrpPaise;
  this.discountPct = Math.max(0, ...this.variants.map((v) => (v.mrpPaise ? Math.round((1 - v.pricePaise / v.mrpPaise) * 100) : 0)));
  this.inStock = this.variants.some((v) => v.stock > 0);
});

const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, uppercase: true, trim: true, match: /^[A-Z0-9]{3,20}$/ },
    description: String,
    type: { type: String, enum: ['percent', 'flat'], required: true },
    value: { type: Number, required: true, min: 0 }, // percent, or paise for flat
    minOrderPaise: { type: Number, default: 0 },
    maxDiscountPaise: Number,
    active: { type: Boolean, default: true },
    expiresAt: Date,
  },
  { timestamps: true },
);
couponSchema.plugin(tenantPlugin);
couponSchema.index({ tenant: 1, code: 1 }, { unique: true });

export const ORDER_STATUSES = ['pending_payment', 'placed', 'confirmed', 'shipped', 'delivered', 'cancelled'];

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
      },
    ],
    address: {
      name: { type: String, required: true },
      phone: { type: String, required: true },
      line1: { type: String, required: true },
      line2: String,
      city: { type: String, required: true },
      state: String,
      pincode: { type: String, required: true },
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
    paymentMethod: { type: String, enum: ['online', 'cod'], required: true },
    status: { type: String, enum: ORDER_STATUSES, required: true },
    statusHistory: [{ _id: false, status: String, at: { type: Date, default: Date.now }, by: { type: ObjectId, ref: 'User' }, note: String }],
    payment: {
      status: { type: String, enum: ['unpaid', 'pending', 'paid', 'failed', 'refund_pending', 'refunded'], default: 'unpaid' },
      gateway: String,
      orderId: String,
      paymentId: String,
      refundId: String,
      amountPaise: Number,
      // Sum of partial refunds from returns, so the total refunded can never exceed what was paid.
      refundedPaise: { type: Number, default: 0 },
      paidAt: Date,
      refundedAt: Date,
      failureReason: String,
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

export const Product = mongoose.model('Product', productSchema);
export const Coupon = mongoose.model('Coupon', couponSchema);
export const ShopOrder = mongoose.model('ShopOrder', orderSchema);
