import crypto from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authenticate } from '../../common/auth.js';
import { badRequest, conflict, notFound } from '../../common/errors.js';
import { paginate } from '../../common/paginate.js';
import { objectId, pageQuery, validate } from '../../common/validate.js';
import { env } from '../../config/env.js';
import { audit } from '../audit/audit.model.js';
import { notify } from '../notifications/notify.js';
import { Pet } from '../pets/pet.model.js';
import { User } from '../users/user.model.js';
import { NfcScan, NfcTag } from './nfc.model.js';

const router = Router();

export const tagUrl = (tag) => `${env.webBaseUrl}/t/${tag.code}`;
const ipHash = (ip) => crypto.createHmac('sha256', env.otp.secret).update(String(ip)).digest('hex').slice(0, 24);
const withUrl = (tag) => ({ ...(tag.toJSON?.() ?? tag), publicUrl: tagUrl(tag) });

// ---- Public recovery profile (no sign-in; this is what a tag tap opens) ----

const publicLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, skip: () => env.nodeEnv === 'test' });
const code = z.string().regex(/^[A-Za-z0-9_-]{8,40}$/);

async function activeTag(tagCode) {
  const tag = await NfcTag.findOne({ code: tagCode, status: 'active' });
  if (!tag) throw notFound('Tag');
  const pet = await Pet.findOne({ _id: tag.pet, archivedAt: null }).lean();
  if (!pet) throw notFound('Tag');
  return { tag, pet };
}

function recoveryProfile(tag, pet, owner) {
  const p = tag.profile ?? {};
  return {
    pet: {
      name: pet.name,
      species: pet.species,
      breed: pet.breed,
      sex: pet.sex,
      color: pet.color,
      photoUrl: pet.photo?.url,
      ...(p.showAllergies && { allergies: pet.allergies ?? [] }),
      ...(p.showMedicalNotes && { conditions: pet.conditions ?? [], emergencyNotes: pet.emergencyNotes }),
    },
    lost: pet.lost?.active ? { since: pet.lost.since, lastSeenArea: pet.lost.lastSeenArea, note: pet.lost.note } : null,
    owner: {
      ...(p.showOwnerName && owner?.name && { firstName: owner.name.split(' ')[0] }),
      ...(p.showPhone && { phone: p.contactPhone || owner?.phone }),
    },
    message: p.message,
    // Finders can always reach the owner through Nurvia, even when no phone number is shown.
    canNotifyOwner: true,
  };
}

router.get('/t/:code', publicLimiter, validate({ params: { code } }), async (req, res) => {
  const { tag, pet } = await activeTag(req.valid.params.code);
  const owner = await User.findById(tag.owner).select('name phone').lean();
  await NfcScan.create({ tag: tag._id, pet: pet._id, owner: tag.owner, kind: 'view', ipHash: ipHash(req.ip), userAgent: req.get('user-agent')?.slice(0, 200) });
  await NfcTag.updateOne({ _id: tag._id }, { $inc: { scanCount: 1 }, lastScanAt: new Date() });
  // While the pet is marked lost, every tap is worth telling the owner about.
  if (pet.lost?.active) {
    await notify([tag.owner], { type: 'nfc.scanned', title: `${pet.name}'s tag was just scanned`, body: 'Someone opened the recovery profile.', data: { tagId: String(tag._id), petId: String(pet._id) } });
  }
  res.set('Cache-Control', 'no-store');
  res.json(recoveryProfile(tag, pet, owner));
});

// A finder tells the owner they have the pet. Location is only stored when the finder shares it.
router.post(
  '/t/:code/found',
  publicLimiter,
  validate({
    params: { code },
    body: {
      message: z.string().trim().min(1).max(500),
      name: z.string().trim().max(80).optional(),
      phone: z.string().trim().max(20).optional(),
      location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional(),
    },
  }),
  async (req, res) => {
    const { tag, pet } = await activeTag(req.valid.params.code);
    const { message, name, phone, location } = req.valid.body;
    const scan = await NfcScan.create({
      tag: tag._id,
      pet: pet._id,
      owner: tag.owner,
      kind: 'found_report',
      message,
      finderName: name,
      finderPhone: phone,
      ...(location && { location: { type: 'Point', coordinates: [location.lng, location.lat] } }),
      ipHash: ipHash(req.ip),
      userAgent: req.get('user-agent')?.slice(0, 200),
    });
    await notify([tag.owner], {
      type: 'nfc.found_report',
      title: `Someone found ${pet.name}`,
      body: [message, phone && `Call ${name ?? 'them'} on ${phone}`].filter(Boolean).join(' · ').slice(0, 300),
      data: { tagId: String(tag._id), petId: String(pet._id), scanId: String(scan._id), ...(location && { lat: location.lat, lng: location.lng }) },
    });
    res.status(201).json({ ok: true, message: 'The owner has been notified. Thank you for helping.' });
  },
);

// ---- Owner: activate and manage tags ----

const profileBody = z.object({
  showOwnerName: z.boolean().optional(),
  showPhone: z.boolean().optional(),
  contactPhone: z.string().trim().max(20).optional(),
  message: z.string().trim().max(300).optional(),
  showAllergies: z.boolean().optional(),
  showMedicalNotes: z.boolean().optional(),
});

async function ownPet(userId, petId) {
  const pet = await Pet.findOne({ _id: petId, owner: userId, archivedAt: null });
  if (!pet) throw notFound('Pet');
  return pet;
}

async function ownTag(req) {
  const tag = await NfcTag.findOne({ _id: req.valid.params.id, owner: req.user._id });
  if (!tag) throw notFound('Tag');
  return tag;
}

// The code or the printed serial activates a tag. A tag already linked to someone cannot be taken over.
async function claimable(codeOrSerial) {
  const tag = await NfcTag.findOne({ $or: [{ code: codeOrSerial }, { serial: codeOrSerial.toUpperCase() }] });
  if (!tag || tag.status === 'deactivated') throw notFound('Tag');
  if (tag.status === 'active') throw conflict('This tag is already linked to a pet');
  return tag;
}

router.get('/tags', authenticate, async (req, res) => {
  const tags = await NfcTag.find({ owner: req.user._id }).sort({ status: 1, activatedAt: -1 }).populate('pet', 'name species photo lost').lean();
  res.json(tags.map(withUrl));
});

router.post(
  '/tags/activate',
  authenticate,
  validate({ body: { code: z.string().trim().min(6).max(40), petId: objectId, profile: profileBody.optional() } }),
  async (req, res) => {
    const pet = await ownPet(req.user._id, req.valid.body.petId);
    const tag = await claimable(req.valid.body.code);
    tag.set({ status: 'active', pet: pet._id, owner: req.user._id, activatedAt: new Date(), profile: { ...tag.toObject().profile, ...req.valid.body.profile } });
    await tag.save();
    res.json(withUrl(tag));
  },
);

router.patch('/tags/:id', authenticate, validate({ body: { profile: profileBody } }), async (req, res) => {
  const tag = await ownTag(req);
  if (tag.status !== 'active') throw conflict('This tag is not active');
  tag.profile = { ...tag.toObject().profile, ...req.valid.body.profile };
  res.json(withUrl(await tag.save()));
});

router.post(
  '/tags/:id/deactivate',
  authenticate,
  validate({ body: { reason: z.enum(['lost_tag', 'damaged', 'pet_passed', 'other']) } }),
  async (req, res) => {
    const tag = await ownTag(req);
    if (tag.status !== 'active') throw conflict('This tag is not active');
    tag.set({ status: 'deactivated', deactivatedAt: new Date(), deactivationReason: req.valid.body.reason });
    res.json(withUrl(await tag.save()));
  },
);

// Moves the pet to a new tag (a lost or damaged one is replaced) and keeps the profile settings.
router.post('/tags/:id/replace', authenticate, validate({ body: { code: z.string().trim().min(6).max(40) } }), async (req, res) => {
  const old = await ownTag(req);
  if (!old.pet) throw conflict('This tag was never linked to a pet');
  await ownPet(req.user._id, old.pet);
  const tag = await claimable(req.valid.body.code);
  tag.set({ status: 'active', pet: old.pet, owner: req.user._id, activatedAt: new Date(), profile: old.toObject().profile });
  await tag.save();
  old.set({ status: 'deactivated', deactivatedAt: old.deactivatedAt ?? new Date(), deactivationReason: old.deactivationReason ?? 'replaced', replacedBy: tag._id });
  await old.save();
  res.json({ tag: withUrl(tag), replaced: withUrl(old) });
});

// Links an active tag to another of the owner's pets.
router.post('/tags/:id/reassign', authenticate, validate({ body: { petId: objectId } }), async (req, res) => {
  const tag = await ownTag(req);
  if (tag.status !== 'active') throw conflict('Only an active tag can be moved to another pet');
  const pet = await ownPet(req.user._id, req.valid.body.petId);
  tag.pet = pet._id;
  res.json(withUrl(await tag.save()));
});

router.get('/tags/:id/scans', authenticate, validate({ query: pageQuery }), async (req, res) => {
  const tag = await ownTag(req);
  const { page, limit } = req.valid.query;
  res.json(await paginate(NfcScan, { tag: tag._id }, { page, limit, select: '-ipHash -userAgent' }));
});

export default router;

// ---- Admin: tag inventory, lifecycle and scan visibility (mounted at /admin/nfc) ----

export const adminNfcRouter = Router();

const SERIAL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomSerial = () => 'NV-' + Array.from(crypto.randomBytes(8), (b) => SERIAL_ALPHABET[b % SERIAL_ALPHABET.length]).join('');
const randomCode = () => crypto.randomBytes(12).toString('base64url');

adminNfcRouter.post(
  '/tags',
  validate({ body: { count: z.number().int().min(1).max(1000), kind: z.enum(['nfc', 'qr']).default('nfc'), batch: z.string().trim().max(60).optional() } }),
  async (req, res) => {
    const { count, kind, batch } = req.valid.body;
    const tags = await NfcTag.insertMany(Array.from({ length: count }, () => ({ code: randomCode(), serial: randomSerial(), kind, batch })));
    await audit(req, 'nfc.tags_created', { type: 'nfc_batch' }, { meta: { count, kind, batch } });
    // The URLs are what gets written to the NFC chips or printed as QR codes.
    res.status(201).json(tags.map((t) => ({ _id: t._id, serial: t.serial, code: t.code, kind: t.kind, publicUrl: tagUrl(t) })));
  },
);

adminNfcRouter.get(
  '/tags',
  validate({ query: { ...pageQuery, status: z.enum(['unassigned', 'active', 'deactivated']).optional(), q: z.string().trim().max(40).optional(), batch: z.string().max(60).optional() } }),
  async (req, res) => {
    const { page, limit, status, q, batch } = req.valid.query;
    const filter = { ...(status && { status }), ...(batch && { batch }), ...(q && { $or: [{ serial: q.toUpperCase() }, { code: q }] }) };
    res.json(await paginate(NfcTag, filter, { page, limit, populate: [{ path: 'pet', select: 'name species' }, { path: 'owner', select: 'name phone' }] }));
  },
);

adminNfcRouter.get('/tags/:id', validate(), async (req, res) => {
  const tag = await NfcTag.findById(req.valid.params.id).populate('pet', 'name species').populate('owner', 'name phone').lean();
  if (!tag) throw notFound('Tag');
  const scans = await NfcScan.find({ tag: tag._id }).sort({ createdAt: -1 }).limit(50).select('-ipHash').lean();
  res.json({ ...withUrl(tag), scans });
});

adminNfcRouter.post(
  '/tags/:id/lifecycle',
  validate({ body: { action: z.enum(['deactivate', 'unassign']), reason: z.string().trim().min(3).max(300) } }),
  async (req, res) => {
    const tag = await NfcTag.findById(req.valid.params.id);
    if (!tag) throw notFound('Tag');
    const { action, reason } = req.valid.body;
    if (action === 'deactivate') {
      if (tag.status === 'deactivated') throw conflict('Already deactivated');
      tag.set({ status: 'deactivated', deactivatedAt: new Date(), deactivationReason: 'admin' });
    } else {
      // Frees a tag for a verified new owner (e.g. after an adoption), clearing the old link.
      if (tag.status === 'unassigned') throw conflict('Already unassigned');
      if (tag.replacedBy) throw badRequest('A replaced tag cannot be reused');
      tag.set({ status: 'unassigned', pet: undefined, owner: undefined, activatedAt: undefined, deactivatedAt: undefined, deactivationReason: undefined });
    }
    await tag.save();
    await audit(req, `nfc.tag_${action}`, { type: 'nfc_tag', id: tag._id }, { reason });
    res.json(withUrl(tag));
  },
);

adminNfcRouter.get('/scans', validate({ query: { ...pageQuery, kind: z.enum(['view', 'found_report']).optional() } }), async (req, res) => {
  const { page, limit, kind } = req.valid.query;
  res.json(await paginate(NfcScan, { ...(kind && { kind }) }, { page, limit, select: '-ipHash', populate: [{ path: 'pet', select: 'name' }, { path: 'tag', select: 'serial' }] }));
});
