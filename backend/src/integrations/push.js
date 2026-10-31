import { env } from '../config/env.js';

let firebaseMessaging;

async function fcm() {
  if (!firebaseMessaging) {
    // firebase-admin is only needed once FCM is switched on, so it is loaded lazily.
    // Credentials come from GOOGLE_APPLICATION_CREDENTIALS (a service-account file owned by Nurvia).
    const { initializeApp, applicationDefault } = await import('firebase-admin/app');
    const { getMessaging } = await import('firebase-admin/messaging');
    initializeApp({ credential: applicationDefault() });
    firebaseMessaging = getMessaging();
  }
  return firebaseMessaging;
}

// Returns the tokens the provider reported as no longer valid, so callers can prune them.
export async function sendPush(tokens, { title, body, data = {} }) {
  if (!tokens.length) return [];
  switch (env.push.provider) {
    case 'console':
      if (env.nodeEnv !== 'test') console.info(`[push] ${tokens.length} device(s): ${title}`);
      return [];
    case 'fcm': {
      const stringData = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]));
      const result = await (await fcm()).sendEachForMulticast({ tokens, notification: { title, body }, data: stringData });
      return result.responses
        .map((r, i) => (r.error?.code === 'messaging/registration-token-not-registered' ? tokens[i] : null))
        .filter(Boolean);
    }
    default:
      console.warn(`[push] unknown provider "${env.push.provider}"; notification not sent`);
      return [];
  }
}
