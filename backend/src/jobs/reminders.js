import { runWithTenant } from '../common/tenancy.js';
import { sendAppointmentReminders } from '../modules/bookings/booking.service.js';
import { notify } from '../modules/notifications/notify.js';
import { Pet, Reminder } from '../modules/pets/pet.model.js';
import { expireUnpaidOrders } from '../modules/shop/shop.service.js';
import { Tenant } from '../modules/tenants/tenant.model.js';

const INTERVAL_MS = 60_000;
const MAX_PER_TICK = 500;

function nextDue(date, repeat) {
  const next = new Date(date);
  if (repeat === 'daily') next.setUTCDate(next.getUTCDate() + 1);
  else if (repeat === 'weekly') next.setUTCDate(next.getUTCDate() + 7);
  else if (repeat === 'monthly') next.setUTCMonth(next.getUTCMonth() + 1);
  else if (repeat === 'yearly') next.setUTCFullYear(next.getUTCFullYear() + 1);
  else return null;
  return next;
}

// Each reminder is claimed with an atomic update before it is sent, so running several API
// instances never delivers the same reminder twice.
async function dispatchForTenant() {
  const now = new Date();
  for (let i = 0; i < MAX_PER_TICK; i++) {
    const reminder = await Reminder.findOneAndUpdate(
      { dueAt: { $lte: now }, sentAt: null, completedAt: null },
      { sentAt: now },
      { sort: { dueAt: 1 }, new: true },
    ).lean();
    if (!reminder) return;

    const pet = await Pet.findById(reminder.pet).select('name').lean();
    await notify([reminder.owner], {
      type: 'reminder.due',
      title: reminder.title,
      body: pet ? `Reminder for ${pet.name}` : undefined,
      data: { reminderId: String(reminder._id), petId: String(reminder.pet) },
    });

    const next = nextDue(reminder.dueAt, reminder.repeat);
    if (next) await Reminder.updateOne({ _id: reminder._id }, { dueAt: next, $unset: { sentAt: 1 } });
  }
}

export async function dispatchDueReminders() {
  const tenants = await Tenant.find({ status: 'active' }).select('slug').lean();
  for (const { slug } of tenants) {
    await runWithTenant(slug, async () => {
      await dispatchForTenant();
      await expireUnpaidOrders();
      await sendAppointmentReminders(MAX_PER_TICK);
    });
  }
}

export function startReminderJob() {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await dispatchDueReminders();
    } catch (err) {
      console.error('[jobs:reminders]', err);
    } finally {
      running = false;
    }
  }, INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
