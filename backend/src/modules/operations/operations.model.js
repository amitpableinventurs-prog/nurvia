import mongoose from 'mongoose';
import { attachmentSchema, pointSchema } from '../../common/schemas.js';
import { tenantPlugin } from '../../common/tenancy.js';

// Vendor SaaS (Phase 2): the vendor's own business workspace. Staff, a customer CRM that also holds
// customers acquired outside Nurvia, appointments and packages, and visit records per business type.
// Nothing here is visible to other vendors, and a customer's Nurvia pet passport only receives what
// the owner approves (see RecordShare).
const { ObjectId } = mongoose.Schema.Types;

// ---- Staff ----

export const STAFF_ROLES = ['owner', 'manager', 'receptionist', 'vet', 'groomer', 'trainer', 'walker', 'boarding_attendant', 'other'];

// What each staff role can do in the vendor workspace. The business owner (Vendor.owner) can do everything.
export const CAPABILITIES = ['calendar.read', 'bookings.manage', 'customers.read', 'customers.manage', 'services.manage', 'visits.write', 'reports.read', 'staff.manage'];
const CARE_ROLE = ['calendar.read', 'customers.read', 'visits.write'];
export const ROLE_CAPABILITIES = {
  owner: CAPABILITIES,
  manager: CAPABILITIES,
  receptionist: ['calendar.read', 'bookings.manage', 'customers.read', 'customers.manage'],
  vet: CARE_ROLE,
  groomer: CARE_ROLE,
  trainer: CARE_ROLE,
  walker: CARE_ROLE,
  boarding_attendant: CARE_ROLE,
  other: ['calendar.read'],
};

const staffSchema = new mongoose.Schema(
  {
    vendor: { type: ObjectId, ref: 'Vendor', required: true },
    user: { type: ObjectId, ref: 'User', required: true }, // the staff member signs in with this account (OTP)
    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, required: true },
    email: String,
    role: { type: String, enum: STAFF_ROLES, required: true },
    // Extra capabilities on top of the role, e.g. a groomer who also manages bookings.
    extraCapabilities: [{ type: String, enum: CAPABILITIES }],
    color: { type: String, match: /^#[0-9a-f]{6}$/i }, // calendar colour
    // Shown to customers choosing who looks after their pet, e.g. "Master Canine Stylist", 6 years.
    title: { type: String, trim: true, maxlength: 60 },
    experienceYears: { type: Number, min: 0, max: 60 },
    // Whether customers can pick this person when booking (care roles only).
    bookable: { type: Boolean, default: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
staffSchema.plugin(tenantPlugin);
staffSchema.index({ tenant: 1, vendor: 1, user: 1 }, { unique: true });
staffSchema.index({ tenant: 1, user: 1, active: 1 });

// ---- CRM ----

export const CUSTOMER_SOURCES = ['nurvia', 'walk_in', 'phone', 'referral', 'other'];

const customerPetSchema = new mongoose.Schema({
  name: { type: String, required: true, maxlength: 60 },
  species: String,
  breed: String,
  sex: String,
  pet: { type: ObjectId, ref: 'Pet' }, // set when the pet has a Nurvia passport
  notes: { type: String, maxlength: 1000 },
});

const customerSchema = new mongoose.Schema(
  {
    vendor: { type: ObjectId, ref: 'Vendor', required: true },
    user: { type: ObjectId, ref: 'User' }, // set for Nurvia users
    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: String,
    email: String,
    source: { type: String, enum: CUSTOMER_SOURCES, default: 'walk_in' },
    pets: [customerPetSchema],
    tags: [{ type: String, lowercase: true, maxlength: 40 }],
    notes: { type: String, maxlength: 2000 },
    visitCount: { type: Number, default: 0 },
    lastVisitAt: Date,
    archivedAt: Date,
  },
  { timestamps: true },
);
customerSchema.plugin(tenantPlugin);
customerSchema.index({ tenant: 1, vendor: 1, phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } } });
customerSchema.index({ tenant: 1, vendor: 1, user: 1 }, { unique: true, partialFilterExpression: { user: { $type: 'objectId' } } });
customerSchema.index({ tenant: 1, vendor: 1, name: 1 });

const noteSchema = new mongoose.Schema(
  {
    vendor: { type: ObjectId, ref: 'Vendor', required: true },
    customer: { type: ObjectId, ref: 'VendorCustomer', required: true },
    petId: ObjectId, // a pet inside the customer record
    author: { type: ObjectId, ref: 'User', required: true },
    text: { type: String, required: true, maxlength: 2000 },
    followUpAt: Date,
    doneAt: Date,
  },
  { timestamps: true },
);
noteSchema.plugin(tenantPlugin);
noteSchema.index({ tenant: 1, vendor: 1, customer: 1, createdAt: -1 });
noteSchema.index({ tenant: 1, vendor: 1, doneAt: 1, followUpAt: 1 });

// ---- Appointments (bookings the vendor enters itself, e.g. for customers from outside Nurvia) ----

export const APPOINTMENT_STATUSES = ['scheduled', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show'];

const appointmentSchema = new mongoose.Schema(
  {
    vendor: { type: ObjectId, ref: 'Vendor', required: true },
    customer: { type: ObjectId, ref: 'VendorCustomer', required: true },
    petId: ObjectId,
    petName: String,
    service: { type: ObjectId, ref: 'Service' },
    serviceName: { type: String, required: true, maxlength: 120 },
    pricePaise: { type: Number, min: 0, default: 0 },
    scheduledAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    staff: { type: ObjectId, ref: 'VendorStaff' },
    status: { type: String, enum: APPOINTMENT_STATUSES, default: 'scheduled' },
    statusHistory: [{ _id: false, status: String, at: { type: Date, default: Date.now }, by: { type: ObjectId, ref: 'User' }, note: String }],
    // Recurring appointments share a seriesId; each occurrence is its own document.
    seriesId: ObjectId,
    recurrence: { rule: { type: String, enum: ['weekly', 'fortnightly', 'monthly'] }, count: Number },
    customerPackage: { type: ObjectId, ref: 'CustomerPackage' },
    paidOffline: { type: Boolean, default: false },
    notes: { type: String, maxlength: 1000 },
    createdBy: { type: ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);
appointmentSchema.plugin(tenantPlugin);
appointmentSchema.index({ tenant: 1, vendor: 1, scheduledAt: 1, status: 1 });
appointmentSchema.index({ tenant: 1, vendor: 1, staff: 1, scheduledAt: 1 });
appointmentSchema.index({ tenant: 1, vendor: 1, customer: 1, scheduledAt: -1 });

const waitlistSchema = new mongoose.Schema(
  {
    vendor: { type: ObjectId, ref: 'Vendor', required: true },
    customer: { type: ObjectId, ref: 'VendorCustomer', required: true },
    petId: ObjectId,
    service: { type: ObjectId, ref: 'Service' },
    preferredFrom: Date,
    preferredTo: Date,
    note: { type: String, maxlength: 500 },
    status: { type: String, enum: ['waiting', 'offered', 'booked', 'removed'], default: 'waiting' },
    appointment: { type: ObjectId, ref: 'Appointment' },
  },
  { timestamps: true },
);
waitlistSchema.plugin(tenantPlugin);
waitlistSchema.index({ tenant: 1, vendor: 1, status: 1, createdAt: 1 });

// ---- Packages ----

const packageSchema = new mongoose.Schema(
  {
    vendor: { type: ObjectId, ref: 'Vendor', required: true },
    name: { type: String, required: true, maxlength: 120 },
    description: { type: String, maxlength: 1000 },
    services: [{ type: ObjectId, ref: 'Service' }],
    sessions: { type: Number, required: true, min: 1, max: 365 },
    pricePaise: { type: Number, required: true, min: 0 },
    validityDays: { type: Number, min: 1, max: 1095 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
packageSchema.plugin(tenantPlugin);
packageSchema.index({ tenant: 1, vendor: 1, active: 1 });

const customerPackageSchema = new mongoose.Schema(
  {
    vendor: { type: ObjectId, ref: 'Vendor', required: true },
    customer: { type: ObjectId, ref: 'VendorCustomer', required: true },
    package: { type: ObjectId, ref: 'ServicePackage', required: true },
    name: String,
    sessionsTotal: { type: Number, required: true },
    sessionsUsed: { type: Number, default: 0 },
    pricePaise: { type: Number, required: true },
    purchasedAt: { type: Date, default: Date.now },
    expiresAt: Date,
    paidOffline: { type: Boolean, default: true },
  },
  { timestamps: true },
);
customerPackageSchema.plugin(tenantPlugin);
customerPackageSchema.index({ tenant: 1, vendor: 1, customer: 1 });

// ---- Visit records per business type ----

export const VISIT_KINDS = ['vet', 'grooming', 'boarding', 'walk', 'training', 'other'];

const visitReportSchema = new mongoose.Schema(
  {
    vendor: { type: ObjectId, ref: 'Vendor', required: true },
    kind: { type: String, enum: VISIT_KINDS, required: true },
    booking: { type: ObjectId, ref: 'Booking' }, // a Nurvia booking, or
    appointment: { type: ObjectId, ref: 'Appointment' }, // an appointment the vendor entered
    customer: { type: ObjectId, ref: 'VendorCustomer' },
    pet: { type: ObjectId, ref: 'Pet' }, // the Nurvia pet, when there is one
    petOwner: { type: ObjectId, ref: 'User' },
    petName: String,
    staff: { type: ObjectId, ref: 'VendorStaff' },
    status: { type: String, enum: ['draft', 'in_progress', 'completed'], default: 'draft' },
    summary: { type: String, maxlength: 300 },
    // Kind-specific fields (validated per kind in operations.routes.js).
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    photos: [{ _id: false, stage: { type: String, enum: ['before', 'after', 'during'] }, file: { type: ObjectId, ref: 'File' }, url: String }],
    attachments: [attachmentSchema],
    // Boarding daily updates, training session notes, etc. Each one can be pushed to the owner.
    updates: [
      {
        at: { type: Date, default: Date.now },
        by: { type: ObjectId, ref: 'User' },
        note: { type: String, maxlength: 1000 },
        photos: [{ _id: false, file: ObjectId, url: String }],
      },
    ],
    // Walk tracking points, stored only when the owner allowed route sharing for the walk.
    route: [{ _id: false, at: Date, location: pointSchema }],
    startedAt: Date,
    endedAt: Date,
    sharedWithOwner: { type: Boolean, default: false },
    sharedAt: Date,
    createdBy: { type: ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);
visitReportSchema.plugin(tenantPlugin);
visitReportSchema.index({ tenant: 1, vendor: 1, createdAt: -1 });
visitReportSchema.index({ tenant: 1, pet: 1, sharedWithOwner: 1, createdAt: -1 });
visitReportSchema.index({ tenant: 1, booking: 1 });

// A clinic record offered to a pet's Nurvia passport. Nothing reaches the passport until the owner accepts.
const recordShareSchema = new mongoose.Schema(
  {
    vendor: { type: ObjectId, ref: 'Vendor', required: true },
    visit: { type: ObjectId, ref: 'VisitReport', required: true },
    pet: { type: ObjectId, ref: 'Pet', required: true },
    owner: { type: ObjectId, ref: 'User', required: true },
    record: {
      type: { type: String, required: true },
      title: { type: String, required: true },
      date: { type: Date, required: true },
      nextDueDate: Date,
      details: { type: mongoose.Schema.Types.Mixed, default: {} },
      notes: String,
      attachments: [attachmentSchema],
    },
    status: { type: String, enum: ['pending', 'accepted', 'declined'], default: 'pending' },
    decidedAt: Date,
    healthRecord: { type: ObjectId, ref: 'HealthRecord' },
  },
  { timestamps: true },
);
recordShareSchema.plugin(tenantPlugin);
recordShareSchema.index({ tenant: 1, owner: 1, status: 1, createdAt: -1 });

export const VendorStaff = mongoose.model('VendorStaff', staffSchema);
export const VendorCustomer = mongoose.model('VendorCustomer', customerSchema);
export const CrmNote = mongoose.model('CrmNote', noteSchema);
export const Appointment = mongoose.model('Appointment', appointmentSchema);
export const WaitlistEntry = mongoose.model('WaitlistEntry', waitlistSchema);
export const ServicePackage = mongoose.model('ServicePackage', packageSchema);
export const CustomerPackage = mongoose.model('CustomerPackage', customerPackageSchema);
export const VisitReport = mongoose.model('VisitReport', visitReportSchema);
export const RecordShare = mongoose.model('RecordShare', recordShareSchema);
