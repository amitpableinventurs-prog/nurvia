import mongoose from 'mongoose';
import { tenantPlugin } from '../../common/tenancy.js';

// One collection for every taxonomy: vendor types (vet, groomer, pet shop...), service types,
// and in Phase 2 product categories. `parent` allows nesting for the product catalogue.
const categorySchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['vendor', 'service', 'product'], required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    slug: { type: String, required: true, lowercase: true, trim: true, match: /^[a-z0-9-]+$/ },
    parent: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
    icon: String,
    sortOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    // Product categories: days after delivery a return can be asked for (unset: the default of 7).
    returnWindowDays: { type: Number, min: 0, max: 60 },
  },
  { timestamps: true },
);
categorySchema.plugin(tenantPlugin);
categorySchema.index({ tenant: 1, kind: 1, slug: 1 }, { unique: true });

export const Category = mongoose.model('Category', categorySchema);
