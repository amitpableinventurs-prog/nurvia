import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import crypto from 'node:crypto';
import { authenticate, can } from '../../common/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../../common/errors.js';
import { paginate } from '../../common/paginate.js';
import { PERMISSIONS, ROLES } from '../../common/roles.js';
import { geoQuery, objectId, pageQuery, partialShape, point, validate } from '../../common/validate.js';
import { attachmentsFor } from '../files/file.routes.js';
import { notify } from '../notifications/notify.js';
import { SosResponder } from '../sos/sos.model.js';
import { User } from '../users/user.model.js';
import {
  CARE_LOG_TYPES,
  CARE_ROLES,
  CareInvite,
  CareLog,
  CommunityDog,
  DOG_SIZES,
  DOG_STATUSES,
  EAR_NOTCH,
  LIFE_STAGES,
  LOG_CATEGORIES,
} from './community-dog.model.js';

const router = Router();
router.use(authenticate);

const dogBody = {
  name: z.string().trim().max(60).optional(),
  breed: z.string().trim().max(60).optional(),
  description: z.string().max(2000).optional(),
  sex: z.enum(['male', 'female', 'unknown']).optional(),
  approxAgeMonths: z.number().int().min(0).max(300).optional(),
  lifeStage: z.enum(LIFE_STAGES).optional(),
  size: z.enum(DOG_SIZES).optional(),
  color: z.string().max(60).optional(),
  markings: z.string().max(200).optional(),
  // The first photo is the primary one.
  photoFileIds: z.array(objectId).max(10).optional(),
  area: z.string().trim().min(2).max(160),
  city: z.string().trim().max(80).optional(),
  location: point,
  roamingRadiusM: z.number().int().min(50).max(3000).optional(),
  landmarks: z.string().trim().max(500).optional(),
  vaccinationStatus: z.enum(['unknown', 'partial', 'up_to_date']).optional(),
  sterilized: z.boolean().optional(),
  earNotch: z.enum(EAR_NOTCH).optional(),
  feeding: z.object({ schedule: z.string().trim().max(300).optional(), tolerances: z.string().trim().max(500).optional() }).optional(),
  healthNotes: z.string().max(2000).optional(),
  emergencyNotes: z.string().max(1000).optional(),
  // A nearby responder from GET /community-dogs/liaisons; null removes the liaison.
  emergencyLiaisonId: objectId.nullable().optional(),
};

// "Save draft" on the registration form: every field optional until submitted.
const draftBody = { ...partialShape(dogBody), draft: z.literal(true) };

async function dogFields(userId, { photoFileIds, emergencyLiaisonId: _liaison, ...body }) {
  const fields = photoFileIds ? { ...body, photos: await attachmentsFor(userId, photoFileIds, ['community']) } : { ...body };
  // An ear notch is the ABC programme's sterilisation mark.
  if (fields.earNotch === 'notched') fields.sterilized = true;
  return fields;
}

const isStaff = (user) => can(user, PERMISSIONS.CONTENT_MODERATE);

async function visibleDog(id) {
  const dog = await CommunityDog.findOne({ _id: id, status: 'visible' });
  if (!dog) throw notFound('Community dog');
  return dog;
}

// A published profile, or the caller's own draft.
async function viewableDog(req) {
  const dog = await CommunityDog.findOne({ _id: req.valid.params.id, $or: [{ status: 'visible' }, { draft: true, createdBy: req.user._id }] });
  if (!dog) throw notFound('Community dog');
  return dog;
}

async function ownDraft(req) {
  const dog = await CommunityDog.findOne({ _id: req.valid.params.id, draft: true, createdBy: req.user._id });
  if (!dog) throw notFound('Draft');
  return dog;
}

const isCaregiver = (dog, user) => dog.caregivers.some((id) => String(id?._id ?? id) === String(user._id));
// Profiles created before care-team roles existed have caregivers but no careTeam entries.
function roleOf(dog, user) {
  const entry = dog.careTeam?.find((m) => String(m.user?._id ?? m.user) === String(user._id));
  if (entry) return entry.role;
  if (!isCaregiver(dog, user)) return null;
  return String(dog.createdBy?._id ?? dog.createdBy) === String(user._id) ? 'primary' : 'co_caregiver';
}
const canManageTeam = (dog, user) => roleOf(dog, user) === 'primary' || isStaff(user);
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomCode = (n) => Array.from(crypto.randomBytes(n), (b) => ALPHABET[b % ALPHABET.length]).join('');
const newIdentifier = () => 'CD-' + randomCode(5);
const SELF_ROLES = ['co_caregiver', 'feeder', 'medical_volunteer', 'other'];
const DAY = 86_400_000;
const LIAISON_KINDS = ['volunteer', 'ngo', 'vet', 'caregiver'];
const LIAISON_RADIUS_KM = 15;

// For animal safety the public never sees where a dog lives: only the area name. Caregivers see
// the territory (an approximate centre and the roaming radius); the primary caregiver and staff
// see the exact pin. Feeding times, resting spots and emergency notes stay within the team.
function dogView(dog, user) {
  const data = typeof dog.toJSON === 'function' ? dog.toJSON() : { ...dog };
  const role = roleOf(dog, user);
  const exact = role === 'primary' || isStaff(user);
  const [lng, lat] = data.location?.coordinates ?? [];
  const round = (v) => Math.round(v * 1000) / 1000; // ~100 m
  const territory = { area: data.area ?? null, city: data.city ?? null };
  if (role || isStaff(user)) {
    territory.radiusM = data.roamingRadiusM ?? null;
    territory.center = lat === undefined ? null : exact ? { lat, lng } : { lat: round(lat), lng: round(lng) };
    territory.exact = exact;
  }
  const { location, landmarks, feeding, emergencyNotes, ...rest } = data;
  return {
    ...rest,
    ...(exact && { location }),
    ...(role || isStaff(user) ? { landmarks, feeding, emergencyNotes } : { feeding: feeding?.tolerances ? { tolerances: feeding.tolerances } : undefined }),
    territory,
    myRole: role,
  };
}

// A nearby responder, checked against the dog's territory, becomes the emergency liaison.
async function setLiaison(dog, liaisonId, by) {
  if (liaisonId === undefined) return false;
  if (liaisonId === null) {
    dog.emergencyLiaison = undefined;
    return false;
  }
  const [lng, lat] = dog.location?.coordinates ?? [];
  const responder = await SosResponder.findOne({
    user: liaisonId,
    active: true,
    kind: { $in: LIAISON_KINDS },
    ...(lat !== undefined && { location: { $geoWithin: { $centerSphere: [[lng, lat], LIAISON_RADIUS_KM / 6378.1] } } }),
  }).lean();
  if (!responder) throw badRequest('Choose a liaison from the nearby responders list');
  if (String(dog.emergencyLiaison?.user) === String(liaisonId)) return false;
  dog.emergencyLiaison = { user: liaisonId, since: new Date() };
  return String(liaisonId) !== String(by._id);
}

const tellLiaison = (dog) =>
  notify([dog.emergencyLiaison.user], {
    type: 'community_dog.liaison',
    title: `You are the emergency contact for ${dog.name ?? 'a community dog'}`,
    body: `Caregivers in ${dog.area} can reach you through Nurvia if the dog needs help.`,
    data: { dogId: String(dog._id) },
  });

router.get('/', validate({ query: { ...geoQuery, ...pageQuery, mine: z.enum(['true']).optional() } }), async (req, res) => {
  const { lat, lng, radiusKm, page, limit, mine } = req.valid.query;
  // "Mine" includes the caller's unsubmitted drafts.
  const filter = mine ? { caregivers: req.user._id, $or: [{ status: 'visible' }, { draft: true, createdBy: req.user._id }] } : { status: 'visible' };
  if (lat !== undefined && lng !== undefined) {
    filter.location = { $geoWithin: { $centerSphere: [[lng, lat], radiusKm / 6378.1] } };
  }
  const result = await paginate(CommunityDog, filter, { page, limit, sort: { lastLogAt: -1, createdAt: -1 }, select: '-moderation' });
  res.json({ ...result, items: result.items.map((d) => dogView(d, req.user)) });
});

router.post('/', validate({ body: dogBody }), async (req, res) => {
  const dog = new CommunityDog({
    ...(await dogFields(req.user._id, req.valid.body)),
    identifier: newIdentifier(),
    createdBy: req.user._id,
    caregivers: [req.user._id],
    careTeam: [{ user: req.user._id, role: 'primary' }],
    submittedAt: new Date(),
  });
  const tell = await setLiaison(dog, req.valid.body.emergencyLiaisonId, req.user);
  await dog.save();
  await User.updateOne({ _id: req.user._id }, { $addToSet: { roles: ROLES.CAREGIVER } });
  if (tell) await tellLiaison(dog);
  res.status(201).json(dogView(dog, req.user));
});

// The registration form's "Draft" button. Drafts are private and appear under ?mine=true.
router.post('/drafts', validate({ body: draftBody }), async (req, res) => {
  const { draft: _draft, ...body } = req.valid.body;
  const dog = new CommunityDog({
    ...(await dogFields(req.user._id, body)),
    identifier: newIdentifier(),
    createdBy: req.user._id,
    caregivers: [req.user._id],
    careTeam: [{ user: req.user._id, role: 'primary' }],
    draft: true,
    status: 'hidden',
  });
  await setLiaison(dog, body.emergencyLiaisonId, req.user);
  await dog.save();
  res.status(201).json(dogView(dog, req.user));
});

// What the registration form still needs before "Submit for review".
function missingForSubmit(dog) {
  return [
    !dog.name && 'name',
    !dog.lifeStage && 'lifeStage',
    !dog.color && !dog.markings && 'markings',
    !dog.size && 'size',
    (dog.photos?.length ?? 0) < 2 && 'photos',
    !dog.area && 'area',
    !dog.location?.coordinates?.length && 'location',
  ].filter(Boolean);
}

router.get('/:id/submit-check', validate(), async (req, res) => {
  const dog = await ownDraft(req);
  const missing = missingForSubmit(dog);
  res.json({ ready: !missing.length, missing, preview: dogView(dog, req.user) });
});

// Publishes a draft. Staff review the territory and caregivers before it gets the community badge.
router.post('/:id/submit', validate(), async (req, res) => {
  const dog = await ownDraft(req);
  const missing = missingForSubmit(dog);
  if (missing.length) throw badRequest('Complete the profile before submitting', { missing });
  dog.set({ draft: false, status: 'visible', submittedAt: new Date(), verification: { status: 'pending' } });
  await dog.save();
  await User.updateOne({ _id: req.user._id }, { $addToSet: { roles: ROLES.CAREGIVER } });
  if (dog.emergencyLiaison?.user && String(dog.emergencyLiaison.user) !== String(req.user._id)) await tellLiaison(dog);
  res.json(dogView(dog, req.user));
});

// "Cancel" on the registration form discards the draft.
router.delete('/:id/draft', validate(), async (req, res) => {
  const dog = await ownDraft(req);
  await dog.deleteOne();
  res.status(204).end();
});

// Dogs the caller cares for that need attention, from the care timeline: not fed lately, rabies
// vaccination or deworming missing or overdue, not sterilised, or marked missing.
router.get('/due-care', async (req, res) => {
  const dogs = await CommunityDog.find({ status: 'visible', caregivers: req.user._id, currentStatus: { $nin: ['adopted', 'deceased', 'relocated'] } })
    .select('name identifier area sterilized vaccinationStatus currentStatus lastSeen photos')
    .lean();
  if (!dogs.length) return res.json([]);
  const last = await CareLog.aggregate([
    { $match: { dog: { $in: dogs.map((d) => d._id) }, type: { $in: ['fed', 'vaccinated', 'rabies_vaccination', 'dewormed'] } } },
    { $group: { _id: { dog: '$dog', type: '$type' }, at: { $max: '$at' } } },
  ]);
  const lastAt = (dog, ...types) => Math.max(0, ...last.filter((r) => String(r._id.dog) === String(dog._id) && types.includes(r._id.type)).map((r) => r.at.getTime()));
  const now = Date.now();
  const items = dogs
    .map((dog) => {
      const due = [];
      if (dog.currentStatus === 'missing') due.push({ key: 'missing', label: 'Marked missing', since: dog.lastSeen?.at });
      const fed = lastAt(dog, 'fed');
      if (now - fed > 2 * DAY) due.push({ key: 'feeding', label: fed ? 'Not fed in over 2 days' : 'No feeding logged yet', lastAt: fed ? new Date(fed) : null });
      const rabies = lastAt(dog, 'rabies_vaccination', 'vaccinated');
      if (now - rabies > 365 * DAY) due.push({ key: 'rabies', label: rabies ? 'Rabies vaccination over a year ago' : 'No rabies vaccination recorded', lastAt: rabies ? new Date(rabies) : null });
      const dewormed = lastAt(dog, 'dewormed');
      if (now - dewormed > 90 * DAY) due.push({ key: 'deworming', label: dewormed ? 'Deworming over 3 months ago' : 'No deworming recorded', lastAt: dewormed ? new Date(dewormed) : null });
      if (!dog.sterilized) due.push({ key: 'sterilisation', label: 'Not sterilised' });
      return { dog, due };
    })
    .filter((d) => d.due.length);
  res.json(items);
});

// Rescue volunteers, NGOs and vets who opted in as SOS responders near a place: the people a
// caregiver can pick as the dog's emergency liaison. Contact goes through Nurvia, never a number.
router.get(
  '/liaisons',
  validate({ query: { lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) } }),
  async (req, res) => {
    const { lat, lng } = req.valid.query;
    const responders = await SosResponder.find({
      active: true,
      kind: { $in: LIAISON_KINDS },
      location: { $geoWithin: { $centerSphere: [[lng, lat], LIAISON_RADIUS_KM / 6378.1] } },
    })
      .limit(30)
      .populate('user', 'name status')
      .lean();
    res.json({
      items: responders
        .filter((r) => r.user?.status === 'active' && String(r.user._id) !== String(req.user._id))
        .map((r) => ({ userId: r.user._id, name: r.user.name, kind: r.kind, organisation: r.organisation ?? null })),
    });
  },
);

// ---- Joining a care team by invitation ----

const INVITE_DAYS = 7;
const inviteParams = { code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{6,12}$/, 'Invalid invite code') };

async function liveInvite(code) {
  const invite = await CareInvite.findOne({ code, expiresAt: { $gt: new Date() } }).lean();
  if (!invite || invite.uses >= invite.maxUses) throw notFound('Invite');
  return invite;
}

router.get('/invites/:code', validate({ params: inviteParams }), async (req, res) => {
  const invite = await liveInvite(req.valid.params.code);
  const [dog, inviter] = await Promise.all([visibleDog(invite.dog), User.findById(invite.createdBy).select('name').lean()]);
  res.json({
    code: invite.code,
    role: invite.role,
    expiresAt: invite.expiresAt,
    invitedBy: inviter?.name ?? null,
    dog: { _id: dog._id, name: dog.name, area: dog.area, photo: dog.photos?.[0]?.url ?? null, caregivers: dog.caregivers.length },
    alreadyMember: isCaregiver(dog, req.user),
  });
});

router.post('/invites/:code/accept', validate({ params: inviteParams }), async (req, res) => {
  const invite = await liveInvite(req.valid.params.code);
  const dog = await visibleDog(invite.dog);
  if (isCaregiver(dog, req.user)) throw conflict('You are already on the care team');
  const claimed = await CareInvite.findOneAndUpdate({ _id: invite._id, uses: { $lt: invite.maxUses }, expiresAt: { $gt: new Date() } }, { $inc: { uses: 1 } });
  if (!claimed) throw notFound('Invite');
  dog.caregivers.addToSet(req.user._id);
  dog.careTeam.push({ user: req.user._id, role: invite.role });
  await dog.save();
  await User.updateOne({ _id: req.user._id }, { $addToSet: { roles: ROLES.CAREGIVER } });
  await notify([invite.createdBy], {
    type: 'community_dog.joined',
    title: `${req.user.name ?? 'A neighbour'} joined ${dog.name ?? 'your dog'}'s care team`,
    data: { dogId: String(dog._id) },
  });
  res.json(dogView(dog, req.user));
});

// ---- Profile ----

const YEAR = 365 * DAY;
const isRabies = (log) => log.type === 'rabies_vaccination' || (log.type === 'vaccinated' && /rabies|\barv\b/i.test(`${log.details?.vaccine ?? ''} ${log.note ?? ''}`));

// The health & compliance matrix, from the care log: anti-rabies, the combination vaccine,
// deworming and sterilisation. A log's details.nextDueDate overrides the usual interval.
async function healthOf(dog) {
  const logs = await CareLog.find({ dog: dog._id, type: { $in: ['rabies_vaccination', 'vaccinated', 'dewormed', 'sterilized'] } }).sort({ at: -1 }).lean();
  const now = Date.now();
  const nextOf = (log, interval) => (log.details?.nextDueDate ? new Date(log.details.nextDueDate) : new Date(log.at.getTime() + interval));
  const stateOf = (next) => (next < now ? 'overdue' : next - now < 30 * DAY ? 'due_soon' : 'valid');
  const entry = (key, label, log, interval) =>
    log
      ? {
          key,
          label: log.details?.vaccine ? String(log.details.vaccine) : label,
          status: stateOf(nextOf(log, interval)),
          lastAt: log.at,
          dueAt: nextOf(log, interval),
          reference: log.official?.reference ?? (log.details?.batch ? String(log.details.batch) : null),
          official: Boolean(log.official?.verified),
        }
      : { key, label, status: 'missing', lastAt: null, dueAt: null, reference: null, official: false };
  const sterilised = logs.find((l) => l.type === 'sterilized');
  const done = dog.sterilized || dog.earNotch === 'notched';
  return [
    entry('rabies', 'Anti-rabies (ARV)', logs.find(isRabies), YEAR),
    entry('combination', '7-in-1 (DHPPi)', logs.find((l) => l.type === 'vaccinated' && !isRabies(l)), YEAR),
    entry('deworming', 'Deworming', logs.find((l) => l.type === 'dewormed'), 90 * DAY),
    {
      key: 'sterilisation',
      label: 'Sterilised',
      status: done ? 'done' : dog.earNotch === 'intact' ? 'not_done' : 'unknown',
      lastAt: sterilised?.at ?? null,
      dueAt: null,
      reference: sterilised?.details?.tag ? String(sterilised.details.tag) : sterilised?.official?.reference ?? null,
      official: Boolean(sterilised?.official?.verified),
    },
  ];
}

const ROLE_ORDER = ['primary', 'vet', 'ngo', 'medical_coordinator', 'medical_volunteer', 'co_caregiver', 'feeder', 'rwa', 'other'];

async function logCounts(dogId) {
  const rows = await CareLog.aggregate([{ $match: { dog: new mongoose.Types.ObjectId(String(dogId)) } }, { $group: { _id: '$type', n: { $sum: 1 } } }]);
  const counts = Object.fromEntries(Object.entries(LOG_CATEGORIES).map(([key, types]) => [key, rows.filter((r) => types.includes(r._id)).reduce((s, r) => s + r.n, 0)]));
  return { all: rows.reduce((s, r) => s + r.n, 0), ...counts };
}

const logView = (log, user) => {
  const { thanks = [], ...rest } = log;
  return { ...rest, thanksCount: thanks.length, thankedByMe: thanks.some((id) => String(id) === String(user._id)) };
};

router.get('/:id', validate(), async (req, res) => {
  const dog = await viewableDog(req);
  await dog.populate([
    { path: 'caregivers', select: 'name avatarUrl' },
    { path: 'careTeam.user', select: 'name avatarUrl' },
    { path: 'emergencyLiaison.user', select: 'name' },
  ]);
  const [recentLogs, health, counts, liaison] = await Promise.all([
    CareLog.find({ dog: dog._id }).sort({ at: -1 }).limit(10).populate('by', 'name').lean(),
    healthOf(dog),
    logCounts(dog._id),
    dog.emergencyLiaison?.user ? SosResponder.findOne({ user: dog.emergencyLiaison.user._id }).select('kind organisation active').lean() : null,
  ]);
  const view = dogView(dog, req.user);
  const members = [...(view.careTeam ?? [])].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || new Date(a.since) - new Date(b.since));
  const rabies = health.find((h) => h.key === 'rabies');
  res.json({
    ...view,
    badges: {
      earNotched: dog.earNotch === 'notched',
      sterilised: Boolean(dog.sterilized || dog.earNotch === 'notched'),
      rabiesProtected: ['valid', 'due_soon'].includes(rabies.status),
      communityVerified: dog.verification?.status === 'verified',
    },
    health,
    team: { total: members.length, members: members.map((m) => ({ user: m.user, role: m.role, title: m.title ?? null, since: m.since })) },
    // Reached through Nurvia ("community relay"); their number is never shown.
    emergencyLiaison: dog.emergencyLiaison?.user
      ? { userId: dog.emergencyLiaison.user._id, name: dog.emergencyLiaison.user.name, kind: liaison?.kind ?? null, organisation: liaison?.organisation ?? null, relayActive: Boolean(liaison?.active) }
      : null,
    logCounts: counts,
    recentLogs: recentLogs.map((l) => logView(l, req.user)),
  });
});

router.patch('/:id', validate({ body: partialShape(dogBody) }), async (req, res) => {
  const dog = await viewableDog(req);
  if (!isCaregiver(dog, req.user)) throw forbidden('Only caregivers can edit this profile');
  const territory = () => JSON.stringify([dog.area, dog.city, dog.location?.coordinates]);
  const before = territory();
  dog.set(await dogFields(req.user._id, req.valid.body));
  const tell = await setLiaison(dog, req.valid.body.emergencyLiaisonId, req.user);
  // A territory that moves has to be checked again before the community badge applies.
  if (!dog.draft && territory() !== before) dog.verification = { status: 'pending' };
  await dog.save();
  if (tell && !dog.draft) await tellLiaison(dog);
  res.json(dogView(dog, req.user));
});

router.post('/:id/caregivers', validate({ body: { role: z.enum(SELF_ROLES).optional() } }), async (req, res) => {
  const dog = await visibleDog(req.valid.params.id);
  if (isCaregiver(dog, req.user)) throw conflict('You are already on the care team');
  dog.caregivers.addToSet(req.user._id);
  dog.careTeam.push({ user: req.user._id, role: req.valid.body.role ?? 'co_caregiver' });
  await dog.save();
  await User.updateOne({ _id: req.user._id }, { $addToSet: { roles: ROLES.CAREGIVER } });
  res.json({ caregivers: dog.caregivers });
});

router.delete('/:id/caregivers/me', validate(), async (req, res) => {
  const dog = await visibleDog(req.valid.params.id);
  const wasPrimary = roleOf(dog, req.user) === 'primary';
  dog.caregivers.pull(req.user._id);
  dog.careTeam = dog.careTeam.filter((m) => String(m.user) !== String(req.user._id));
  // The longest-serving remaining caregiver takes over as primary.
  if (wasPrimary && dog.careTeam.length) [...dog.careTeam].sort((a, b) => a.since - b.since)[0].role = 'primary';
  await dog.save();
  res.status(204).end();
});

// "+ Invite neighbourhood caregiver": a code any caregiver can share, valid for a week.
router.post('/:id/invites', validate({ body: { role: z.enum(SELF_ROLES).optional() } }), async (req, res) => {
  const dog = await visibleDog(req.valid.params.id);
  if (!isCaregiver(dog, req.user)) throw forbidden('Only caregivers can invite people');
  const invite = await CareInvite.create({
    dog: dog._id,
    code: randomCode(8),
    role: req.valid.body.role ?? 'co_caregiver',
    createdBy: req.user._id,
    expiresAt: new Date(Date.now() + INVITE_DAYS * DAY),
  });
  res.status(201).json({
    code: invite.code,
    role: invite.role,
    expiresAt: invite.expiresAt,
    shareText: `Help look after ${dog.name ?? 'a community dog'} in ${dog.area}. Join the care team on Nurvia with code ${invite.code}.`,
  });
});

// How each member describes themselves on the team list ("Daily morning feeder").
router.patch('/:id/care-team/me', validate({ body: { title: z.string().trim().max(80).nullable() } }), async (req, res) => {
  const dog = await visibleDog(req.valid.params.id);
  const member = dog.careTeam.find((m) => String(m.user) === String(req.user._id));
  if (!member) throw forbidden('You are not on the care team');
  member.title = req.valid.body.title ?? undefined;
  await dog.save();
  res.json({ role: member.role, title: member.title ?? null });
});

// The primary caregiver (or staff) sets roles: vet, NGO, RWA, medical coordinator and so on.
router.put(
  '/:id/care-team/:userId',
  validate({ params: { userId: objectId }, body: { role: z.enum(CARE_ROLES), title: z.string().trim().max(80).optional() } }),
  async (req, res) => {
    const dog = await visibleDog(req.valid.params.id);
    if (!canManageTeam(dog, req.user)) throw forbidden('Only the primary caregiver can change roles');
    const { userId } = req.valid.params;
    const { role, title } = req.valid.body;
    if (!(await User.exists({ _id: userId, status: 'active' }))) throw notFound('User');
    // Bring members from before care-team roles into careTeam before editing it.
    for (const id of dog.caregivers) {
      if (!dog.careTeam.some((m) => String(m.user) === String(id))) dog.careTeam.push({ user: id, role: roleOf(dog, { _id: id }) });
    }
    if (role === 'primary') for (const m of dog.careTeam) if (m.role === 'primary') m.role = 'co_caregiver';
    const member = dog.careTeam.find((m) => String(m.user) === userId);
    if (member) Object.assign(member, { role, ...(title !== undefined && { title }) });
    else dog.careTeam.push({ user: userId, role, title });
    dog.caregivers.addToSet(userId);
    await dog.save();
    await User.updateOne({ _id: userId }, { $addToSet: { roles: ROLES.CAREGIVER } });
    res.json({ careTeam: dog.careTeam });
  },
);

router.delete('/:id/care-team/:userId', validate({ params: { userId: objectId } }), async (req, res) => {
  const dog = await visibleDog(req.valid.params.id);
  if (!canManageTeam(dog, req.user)) throw forbidden('Only the primary caregiver can remove people');
  if (req.valid.params.userId === String(req.user._id)) throw badRequest('Use DELETE /caregivers/me to leave');
  dog.caregivers.pull(req.valid.params.userId);
  dog.careTeam = dog.careTeam.filter((m) => String(m.user) !== req.valid.params.userId);
  await dog.save();
  res.status(204).end();
});

const STATUS_LOG = { missing: 'missing', fostered: 'fostered', adopted: 'adopted' };

// Missing, back on the street, fostered, adopted, in treatment... recorded on the care timeline.
router.post(
  '/:id/status',
  validate({ body: { currentStatus: z.enum(DOG_STATUSES), note: z.string().trim().max(1000).optional(), area: z.string().trim().max(160).optional(), at: z.coerce.date().optional() } }),
  async (req, res) => {
    const dog = await visibleDog(req.valid.params.id);
    if (!isCaregiver(dog, req.user)) throw forbidden('Only caregivers can change the status');
    const { currentStatus, note, area, at = new Date() } = req.valid.body;
    if (currentStatus === dog.currentStatus) throw conflict(`Already ${currentStatus.replace('_', ' ')}`);
    const type = dog.currentStatus === 'missing' && currentStatus === 'on_street' ? 'found' : STATUS_LOG[currentStatus] ?? 'status_change';
    dog.currentStatus = currentStatus;
    if (currentStatus === 'missing') dog.lastSeen = { at: dog.lastSeen?.at ?? at, area: area ?? dog.lastSeen?.area ?? dog.area };
    if (type === 'found') dog.lastSeen = { at, area: area ?? dog.area };
    dog.lastLogAt = at;
    await dog.save();
    const log = await CareLog.create({
      dog: dog._id,
      by: req.user._id,
      byRole: roleOf(dog, req.user),
      type,
      note: note ?? `Status: ${currentStatus.replace('_', ' ')}`,
      details: { currentStatus, ...(area && { area }) },
      at,
    });
    // Tell the rest of the care team when a dog goes missing or comes back.
    if (['missing', 'found'].includes(type)) {
      await notify(dog.caregivers.filter((id) => String(id) !== String(req.user._id)), {
        type: `community_dog.${type}`,
        title: type === 'missing' ? `${dog.name ?? 'A community dog'} is missing` : `${dog.name ?? 'A community dog'} is back`,
        body: note ?? area ?? dog.area,
        data: { dogId: String(dog._id) },
      });
    }
    res.json({ dog, log });
  },
);

// The care & activity log, filtered by category (feeding, medical, sightings, other), with counts
// for the filter chips. `after` returns only newer entries, for keeping an open screen up to date.
router.get(
  '/:id/logs',
  validate({ query: { ...pageQuery, category: z.enum(Object.keys(LOG_CATEGORIES)).optional(), after: z.coerce.date().optional() } }),
  async (req, res) => {
    const dog = await visibleDog(req.valid.params.id);
    const { page, limit, category, after } = req.valid.query;
    const filter = { dog: dog._id, ...(category && { type: { $in: LOG_CATEGORIES[category] } }), ...(after && { at: { $gt: after } }) };
    const [result, counts] = await Promise.all([
      paginate(CareLog, filter, { page, limit, sort: { at: -1 }, populate: { path: 'by', select: 'name avatarUrl' } }),
      logCounts(dog._id),
    ]);
    res.json({ ...result, items: result.items.map((l) => logView(l, req.user)), counts, syncedAt: new Date() });
  },
);

router.post(
  '/:id/logs',
  validate({
    body: {
      type: z.enum(CARE_LOG_TYPES.filter((t) => t !== 'status_change')),
      note: z.string().max(1000).optional(),
      photoFileIds: z.array(objectId).max(5).optional(),
      documentFileIds: z.array(objectId).max(5).optional(),
      details: z.record(z.union([z.string().max(300), z.number(), z.boolean()])).optional(),
      area: z.string().trim().max(160).optional(),
      at: z.coerce.date().optional(),
    },
  }),
  async (req, res) => {
    const dog = await visibleDog(req.valid.params.id);
    // Any signed-in user may report a sighting; other care activity is limited to caregivers.
    if (req.valid.body.type !== 'sighting' && !isCaregiver(dog, req.user)) throw forbidden('Join as a caregiver to log care activity');
    const { photoFileIds, documentFileIds, area, ...body } = req.valid.body;
    const byRole = roleOf(dog, req.user) ?? 'public';
    const documents = await attachmentsFor(req.user._id, documentFileIds, ['community', 'health_record']);
    // A record from an authority, with its certificate: verified at once when a vet or NGO on the team logs it.
    const authority = body.details?.authority;
    const official =
      authority && documents.length
        ? { authority: String(authority), reference: body.details.reference ? String(body.details.reference) : undefined, verified: ['vet', 'ngo'].includes(byRole) }
        : undefined;
    const log = await CareLog.create({
      ...body,
      dog: dog._id,
      by: req.user._id,
      byRole,
      photos: await attachmentsFor(req.user._id, photoFileIds, ['community']),
      documents,
      official,
    });

    const update = { lastLogAt: log.at };
    if (log.type === 'sighting') update.lastSeen = { at: log.at, area: area ?? dog.area };
    if (log.type === 'rabies_vaccination' && dog.vaccinationStatus === 'unknown') update.vaccinationStatus = 'partial';
    if (log.type === 'sterilized') update.sterilized = true;
    if (log.type === 'vaccinated' && dog.vaccinationStatus === 'unknown') update.vaccinationStatus = 'partial';
    await CommunityDog.updateOne({ _id: dog._id }, update);
    res.status(201).json(log);
  },
);

// A thumbs-up on a care entry; sending it again takes it back.
router.post('/:id/logs/:logId/thanks', validate({ params: { logId: objectId } }), async (req, res) => {
  const dog = await visibleDog(req.valid.params.id);
  const log = await CareLog.findOne({ _id: req.valid.params.logId, dog: dog._id });
  if (!log) throw notFound('Log entry');
  const thanked = log.thanks.some((id) => String(id) === String(req.user._id));
  if (thanked) log.thanks.pull(req.user._id);
  else log.thanks.addToSet(req.user._id);
  await log.save();
  res.json({ thanked: !thanked, thanksCount: log.thanks.length });
});

// Staff confirm an official record (certificate checked against the issuing authority).
router.post('/:id/logs/:logId/verify', validate({ params: { logId: objectId } }), async (req, res) => {
  if (!isStaff(req.user)) throw forbidden();
  const log = await CareLog.findOne({ _id: req.valid.params.logId, dog: req.valid.params.id });
  if (!log) throw notFound('Log entry');
  if (!log.official?.authority) throw badRequest('Only records from an authority can be verified');
  log.official.verified = true;
  log.official.verifiedBy = req.user._id;
  await log.save();
  res.json(log);
});

export default router;
