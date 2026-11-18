import { Router } from 'express';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { authenticate } from '../../common/auth.js';
import { badRequest, forbidden, notFound, tooMany } from '../../common/errors.js';
import { tenantPlugin } from '../../common/tenancy.js';
import { objectId, validate } from '../../common/validate.js';
import { env } from '../../config/env.js';
import { aiStatus, complete } from '../../integrations/ai.js';
import { privatePath, publicDir } from '../../integrations/storage.js';
import { CareLog, CommunityDog } from '../community-dogs/community-dog.model.js';
import { dueCareFor } from '../community-dogs/due-care.js';
import { File } from '../files/file.model.js';
import { ageMonths, careStatus } from '../pets/care.js';
import { HealthRecord, Pet } from '../pets/pet.model.js';

// The AI assistant. It works from the structured data already in Nurvia:
//  - rule-based answers, always available: a pet's recorded vaccinations and what is due, and the
//    community dogs a caregiver looks after that need care;
//  - with a model switched on (AI_PROVIDER, integrations/ai.js): a written health summary, questions
//    about a pet or community dog, and summaries of a prescription or vet document.
// Only the fields picked below leave Nurvia: never the owner's name, phone, email or address, a
// dog's location, or care-team members' names. Every model call is logged in AiUsage.
const router = Router();
router.use(authenticate);

const aiUsageSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    feature: { type: String, required: true },
    provider: String,
    model: String,
    inputTokens: Number,
    outputTokens: Number,
    cacheReadTokens: Number, // read from Claude's prompt cache: quicker and cheaper than plain input
    cacheWriteTokens: Number,
    // Answered from the answer cache below: no model call, and not counted towards the daily limit.
    cached: Boolean,
    ok: Boolean,
    error: String,
  },
  { timestamps: true },
);
aiUsageSchema.plugin(tenantPlugin);
aiUsageSchema.index({ tenant: 1, user: 1, createdAt: -1 });
export const AiUsage = mongoose.model('AiUsage', aiUsageSchema);

// Answers already given. The key is a hash of everything an answer depends on (user, feature,
// model, instructions and the exact data sent), so a change to the pet's records, the dog's care
// log, the question or the date gives a new key and a fresh answer. Entries expire after
// AI_CACHE_HOURS.
const aiAnswerSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    feature: { type: String, required: true },
    model: String,
    text: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
aiAnswerSchema.plugin(tenantPlugin);
aiAnswerSchema.index({ tenant: 1, key: 1 }, { unique: true });
aiAnswerSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const AiAnswer = mongoose.model('AiAnswer', aiAnswerSchema);

// Bump when the instructions or the shape of the data sent change, so older answers are not reused.
const PROMPT_VERSION = 1;

export const DISCLAIMER = 'AI-generated from the records saved in Nurvia. Nurvia’s assistant is not a veterinarian and does not diagnose; please consult a vet about your pet’s health.';

// Kept stable so requests can share a cached prefix.
const SYSTEM = [
  'You are the Nurvia assistant inside a pet care app used in India. You help pet parents and community-dog caregivers understand the records they have saved in Nurvia.',
  'Use only the data in the request. If something is not in the data, say it is not recorded. Never invent dates, vaccines, medicines, doses or results.',
  'You are not a veterinarian. Do not diagnose, do not suggest what illness a pet might have, and do not recommend or change medicines or doses. For symptoms, injuries or anything worrying, tell the user to contact a vet, and for an emergency to go to an emergency vet straight away.',
  'Write short, plain answers: a few sentences or a short list. Write dates like 12 Mar 2026.',
].join('\n');

const DAY = 86_400_000;
const clip = (text, n) => (text ? String(text).slice(0, n) : undefined);

async function ownPet(req, petId) {
  const pet = await Pet.findOne({ _id: petId, owner: req.user._id, archivedAt: null }).lean();
  if (!pet) throw notFound('Pet');
  return pet;
}

async function caredForDog(req, dogId) {
  const dog = await CommunityDog.findOne({ _id: dogId, status: 'visible' }).lean();
  if (!dog) throw notFound('Community dog');
  if (!dog.caregivers.some((id) => String(id) === String(req.user._id))) throw forbidden('Only the dog’s care team can ask about its records');
  return dog;
}

// What a model sees about a pet: no owner details.
async function petContext(pet) {
  const [records, care] = await Promise.all([
    HealthRecord.find({ pet: pet._id }).sort({ date: -1 }).limit(60).select('type title date nextDueDate notes details source').lean(),
    careStatus(pet),
  ]);
  return {
    pet: { name: pet.name, species: pet.species, breed: pet.breed, sex: pet.sex, ageMonths: ageMonths(pet), weightKg: pet.weightKg, neutered: pet.neutered, allergies: pet.allergies, conditions: pet.conditions },
    today: new Date().toISOString().slice(0, 10),
    coreVaccines: care.coreVaccines.map(({ recordId, ...c }) => c),
    otherVaccinations: care.otherVaccinations,
    deworming: care.deworming,
    reminders: { overdue: care.reminders.overdue.map((r) => ({ title: r.title, kind: r.kind, dueAt: r.dueAt })), upcoming: care.reminders.upcoming.map((r) => ({ title: r.title, kind: r.kind, dueAt: r.dueAt })) },
    records: records.map((r) => ({ type: r.type, title: r.title, date: r.date, nextDueDate: r.nextDueDate, notes: clip(r.notes, 300), details: r.details, fromClinic: r.source === 'clinic' })),
  };
}

// What a model sees about a community dog: no location and no people.
async function dogContext(dog) {
  const logs = await CareLog.find({ dog: dog._id }).sort({ at: -1 }).limit(40).select('type note details at').lean();
  return {
    dog: {
      name: dog.name ?? dog.nickname ?? dog.identifier,
      sex: dog.sex,
      approxAgeMonths: dog.approxAgeMonths,
      area: dog.area,
      sterilised: dog.sterilized,
      earNotch: dog.earNotch,
      vaccinationStatus: dog.vaccinationStatus,
      currentStatus: dog.currentStatus,
      healthNotes: clip(dog.healthNotes, 1000),
      behaviour: clip(dog.behaviour, 500),
      feeding: dog.feeding?.schedule,
    },
    today: new Date().toISOString().slice(0, 10),
    careLog: logs.map((l) => ({ type: l.type, at: l.at, note: clip(l.note, 200), details: l.details })),
  };
}

// The data first, as its own block marked for Claude's prompt cache, then the request. Another
// question about the same pet or dog within a few minutes reads the data from that cache.
const withData = (data, request) => [
  { type: 'text', text: `<nurvia_data>\n${JSON.stringify(data)}\n</nurvia_data>`, cache_control: { type: 'ephemeral' } },
  { type: 'text', text: request },
];

const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Model requests in the last 24 hours; answers from the cache do not count.
const modelCalls = (userId) => ({ user: userId, cached: { $ne: true }, createdAt: { $gte: new Date(Date.now() - DAY) } });

// Runs one model request with the answer cache, the daily limit and the usage log. `cacheKey`
// stands in for content too large to hash cheaply (a document's bytes).
async function ask(req, feature, content, { cacheKey = content } = {}) {
  const status = aiStatus();
  const usage = { user: req.user._id, feature, provider: status.provider, model: status.model };
  const key = status.enabled && env.ai.cacheHours > 0 ? hash({ v: PROMPT_VERSION, system: SYSTEM, model: status.model, user: String(req.user._id), feature, cacheKey }) : null;

  if (key) {
    const hit = await AiAnswer.findOne({ key, expiresAt: { $gt: new Date() } }).lean();
    if (hit) {
      await AiUsage.create({ ...usage, model: hit.model, cached: true, ok: true });
      return { text: hit.text, cached: true };
    }
  }
  if ((await AiUsage.countDocuments(modelCalls(req.user._id))) >= env.ai.dailyLimit) {
    throw tooMany(`You can use the AI assistant ${env.ai.dailyLimit} times a day. Please try again tomorrow`);
  }
  try {
    const result = await complete({ system: SYSTEM, content });
    await AiUsage.create({
      ...usage,
      model: result.model,
      ok: true,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: result.cacheReadTokens,
      cacheWriteTokens: result.cacheWriteTokens,
    });
    if (key) {
      await AiAnswer.updateOne(
        { key },
        { $set: { user: req.user._id, feature, model: result.model, text: result.text, expiresAt: new Date(Date.now() + env.ai.cacheHours * 3_600_000) } },
        { upsert: true },
      );
    }
    return { text: result.text, cached: false };
  } catch (err) {
    if (status.enabled) await AiUsage.create({ ...usage, ok: false, error: err.message, inputTokens: err.usage?.inputTokens, outputTokens: err.usage?.outputTokens });
    throw err;
  }
}

// ---- What the app can offer ----

router.get('/status', async (req, res) => {
  const status = aiStatus();
  const used = status.enabled ? await AiUsage.countDocuments(modelCalls(req.user._id)) : 0;
  res.json({
    ...status,
    features: {
      petRecords: true,
      communityDogInsights: true,
      healthSummary: status.enabled,
      questions: status.enabled,
      documentSummary: status.enabled,
    },
    dailyLimit: env.ai.dailyLimit,
    remainingToday: status.enabled ? Math.max(0, env.ai.dailyLimit - used) : 0,
    disclaimer: DISCLAIMER,
  });
});

// ---- Rule-based answers (no model) ----

// "What vaccinations are recorded, and what is due?" for one pet.
router.get('/pets/:petId/records', validate({ params: { petId: objectId } }), async (req, res) => {
  const pet = await ownPet(req, req.valid.params.petId);
  const [care, history] = await Promise.all([
    careStatus(pet),
    HealthRecord.find({ pet: pet._id }).sort({ date: -1 }).limit(10).select('type title date nextDueDate source').lean(),
  ]);
  const vaccinations = [...care.coreVaccines.filter((v) => v.status !== 'missing').map(({ recordId, key, ...v }) => ({ title: v.label, ...v })), ...care.otherVaccinations];
  res.json({
    pet: { _id: pet._id, name: pet.name, species: pet.species },
    vaccinations,
    missingCoreVaccines: care.coreVaccines.filter((v) => v.status === 'missing').map((v) => v.label),
    deworming: care.deworming,
    due: {
      overdue: [...care.coreVaccines.filter((v) => v.status === 'overdue').map((v) => ({ title: v.label, dueAt: v.nextDueDate, source: 'record' })), ...care.reminders.overdue.map((r) => ({ title: r.title, dueAt: r.dueAt, source: 'reminder' }))],
      upcoming: [...care.coreVaccines.filter((v) => v.status === 'due_soon').map((v) => ({ title: v.label, dueAt: v.nextDueDate, source: 'record' })), ...care.reminders.upcoming.map((r) => ({ title: r.title, dueAt: r.dueAt, source: 'reminder' }))],
    },
    history: history.map((r) => ({ type: r.type, title: r.title, date: r.date, nextDueDate: r.nextDueDate ?? null, fromClinic: r.source === 'clinic' })),
    allergies: care.allergies,
    conditions: care.conditions,
    disclaimer: care.disclaimer,
  });
});

// "Which of my community dogs need vaccinations, feeding updates or a sterilisation check?"
router.get('/community-dogs/insights', validate({ query: { dogId: objectId.optional() } }), async (req, res) => {
  if (req.valid.query.dogId) await caredForDog(req, req.valid.query.dogId);
  const items = (await dueCareFor(req.user._id)).filter((i) => !req.valid.query.dogId || String(i.dog._id) === req.valid.query.dogId);
  const having = (...keys) => items.filter((i) => i.due.some((d) => keys.includes(d.key))).map((i) => ({ _id: i.dog._id, name: i.dog.name ?? i.dog.nickname ?? i.dog.identifier, area: i.dog.area }));
  res.json({
    pendingVaccinations: having('rabies'),
    pendingDeworming: having('deworming'),
    missingFeedingUpdates: having('feeding'),
    unknownSterilisation: having('sterilisation_unknown'),
    notSterilised: having('sterilisation'),
    missing: having('missing'),
    dogs: items.map((i) => ({ _id: i.dog._id, name: i.dog.name ?? i.dog.nickname ?? i.dog.identifier, area: i.dog.area, due: i.due })),
  });
});

// ---- With a model ----

router.post('/pets/:petId/health-summary', validate({ params: { petId: objectId } }), async (req, res) => {
  const pet = await ownPet(req, req.valid.params.petId);
  const { text, cached } = await ask(
    req,
    'health_summary',
    withData(
      await petContext(pet),
      'Write a short health-history summary of this pet for its owner: vaccinations recorded, anything overdue or due in the next month, deworming, allergies and conditions, and recent vet visits. End with what to do next, if anything.',
    ),
  );
  res.json({ summary: text, cached, disclaimer: DISCLAIMER });
});

// A question about one pet, one community dog the caller cares for, or (with neither) all of the
// caller's pets and the community dogs that need care.
router.post(
  '/ask',
  validate({ body: { question: z.string().trim().min(3).max(500), petId: objectId.optional(), communityDogId: objectId.optional() } }),
  async (req, res) => {
    const { question, petId, communityDogId } = req.valid.body;
    if (petId && communityDogId) throw badRequest('Ask about one pet or one community dog at a time');
    let data;
    if (petId) data = await petContext(await ownPet(req, petId));
    else if (communityDogId) data = await dogContext(await caredForDog(req, communityDogId));
    else {
      const pets = await Pet.find({ owner: req.user._id, archivedAt: null }).limit(5).lean();
      const dogs = await dueCareFor(req.user._id);
      data = {
        pets: await Promise.all(pets.map(petContext)),
        communityDogsNeedingCare: dogs.map((i) => ({ name: i.dog.name ?? i.dog.nickname ?? i.dog.identifier, area: i.dog.area, due: i.due.map((d) => d.label) })),
      };
    }
    const { text, cached } = await ask(req, petId ? 'ask_pet' : communityDogId ? 'ask_community_dog' : 'ask', withData(data, `Question: ${question}`));
    res.json({ answer: text, cached, disclaimer: DISCLAIMER });
  },
);

const DOCUMENT_TYPES = { 'application/pdf': 'document', 'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image', 'image/gif': 'image' };

// A prescription, lab report or vet document the caller uploaded (health record or visit report).
router.post('/documents/summarise', validate({ body: { fileId: objectId } }), async (req, res) => {
  const file = await File.findOne({ _id: req.valid.body.fileId, owner: req.user._id }).lean();
  if (!file) throw notFound('File');
  if (!['health_record', 'visit_report', 'pet_photo'].includes(file.purpose)) throw badRequest('Only health records and vet documents can be summarised');
  const kind = DOCUMENT_TYPES[file.mime];
  if (!kind) throw badRequest('Summaries work for PDF, JPEG, PNG, WebP and GIF files');
  const bytes = await fs.readFile(file.visibility === 'public' ? path.join(publicDir, file.key) : privatePath(file.key));
  const source = { type: 'base64', media_type: file.mime, data: bytes.toString('base64') };
  const instructions =
    'Summarise this veterinary document for the pet owner: what it is, the date, each medicine with its dose, how often and for how long exactly as written, other instructions, and any follow-up date. If part of it cannot be read, say so rather than guessing. Do not add advice beyond what the document says.';
  const { text, cached } = await ask(
    req,
    'document_summary',
    [{ ...(kind === 'document' ? { type: 'document', source } : { type: 'image', source }), cache_control: { type: 'ephemeral' } }, { type: 'text', text: instructions }],
    // Files are never changed after upload, so the file id stands for its contents.
    { cacheKey: { fileId: String(file._id), size: file.size, instructions } },
  );
  res.json({ summary: text, cached, disclaimer: DISCLAIMER });
});

export default router;
