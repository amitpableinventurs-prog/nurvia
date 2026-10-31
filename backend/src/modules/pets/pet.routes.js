import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../common/auth.js';
import { notFound } from '../../common/errors.js';
import { paginate } from '../../common/paginate.js';
import { objectId, pageQuery, partialShape, validate } from '../../common/validate.js';
import { apiDoc } from '../../docs/api-doc.js';
import { AdoptionListing } from '../adoption/adoption.model.js';
import { Booking } from '../bookings/booking.model.js';
import { attachmentsFor } from '../files/file.routes.js';
import { VisitReport } from '../operations/operations.model.js';
import { getPlatform } from '../platform/platform.service.js';
import { careStatus } from './care.js';
import { Breed, HealthRecord, Pet, RECORD_TYPES, REMINDER_KINDS, Reminder, SPECIES } from './pet.model.js';

const router = Router();
router.use(authenticate);
const DAY = 86_400_000;

const petBody = {
  name: z.string().trim().min(1).max(60),
  species: z.enum(SPECIES),
  breed: z.string().trim().max(80).optional(),
  sex: z.enum(['male', 'female', 'unknown']).optional(),
  dateOfBirth: z.coerce.date().refine((d) => d <= new Date(), 'Date of birth cannot be in the future').optional(),
  weightKg: z.number().min(0).max(200).optional(),
  color: z.string().max(40).optional(),
  microchipId: z.string().max(40).optional(),
  neutered: z.boolean().optional(),
  approxAgeMonths: z.number().int().min(0).max(400).optional(),
  photoFileId: objectId.optional(),
  allergies: z.array(z.string().max(80)).max(30).optional(),
  conditions: z.array(z.string().max(120)).max(30).optional(),
  behaviour: z.string().max(1000).optional(),
  emergencyNotes: z.string().max(1000).optional(),
  emergencyContact: z.object({ name: z.string().trim().max(120).optional(), phone: z.string().trim().max(20).optional() }).optional(),
  notes: z.string().max(2000).optional(),
};

async function withPhoto(userId, { photoFileId, ...body }) {
  if (photoFileId === undefined) return body;
  const [photo] = await attachmentsFor(userId, [photoFileId], ['pet_photo']);
  return { ...body, photo: { file: photo.file, url: photo.url } };
}

async function ownPet(req) {
  const pet = await Pet.findOne({ _id: req.valid.params.petId ?? req.valid.params.id, owner: req.user._id, archivedAt: null });
  if (!pet) throw notFound('Pet');
  return pet;
}

router.get('/', async (req, res) => {
  res.json(await Pet.find({ owner: req.user._id, archivedAt: null }).sort({ createdAt: 1 }).lean());
});

const SPECIES_LABELS = { dog: 'Dog', cat: 'Cat', bird: 'Bird', small_animal: 'Small animal', rabbit: 'Rabbit', fish: 'Fish', other: 'Other' };

// The My Pets screen. With no pets it is the empty state: `emptyState.actions` lists what the
// screen offers (add a pet, and adopt one while adoption is switched on with open listings).
// Each pet comes with its next due reminder for the card.
router.get('/overview', async (req, res) => {
  const pets = await Pet.find({ owner: req.user._id, archivedAt: null })
    .sort({ createdAt: 1 })
    .select('name species breed sex dateOfBirth approxAgeMonths photo lost.active createdAt')
    .lean();
  const { features } = await getPlatform();

  const nextDue = pets.length
    ? await Reminder.aggregate([
        { $match: { owner: req.user._id, pet: { $in: pets.map((p) => p._id) }, completedAt: null } },
        { $sort: { dueAt: 1 } },
        { $group: { _id: '$pet', reminder: { $first: { _id: '$_id', title: '$title', kind: '$kind', dueAt: '$dueAt' } } } },
      ])
    : [];
  const reminderByPet = new Map(nextDue.map((r) => [String(r._id), r.reminder]));

  let emptyState = null;
  if (!pets.length) {
    const openListings = features.adoption ? await AdoptionListing.countDocuments({ status: 'open' }) : 0;
    emptyState = {
      actions: [
        { key: 'add_pet', primary: true },
        ...(openListings ? [{ key: 'adopt', primary: false, openListings }] : []),
      ],
    };
  }

  res.json({
    count: pets.length,
    empty: !pets.length,
    pets: pets.map((pet) => ({ ...pet, lost: Boolean(pet.lost?.active), nextReminder: reminderByPet.get(String(pet._id)) ?? null })),
    emptyState,
    // Choices for the "Add a pet" form (POST /pets).
    addPet: { species: SPECIES.map((key) => ({ key, label: SPECIES_LABELS[key] })) },
  });
});

// The "Select breed" sheet on the Add a pet form.
router.get(
  '/breeds',
  apiDoc({
    summary: 'Breeds to pick from for a species',
    description: 'Active breeds in display order. Send the chosen `name` as `breed` to `POST /pets` or `PATCH /pets/{id}`. Without `species`, every species\' breeds are returned.',
    responses: {
      200: {
        description: 'Breeds',
        example: {
          items: [
            { _id: '6ad889a8e6cbea1891b82200', species: 'dog', name: 'Golden Retriever', slug: 'golden-retriever' },
            { _id: '6ad889a8e6cbea1891b82201', species: 'dog', name: 'Labrador', slug: 'labrador' },
          ],
        },
      },
    },
  }),
  validate({ query: { species: z.enum(SPECIES).optional() } }),
  async (req, res) => {
    const { species } = req.valid.query;
    const breeds = await Breed.find({ active: true, ...(species && { species }) }).sort({ species: 1, sortOrder: 1, name: 1 }).select('species name slug').lean();
    res.json({ items: breeds });
  },
);

router.post('/', validate({ body: petBody }), async (req, res) => {
  const pet = await Pet.create({ ...(await withPhoto(req.user._id, req.valid.body)), owner: req.user._id });
  res.status(201).json(pet);
});

router.get('/:id', validate(), async (req, res) => {
  res.json(await ownPet(req));
});

router.patch('/:id', validate({ body: partialShape(petBody) }), async (req, res) => {
  const pet = await ownPet(req);
  pet.set(await withPhoto(req.user._id, req.valid.body));
  res.json(await pet.save());
});

// Lost mode shows on the pet's NFC recovery profile and lets finders contact the owner.
router.put(
  '/:id/lost',
  validate({ body: { active: z.boolean(), lastSeenArea: z.string().trim().max(200).optional(), note: z.string().trim().max(500).optional() } }),
  async (req, res) => {
    const pet = await ownPet(req);
    const { active, lastSeenArea, note } = req.valid.body;
    pet.lost = active ? { active, since: pet.lost?.active ? pet.lost.since : new Date(), lastSeenArea, note } : { active: false };
    res.json(await pet.save());
  },
);

// Everything that happened to the pet, newest first: health records, bookings, completed reminders
// and visit reports vendors have shared with the owner.
router.get(
  '/:id/timeline',
  validate({ query: { before: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) } }),
  async (req, res) => {
    const pet = await ownPet(req);
    const { before = new Date(8.64e15), limit } = req.valid.query;
    const [records, bookings, reminders, visits] = await Promise.all([
      HealthRecord.find({ pet: pet._id, date: { $lt: before } }).sort({ date: -1 }).limit(limit).lean(),
      Booking.find({ pet: pet._id, user: req.user._id, scheduledAt: { $lt: before } })
        .sort({ scheduledAt: -1 })
        .limit(limit)
        .populate('vendor', 'businessName')
        .select('code status scheduledAt serviceSnapshot vendor')
        .lean(),
      Reminder.find({ pet: pet._id, completedAt: { $ne: null, $lt: before } }).sort({ completedAt: -1 }).limit(limit).lean(),
      VisitReport.find({ pet: pet._id, sharedWithOwner: true, createdAt: { $lt: before } })
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate('vendor', 'businessName')
        .select('kind summary createdAt vendor booking')
        .lean(),
    ]);
    const events = [
      ...records.map((r) => ({ kind: 'health_record', at: r.date, title: r.title, type: r.type, id: r._id })),
      ...bookings.map((b) => ({ kind: 'booking', at: b.scheduledAt, title: b.serviceSnapshot?.name, status: b.status, vendor: b.vendor, id: b._id })),
      ...reminders.map((r) => ({ kind: 'reminder_done', at: r.completedAt, title: r.title, type: r.kind, id: r._id })),
      ...visits.map((v) => ({ kind: 'visit_report', at: v.createdAt, title: v.summary, type: v.kind, vendor: v.vendor, id: v._id })),
    ]
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
    res.json({ items: events, nextBefore: events.length === limit ? events.at(-1).at : null });
  },
);

// Visit reports vendors have shared with the owner: grooming photos, walk reports, boarding updates.
router.get('/:petId/visits', validate({ params: { petId: objectId }, query: pageQuery }), async (req, res) => {
  const pet = await ownPet(req);
  const { page, limit } = req.valid.query;
  res.json(
    await paginate(
      VisitReport,
      { pet: pet._id, petOwner: req.user._id, sharedWithOwner: true },
      { page, limit, sort: { createdAt: -1 }, select: '-customer -createdBy', populate: [{ path: 'vendor', select: 'businessName' }, { path: 'staff', select: 'name role' }] },
    ),
  );
});

// What is recorded, due and missing for the pet's core care. Rule-based, from the owner's own
// records; it is also the authorised context an AI assistant answers from.
router.get('/:id/care-status', validate(), async (req, res) => {
  res.json(await careStatus(await ownPet(req)));
});

// Pets are archived rather than deleted so their health history is not lost by accident.
router.delete('/:id', validate(), async (req, res) => {
  const pet = await ownPet(req);
  pet.archivedAt = new Date();
  await pet.save();
  await Reminder.updateMany({ pet: pet._id, completedAt: null }, { completedAt: new Date() });
  res.status(204).end();
});

// ---- Health timeline ----

const recordBody = {
  type: z.enum(RECORD_TYPES),
  title: z.string().trim().min(1).max(160),
  date: z.coerce.date(),
  nextDueDate: z.coerce.date().optional(),
  details: z.record(z.union([z.string().max(500), z.number(), z.boolean()])).optional(),
  vet: z.object({ name: z.string().max(120).optional(), clinic: z.string().max(160).optional(), vendor: objectId.optional() }).optional(),
  attachmentFileIds: z.array(objectId).max(10).optional(),
  notes: z.string().max(4000).optional(),
  remind: z.boolean().optional(), // create a reminder for nextDueDate
};
const recordParams = { petId: objectId, recordId: objectId };

async function recordFields(userId, { attachmentFileIds, remind: _remind, ...body }) {
  if (attachmentFileIds === undefined) return body;
  return { ...body, attachments: await attachmentsFor(userId, attachmentFileIds, ['health_record', 'pet_photo']) };
}

router.get(
  '/:petId/records',
  validate({ params: { petId: objectId }, query: { ...pageQuery, type: z.enum(RECORD_TYPES).optional() } }),
  async (req, res) => {
    const pet = await ownPet(req);
    const { page, limit, type } = req.valid.query;
    res.json(await paginate(HealthRecord, { pet: pet._id, ...(type && { type }) }, { page, limit, sort: { date: -1 } }));
  },
);

router.post('/:petId/records', validate({ params: { petId: objectId }, body: recordBody }), async (req, res) => {
  const pet = await ownPet(req);
  const record = await HealthRecord.create({ ...(await recordFields(req.user._id, req.valid.body)), pet: pet._id, owner: req.user._id });
  if (req.valid.body.remind && record.nextDueDate) {
    const kind = { vaccination: 'vaccination', deworming: 'deworming', medication: 'medication', prescription: 'medication', grooming: 'grooming', vet_visit: 'vet_follow_up' }[record.type];
    await Reminder.create({ pet: pet._id, owner: req.user._id, kind, title: `${pet.name}: ${record.title} due`, dueAt: record.nextDueDate, healthRecord: record._id });
  }
  res.status(201).json(record);
});

router.patch('/:petId/records/:recordId', validate({ params: recordParams, body: partialShape(recordBody) }), async (req, res) => {
  const record = await HealthRecord.findOne({ _id: req.valid.params.recordId, pet: req.valid.params.petId, owner: req.user._id });
  if (!record) throw notFound('Health record');
  record.set(await recordFields(req.user._id, req.valid.body));
  res.json(await record.save());
});

router.delete('/:petId/records/:recordId', validate({ params: recordParams }), async (req, res) => {
  const result = await HealthRecord.deleteOne({ _id: req.valid.params.recordId, pet: req.valid.params.petId, owner: req.user._id });
  if (!result.deletedCount) throw notFound('Health record');
  await Reminder.deleteMany({ healthRecord: req.valid.params.recordId, sentAt: null });
  res.status(204).end();
});

// ---- Reminders ----

const reminderBody = {
  kind: z.enum(REMINDER_KINDS).optional(),
  title: z.string().trim().min(1).max(160),
  dueAt: z.coerce.date(),
  repeat: z.enum(['none', 'daily', 'weekly', 'monthly', 'yearly']).optional(),
};
const reminderParams = { petId: objectId, reminderId: objectId };

router.get('/:petId/reminders', validate({ params: { petId: objectId } }), async (req, res) => {
  const pet = await ownPet(req);
  res.json(await Reminder.find({ pet: pet._id, completedAt: null }).sort({ dueAt: 1 }).lean());
});

router.post('/:petId/reminders', validate({ params: { petId: objectId }, body: reminderBody }), async (req, res) => {
  const pet = await ownPet(req);
  res.status(201).json(await Reminder.create({ ...req.valid.body, pet: pet._id, owner: req.user._id }));
});

router.patch(
  '/:petId/reminders/:reminderId',
  validate({ params: reminderParams, body: { ...partialShape(reminderBody), completed: z.boolean().optional() } }),
  async (req, res) => {
    const reminder = await Reminder.findOne({ _id: req.valid.params.reminderId, pet: req.valid.params.petId, owner: req.user._id });
    if (!reminder) throw notFound('Reminder');
    const { completed, ...fields } = req.valid.body;
    reminder.set(fields);
    if (fields.dueAt) reminder.sentAt = undefined;
    if (completed !== undefined) reminder.completedAt = completed ? new Date() : undefined;
    res.json(await reminder.save());
  },
);

router.delete('/:petId/reminders/:reminderId', validate({ params: reminderParams }), async (req, res) => {
  const result = await Reminder.deleteOne({ _id: req.valid.params.reminderId, pet: req.valid.params.petId, owner: req.user._id });
  if (!result.deletedCount) throw notFound('Reminder');
  res.status(204).end();
});

export default router;

// All of the signed-in user's open reminders across their pets, mounted at /reminders.
export const remindersRouter = Router();
remindersRouter.get(
  '/',
  authenticate,
  validate({ query: { kind: z.enum(REMINDER_KINDS).optional(), days: z.coerce.number().int().min(1).max(366).optional() } }),
  async (req, res) => {
    const { kind, days } = req.valid.query;
    const pets = await Pet.find({ owner: req.user._id, archivedAt: null }).select('name species photo').lean();
    const filter = {
      owner: req.user._id,
      pet: { $in: pets.map((p) => p._id) },
      completedAt: null,
      ...(kind && { kind }),
      ...(days && { dueAt: { $lt: new Date(Date.now() + days * DAY) } }),
    };
    const reminders = await Reminder.find(filter).sort({ dueAt: 1 }).limit(200).lean();
    const petById = new Map(pets.map((p) => [String(p._id), p]));
    res.json(reminders.map((r) => ({ ...r, pet: petById.get(String(r.pet)), overdue: r.dueAt < new Date() })));
  },
);
