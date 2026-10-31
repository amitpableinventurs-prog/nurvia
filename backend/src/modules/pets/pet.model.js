import mongoose from 'mongoose';
import { attachmentSchema } from '../../common/schemas.js';
import { tenantPlugin } from '../../common/tenancy.js';

const { ObjectId } = mongoose.Schema.Types;

export const SPECIES = ['dog', 'cat', 'bird', 'small_animal', 'rabbit', 'fish', 'other'];

const petSchema = new mongoose.Schema(
  {
    owner: { type: ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    species: { type: String, enum: SPECIES, required: true },
    breed: { type: String, trim: true, maxlength: 80 },
    sex: { type: String, enum: ['male', 'female', 'unknown'], default: 'unknown' },
    dateOfBirth: Date,
    // For rescues and adoptions where the exact date of birth is not known.
    approxAgeMonths: { type: Number, min: 0, max: 400 },
    weightKg: { type: Number, min: 0, max: 200 },
    color: String,
    microchipId: String,
    neutered: Boolean,
    photo: { file: { type: ObjectId, ref: 'File' }, url: String },
    allergies: [String],
    conditions: [String], // ongoing medical conditions, e.g. "hip dysplasia"
    behaviour: { type: String, maxlength: 1000 },
    emergencyNotes: { type: String, maxlength: 1000 },
    emergencyContact: { name: String, phone: String },
    notes: { type: String, maxlength: 2000 },
    // Lost mode: set by the owner, shown on the NFC recovery profile and in Lost & Found.
    lost: {
      active: { type: Boolean, default: false },
      since: Date,
      lastSeenArea: { type: String, maxlength: 200 },
      note: { type: String, maxlength: 500 },
    },
    archivedAt: Date,
  },
  { timestamps: true },
);
petSchema.plugin(tenantPlugin);
petSchema.index({ tenant: 1, owner: 1, archivedAt: 1 });
// Admin list of active pets, newest first.
petSchema.index({ tenant: 1, archivedAt: 1, createdAt: -1 });

// Choices for the breed picker on the Add a pet form. A pet keeps the breed's name as free text,
// so a breed can be renamed or switched off here without changing existing pets.
const breedSchema = new mongoose.Schema(
  {
    species: { type: String, enum: SPECIES, required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    slug: { type: String, required: true, lowercase: true, trim: true, match: /^[a-z0-9-]+$/ },
    sortOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
breedSchema.plugin(tenantPlugin);
breedSchema.index({ tenant: 1, species: 1, slug: 1 }, { unique: true });

export const RECORD_TYPES =['vaccination', 'medication', 'prescription', 'vet_visit', 'deworming', 'lab_report', 'grooming', 'weight', 'document', 'note'];

const healthRecordSchema = new mongoose.Schema(
  {
    pet: { type: ObjectId, ref: 'Pet', required: true },
    owner: { type: ObjectId, ref: 'User', required: true },
    type: { type: String, enum: RECORD_TYPES, required: true },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    date: { type: Date, required: true },
    nextDueDate: Date,
    // Type-specific details: vaccine name/batch, dosage/frequency, diagnosis, weight, etc.
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    vet: { name: String, clinic: String, vendor: { type: ObjectId, ref: 'Vendor' } },
    // clinic: added from a record a clinic shared and the owner accepted (RecordShare), so it counts as verified.
    source: { type: String, enum: ['owner', 'clinic'], default: 'owner' },
    attachments: [attachmentSchema],
    notes: { type: String, maxlength: 4000 },
  },
  { timestamps: true },
);
healthRecordSchema.plugin(tenantPlugin);
healthRecordSchema.index({ tenant: 1, pet: 1, date: -1 });

export const REMINDER_KINDS = ['vaccination', 'deworming', 'medication', 'grooming', 'vet_follow_up', 'routine', 'custom'];

const reminderSchema = new mongoose.Schema(
  {
    pet: { type: ObjectId, ref: 'Pet', required: true },
    owner: { type: ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: REMINDER_KINDS, default: 'custom' },
    title: { type: String, required: true, maxlength: 160 },
    dueAt: { type: Date, required: true },
    repeat: { type: String, enum: ['none', 'daily', 'weekly', 'monthly', 'yearly'], default: 'none' },
    healthRecord: { type: ObjectId, ref: 'HealthRecord' },
    sentAt: Date,
    completedAt: Date,
  },
  { timestamps: true },
);
reminderSchema.plugin(tenantPlugin);
reminderSchema.index({ tenant: 1, owner: 1, dueAt: 1 });
// Used by the reminder dispatcher, which scans across tenants.
reminderSchema.index({ dueAt: 1, sentAt: 1, completedAt: 1 });

export const Pet = mongoose.model('Pet', petSchema);
export const Breed = mongoose.model('Breed', breedSchema);
export const HealthRecord = mongoose.model('HealthRecord', healthRecordSchema);
export const Reminder = mongoose.model('Reminder', reminderSchema);
