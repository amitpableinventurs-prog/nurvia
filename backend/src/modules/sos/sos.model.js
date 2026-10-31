import mongoose from 'mongoose';
import { attachmentSchema, pointSchema } from '../../common/schemas.js';
import { tenantPlugin } from '../../common/tenancy.js';

const { ObjectId } = mongoose.Schema.Types;

// SOS and Lost & Found. Reports alert nearby responders, but Nurvia does not promise that anyone
// will accept, or how fast: the statuses only show what responders have said they are doing.
export const INCIDENT_TYPES = ['injured_animal', 'lost_pet', 'found_pet', 'other_emergency'];
export const INCIDENT_STATUSES = ['open', 'accepted', 'help_on_way', 'resolved', 'cancelled'];
export const RESOLUTION_OUTCOMES = ['rescued', 'treated', 'reunited', 'rehomed', 'not_found', 'false_alarm', 'other'];
export const RESPONDER_KINDS = ['volunteer', 'caregiver', 'ngo', 'vet', 'staff'];

const incidentSchema = new mongoose.Schema(
  {
    code: { type: String, required: true },
    type: { type: String, enum: INCIDENT_TYPES, required: true },
    reporter: { type: ObjectId, ref: 'User', required: true },
    pet: { type: ObjectId, ref: 'Pet' }, // the reporter's own pet, for lost_pet
    communityDog: { type: ObjectId, ref: 'CommunityDog' },
    species: { type: String, enum: ['dog', 'cat', 'bird', 'rabbit', 'other'], default: 'dog' },
    description: { type: String, required: true, maxlength: 2000 },
    photos: [attachmentSchema],
    location: { type: pointSchema, required: true },
    area: { type: String, maxlength: 200 },
    city: String,
    lastSeenAt: Date, // lost_pet: when the pet was last seen; found_pet: when it was found
    contactPhone: String,
    status: { type: String, enum: INCIDENT_STATUSES, default: 'open' },
    responders: [
      {
        _id: false,
        user: { type: ObjectId, ref: 'User', required: true },
        kind: { type: String, enum: RESPONDER_KINDS },
        status: { type: String, enum: ['accepted', 'on_the_way', 'withdrawn'], default: 'accepted' },
        at: { type: Date, default: Date.now },
      },
    ],
    updates: [
      {
        by: { type: ObjectId, ref: 'User' },
        note: { type: String, maxlength: 1000 },
        status: String,
        photos: [attachmentSchema],
        at: { type: Date, default: Date.now },
      },
    ],
    resolution: { outcome: { type: String, enum: RESOLUTION_OUTCOMES }, note: String, by: { type: ObjectId, ref: 'User' }, at: Date },
    alertedCount: { type: Number, default: 0 },
    // Staff can hide an abusive or fake report. (Not the shared moderationFields: their `status` would clash.)
    moderation: { hidden: { type: Boolean, default: false }, by: { type: ObjectId, ref: 'User' }, at: Date, reason: String },
  },
  { timestamps: true },
);
incidentSchema.plugin(tenantPlugin);
incidentSchema.index({ location: '2dsphere' });
incidentSchema.index({ tenant: 1, code: 1 }, { unique: true });
incidentSchema.index({ tenant: 1, status: 1, type: 1, createdAt: -1 });
incidentSchema.index({ tenant: 1, reporter: 1, createdAt: -1 });

// People and organisations who opt in to SOS alerts around a place.
const responderSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: RESPONDER_KINDS.filter((k) => k !== 'staff'), required: true },
    organisation: { type: String, maxlength: 120 },
    phone: String,
    location: { type: pointSchema, required: true },
    radiusKm: { type: Number, min: 1, max: 50, default: 5 },
    types: [{ type: String, enum: INCIDENT_TYPES }],
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
responderSchema.plugin(tenantPlugin);
responderSchema.index({ location: '2dsphere' });
responderSchema.index({ tenant: 1, user: 1 }, { unique: true });

export const SosIncident = mongoose.model('SosIncident', incidentSchema);
export const SosResponder = mongoose.model('SosResponder', responderSchema);
