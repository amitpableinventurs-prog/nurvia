import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, can } from '../../common/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../../common/errors.js';
import { paginate } from '../../common/paginate.js';
import { PERMISSIONS } from '../../common/roles.js';
import { geoQuery, objectId, pageQuery, point, validate } from '../../common/validate.js';
import { audit } from '../audit/audit.model.js';
import { Category } from '../categories/category.model.js';
import { CommunityDog } from '../community-dogs/community-dog.model.js';
import { attachmentsFor } from '../files/file.routes.js';
import { notify } from '../notifications/notify.js';
import { Pet } from '../pets/pet.model.js';
import { Vendor } from '../vendors/vendor.model.js';
import { INCIDENT_STATUSES, INCIDENT_TYPES, RESOLUTION_OUTCOMES, RESPONDER_KINDS, SosIncident, SosResponder } from './sos.model.js';

const router = Router();
router.use(authenticate);

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => 'SOS' + Array.from(crypto.randomBytes(5), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
const ALERT_RADIUS_KM = { injured_animal: 5, other_emergency: 5, lost_pet: 3, found_pet: 3 };
const VET_RADIUS_KM = 10;
const LABELS = { injured_animal: 'Injured animal', lost_pet: 'Lost pet', found_pet: 'Found pet', other_emergency: 'Animal emergency' };
const within = (coordinates, km) => ({ $geoWithin: { $centerSphere: [coordinates, km / 6378.1] } });

// Who hears about a new incident: opted-in responders whose area covers it, caregivers of community
// dogs nearby, and the owners of vet clinics within reach (injuries only).
async function alertNearby(incident) {
  const coords = incident.location.coordinates;
  const radius = ALERT_RADIUS_KM[incident.type];
  const [responders, dogs, vets] = await Promise.all([
    SosResponder.find({ active: true, location: within(coords, 50) }).lean(),
    CommunityDog.find({ status: 'visible', location: within(coords, radius) }).select('caregivers').lean(),
    incident.type === 'injured_animal'
      ? Category.find({ kind: 'vendor', slug: { $in: ['vet-clinic', 'vet'] } })
          .distinct('_id')
          .then((ids) => Vendor.find({ status: 'active', categories: { $in: ids }, location: within(coords, VET_RADIUS_KM) }).select('owner').lean())
      : [],
  ]);
  const distanceKm = ([lng1, lat1], [lng2, lat2]) => {
    const rad = Math.PI / 180;
    const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(a));
  };
  const wanted = responders.filter((r) => (!r.types?.length || r.types.includes(incident.type)) && distanceKm(r.location.coordinates, coords) <= r.radiusKm);
  const ids = new Set([...wanted.map((r) => String(r.user)), ...dogs.flatMap((d) => d.caregivers.map(String)), ...vets.map((v) => String(v.owner))]);
  ids.delete(String(incident.reporter));
  await notify([...ids], {
    type: `sos.${incident.type}`,
    title: `${LABELS[incident.type]} reported nearby`,
    body: `${incident.area ? `${incident.area}: ` : ''}${incident.description.slice(0, 120)}`,
    data: { incidentId: String(incident._id), lat: coords[1], lng: coords[0] },
  });
  return ids.size;
}

const isResponder = (incident, user) => incident.responders.some((r) => String(r.user) === String(user._id) && r.status !== 'withdrawn');
const isReporter = (incident, user) => String(incident.reporter) === String(user._id);
const isStaff = (user) => can(user, PERMISSIONS.CONTENT_MODERATE);

// Incidents staff have hidden are left out everywhere except the admin views.
const PUBLIC = { 'moderation.hidden': { $ne: true } };

router.post(
  '/incidents',
  validate({
    body: {
      type: z.enum(INCIDENT_TYPES),
      description: z.string().trim().min(5).max(2000),
      location: point,
      area: z.string().trim().max(200).optional(),
      city: z.string().trim().max(80).optional(),
      species: z.enum(['dog', 'cat', 'bird', 'rabbit', 'other']).optional(),
      petId: objectId.optional(),
      communityDogId: objectId.optional(),
      lastSeenAt: z.coerce.date().optional(),
      contactPhone: z.string().trim().max(20).optional(),
      photoFileIds: z.array(objectId).max(6).optional(),
    },
  }),
  async (req, res) => {
    const { photoFileIds, petId, communityDogId, ...body } = req.valid.body;
    let pet;
    if (petId) {
      if (body.type !== 'lost_pet') throw badRequest('Only a lost-pet report links one of your pets');
      pet = await Pet.findOne({ _id: petId, owner: req.user._id, archivedAt: null });
      if (!pet) throw notFound('Pet');
    }
    if (communityDogId && !(await CommunityDog.exists({ _id: communityDogId, status: 'visible' }))) throw notFound('Community dog');
    const incident = await SosIncident.create({
      ...body,
      code: newCode(),
      reporter: req.user._id,
      pet: pet?._id,
      species: body.species ?? pet?.species ?? 'dog',
      communityDog: communityDogId,
      photos: await attachmentsFor(req.user._id, photoFileIds, ['sos', 'community', 'pet_photo']),
      updates: [{ by: req.user._id, status: 'open', note: 'Reported' }],
    });
    // A lost-pet report also switches the pet's tag profile into lost mode.
    if (pet && !pet.lost?.active) {
      pet.lost = { active: true, since: body.lastSeenAt ?? new Date(), lastSeenArea: body.area, note: body.description.slice(0, 500) };
      await pet.save();
    }
    incident.alertedCount = await alertNearby(incident);
    await incident.save();
    res.status(201).json(incident);
  },
);

router.get(
  '/incidents',
  validate({
    query: {
      ...geoQuery,
      ...pageQuery,
      type: z.enum(INCIDENT_TYPES).optional(),
      status: z.enum(INCIDENT_STATUSES).optional(),
      mine: z.enum(['true']).optional(),
    },
  }),
  async (req, res) => {
    const { lat, lng, radiusKm, page, limit, type, status, mine } = req.valid.query;
    const filter = {
      ...PUBLIC,
      ...(type && { type }),
      ...(mine ? { $or: [{ reporter: req.user._id }, { 'responders.user': req.user._id }] } : { status: status ?? { $in: ['open', 'accepted', 'help_on_way'] } }),
      ...(mine && status && { status }),
      ...(lat !== undefined && lng !== undefined && { location: within([lng, lat], radiusKm) }),
    };
    res.json(await paginate(SosIncident, filter, { page, limit, select: '-contactPhone', populate: { path: 'reporter', select: 'name' } }));
  },
);

router.get('/incidents/:id', validate(), async (req, res) => {
  const incident = await SosIncident.findOne({ _id: req.valid.params.id, ...PUBLIC })
    .populate('reporter', 'name')
    .populate('responders.user', 'name')
    .populate('pet', 'name species breed photo color')
    .lean();
  if (!incident) throw notFound('Incident');
  // The reporter's phone is for people actually helping.
  const helping = incident.responders.some((r) => String(r.user?._id) === String(req.user._id) && r.status !== 'withdrawn');
  if (!helping && String(incident.reporter._id) !== String(req.user._id) && !isStaff(req.user)) delete incident.contactPhone;
  res.json(incident);
});

// A responder takes the incident on. The first acceptance moves it from open to accepted.
router.post('/incidents/:id/respond', validate({ body: { kind: z.enum(RESPONDER_KINDS.filter((k) => k !== 'staff')).optional() } }), async (req, res) => {
  const incident = await SosIncident.findOne({ _id: req.valid.params.id, ...PUBLIC });
  if (!incident) throw notFound('Incident');
  if (['resolved', 'cancelled'].includes(incident.status)) throw conflict(`This incident is ${incident.status}`);
  if (isReporter(incident, req.user)) throw badRequest('You reported this incident');
  if (isResponder(incident, req.user)) throw conflict('You are already responding');
  const profile = await SosResponder.findOne({ user: req.user._id }).select('kind').lean();
  const existing = incident.responders.find((r) => String(r.user) === String(req.user._id));
  if (existing) existing.set({ status: 'accepted', at: new Date() });
  else incident.responders.push({ user: req.user._id, kind: req.valid.body.kind ?? profile?.kind ?? 'volunteer' });
  if (incident.status === 'open') incident.status = 'accepted';
  incident.updates.push({ by: req.user._id, status: incident.status, note: `${req.user.name ?? 'A responder'} is responding` });
  await incident.save();
  await notify([incident.reporter], { type: 'sos.accepted', title: 'Someone is responding to your report', body: incident.code, data: { incidentId: String(incident._id) } });
  res.json(incident);
});

router.post('/incidents/:id/withdraw', validate(), async (req, res) => {
  const incident = await SosIncident.findOne({ _id: req.valid.params.id, ...PUBLIC });
  if (!incident) throw notFound('Incident');
  const me = incident.responders.find((r) => String(r.user) === String(req.user._id) && r.status !== 'withdrawn');
  if (!me) throw conflict('You are not responding to this incident');
  me.status = 'withdrawn';
  if (!incident.responders.some((r) => r.status !== 'withdrawn') && ['accepted', 'help_on_way'].includes(incident.status)) incident.status = 'open';
  incident.updates.push({ by: req.user._id, status: incident.status, note: 'A responder withdrew' });
  await incident.save();
  res.json(incident);
});

const STATUS_RULES = {
  help_on_way: { from: ['accepted', 'help_on_way'], who: 'responder' },
  resolved: { from: ['open', 'accepted', 'help_on_way'], who: 'either' },
  cancelled: { from: ['open', 'accepted', 'help_on_way'], who: 'reporter' },
};

router.post(
  '/incidents/:id/status',
  validate({ body: { status: z.enum(Object.keys(STATUS_RULES)), outcome: z.enum(RESOLUTION_OUTCOMES).optional(), note: z.string().trim().max(1000).optional() } }),
  async (req, res) => {
    const incident = await SosIncident.findOne({ _id: req.valid.params.id, ...PUBLIC });
    if (!incident) throw notFound('Incident');
    const { status, outcome, note } = req.valid.body;
    const rule = STATUS_RULES[status];
    const allowed =
      isStaff(req.user) ||
      (rule.who === 'responder' && isResponder(incident, req.user)) ||
      (rule.who === 'reporter' && isReporter(incident, req.user)) ||
      (rule.who === 'either' && (isResponder(incident, req.user) || isReporter(incident, req.user)));
    if (!allowed) throw forbidden(`You cannot mark this incident as ${status.replace(/_/g, ' ')}`);
    if (!rule.from.includes(incident.status)) throw conflict(`Cannot move an incident from ${incident.status} to ${status}`);
    if (status === 'resolved' && !outcome) throw badRequest('Say how it was resolved (outcome)');

    incident.status = status;
    if (status === 'help_on_way') {
      const me = incident.responders.find((r) => String(r.user) === String(req.user._id));
      if (me) me.status = 'on_the_way';
    }
    if (status === 'resolved') incident.resolution = { outcome, note, by: req.user._id, at: new Date() };
    incident.updates.push({ by: req.user._id, status, note });
    await incident.save();

    if (['resolved', 'cancelled'].includes(status) && incident.pet && incident.type === 'lost_pet' && (outcome === 'reunited' || status === 'cancelled')) {
      await Pet.updateOne({ _id: incident.pet }, { lost: { active: false } });
    }
    const others = [incident.reporter, ...incident.responders.filter((r) => r.status !== 'withdrawn').map((r) => r.user)].filter((id) => String(id) !== String(req.user._id));
    await notify(others, {
      type: `sos.${status}`,
      title: { help_on_way: 'Help is on the way', resolved: 'Incident resolved', cancelled: 'Incident cancelled' }[status],
      body: [incident.code, note].filter(Boolean).join(' · '),
      data: { incidentId: String(incident._id) },
    });
    res.json(incident);
  },
);

router.post(
  '/incidents/:id/updates',
  validate({ body: { note: z.string().trim().min(1).max(1000), photoFileIds: z.array(objectId).max(4).optional() } }),
  async (req, res) => {
    const incident = await SosIncident.findOne({ _id: req.valid.params.id, ...PUBLIC });
    if (!incident) throw notFound('Incident');
    if (!isReporter(incident, req.user) && !isResponder(incident, req.user) && !isStaff(req.user)) throw forbidden('Only the reporter and responders can post updates');
    incident.updates.push({ by: req.user._id, note: req.valid.body.note, photos: await attachmentsFor(req.user._id, req.valid.body.photoFileIds, ['sos', 'community']) });
    await incident.save();
    res.status(201).json(incident.updates.at(-1));
  },
);

// Lost and found reports of the same species near each other, from around the same time.
router.get('/incidents/:id/matches', validate(), async (req, res) => {
  const incident = await SosIncident.findOne({ _id: req.valid.params.id, ...PUBLIC }).lean();
  if (!incident) throw notFound('Incident');
  const opposite = { lost_pet: 'found_pet', found_pet: 'lost_pet' }[incident.type];
  if (!opposite) return res.json([]);
  const since = new Date((incident.lastSeenAt ?? incident.createdAt).getTime() - 14 * 86_400_000);
  res.json(
    await SosIncident.find({
      ...PUBLIC,
      type: opposite,
      species: incident.species,
      status: { $nin: ['resolved', 'cancelled'] },
      createdAt: { $gte: since },
      location: within(incident.location.coordinates, 5),
    })
      .select('-contactPhone')
      .limit(20)
      .lean(),
  );
});

// ---- Responder opt-in ----

router.get('/responder', async (req, res) => {
  res.json(await SosResponder.findOne({ user: req.user._id }).lean());
});

router.put(
  '/responder',
  validate({
    body: {
      kind: z.enum(RESPONDER_KINDS.filter((k) => k !== 'staff')),
      organisation: z.string().trim().max(120).optional(),
      phone: z.string().trim().max(20).optional(),
      location: point,
      radiusKm: z.number().min(1).max(50).optional(),
      types: z.array(z.enum(INCIDENT_TYPES)).max(4).optional(),
      active: z.boolean().optional(),
    },
  }),
  async (req, res) => {
    const responder = await SosResponder.findOneAndUpdate(
      { user: req.user._id },
      { ...req.valid.body, user: req.user._id },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
    );
    res.json(responder);
  },
);

router.delete('/responder', async (req, res) => {
  await SosResponder.deleteOne({ user: req.user._id });
  res.status(204).end();
});

export default router;

// ---- Admin oversight (mounted at /admin/sos) ----

export const adminSosRouter = Router();

adminSosRouter.get(
  '/incidents',
  validate({ query: { ...pageQuery, type: z.enum(INCIDENT_TYPES).optional(), status: z.enum(INCIDENT_STATUSES).optional(), hidden: z.enum(['true', 'false']).optional() } }),
  async (req, res) => {
    const { page, limit, type, status, hidden } = req.valid.query;
    const filter = { ...(type && { type }), ...(status && { status }), ...(hidden && { 'moderation.hidden': hidden === 'true' ? true : { $ne: true } }) };
    res.json(await paginate(SosIncident, filter, { page, limit, populate: [{ path: 'reporter', select: 'name phone' }] }));
  },
);

adminSosRouter.post(
  '/incidents/:id/moderate',
  validate({ body: { action: z.enum(['hide', 'unhide', 'close']), reason: z.string().trim().min(3).max(300) } }),
  async (req, res) => {
    const incident = await SosIncident.findById(req.valid.params.id);
    if (!incident) throw notFound('Incident');
    const { action, reason } = req.valid.body;
    if (action === 'close') {
      if (['resolved', 'cancelled'].includes(incident.status)) throw conflict(`Already ${incident.status}`);
      incident.status = 'resolved';
      incident.resolution = { outcome: 'other', note: reason, by: req.user._id, at: new Date() };
    }
    incident.moderation = { ...incident.toObject().moderation, by: req.user._id, at: new Date(), reason, ...(action !== 'close' && { hidden: action === 'hide' }) };
    incident.updates.push({ by: req.user._id, status: incident.status, note: `Staff: ${action}` });
    await incident.save();
    await audit(req, `sos.${action}`, { type: 'sos_incident', id: incident._id }, { reason });
    res.json(incident);
  },
);

adminSosRouter.get('/responders', validate({ query: { ...pageQuery, kind: z.enum(RESPONDER_KINDS).optional() } }), async (req, res) => {
  const { page, limit, kind } = req.valid.query;
  res.json(await paginate(SosResponder, { ...(kind && { kind }) }, { page, limit, populate: { path: 'user', select: 'name phone' } }));
});
