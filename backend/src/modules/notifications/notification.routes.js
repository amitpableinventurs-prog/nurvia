import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../common/auth.js';
import { badRequest, notFound } from '../../common/errors.js';
import { paginate } from '../../common/paginate.js';
import { pageQuery, queryBool, validate } from '../../common/validate.js';
import { onboardingFor } from '../auth/auth.service.js';
import { User } from '../users/user.model.js';
import { Notification } from './notification.model.js';
import { registerDevice } from './notify.js';
import { askAgainAfterDays, NOTIFICATION_TOPICS, TOPIC_KEYS } from './topics.js';

const router = Router();
router.use(authenticate);

const deviceToken = z.string().min(10).max(4096);

// Whether the app should show the "Turn on notifications" screen. The phone's own permission state
// comes first: the app asks the OS, and uses this only when the OS would let it ask.
function promptFor(permission, deviceCount, now = new Date()) {
  switch (permission.status) {
    case undefined:
      return { show: true, reason: 'not_asked' };
    case 'later':
      return { show: permission.askAgainAt <= now, reason: 'later', askAgainAt: permission.askAgainAt };
    // The OS will not show its prompt again, so the app offers a link to the phone's Settings instead.
    case 'denied':
      return { show: false, reason: 'blocked', openSettings: true };
    // Granted, but every token has since been reported stale (app reinstalled): register again.
    default:
      return deviceCount ? { show: false, reason: 'granted' } : { show: true, reason: 'no_device' };
  }
}

function settingsFor(user) {
  const permission = user.pushPermission ?? {};
  const deviceCount = user.deviceTokens?.length ?? 0;
  return {
    enabled: user.preferences?.notifications !== false,
    permission: {
      status: permission.status ?? 'not_asked',
      platform: permission.platform ?? null,
      answeredAt: permission.answeredAt ?? null,
    },
    prompt: promptFor(permission, deviceCount),
    devices: deviceCount,
    topics: NOTIFICATION_TOPICS.map(({ key, label, description }) => ({ key, label, description, enabled: user.preferences?.topics?.[key] !== false })),
  };
}

const loadUser = (id) => User.findById(id).select('+deviceTokens');

router.get('/', validate({ query: { ...pageQuery, unread: queryBool.optional() } }), async (req, res) => {
  const { page, limit, unread } = req.valid.query;
  const filter = { user: req.user._id, ...(unread && { readAt: null }) };
  const result = await paginate(Notification, filter, { page, limit });
  res.json({ ...result, unreadCount: await Notification.countDocuments({ user: req.user._id, readAt: null }) });
});

// The "Turn on notifications" screen and notification settings: what can be switched, what is on,
// and whether to show the screen now.
router.get('/settings', async (req, res) => {
  res.json(settingsFor(await loadUser(req.user._id)));
});

// The answer on the screen, after the app has shown the phone's own prompt.
//   granted: "Allow" on the phone's prompt; send the FCM token. Turns notifications on.
//   denied:  the phone blocked it (refused, or blocked earlier in Settings).
//   later:   "Not now" before the phone's prompt was shown; the screen comes back after 3, 7, then 30 days.
router.put(
  '/permission',
  validate({
    body: {
      status: z.enum(['granted', 'denied', 'later']),
      platform: z.enum(['android', 'ios', 'web']),
      token: deviceToken.optional(),
      // On the screen: which topics the user left on. Topics not listed keep their setting.
      topics: z.array(z.enum(TOPIC_KEYS)).optional(),
    },
  }),
  async (req, res) => {
    const { status, platform, token, topics } = req.valid.body;
    if (status === 'granted' && !token) throw badRequest('Send the device token with a granted permission');

    const now = new Date();
    const previous = await User.findById(req.user._id).select('pushPermission').lean();
    const laterCount = status === 'later' ? (previous?.pushPermission?.laterCount ?? 0) + 1 : 0;
    const $set = {
      pushPermission: {
        status,
        platform,
        answeredAt: now,
        laterCount,
        ...(status === 'later' && { askAgainAt: new Date(now.getTime() + askAgainAfterDays(laterCount) * 86_400_000) }),
      },
    };
    if (status === 'granted') $set['preferences.notifications'] = true;
    if (topics) for (const key of TOPIC_KEYS) $set[`preferences.topics.${key}`] = topics.includes(key);
    await User.updateOne({ _id: req.user._id }, { $set });

    if (status === 'granted') await registerDevice(req.user._id, token);
    // This phone can no longer show notifications, so stop sending to it.
    else if (token) await User.updateOne({ _id: req.user._id }, { $pull: { deviceTokens: token } });

    const user = await loadUser(req.user._id);
    res.json({ ...settingsFor(user), onboarding: await onboardingFor(user) });
  },
);

// Notification settings: the main switch and each topic. Neither changes the phone's permission.
router.patch(
  '/settings',
  validate({
    body: {
      enabled: z.boolean().optional(),
      topics: z.object(Object.fromEntries(TOPIC_KEYS.map((key) => [key, z.boolean().optional()]))).strict().optional(),
    },
  }),
  async (req, res) => {
    const { enabled, topics = {} } = req.valid.body;
    const $set = Object.fromEntries(Object.entries(topics).map(([key, value]) => [`preferences.topics.${key}`, value]));
    if (enabled !== undefined) $set['preferences.notifications'] = enabled;
    if (Object.keys($set).length) await User.updateOne({ _id: req.user._id }, { $set });
    res.json(settingsFor(await loadUser(req.user._id)));
  },
);

router.post('/read-all', async (req, res) => {
  await Notification.updateMany({ user: req.user._id, readAt: null }, { readAt: new Date() });
  res.status(204).end();
});

router.post('/:id/read', validate(), async (req, res) => {
  const result = await Notification.updateOne({ _id: req.valid.params.id, user: req.user._id }, { readAt: new Date() });
  if (!result.matchedCount) throw notFound('Notification');
  res.status(204).end();
});

export default router;
