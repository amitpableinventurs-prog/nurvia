import { HealthRecord, Reminder } from './pet.model.js';

const DAY = 86_400_000;

// Core vaccines checked by the care status, matched loosely on the record title owners type.
const CORE_VACCINES = {
  dog: [
    { key: 'rabies', label: 'Rabies', match: /rabies|\barv\b/i },
    { key: 'dhpp', label: 'DHPP (distemper combination)', match: /dhpp|da2pp|dhlpp|distemper|parvo|\b[5-9]\s*-?in\s*-?1\b/i },
  ],
  cat: [
    { key: 'rabies', label: 'Rabies', match: /rabies/i },
    { key: 'fvrcp', label: 'FVRCP (feline combination)', match: /fvrcp|tricat|panleuk|rhinotracheitis|\b[3-4]\s*-?in\s*-?1\b/i },
  ],
};

// What is recorded, due and missing for a pet's core care. Rule-based, from the owner's own
// records. `verified` marks records that came from a clinic (RecordShare) rather than the owner.
export async function careStatus(pet, { withReminders = true } = {}) {
  const now = new Date();
  const [records, reminders] = await Promise.all([
    HealthRecord.find({ pet: pet._id, type: { $in: ['vaccination', 'deworming'] } }).sort({ date: -1 }).lean(),
    withReminders ? Reminder.find({ pet: pet._id, completedAt: null }).sort({ dueAt: 1 }).lean() : [],
  ]);
  const vaccinations = records.filter((r) => r.type === 'vaccination');
  const statusOf = (latest) => {
    if (!latest) return 'missing';
    if (latest.nextDueDate && latest.nextDueDate < now) return 'overdue';
    if (latest.nextDueDate && latest.nextDueDate < new Date(now.getTime() + 30 * DAY)) return 'due_soon';
    return 'recorded';
  };
  const core = (CORE_VACCINES[pet.species] ?? []).map(({ key, label, match }) => {
    const latest = vaccinations.find((r) => match.test(r.title));
    return {
      key,
      label,
      status: statusOf(latest),
      verified: latest?.source === 'clinic',
      lastDate: latest?.date ?? null,
      nextDueDate: latest?.nextDueDate ?? null,
      recordId: latest?._id ?? null,
    };
  });
  const lastDeworming = records.find((r) => r.type === 'deworming');
  return {
    pet: { _id: pet._id, name: pet.name, species: pet.species },
    coreVaccines: core,
    otherVaccinations: vaccinations
      .filter((r) => !core.some((c) => String(c.recordId) === String(r._id)))
      .map((r) => ({ title: r.title, date: r.date, nextDueDate: r.nextDueDate ?? null, status: statusOf(r), verified: r.source === 'clinic' })),
    deworming: { status: statusOf(lastDeworming), verified: lastDeworming?.source === 'clinic', lastDate: lastDeworming?.date ?? null, nextDueDate: lastDeworming?.nextDueDate ?? null },
    ...(withReminders && {
      reminders: {
        overdue: reminders.filter((r) => r.dueAt < now),
        upcoming: reminders.filter((r) => r.dueAt >= now && r.dueAt < new Date(now.getTime() + 30 * DAY)),
      },
    }),
    allergies: pet.allergies ?? [],
    conditions: pet.conditions ?? [],
    disclaimer: 'This summary is based on records you have added. It is not a substitute for advice from a veterinarian.',
  };
}

// Whether every core vaccine and deworming is on record and not overdue ("vaccines & deworming valid").
export const careUpToDate = (status) => [...status.coreVaccines, status.deworming].every((c) => ['recorded', 'due_soon'].includes(c.status));

// Age in whole months, from the date of birth or the approximate age given for rescues.
export function ageMonths(pet, now = new Date()) {
  if (pet.dateOfBirth) {
    const dob = new Date(pet.dateOfBirth);
    return Math.max(0, (now.getUTCFullYear() - dob.getUTCFullYear()) * 12 + now.getUTCMonth() - dob.getUTCMonth() - (now.getUTCDate() < dob.getUTCDate() ? 1 : 0));
  }
  return pet.approxAgeMonths ?? null;
}
