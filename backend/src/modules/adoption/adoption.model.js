import mongoose from 'mongoose';
import { attachmentSchema, pointSchema } from '../../common/schemas.js';
import { tenantPlugin } from '../../common/tenancy.js';
import { SPECIES } from '../pets/pet.model.js';

const { ObjectId } = mongoose.Schema.Types;

// pending_review → open (admin approves) → on_hold / adopted / closed. `removed` is a moderation outcome.
export const LISTING_STATUSES = ['pending_review', 'open', 'on_hold', 'adopted', 'closed', 'rejected', 'removed'];

const listingSchema = new mongoose.Schema(
  {
    postedBy: { type: ObjectId, ref: 'User', required: true },
    communityDog: { type: ObjectId, ref: 'CommunityDog' },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    species: { type: String, enum: SPECIES, required: true },
    breed: String,
    sex: { type: String, enum: ['male', 'female', 'unknown'], default: 'unknown' },
    ageMonths: Number,
    description: { type: String, required: true, maxlength: 3000 },
    photos: [attachmentSchema],
    vaccinated: Boolean,
    vaccinationDetails: { type: String, maxlength: 500 },
    sterilized: Boolean,
    dewormed: Boolean,
    temperament: { type: String, maxlength: 500 }, // e.g. "calm, good with cats, shy with men"
    healthNotes: { type: String, maxlength: 1000 },
    specialNeeds: String,
    // What the lister asks of an adopter: home type, experience, follow-up visits, etc.
    requirements: { type: String, maxlength: 1000 },
    // Ready for the Phase 2 foster workflow: who is fostering the animal while it waits.
    foster: { active: { type: Boolean, default: false }, by: { type: ObjectId, ref: 'User' }, since: Date, note: String, locality: String },
    locality: { type: String, trim: true, maxlength: 80 }, // neighbourhood, for search ("Indiranagar")
    city: { type: String, required: true },
    location: pointSchema,
    status: { type: String, enum: LISTING_STATUSES, default: 'pending_review', index: true },
    moderation: { by: { type: ObjectId, ref: 'User' }, at: Date, reason: String },
    applicationCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);
listingSchema.plugin(tenantPlugin);
listingSchema.index({ tenant: 1, status: 1, city: 1, species: 1, createdAt: -1 });
// Public list without a city or species filter, newest first.
listingSchema.index({ tenant: 1, status: 1, createdAt: -1 });

export const APPLICATION_STATUSES = ['submitted', 'shortlisted', 'approved', 'rejected', 'withdrawn'];

const applicationSchema = new mongoose.Schema(
  {
    listing: { type: ObjectId, ref: 'AdoptionListing', required: true },
    lister: { type: ObjectId, ref: 'User', required: true },
    applicant: { type: ObjectId, ref: 'User', required: true },
    message: { type: String, required: true, maxlength: 2000 },
    home: {
      type: { type: String, enum: ['apartment', 'independent_house', 'farm', 'other'] },
      hasOtherPets: Boolean,
      hasChildren: Boolean,
      experience: String,
    },
    contactPhone: String,
    status: { type: String, enum: APPLICATION_STATUSES, default: 'submitted' },
    statusNote: String,
    // Once the lister approves an adopter, staff complete the ethical-adoption checks and sign off.
    // Adoption on Nurvia is free: the platform never takes a fee, so there is no fee to record.
    compliance: {
      status: { type: String, enum: ['pending', 'info_requested', 'certified'], default: 'pending' },
      note: String,
      homeCheck: {
        status: { type: String, enum: ['pending', 'passed', 'failed'], default: 'pending' },
        note: String,
        by: { type: ObjectId, ref: 'User' },
        at: Date,
      },
      microchip: { scheduledAt: Date, chipId: String },
      certifiedBy: { type: ObjectId, ref: 'User' },
      certifiedAt: Date,
    },
  },
  { timestamps: true },
);
applicationSchema.plugin(tenantPlugin);
applicationSchema.index({ tenant: 1, listing: 1, applicant: 1 }, { unique: true });
applicationSchema.index({ tenant: 1, applicant: 1, createdAt: -1 });
applicationSchema.index({ tenant: 1, status: 1, 'compliance.status': 1, updatedAt: 1 });

// The adoption stage shown to people, from the listing status and how far its applications have got:
// Available → Application received → Under discussion → Adopted / Closed.
export function adoptionStage(listing, { shortlisted = 0 } = {}) {
  if (listing.status === 'adopted') return 'adopted';
  if (['closed', 'rejected', 'removed'].includes(listing.status)) return 'closed';
  if (listing.status === 'pending_review') return 'pending_review';
  if (shortlisted > 0) return 'under_discussion';
  if (listing.applicationCount > 0) return 'application_received';
  return 'available';
}

export const AdoptionListing = mongoose.model('AdoptionListing', listingSchema);
export const AdoptionApplication = mongoose.model('AdoptionApplication', applicationSchema);

// Listings a user saved with the heart on Adoption Browse.
const savedListingSchema = new mongoose.Schema({ user: { type: ObjectId, ref: 'User', required: true }, listing: { type: ObjectId, ref: 'AdoptionListing', required: true } }, { timestamps: true });
savedListingSchema.plugin(tenantPlugin);
savedListingSchema.index({ tenant: 1, user: 1, listing: 1 }, { unique: true });
export const SavedListing = mongoose.model('SavedListing', savedListingSchema);
