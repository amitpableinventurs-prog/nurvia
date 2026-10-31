import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { unauthorized, unavailable } from '../common/errors.js';

// Sign in with Google / Apple. The app signs the user in with the provider's SDK and sends us the
// ID token; we check its signature against the provider's published keys, its issuer, its audience
// (one of our client IDs) and expiry. No provider secret is needed for this.
const PROVIDERS = {
  google: {
    label: 'Google',
    jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
    clientIds: () => env.oauth.googleClientIds,
  },
  apple: {
    label: 'Apple',
    jwksUrl: 'https://appleid.apple.com/auth/keys',
    issuers: ['https://appleid.apple.com'],
    clientIds: () => env.oauth.appleClientIds,
  },
};

export const providerEnabled = (provider) => PROVIDERS[provider].clientIds().length > 0;

const keyCache = new Map(); // provider -> { keys: Map<kid, KeyObject>, fetchedAt }
const KEYS_MAX_AGE_MS = 6 * 3_600_000;
const REFETCH_MIN_INTERVAL_MS = 60_000;

// Keys are cached; an unknown key id (the provider rotated keys) triggers a refetch, at most once a minute.
async function signingKey(provider, kid) {
  let entry = keyCache.get(provider);
  const stale = !entry || Date.now() - entry.fetchedAt > KEYS_MAX_AGE_MS;
  const unknown = entry && !entry.keys.has(kid) && Date.now() - entry.fetchedAt > REFETCH_MIN_INTERVAL_MS;
  if (stale || unknown) {
    let body;
    try {
      const res = await fetch(PROVIDERS[provider].jwksUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.json();
    } catch (err) {
      if (entry) return entry.keys.get(kid);
      throw unavailable(`Could not reach ${PROVIDERS[provider].label} to check the sign-in (${err.message})`);
    }
    const keys = new Map((body.keys ?? []).filter((k) => k.kid).map((k) => [k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })]));
    entry = { keys, fetchedAt: Date.now() };
    keyCache.set(provider, entry);
  }
  return entry.keys.get(kid);
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// Returns the provider's stable user id and, when the provider has verified it, the email address.
export async function verifyIdToken(provider, idToken, { nonce } = {}) {
  const { label, issuers, clientIds } = PROVIDERS[provider];
  if (!providerEnabled(provider)) throw unavailable(`${label} sign-in is not configured`);
  const invalid = () => unauthorized(`${label} sign-in failed; please try again`);

  const kid = jwt.decode(idToken, { complete: true })?.header?.kid;
  if (!kid) throw invalid();
  const key = await signingKey(provider, kid);
  if (!key) throw invalid();

  let claims;
  try {
    claims = jwt.verify(idToken, key, { algorithms: ['RS256'], issuer: issuers, audience: clientIds(), clockTolerance: 60 });
  } catch {
    throw invalid();
  }
  // Apps should send a nonce to stop a captured token being replayed. Apple carries it hashed
  // when the app passed Apple the SHA-256 of it, so either form is accepted.
  if (nonce && claims.nonce !== nonce && claims.nonce !== sha256(nonce)) throw invalid();
  if (!claims.sub) throw invalid();

  const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
  return {
    subject: String(claims.sub),
    email: emailVerified && claims.email ? String(claims.email).toLowerCase() : undefined,
    name: typeof claims.name === 'string' ? claims.name.slice(0, 120) : undefined,
  };
}
