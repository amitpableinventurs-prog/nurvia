import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { signAccessToken } from '../../common/auth.js';
import { badRequest, conflict, forbidden, notFound, tooMany, unauthorized } from '../../common/errors.js';
import { verifyIdToken } from '../../integrations/identity.js';
import { deliverOtp, exposesDevCode, fixedDevCode } from '../../integrations/otp.js';
import { saveFile, sniff } from '../files/file.routes.js';
import { Pet } from '../pets/pet.model.js';
import { resolveCity } from '../platform/platform.service.js';
import { User } from '../users/user.model.js';
import { OtpChallenge, OtpSend, RefreshToken, SignupGrant } from './auth.model.js';

const hashOtp = (target, code) => crypto.createHmac('sha256', env.otp.secret).update(`${target}:${code}`).digest('hex');
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// Masked for "We sent a code to ...": +91 96300 •••••, as•••@gmail.com.
export function maskTarget(target) {
  if (target.startsWith('+91')) return `+91 ${target.slice(3, 8)} •••••`;
  const [local, domain] = target.split('@');
  return `${local.slice(0, 2)}•••@${domain}`;
}

const accountWith = (kind, target) => User.findOne({ [kind]: target }).select('+passwordHash').lean();

// Existing accounts receive a sign-in code; new numbers receive a code to verify before registration.
export async function requestPhoneOtp({ phone, channel, appHash }) {
  const user = await accountWith('phone', phone);
  if (user?.passwordHash) throw forbidden('This account signs in with email and password');
  return requestOtp({ kind: 'phone', target: phone, channel, appHash, purpose: user ? 'login' : 'signup' });
}

// A phone gets a code by SMS, WhatsApp or a voice call; an email gets it by email.
export async function requestOtp({ kind, target, channel = kind === 'email' ? 'email' : 'sms', appHash, purpose = 'login' }) {
  if (kind === 'phone' && !env.otp.phoneChannels.includes(channel)) throw badRequest(`Codes cannot be sent by ${channel} yet`);
  const recent = await OtpChallenge.findOne({ target }).sort({ createdAt: -1 }).lean();
  const cooldownMs = env.otp.resendCooldownSeconds * 1000;
  const sinceLast = recent ? Date.now() - recent.createdAt.getTime() : Infinity;
  if (sinceLast < cooldownMs) {
    const wait = Math.ceil((cooldownMs - sinceLast) / 1000);
    throw tooMany(`Please wait ${wait} seconds before requesting another code`, { retryInSeconds: wait });
  }
  const sentLastHour = await OtpSend.countDocuments({ target, createdAt: { $gt: new Date(Date.now() - 3_600_000) } });
  if (sentLastHour >= env.otp.maxSendsPerHour) throw tooMany('Too many codes requested. Please try again in an hour');

  const code = fixedDevCode() ?? String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await OtpChallenge.deleteMany({ target });
  await OtpChallenge.create({
    channel,
    target,
    codeHash: hashOtp(target, code),
    purpose,
    expiresAt: new Date(Date.now() + env.otp.ttlSeconds * 1000),
  });
  await OtpSend.create({ target });
  await deliverOtp({ channel, target, code, appHash });

  return {
    channel,
    sentTo: maskTarget(target),
    codeLength: 6,
    expiresInSeconds: env.otp.ttlSeconds,
    resendInSeconds: env.otp.resendCooldownSeconds,
    ...(exposesDevCode() && { devCode: code }),
  };
}

// Sign-in codes open a session (isNew: false); sign-up codes return isNew: true and a registration
// token for the profile form, without creating an account yet.
export async function verifyOtp({ phone, code }, meta) {
  const challenge = await checkOtp(phone, code, ['signup', 'login']);
  if (challenge.purpose === 'signup') {
    if (await accountWith('phone', phone)) throw conflict('An account already uses this number. Sign in instead');
    const registrationToken = crypto.randomBytes(32).toString('base64url');
    await SignupGrant.create({
      tokenHash: hashToken(registrationToken),
      phone,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    return { isNew: true, registrationRequired: true, registrationToken, expiresInSeconds: 600 };
  }
  return signInByContact({ field: 'phone', value: phone }, meta);
}

// Completes registration only with the one-time grant issued after phone verification.
export async function completeSignup({ registrationToken, name, email, city, locality, whatsapp, emergencyContact, acceptTerms: termsAccepted, photo }, meta) {
  const tokenHash = hashToken(registrationToken);
  const grant = await SignupGrant.findOne({ tokenHash, expiresAt: { $gt: new Date() } });
  if (!grant) throw unauthorized('Registration verification expired or already used; verify your phone again');
  if (await User.exists({ phone: grant.phone })) throw conflict('An account already uses this number. Sign in instead');
  if (email && (await accountWith('email', email))) throw conflict('This email is linked to another Nurvia account');
  if (emergencyContact?.phone === grant.phone) throw badRequest('The emergency contact needs a different number from yours');
  const type = photo && sniff(photo.buffer);
  if (photo && (!type || type.mime === 'application/pdf')) throw badRequest('The photo must be a JPEG, PNG or WebP image');
  const cityDetails = city ? await resolveCity(city) : {};
  const claimed = await SignupGrant.findOneAndDelete({ _id: grant._id, expiresAt: { $gt: new Date() } });
  if (!claimed) throw unauthorized('Registration verification expired or already used; verify your phone again');
  const profile = {
    name,
    pendingEmail: email,
    ...cityDetails,
    locality,
    whatsapp,
    emergencyContact,
    ...(photo && { photo: { data: photo.buffer, originalName: photo.originalname } }),
  };
  const user = await newUserFromProfile('phone', grant.phone, profile);
  return startSession(user, meta, { isNew: true, termsAccepted });
}

// A new account from the sign-up profile. The photo is stored only now that the number is verified.
async function newUserFromProfile(field, value, { photo, whatsapp, emergencyContact, ...profile }) {
  const user = new User({ [field]: value, ...profile });
  if (whatsapp) {
    user.preferences.whatsapp = true;
    user.preferences.whatsappConsentAt = new Date();
  }
  if (emergencyContact?.phone) user.emergencyContact = emergencyContact;
  if (photo?.data) {
    const buffer = Buffer.isBuffer(photo.data) ? photo.data : Buffer.from(photo.data.buffer);
    const file = await saveFile({ owner: user._id, purpose: 'avatar', buffer, originalName: photo.originalName });
    user.avatarUrl = file.url;
  }
  return user;
}

// Adds or changes the signed-in user's mobile number or email, once the code sent to it is entered.
export async function verifyContact(user, { kind, target, code }) {
  await checkOtp(target, code, ['contact']);
  const taken = await User.exists({ [kind]: target, _id: { $ne: user._id }, status: { $ne: 'deleted' } });
  if (taken) throw conflict(`This ${kind === 'phone' ? 'number' : 'email'} is linked to another Nurvia account. Sign in with it instead`);
  user[kind] = target;
  if (kind === 'email' && user.pendingEmail === target) user.pendingEmail = undefined;
  await user.save();
  return user;
}

// Checks a code sent for one of `purposes` and uses it up. Returns the challenge it ended.
async function checkOtp(target, code, purposes) {
  // The attempt is counted atomically before the code is checked, so parallel guesses cannot
  // all read the same count and get past the limit.
  const challenge = await OtpChallenge.findOneAndUpdate(
    { target, expiresAt: { $gt: new Date() }, purpose: { $in: purposes } },
    { $inc: { attempts: 1 } },
    { sort: { createdAt: -1 }, new: true },
  );
  if (!challenge) throw unauthorized('Code expired or not requested');
  if (challenge.attempts > env.otp.maxAttempts) {
    await challenge.deleteOne();
    throw tooMany('Too many incorrect attempts; request a new code');
  }
  if (!safeEqual(challenge.codeHash, hashOtp(target, code))) {
    throw unauthorized('Incorrect code', { attemptsLeft: env.otp.maxAttempts - challenge.attempts });
  }
  // Deleting is the claim: of two requests with the right code, only one opens a session.
  if (!(await OtpChallenge.findOneAndDelete({ _id: challenge._id }))) throw unauthorized('Code expired or not requested');
  return challenge;
}

async function signInByContact({ field, value }, meta) {
  let user = await User.findOne({ [field]: value }).select('+passwordHash');
  // Staff accounts with a password must use it; an emailed code would otherwise skip the password.
  if (user?.passwordHash) throw forbidden('This account signs in with email and password');
  if (!user) throw unauthorized('Account not found');
  return startSession(user, meta);
}

// Sign in with Google / Apple. The account is found by the provider's user id, then by verified
// email (linking the provider to an existing account), else created.
export async function signInWithProvider(provider, { idToken, nonce, name, termsAccepted }, meta) {
  const identity = await verifyIdToken(provider, idToken, { nonce });
  let user = await User.findOne({ identities: { $elemMatch: { provider, subject: identity.subject } } }).select('+passwordHash');
  if (!user && identity.email) user = await User.findOne({ email: identity.email }).select('+passwordHash');
  if (user?.passwordHash) throw forbidden('This account signs in with email and password');

  const isNew = !user;
  if (!user) user = new User({ email: identity.email });
  if (!user.identities.some((i) => i.provider === provider)) user.identities.push({ provider, subject: identity.subject, linkedAt: new Date() });
  // Apple sends the name only to the app, and only the first time, so the app passes it on.
  if (!user.name && (name || identity.name)) user.name = name || identity.name;
  return startSession(user, meta, { isNew, termsAccepted });
}

// What the app still needs from a new user: accept the current Terms, complete the profile (name,
// a verified mobile number so clinics can reach them, city), register a pet. Location is optional
// ("Set later"), so it never blocks a step; `hasLocation` tells the app whether to offer it.
export async function onboardingFor(user) {
  const termsAccepted = user.consents?.termsVersion === env.legal.termsVersion;
  const missing = [!user.name && 'name', !user.phone && 'phone', !user.city && 'city'].filter(Boolean);
  const hasPet = Boolean(await Pet.exists({ owner: user._id, archivedAt: null }));
  const nextStep = !termsAccepted ? 'terms' : missing.length ? 'profile' : !hasPet ? 'pet' : 'done';
  return {
    termsAccepted,
    termsVersion: env.legal.termsVersion,
    profileComplete: !missing.length,
    missing,
    hasLocation: Boolean(user.location?.coordinates?.length),
    // An email typed at sign-up that still needs its code (POST /users/me/contact/request with it).
    emailToVerify: user.pendingEmail ?? null,
    // The "Turn on notifications" screen was answered (GET /notifications/settings says whether to show it again).
    notificationsAnswered: Boolean(user.pushPermission?.status),
    hasPet,
    nextStep,
  };
}

export function acceptTerms(user, version) {
  if (version !== env.legal.termsVersion) throw badRequest(`The current Terms version is ${env.legal.termsVersion}`, { termsVersion: env.legal.termsVersion });
  user.consents = { termsVersion: version, termsAcceptedAt: new Date() };
}

let dummyHash;

export async function passwordLogin({ email, password }, meta) {
  const user = await User.findOne({ email }).select('+passwordHash');
  // Compare against a dummy hash when the user is missing so timing does not reveal which emails exist.
  dummyHash ??= bcrypt.hash(crypto.randomUUID(), 12);
  const ok = await bcrypt.compare(password, user?.passwordHash ?? (await dummyHash));
  if (!user?.passwordHash || !ok) throw unauthorized('Incorrect email or password');
  return startSession(user, meta);
}

export const hashPassword = (password) => bcrypt.hash(password, 12);

// Ends every other session and returns fresh tokens for the device that made the change.
export async function changePassword(userId, { currentPassword, newPassword }, meta) {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user?.passwordHash) throw badRequest('This account signs in with a one-time code and has no password');
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) throw unauthorized('Current password is incorrect');
  if (currentPassword === newPassword) throw badRequest('Choose a password different from the current one');
  user.passwordHash = await hashPassword(newPassword);
  await user.save();
  await revokeAllSessions(user._id);
  return issueTokens(user, meta);
}

async function startSession(user, meta, { isNew = false, termsAccepted = false } = {}) {
  if (user.status === 'suspended') throw forbidden('This account is suspended');
  if (user.status === 'deleted') throw unauthorized('Account not found');
  if (termsAccepted && user.consents?.termsVersion !== env.legal.termsVersion) acceptTerms(user, env.legal.termsVersion);
  user.lastLoginAt = new Date();
  await user.save();
  return { user: user.toJSON(), ...(await issueTokens(user, meta)), isNew, onboarding: await onboardingFor(user) };
}

async function issueTokens(user, meta = {}, session = { family: crypto.randomUUID(), sessionStartedAt: new Date() }) {
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  await RefreshToken.create({
    user: user._id,
    tokenHash: hashToken(refreshToken),
    ...session,
    expiresAt: new Date(Date.now() + env.jwt.refreshTtlDays * 86_400_000),
    userAgent: meta.userAgent,
  });
  const accessToken = signAccessToken(user, session.family);
  const { iat, exp } = jwt.decode(accessToken);
  return { accessToken, refreshToken, expiresInSeconds: exp - iat };
}

const revoke = (filter, reason) => RefreshToken.updateMany({ ...filter, revokedAt: null }, { revokedAt: new Date(), revokeReason: reason });

// Refresh tokens are single-use. A token used again shortly after it was rotated is a second tab
// or a retried request racing the first, and gets its own new token. Used again later, it was
// copied, so that session is ended (every session, for tokens issued before sessions existed).
export async function rotateRefreshToken(token, meta) {
  const tokenHash = hashToken(token);
  const now = new Date();
  // Claiming the token atomically means two concurrent refreshes cannot both see it unused.
  let record = await RefreshToken.findOneAndUpdate({ tokenHash, revokedAt: null, expiresAt: { $gt: now } }, { revokedAt: now, revokeReason: 'rotated' });
  if (!record) {
    record = await RefreshToken.findOne({ tokenHash });
    const rotated = record?.revokeReason === 'rotated' || (record?.replacedBy && !record.revokeReason);
    if (!record || record.expiresAt <= now || !rotated) throw unauthorized('Session has ended; please sign in again');
    const withinGrace = record.family && now - record.revokedAt <= env.jwt.refreshReuseGraceSeconds * 1000;
    if (!withinGrace || !(await RefreshToken.exists({ family: record.family, revokedAt: null }))) {
      await revoke(record.family ? { family: record.family } : { user: record.user }, 'reuse');
      throw unauthorized('Refresh token reuse detected; please sign in again');
    }
  }

  const user = await User.findById(record.user);
  if (!user || user.status !== 'active') throw unauthorized('Account is not active');

  const tokens = await issueTokens(user, meta, {
    family: record.family ?? crypto.randomUUID(),
    sessionStartedAt: record.sessionStartedAt ?? record.createdAt,
  });
  if (!record.replacedBy) await RefreshToken.updateOne({ _id: record._id }, { replacedBy: hashToken(tokens.refreshToken) });
  return tokens;
}

// Signing out ends the whole session, including a token handed out during the reuse grace period.
export async function revokeRefreshToken(token) {
  if (!token) throw badRequest('refreshToken is required');
  const record = await RefreshToken.findOne({ tokenHash: hashToken(token) }).lean();
  if (!record) return;
  await revoke(record.family ? { family: record.family } : { _id: record._id }, 'logout');
}

// Also invalidates access tokens already issued (see common/auth.js), so it takes effect at once.
export async function revokeAllSessions(userId) {
  await revoke({ user: userId }, 'revoked');
  await User.updateOne({ _id: userId }, { sessionsRevokedAt: new Date() });
}
