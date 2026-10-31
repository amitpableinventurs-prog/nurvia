import { sendPush } from '../../integrations/push.js';
import { User } from '../users/user.model.js';
import { Notification } from './notification.model.js';
import { topicOf } from './topics.js';

// A device token belongs to one account: on a shared phone, the account that signed in last gets the pushes.
export async function registerDevice(userId, token) {
  await User.updateMany({ _id: { $ne: userId }, deviceTokens: token }, { $pull: { deviceTokens: token } });
  await User.updateOne({ _id: userId }, { $addToSet: { deviceTokens: token } });
}

// Stores an in-app notification for each user and pushes it to their devices.
// Push failures are logged rather than thrown: a failed push must never fail the booking,
// review or moderation action that triggered it.
export async function notify(userIds, { type, title, body, data }) {
  const ids = [...new Set(userIds.filter(Boolean).map(String))];
  if (!ids.length) return;

  await Notification.insertMany(ids.map((user) => ({ user, type, title, body, data })));

  try {
    const topic = topicOf(type);
    const users = await User.find({
      _id: { $in: ids },
      status: 'active',
      'preferences.notifications': { $ne: false },
      ...(topic && { [`preferences.topics.${topic}`]: { $ne: false } }),
    })
      .select('+deviceTokens')
      .lean();
    const tokens = users.flatMap((u) => u.deviceTokens ?? []);
    const stale = await sendPush(tokens, { title, body, data: { type, ...data } });
    if (stale.length) await User.updateMany({ _id: { $in: ids } }, { $pull: { deviceTokens: { $in: stale } } });
  } catch (err) {
    console.error('[notify] push delivery failed', err);
  }
}
