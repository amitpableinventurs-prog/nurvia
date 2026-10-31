import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../common/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../../common/errors.js';
import { paginate } from '../../common/paginate.js';
import { escapeRegex, objectId, pageQuery, partialShape, point, validate } from '../../common/validate.js';
import { CommunityDog } from '../community-dogs/community-dog.model.js';
import { attachmentsFor } from '../files/file.routes.js';
import { notify } from '../notifications/notify.js';
import { SPECIES } from '../pets/pet.model.js';
import { APPLICATION_STATUSES, AdoptionApplication, AdoptionListing, SavedListing, adoptionStage } from './adoption.model.js';

const router = Router();
router.use(authenticate);

const listingBody = {
  name: z.string().trim().min(1).max(60),
  species: z.enum(SPECIES),
  breed: z.string().max(80).optional(),
  sex: z.enum(['male', 'female', 'unknown']).optional(),
  ageMonths: z.number().int().min(0).max(300).optional(),
  description: z.string().trim().min(20).max(3000),
  photoFileIds: z.array(objectId).min(1).max(10),
  vaccinated: z.boolean().optional(),
  vaccinationDetails: z.string().max(500).optional(),
  sterilized: z.boolean().optional(),
  dewormed: z.boolean().optional(),
  locality: z.string().trim().max(80).optional(),
  // The lister is fostering the animal while it waits ("Fostered in Indiranagar").
  foster: z.object({ locality: z.string().trim().max(80).optional(), note: z.string().trim().max(300).optional() }).nullable().optional(),
  temperament: z.string().max(500).optional(),
  healthNotes: z.string().max(1000).optional(),
  specialNeeds: z.string().max(500).optional(),
  requirements: z.string().max(1000).optional(),
  city: z.string().trim().min(1).max(80),
  location: point.optional(),
  communityDogId: objectId.optional(),
};

async function listingFields(userId, { photoFileIds, communityDogId, foster, ...body }) {
  const fields = { ...body };
  if (foster === null) fields.foster = { active: false };
  else if (foster) fields.foster = { active: true, by: userId, since: new Date(), ...foster };
  if (photoFileIds) fields.photos = await attachmentsFor(userId, photoFileIds, ['adoption', 'community', 'pet_photo']);
  if (communityDogId) {
    if (!(await CommunityDog.exists({ _id: communityDogId, caregivers: userId }))) throw badRequest('Only a caregiver can list a community dog');
    fields.communityDog = communityDogId;
  }
  return fields;
}

async function ownListing(req) {
  const listing = await AdoptionListing.findOne({ _id: req.valid.params.id, postedBy: req.user._id });
  if (!listing) throw notFound('Listing');
  return listing;
}

router.get(
  '/listings',
  validate({ query: { ...pageQuery, city: z.string().trim().max(80).optional(), species: z.enum(SPECIES).optional(), mine: z.enum(['true']).optional() } }),
  async (req, res) => {
    const { page, limit, city, species, mine } = req.valid.query;
    const filter = mine
      ? { postedBy: req.user._id }
      : {
          status: 'open',
          ...(city && { city: { $regex: `^${escapeRegex(city)}$`, $options: 'i' } }),
          ...(species && { species }),
        };
    const result = await paginate(AdoptionListing, filter, { page, limit, select: '-moderation' });
    res.json({ ...result, items: await withStage(result.items) });
  },
);

// Adds the adoption stage (available, application received, under discussion, adopted, closed).
async function withStage(listings) {
  if (!listings.length) return listings;
  const rows = await AdoptionApplication.aggregate([
    { $match: { listing: { $in: listings.map((l) => l._id) }, status: { $in: ['shortlisted', 'approved'] } } },
    { $group: { _id: '$listing', n: { $sum: 1 } } },
  ]);
  const shortlisted = new Map(rows.map((r) => [String(r._id), r.n]));
  return listings.map((l) => ({ ...l, stage: adoptionStage(l, { shortlisted: shortlisted.get(String(l._id)) ?? 0 }) }));
}

router.post('/listings', validate({ body: listingBody }), async (req, res) => {
  const listing = await AdoptionListing.create({ ...(await listingFields(req.user._id, req.valid.body)), postedBy: req.user._id });
  res.status(201).json(listing);
});

router.get('/listings/:id', validate(), async (req, res) => {
  const listing = await AdoptionListing.findById(req.valid.params.id).populate('postedBy', 'name avatarUrl').lean();
  const isOwner = listing && String(listing.postedBy._id) === String(req.user._id);
  if (!listing || (!isOwner && !['open', 'on_hold', 'adopted'].includes(listing.status))) throw notFound('Listing');
  const myApplication = isOwner ? null : await AdoptionApplication.findOne({ listing: listing._id, applicant: req.user._id }).lean();
  const [withStageListing] = await withStage([listing]);
  res.json({ ...withStageListing, moderation: isOwner ? listing.moderation : undefined, myApplication });
});

// Editing an open listing sends it back for review, so approved content cannot be swapped afterwards.
router.patch('/listings/:id', validate({ body: partialShape(listingBody) }), async (req, res) => {
  const listing = await ownListing(req);
  if (['adopted', 'closed', 'removed'].includes(listing.status)) throw conflict(`A ${listing.status} listing cannot be edited`);
  listing.set(await listingFields(req.user._id, req.valid.body));
  if (['open', 'on_hold', 'rejected'].includes(listing.status)) listing.status = 'pending_review';
  res.json(await listing.save());
});

const OWNER_STATUS_CHANGES = { open: ['on_hold', 'adopted', 'closed'], on_hold: ['open', 'adopted', 'closed'], pending_review: ['closed'], rejected: ['closed'] };

router.post('/listings/:id/status', validate({ body: { status: z.enum(['open', 'on_hold', 'adopted', 'closed']) } }), async (req, res) => {
  const listing = await ownListing(req);
  const { status } = req.valid.body;
  if (!OWNER_STATUS_CHANGES[listing.status]?.includes(status)) throw conflict(`Cannot move a ${listing.status} listing to ${status}`);
  listing.status = status;
  await listing.save();
  if (['adopted', 'closed'].includes(status)) {
    await AdoptionApplication.updateMany(
      { listing: listing._id, status: { $in: ['submitted', 'shortlisted'] } },
      { status: 'rejected', statusNote: `Listing ${status}` },
    );
  }
  res.json(listing);
});

router.post(
  '/listings/:id/applications',
  validate({
    body: {
      message: z.string().trim().min(10).max(2000),
      home: z
        .object({
          type: z.enum(['apartment', 'independent_house', 'farm', 'other']).optional(),
          hasOtherPets: z.boolean().optional(),
          hasChildren: z.boolean().optional(),
          experience: z.string().max(1000).optional(),
        })
        .optional(),
      contactPhone: z.string().max(20).optional(),
    },
  }),
  async (req, res) => {
    const listing = await AdoptionListing.findOne({ _id: req.valid.params.id, status: 'open' });
    if (!listing) throw notFound('Listing');
    if (String(listing.postedBy) === String(req.user._id)) throw badRequest('You cannot apply to your own listing');
    const application = await AdoptionApplication.create({ ...req.valid.body, listing: listing._id, lister: listing.postedBy, applicant: req.user._id });
    await AdoptionListing.updateOne({ _id: listing._id }, { $inc: { applicationCount: 1 } });
    await notify([listing.postedBy], {
      type: 'adoption.application',
      title: `New adoption application for ${listing.name}`,
      data: { listingId: String(listing._id), applicationId: String(application._id) },
    });
    res.status(201).json(application);
  },
);

router.get('/listings/:id/applications', validate({ query: pageQuery }), async (req, res) => {
  const listing = await ownListing(req);
  const { page, limit } = req.valid.query;
  res.json(await paginate(AdoptionApplication, { listing: listing._id }, { page, limit, populate: { path: 'applicant', select: 'name phone avatarUrl' } }));
});

router.get('/applications/mine', validate({ query: pageQuery }), async (req, res) => {
  const { page, limit } = req.valid.query;
  res.json(await paginate(AdoptionApplication, { applicant: req.user._id }, { page, limit, populate: { path: 'listing', select: 'name species city status photos' } }));
});

// The lister moves applications through review; the applicant can only withdraw.
router.patch(
  '/applications/:id',
  validate({ body: { status: z.enum(APPLICATION_STATUSES.filter((s) => s !== 'submitted')), note: z.string().max(500).optional() } }),
  async (req, res) => {
    const application = await AdoptionApplication.findById(req.valid.params.id);
    if (!application) throw notFound('Application');
    const { status, note } = req.valid.body;
    const isLister = String(application.lister) === String(req.user._id);
    const isApplicant = String(application.applicant) === String(req.user._id);
    if (status === 'withdrawn' ? !isApplicant : !isLister) throw forbidden();
    if (['approved', 'rejected', 'withdrawn'].includes(application.status)) throw conflict(`Application is already ${application.status}`);

    application.status = status;
    application.statusNote = note;
    await application.save();
    await notify([isLister ? application.applicant : application.lister], {
      type: 'adoption.application_status',
      title: `Adoption application ${status}`,
      data: { applicationId: String(application._id), listingId: String(application.listing) },
    });
    res.json(application);
  },
);

// ---- Adoption Browse ----

// The filter chips.
const BROWSE_GROUPS = {
  all: {},
  young: { ageMonths: { $lt: 12 } }, // puppies and kittens
  adult_dogs: { species: 'dog', ageMonths: { $gte: 12 } },
  cats: { species: 'cat' },
  special_needs: { specialNeeds: { $nin: [null, ''] } },
};
const BROWSE_RADII = [10, 25, 50, 100];
const INDIE = /\b(indie|indian|native|desi|community)\b/i;

// "Preeti M." rather than a full name on a public card.
const shortName = (name) => {
  const [first, ...rest] = String(name ?? '').trim().split(/\s+/);
  return first ? `${first}${rest.length ? ` ${rest.at(-1)[0]}.` : ''}` : null;
};

function ageLabel({ ageMonths, species }) {
  if (ageMonths === undefined || ageMonths === null) return null;
  if (ageMonths < 12) return `${species === 'cat' ? 'Kitten' : species === 'dog' ? 'Puppy' : 'Young'} · ${ageMonths} mo${ageMonths === 1 ? '' : 's'}`;
  const years = Math.floor(ageMonths / 12);
  return `Adult · ${years} yr${years === 1 ? '' : 's'}`;
}

// One card on Adoption Browse. An open listing has passed Nurvia's review, so its foster has too.
const listingCard = (l, { saved, application }) => ({
  _id: l._id,
  name: l.name,
  species: l.species,
  breed: l.breed ?? null,
  sex: l.sex,
  ageMonths: l.ageMonths ?? null,
  ageLabel: ageLabel(l),
  stage: l.stage,
  photo: l.photos?.[0]?.url ?? null,
  photoCount: l.photos?.length ?? 0,
  health: { vaccinated: l.vaccinated ?? null, vaccinationDetails: l.vaccinationDetails ?? null, dewormed: l.dewormed ?? null, sterilized: l.sterilized ?? null },
  temperament: l.temperament ?? null,
  specialNeeds: l.specialNeeds ?? null,
  city: l.city,
  locality: l.locality ?? null,
  foster: l.foster?.active ? { name: shortName(l.postedBy?.name), locality: l.foster.locality ?? l.locality ?? null, reviewedByNurvia: ['open', 'on_hold', 'adopted'].includes(l.status) } : null,
  hasRequirements: Boolean(l.requirements),
  saved,
  myApplication: application ? { _id: application._id, status: application.status } : null,
});

async function cardsFor(listings, user) {
  const ids = listings.map((l) => l._id);
  const [saved, applications, staged] = await Promise.all([
    SavedListing.find({ user: user._id, listing: { $in: ids } }).select('listing').lean(),
    AdoptionApplication.find({ applicant: user._id, listing: { $in: ids } }).select('listing status').lean(),
    withStage(listings),
  ]);
  const savedIds = new Set(saved.map((s) => String(s.listing)));
  const appOf = new Map(applications.map((a) => [String(a.listing), a]));
  return staged.map((l) => listingCard(l, { saved: savedIds.has(String(l._id)), application: appOf.get(String(l._id)) }));
}

router.get(
  '/browse',
  validate({
    query: {
      ...pageQuery,
      lat: z.coerce.number().min(-90).max(90).optional(),
      lng: z.coerce.number().min(-180).max(180).optional(),
      radiusKm: z.coerce.number().positive().max(100).default(25),
      city: z.string().trim().max(80).optional(),
      // Species, breed, name or locality.
      q: z.string().trim().max(80).optional(),
      group: z.enum(Object.keys(BROWSE_GROUPS)).default('all'),
    },
  }),
  async (req, res) => {
    const { page, limit, lat, lng, radiusKm, city, q, group } = req.valid.query;
    const near = lat !== undefined && lng !== undefined;
    const place = near
      ? { location: { $geoWithin: { $centerSphere: [[lng, lat], radiusKm / 6378.1] } } }
      : city
        ? { city: { $regex: `^${escapeRegex(city)}$`, $options: 'i' } }
        : {};
    const base = { status: 'open', ...place };
    const pattern = q && { $regex: escapeRegex(q), $options: 'i' };
    const species = q && SPECIES.find((s) => q.toLowerCase().replace(/s$/, '') === s);
    const search = pattern ? { $or: [{ name: pattern }, { breed: pattern }, { locality: pattern }, { city: pattern }, ...(species ? [{ species }] : [])] } : {};
    const filter = { ...base, ...BROWSE_GROUPS[group], ...search };

    const [result, rescuesNearby] = await Promise.all([
      paginate(AdoptionListing, filter, { page, limit, sort: { createdAt: -1 }, select: '-moderation', populate: { path: 'postedBy', select: 'name' } }),
      AdoptionListing.countDocuments(base),
    ]);
    let emptyState = null;
    if (!result.total) {
      const nextRadius = near && BROWSE_RADII.find((r) => r > radiusKm);
      emptyState = {
        query: q ?? null,
        // Commercial breeding is not allowed on Nurvia, so a pedigree search often finds nothing:
        // point to the indie dogs and cats waiting nearby instead.
        indieNearby: await AdoptionListing.countDocuments({ ...base, breed: INDIE }),
        broaden: nextRadius ? { radiusKm: nextRadius } : q || group !== 'all' ? { clearFilters: true } : null,
      };
    }
    res.json({ ...result, items: await cardsFor(result.items, req.user), rescuesNearby, radiusKm: near ? radiusKm : null, emptyState });
  },
);

// The heart on a card.
router.put('/listings/:id/save', validate(), async (req, res) => {
  if (!(await AdoptionListing.exists({ _id: req.valid.params.id, status: { $in: ['open', 'on_hold'] } }))) throw notFound('Listing');
  await SavedListing.updateOne({ user: req.user._id, listing: req.valid.params.id }, { $setOnInsert: { user: req.user._id, listing: req.valid.params.id } }, { upsert: true });
  res.json({ saved: true });
});

router.delete('/listings/:id/save', validate(), async (req, res) => {
  await SavedListing.deleteOne({ user: req.user._id, listing: req.valid.params.id });
  res.json({ saved: false });
});

// Saved animals still looking for a home (adopted or closed ones drop out).
router.get('/saved', validate({ query: pageQuery }), async (req, res) => {
  const { page, limit } = req.valid.query;
  const saved = await SavedListing.find({ user: req.user._id }).select('listing').lean();
  const result = await paginate(
    AdoptionListing,
    { _id: { $in: saved.map((s) => s.listing) }, status: { $in: ['open', 'on_hold'] } },
    { page, limit, select: '-moderation', populate: { path: 'postedBy', select: 'name' } },
  );
  res.json({ ...result, items: await cardsFor(result.items, req.user) });
});

export default router;
