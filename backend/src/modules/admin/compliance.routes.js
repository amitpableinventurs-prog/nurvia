import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../common/auth.js';
import { badRequest, conflict, notFound } from '../../common/errors.js';
import { PERMISSIONS } from '../../common/roles.js';
import { validate } from '../../common/validate.js';
import { AdoptionApplication, AdoptionListing } from '../adoption/adoption.model.js';
import { audit } from '../audit/audit.model.js';
import { CommunityDog } from '../community-dogs/community-dog.model.js';
import { notify } from '../notifications/notify.js';

const router = Router();
router.use(requirePermission(PERMISSIONS.CONTENT_MODERATE));

// ---- Community dog badge ----

router.post(
  '/community-dogs/:id/verification',
  validate({ body: { action: z.enum(['approve', 'request_changes']), note: z.string().trim().max(500).optional() } }),
  async (req, res) => {
    const { action, note } = req.valid.body;
    if (action === 'request_changes' && !note) throw badRequest('Say what the caregiver needs to change');
    const dog = await CommunityDog.findOne({ _id: req.valid.params.id, status: 'visible' });
    if (!dog) throw notFound('Community dog');

    const status = action === 'approve' ? 'verified' : 'changes_requested';
    dog.verification = { status, note, by: req.user._id, at: new Date() };
    await dog.save();
    await audit(req, `community_dog.${status}`, { type: 'community_dog', id: dog._id }, { reason: note });
    await notify([dog.createdBy], {
      type: 'community_dog.verification',
      title: action === 'approve' ? `${dog.name ?? 'Your community dog'} now has the community badge` : `${dog.name ?? 'Your community dog'}'s profile needs changes`,
      body: note,
      data: { communityDogId: String(dog._id) },
    });
    res.json(dog);
  },
);

// ---- Adoption compliance ----

// Pets that must be microchipped before an adoption is certified.
const CHIP_REQUIRED = ['dog', 'cat'];

router.post(
  '/adoption/applications/:id/compliance',
  validate({
    body: {
      action: z.enum(['home_check', 'schedule_microchip', 'request_info', 'certify']),
      result: z.enum(['passed', 'failed']).optional(),
      scheduledAt: z.coerce.date().optional(),
      chipId: z.string().trim().regex(/^\d{9,15}$/, 'A microchip number has 9 to 15 digits').optional(),
      note: z.string().trim().max(500).optional(),
    },
  }),
  async (req, res) => {
    const { action, result, scheduledAt, chipId, note } = req.valid.body;
    const application = await AdoptionApplication.findById(req.valid.params.id);
    if (!application) throw notFound('Application');
    if (application.status !== 'approved') throw conflict('Only adopters the lister has approved go through compliance');
    if (application.compliance?.status === 'certified') throw conflict('This adoption is already certified');
    const listing = await AdoptionListing.findById(application.listing);
    if (!listing) throw notFound('Listing');

    const c = application.compliance;
    const parties = [application.applicant, application.lister];

    if (action === 'home_check') {
      if (!result) throw badRequest('Record whether the home check passed or failed');
      if (result === 'failed' && !note) throw badRequest('Say why the home check failed');
      c.homeCheck = { status: result, note, by: req.user._id, at: new Date() };
    } else if (action === 'schedule_microchip') {
      if (!scheduledAt && !chipId) throw badRequest('Give an appointment time or the implanted chip number');
      c.microchip = { scheduledAt: scheduledAt ?? c.microchip?.scheduledAt, chipId: chipId ?? c.microchip?.chipId };
    } else if (action === 'request_info') {
      if (!note) throw badRequest('Say what information is missing');
      c.status = 'info_requested';
      c.note = note;
      await notify(parties, { type: 'adoption.compliance', title: `More information needed for ${listing.name}'s adoption`, body: note, data: { applicationId: String(application._id) } });
    } else {
      const missing = [];
      if (c.homeCheck?.status !== 'passed') missing.push('a passed home check');
      if (CHIP_REQUIRED.includes(listing.species) && !c.microchip?.scheduledAt && !c.microchip?.chipId) missing.push('a microchip appointment');
      if (missing.length) throw conflict(`Certification needs ${missing.join(' and ')}`);
      c.status = 'certified';
      c.note = note;
      c.certifiedBy = req.user._id;
      c.certifiedAt = new Date();
    }
    await application.save();

    if (action === 'certify') {
      listing.status = 'adopted';
      await listing.save();
      await AdoptionApplication.updateMany(
        { listing: listing._id, _id: { $ne: application._id }, status: { $in: ['submitted', 'shortlisted'] } },
        { status: 'rejected', statusNote: 'Listing adopted' },
      );
      await notify(parties, { type: 'adoption.certified', title: `${listing.name}'s adoption is certified`, body: note, data: { applicationId: String(application._id), listingId: String(listing._id) } });
    }
    await audit(req, `adoption.${action}`, { type: 'adoption_application', id: application._id }, { reason: note, meta: { result, scheduledAt, chipId } });
    res.json(application);
  },
);

export default router;
