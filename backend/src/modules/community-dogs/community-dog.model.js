import mongoose from 'mongoose';
import { attachmentSchema, moderationFields, pointSchema } from '../../common/schemas.js';
import { tenantPlugin } from '../../common/tenancy.js';

const { ObjectId } = mongoose.Schema.Types;

// Roles on a dog's care team. The primary caregiver manages the team.
export const CARE_ROLES = ['primary', 'co_caregiver', 'feeder', 'medical_volunteer', 'medical_coordinator', 'vet', 'ngo', 'rwa', 'other'];
// Where the dog is now. Anything other than on_street is also recorded on the care timeline.
export const DOG_STATUSES = ['on_street', 'missing', 'in_treatment', 'fostered', 'adopted', 'relocated', 'deceased'];
export const LIFE_STAGES = ['puppy', 'young_adult', 'adult', 'senior'];
export const DOG_SIZES = ['small', 'medium', 'large'];
// An ear notch (or tip) marks a dog sterilised under the ABC programme.
export const EAR_NOTCH = ['notched', 'intact', 'unknown'];

function requiredUnlessDraft() {
  return !this.draft;
}

// Street/community dogs looked after by local caregivers rather than a single owner.
const communityDogSchema = new mongoose.Schema(
  {
    identifier: { type: String }, // short code shown on the profile, e.g. CD-7K2QX
    name: { type: String, trim: true, maxlength: 60 },
    breed: { type: String, trim: true, maxlength: 60 }, // usually Indie / community native
    description: { type: String, maxlength: 2000 },
    sex: { type: String, enum: ['male', 'female', 'unknown'], default: 'unknown' },
    approxAgeMonths: Number,
    lifeStage: { type: String, enum: LIFE_STAGES },
    size: { type: String, enum: DOG_SIZES },
    color: { type: String, maxlength: 60 },
    markings: String,
    photos: [attachmentSchema], // the first is the primary photo
    // A draft only needs to be saved; area and location are required once it is published.
    area: { type: String, required: requiredUnlessDraft, maxlength: 160 }, // locality / landmark
    city: String,
    // Never shown to the public: caregivers see the territory, the primary caregiver and staff the pin.
    location: { type: pointSchema, required: requiredUnlessDraft },
    roamingRadiusM: { type: Number, min: 50, max: 3000, default: 350 },
    landmarks: { type: String, maxlength: 500 }, // habitual resting spots
    vaccinationStatus: { type: String, enum: ['unknown', 'partial', 'up_to_date'], default: 'unknown' },
    sterilized: { type: Boolean, default: false },
    earNotch: { type: String, enum: EAR_NOTCH, default: 'unknown' },
    feeding: { schedule: { type: String, maxlength: 300 }, tolerances: { type: String, maxlength: 500 } },
    healthNotes: { type: String, maxlength: 2000 },
    emergencyNotes: { type: String, maxlength: 1000 },
    // A rescue volunteer, NGO or vet nearby (an SOS responder) to call in an emergency, through Nurvia.
    emergencyLiaison: { user: { type: ObjectId, ref: 'User' }, since: Date },
    currentStatus: { type: String, enum: DOG_STATUSES, default: 'on_street' },
    lastSeen: { at: Date, area: String },
    createdBy: { type: ObjectId, ref: 'User', required: true },
    // Everyone on the care team, kept in step with careTeam below for simple membership queries.
    caregivers: [{ type: ObjectId, ref: 'User' }],
    careTeam: [
      {
        _id: false,
        user: { type: ObjectId, ref: 'User', required: true },
        role: { type: String, enum: CARE_ROLES, default: 'co_caregiver' },
        // How the team knows them: "Resident, 12th Main", "Daily morning feeder".
        title: { type: String, trim: true, maxlength: 80 },
        since: { type: Date, default: Date.now },
      },
    ],
    lastLogAt: Date,
    // Saved but not yet submitted: only its creator sees it.
    draft: { type: Boolean, default: false },
    submittedAt: Date,
    // Staff check the territory and caregivers before a profile earns the community badge.
    verification: {
      status: { type: String, enum: ['pending', 'verified', 'changes_requested'], default: 'pending' },
      note: String,
      by: { type: ObjectId, ref: 'User' },
      at: Date,
    },
    ...moderationFields,
  },
  { timestamps: true },
);
communityDogSchema.plugin(tenantPlugin);
communityDogSchema.index({ location: '2dsphere' });
communityDogSchema.index({ tenant: 1, caregivers: 1 });
communityDogSchema.index({ tenant: 1, status: 1, 'verification.status': 1, createdAt: 1 });
// Public list, most recently cared for first.
communityDogSchema.index({ tenant: 1, status: 1, lastLogAt: -1, createdAt: -1 });

export const CARE_LOG_TYPES = [
  'fed', 'water', 'vaccinated', 'rabies_vaccination', 'dewormed', 'sterilized', 'vet_visit', 'injury', 'medicine', 'treatment',
  'behaviour', 'document', 'sighting', 'missing', 'found', 'fostered', 'adopted', 'emergency', 'status_change', 'other',
];

// The filters on the care & activity log.
export const LOG_CATEGORIES = {
  feeding: ['fed', 'water'],
  medical: ['vaccinated', 'rabies_vaccination', 'dewormed', 'sterilized', 'vet_visit', 'injury', 'medicine', 'treatment', 'document'],
  sightings: ['sighting', 'missing', 'found'],
  other: ['behaviour', 'fostered', 'adopted', 'emergency', 'status_change', 'other'],
};

const careLogSchema = new mongoose.Schema(
  {
    dog: { type: ObjectId, ref: 'CommunityDog', required: true },
    by: { type: ObjectId, ref: 'User', required: true },
    type: { type: String, enum: CARE_LOG_TYPES, required: true },
    note: { type: String, maxlength: 1000 },
    photos: [attachmentSchema],
    documents: [attachmentSchema],
    // Medicine/treatment details: drug, dose, next due date.
    details: { type: mongoose.Schema.Types.Mixed },
    byRole: { type: String, enum: [...CARE_ROLES, 'public'] }, // the logger's role at the time, for accountability
    thanks: [{ type: ObjectId, ref: 'User' }],
    // A record from an authority (vaccination drive, ABC centre) with its certificate attached.
    // Verified when a vet or NGO on the team logged it, or when staff checked it.
    official: { authority: String, reference: String, verified: { type: Boolean, default: false }, verifiedBy: { type: ObjectId, ref: 'User' } },
    at: { type: Date, default: Date.now },
  },
  { timestamps: true },
);
careLogSchema.plugin(tenantPlugin);
careLogSchema.index({ tenant: 1, dog: 1, at: -1 });

// A link a caregiver shares with a neighbour to join the care team.
const careInviteSchema = new mongoose.Schema(
  {
    dog: { type: ObjectId, ref: 'CommunityDog', required: true },
    code: { type: String, required: true },
    role: { type: String, enum: CARE_ROLES, default: 'co_caregiver' },
    createdBy: { type: ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, required: true },
    uses: { type: Number, default: 0 },
    maxUses: { type: Number, default: 20 },
  },
  { timestamps: true },
);
careInviteSchema.plugin(tenantPlugin);
careInviteSchema.index({ tenant: 1, code: 1 }, { unique: true });
careInviteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const CommunityDog = mongoose.model('CommunityDog', communityDogSchema);
export const CareLog = mongoose.model('CareLog', careLogSchema);
export const CareInvite = mongoose.model('CareInvite', careInviteSchema);
