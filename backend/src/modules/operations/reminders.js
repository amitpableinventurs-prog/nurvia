import { formatLocalTime } from '../../common/time.js';
import { notify } from '../notifications/notify.js';
import { Vendor } from '../vendors/vendor.model.js';
import { Appointment, CrmNote, REMINDER_DEFAULTS, VendorCustomer, VendorStaff } from './operations.model.js';

const HOUR = 3_600_000;
const MAX_LEAD_HOURS = 72;
const when = (date) => `${date.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}, ${formatLocalTime(date)}`;

const settingsOf = (vendor) => ({ ...REMINDER_DEFAULTS, ...Object.fromEntries(Object.entries(vendor?.reminderSettings ?? {}).filter(([, v]) => v !== undefined && v !== null)) });

// Reminders for the business's own appointments (entered in the workspace) and CRM follow-ups, on
// each business's settings (PUT /vendors/me/reminder-settings). Run every minute by jobs/reminders.js.
//  - customers who have the Nurvia app: N hours before (customers without it have no channel yet:
//    SMS needs a provider, see README);
//  - the staff member doing the appointment: N minutes before;
//  - the author of a CRM note when its follow-up date arrives.
// Nurvia bookings have their own reminder (bookings/booking.service.js).
export async function sendWorkspaceReminders(limit = 500, now = new Date()) {
  const appointments = await Appointment.find({
    status: { $in: ['scheduled', 'confirmed'] },
    scheduledAt: { $gt: now, $lte: new Date(now.getTime() + MAX_LEAD_HOURS * HOUR) },
  })
    .select('vendor customer staff scheduledAt serviceName petName remindersSent')
    .sort({ scheduledAt: 1 })
    .limit(limit)
    .lean();

  const vendors = new Map(
    (await Vendor.find({ _id: { $in: [...new Set(appointments.map((a) => String(a.vendor)))] } }).select('businessName reminderSettings').lean()).map((v) => [String(v._id), v]),
  );

  for (const a of appointments) {
    const vendor = vendors.get(String(a.vendor));
    const settings = settingsOf(vendor);
    const left = a.scheduledAt - now;
    const sent = new Set(a.remindersSent ?? []);

    // Customer: every window already reached counts as sent, but only one message goes out.
    const reached = settings.customerHours.filter((h) => left <= h * HOUR).map((h) => `customer:${h}`);
    const customerKeys = reached.filter((k) => !sent.has(k));
    // Staff: one reminder, N minutes before.
    const staffKey = settings.staffMinutes > 0 && a.staff && left <= settings.staffMinutes * 60_000 && !sent.has(`staff:${settings.staffMinutes}`) ? `staff:${settings.staffMinutes}` : null;
    const keys = [...customerKeys, ...(staffKey ? [staffKey] : [])];
    if (!keys.length) continue;
    const claimed = await Appointment.updateOne({ _id: a._id, remindersSent: { $nin: keys } }, { $addToSet: { remindersSent: { $each: keys } } });
    if (!claimed.modifiedCount) continue;

    const what = `${a.serviceName}${a.petName ? ` for ${a.petName}` : ''}`;
    if (customerKeys.length) {
      const customer = await VendorCustomer.findById(a.customer).select('user').lean();
      if (customer?.user) {
        await notify([customer.user], {
          type: 'appointment.reminder',
          title: `Reminder: ${what} at ${vendor?.businessName ?? 'your appointment'}`,
          body: when(a.scheduledAt),
          data: { appointmentId: String(a._id), vendorId: String(a.vendor) },
        });
      }
    }
    if (staffKey) {
      const staff = await VendorStaff.findById(a.staff).select('user active').lean();
      if (staff?.active) {
        await notify([staff.user], {
          type: 'staff.appointment_reminder',
          title: `Coming up: ${what}`,
          body: `${when(a.scheduledAt)} · ${vendor?.businessName ?? ''}`.trim(),
          data: { appointmentId: String(a._id), vendorId: String(a.vendor) },
        });
      }
    }
  }

  const notes = await CrmNote.find({ doneAt: null, remindedAt: null, followUpAt: { $ne: null, $lte: now } }).limit(limit).lean();
  if (!notes.length) return;
  const noteVendors = new Map((await Vendor.find({ _id: { $in: [...new Set(notes.map((n) => String(n.vendor)))] } }).select('reminderSettings').lean()).map((v) => [String(v._id), v]));
  const customers = new Map((await VendorCustomer.find({ _id: { $in: notes.map((n) => n.customer) } }).select('name').lean()).map((c) => [String(c._id), c]));
  for (const note of notes) {
    const claimed = await CrmNote.updateOne({ _id: note._id, remindedAt: null }, { remindedAt: now });
    if (!claimed.modifiedCount || !settingsOf(noteVendors.get(String(note.vendor))).followUps) continue;
    await notify([note.author], {
      type: 'crm.follow_up',
      title: `Follow up with ${customers.get(String(note.customer))?.name ?? 'a customer'}`,
      body: note.text.slice(0, 120),
      data: { noteId: String(note._id), customerId: String(note.customer), vendorId: String(note.vendor) },
    });
  }
}
