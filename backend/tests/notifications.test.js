import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendPush } from '../src/integrations/push.js';
import { notify } from '../src/modules/notifications/notify.js';
import { signUpByPhone, startDb, stopDb, tenantRun } from './helpers.js';

vi.mock('../src/integrations/push.js', () => ({ sendPush: vi.fn(async () => []) }));

const PHONE_TOKEN = 'fcm-token-asha-phone-0001';
const DAY = 86_400_000;

let user;

beforeAll(async () => {
  await startDb();
  user = await signUpByPhone('Asha');
  await user.http.post('/users/me/terms').send({ version: user.onboarding.termsVersion }).expect(200);
});
afterAll(stopDb);
beforeEach(() => sendPush.mockClear());

// The tokens a notification of this type was pushed to.
async function pushedTo(type) {
  sendPush.mockClear();
  await tenantRun(() => notify([user.user._id], { type, title: 'Test' }));
  return sendPush.mock.calls.flatMap(([tokens]) => tokens);
}

describe('notification permission screen', () => {
  it('asks a new user, with every topic on', async () => {
    const { body } = await user.http.get('/notifications/settings').expect(200);
    expect(body).toMatchObject({ enabled: true, permission: { status: 'not_asked' }, prompt: { show: true, reason: 'not_asked' }, devices: 0 });
    expect(body.topics.map((t) => t.key)).toEqual(['reminders', 'bookings', 'orders', 'safety', 'community', 'rewards']);
    expect(body.topics.every((t) => t.enabled && t.label && t.description)).toBe(true);
    expect((await user.http.get('/users/me/onboarding')).body.notificationsAnswered).toBe(false);
  });

  it('asks again later after "Not now", waiting longer each time', async () => {
    const first = await user.http.put('/notifications/permission').send({ status: 'later', platform: 'android' }).expect(200);
    expect(first.body).toMatchObject({ permission: { status: 'later', platform: 'android' }, prompt: { show: false, reason: 'later' }, onboarding: { notificationsAnswered: true } });
    expect(new Date(first.body.prompt.askAgainAt) - Date.now()).toBeGreaterThan(2.9 * DAY);

    const second = await user.http.put('/notifications/permission').send({ status: 'later', platform: 'android' }).expect(200);
    expect(new Date(second.body.prompt.askAgainAt) - Date.now()).toBeGreaterThan(6.9 * DAY);
  });

  it('registers the phone when allowed, keeping the topics left on', async () => {
    await user.http.put('/notifications/permission').send({ status: 'granted', platform: 'android' }).expect(400);
    await user.http.put('/notifications/permission').send({ status: 'granted', platform: 'android', token: PHONE_TOKEN, topics: ['nope'] }).expect(400);

    const { body } = await user.http
      .put('/notifications/permission')
      .send({ status: 'granted', platform: 'android', token: PHONE_TOKEN, topics: ['reminders', 'bookings', 'orders', 'safety', 'rewards'] })
      .expect(200);
    expect(body).toMatchObject({ enabled: true, permission: { status: 'granted' }, prompt: { show: false, reason: 'granted' }, devices: 1 });
    expect(body.topics.find((t) => t.key === 'community').enabled).toBe(false);
  });

  it('pushes only the topics that are on, and keeps everything in the inbox', async () => {
    expect(await pushedTo('reminder.due')).toEqual([PHONE_TOKEN]);
    expect(await pushedTo('community.comment')).toEqual([]);
    // Account updates and announcements have no topic and always go out.
    expect(await pushedTo('announcement')).toEqual([PHONE_TOKEN]);

    const inbox = await user.http.get('/notifications').expect(200);
    expect(inbox.body.items.map((n) => n.type)).toContain('community.comment');
  });

  it('changes topics and the main switch from settings', async () => {
    await user.http.patch('/notifications/settings').send({ topics: { unknown: true } }).expect(400);

    const { body } = await user.http.patch('/notifications/settings').send({ topics: { community: true, orders: false } }).expect(200);
    expect(Object.fromEntries(body.topics.map((t) => [t.key, t.enabled]))).toMatchObject({ community: true, orders: false, reminders: true });
    expect(await pushedTo('community.comment')).toEqual([PHONE_TOKEN]);
    expect(await pushedTo('shop.shipped')).toEqual([]);

    await user.http.patch('/notifications/settings').send({ enabled: false }).expect(200);
    expect(await pushedTo('reminder.due')).toEqual([]);
    await user.http.patch('/notifications/settings').send({ enabled: true }).expect(200);
  });

  it('moves a phone to the account that signed in on it last', async () => {
    const partner = await signUpByPhone('Rahul');
    await partner.http.put('/notifications/permission').send({ status: 'granted', platform: 'android', token: PHONE_TOKEN }).expect(200);
    expect((await user.http.get('/notifications/settings')).body).toMatchObject({ devices: 0, prompt: { show: true, reason: 'no_device' } });
    expect(await pushedTo('reminder.due')).toEqual([]);
  });

  it('stops pushing to a phone that blocked notifications, and points to Settings', async () => {
    await user.http.post('/users/me/devices').send({ token: PHONE_TOKEN }).expect(204);
    const { body } = await user.http.put('/notifications/permission').send({ status: 'denied', platform: 'ios', token: PHONE_TOKEN }).expect(200);
    expect(body).toMatchObject({ permission: { status: 'denied' }, prompt: { show: false, reason: 'blocked', openSettings: true }, devices: 0 });
  });
});
