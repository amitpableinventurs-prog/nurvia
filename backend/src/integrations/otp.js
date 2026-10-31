import { env } from '../config/env.js';
import { unavailable } from '../common/errors.js';

// Delivery adapter for OTP codes. Nurvia has not chosen an Indian SMS/OTP provider yet
// (MSG91, Gupshup, Twilio Verify etc.); add it as a case here once credentials exist.
// DLT template registration is required for SMS in India before go-live, and the registered
// template must match buildOtpMessage() below. WhatsApp needs an approved authentication template.
export async function deliverOtp({ channel, target, code, appHash }) {
  const message = buildOtpMessage({ channel, code, appHash });
  switch (env.otp.provider) {
    case 'console':
      if (env.nodeEnv !== 'test') console.info(`[otp:${channel}] ${target}\n${message}`);
      return;
    default:
      throw unavailable(`OTP provider "${env.otp.provider}" is not configured`);
  }
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
