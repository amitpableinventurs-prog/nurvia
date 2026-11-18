import { CareLog, CommunityDog } from './community-dog.model.js';

const DAY = 86_400_000;

// Dogs a caregiver looks after that need attention, from the care timeline: not fed lately, rabies
// vaccination or deworming missing or overdue, sterilisation not done or not known, or marked missing.
// Used by GET /community-dogs/due-care and the AI assistant's community-dog answers.
export async function dueCareFor(userId, now = Date.now()) {
  const dogs = await CommunityDog.find({ status: 'visible', caregivers: userId, currentStatus: { $nin: ['adopted', 'deceased', 'relocated'] } })
    .select('name nickname identifier area sterilized earNotch vaccinationStatus currentStatus lastSeen photos')
    .lean();
  if (!dogs.length) return [];
  const last = await CareLog.aggregate([
    { $match: { dog: { $in: dogs.map((d) => d._id) }, type: { $in: ['fed', 'vaccinated', 'rabies_vaccination', 'dewormed'] } } },
    { $group: { _id: { dog: '$dog', type: '$type' }, at: { $max: '$at' } } },
  ]);
  const lastAt = (dog, ...types) => Math.max(0, ...last.filter((r) => String(r._id.dog) === String(dog._id) && types.includes(r._id.type)).map((r) => r.at.getTime()));
  return dogs
    .map((dog) => {
      const due = [];
      if (dog.currentStatus === 'missing') due.push({ key: 'missing', label: 'Marked missing', since: dog.lastSeen?.at });
      const fed = lastAt(dog, 'fed');
      if (now - fed > 2 * DAY) due.push({ key: 'feeding', label: fed ? 'Not fed in over 2 days' : 'No feeding logged yet', lastAt: fed ? new Date(fed) : null });
      const rabies = lastAt(dog, 'rabies_vaccination', 'vaccinated');
      if (now - rabies > 365 * DAY) due.push({ key: 'rabies', label: rabies ? 'Rabies vaccination over a year ago' : 'No rabies vaccination recorded', lastAt: rabies ? new Date(rabies) : null });
      const dewormed = lastAt(dog, 'dewormed');
      if (now - dewormed > 90 * DAY) due.push({ key: 'deworming', label: dewormed ? 'Deworming over 3 months ago' : 'No deworming recorded', lastAt: dewormed ? new Date(dewormed) : null });
      if (!dog.sterilized) {
        due.push(dog.earNotch === 'intact' ? { key: 'sterilisation', label: 'Not sterilised' } : { key: 'sterilisation_unknown', label: 'Sterilisation status unknown' });
      }
      return { dog, due };
    })
    .filter((d) => d.due.length);
}
