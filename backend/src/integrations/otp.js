import { env } from '../config/env.js';
import { badRequest, tooMany, unavailable } from '../common/errors.js';

// Delivery adapter for OTP codes.
//   console: logs the code (development); the API also returns it as devCode.
//   twilio:  Twilio Verify sends phone codes by SMS, WhatsApp or a voice call, and checks them.
//            Twilio generates the code, which keeps Indian SMS within its DLT-registered templates.
// Email codes are not sent by Twilio Verify yet; they are logged as with the console provider.
export const providerChecksCode = (channel) => env.otp.provider === 'twilio' && channel !== 'email';

export async function deliverOtp({ channel, target, code, appHash }) {
  if (providerChecksCode(channel)) return startTwilioVerification({ channel, target, appHash });
  if (env.otp.provider !== 'console' && channel !== 'email') throw unavailable(`OTP provider "${env.otp.provider}" is not configured`);
  if (env.nodeEnv !== 'test') console.info(`[otp:${channel}] ${target}\n${buildOtpMessage({ channel, code, appHash })}`);
}

const minutes = () => Math.round(env.otp.ttlSeconds / 60);

// SMS layout for automatic code reading: Android's SMS Retriever needs the app's 11-character hash
// in the message, and iOS autofill reads a last line of "@<domain> #<code>".
export function buildOtpMessage({ channel, code, appHash }) {
  switch (channel) {
    case 'voice':
      return `Your Nurvia Petcare verification code is ${code.split('').join(' ')}. Again, ${code.split('').join(' ')}.`;
    case 'email':
      return `${code} is your Nurvia Petcare verification code. It expires in ${minutes()} minutes. If you did not ask for it, ignore this email.`;
    default:
      return [
        `${code} is your Nurvia Petcare verification code. It expires in ${minutes()} minutes. Do not share it with anyone.`,
        ...(appHash ? [appHash] : []),
        '',
        `@${env.otp.appDomain} #${code}`,
      ].join('\n');
  }
}

// The console provider exists only so the apps can be built without an SMS account;
// it echoes the code back in the API response, which must never happen in production.
export const exposesDevCode = () => env.otp.provider === 'console' && !env.isProd;

if (env.otp.fixedCode && !/^\d{6}$/.test(env.otp.fixedCode)) throw new Error('OTP_FIXED_CODE must be 6 digits');

// OTP_FIXED_CODE, on the same terms as devCode: never with a real provider or in production.
export const fixedDevCode = () => (exposesDevCode() ? env.otp.fixedCode : undefined);

// The fixed code of an OTP_TEST_ACCOUNTS number (any environment), or undefined.
export const testAccountCode = (target) => env.otp.testAccounts.get(target);

/* ───────────── Twilio Verify ───────────── */

const TWILIO_CHANNELS = { sms: 'sms', whatsapp: 'whatsapp', voice: 'call' };

async function twilio(path, params) {
  const { accountSid, apiKeySid, apiKeySecret, verifyServiceSid } = env.twilio;
  if (!accountSid || !apiKeySid || !apiKeySecret || !verifyServiceSid) throw unavailable('Twilio Verify is not configured');
  let res;
  try {
    res = await fetch(`https://verify.twilio.com/v2/Services/${verifyServiceSid}/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${apiKeySid}:${apiKeySecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw unavailable('Could not reach the SMS provider. Please try again');
  }
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function startTwilioVerification({ channel, target, appHash }) {
  const { status, body } = await twilio('Verifications', { To: target, Channel: TWILIO_CHANNELS[channel], ...(appHash && { AppHash: appHash }) });
  if (status < 300) return;
  console.warn(`[otp:twilio] send to ${target.slice(0, 6)}… failed: ${status} ${body.code} ${body.message}`);
  if (status === 429 || body.code === 60203) throw tooMany('Too many codes requested. Please try again later');
  // 21608: a trial Twilio account can only send to numbers verified in the Twilio console.
  if (body.code === 21608) throw badRequest('This number cannot receive codes yet (Twilio trial account)');
  if (status === 400) throw badRequest(`Codes cannot be sent to this number by ${channel}`);
  throw unavailable('The SMS provider could not send the code. Please try again');
}

// True when Twilio accepts the code. Twilio forgets a verification once it is approved, expired
// or out of attempts; that answers 404, which counts as a wrong code here.
export async function checkTwilioCode(target, code) {
  const { status, body } = await twilio('VerificationCheck', { To: target, Code: code });
  if (status === 404) return false;
  if (status >= 300) {
    console.warn(`[otp:twilio] check failed: ${status} ${body.code} ${body.message}`);
    throw unavailable('Could not check the code. Please try again');
  }
  return body.status === 'approved';
}
