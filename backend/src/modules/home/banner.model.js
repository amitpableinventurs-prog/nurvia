import mongoose from 'mongoose';
import { attachmentSchema } from '../../common/schemas.js';
import { tenantPlugin } from '../../common/tenancy.js';
import { PET_TYPES } from '../shop/shop.model.js';

// An offer banner at the top of the pet parent app's home screen ("Spring Care & Nutrition
// Festival"). Shown while active and within its dates, to everyone or only for some pet types and
// cities. "{pet}" in the text becomes the name of the pet the screen is showing.
const bannerSchema = new mongoose.Schema(
  {
    eyebrow: { type: String, trim: true, maxlength: 60 }, // the small line above the title: "{pet}-friendly selection"
    title: { type: String, required: true, trim: true, maxlength: 120 },
    subtitle: { type: String, trim: true, maxlength: 300 },
    image: attachmentSchema,
    // `link` is what the app opens: a deep link such as nurvia://shop/products?category=food, or a web page.
    cta: { label: { type: String, maxlength: 40 }, link: { type: String, maxlength: 500 } },
    theme: {
      background: { type: String, default: '#1f3d33' },
      foreground: { type: String, default: '#ffffff' },
      accent: { type: String, default: '#d9b46a' },
    },
    // Empty: shown for every pet type, and in every city.
    petTypes: [{ type: String, enum: PET_TYPES }],
    citySlugs: [String],
    startsAt: Date,
    endsAt: Date,
    sortOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
bannerSchema.plugin(tenantPlugin);
bannerSchema.index({ tenant: 1, active: 1, sortOrder: 1 });

export const Banner = mongoose.model('Banner', bannerSchema);
