import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { ApiError, unavailable } from '../common/errors.js';

const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Razorpay (https://razorpay.com/docs/api/). Cashfree or another gateway can be added as a
// sibling object implementing the same four functions.
const razorpay = {
  name: 'razorpay',
  async call(method, path, body) {
    const { razorpayKeyId: id, razorpayKeySecret: secret } = env.payments;
    if (!id || !secret) throw unavailable('Razorpay keys are not configured');
    const res = await fetch(`https://api.razorpay.com/v1${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` },
      body: body && JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new ApiError(502, 'PAYMENT_GATEWAY_ERROR', json?.error?.description ?? 'Payment gateway request failed');
    return json;
  },
  async createOrder({ amountPaise, receipt, notes }) {
    const order = await this.call('POST', '/orders', { amount: amountPaise, currency: 'INR', receipt, notes });
    return { orderId: order.id, amountPaise: order.amount, currency: order.currency, keyId: env.payments.razorpayKeyId };
  },
  verifyPayment({ orderId, paymentId, signature }) {
    return safeEqualHex(hmac(env.payments.razorpayKeySecret, `${orderId}|${paymentId}`), signature);
  },
  verifyWebhook(rawBody, signature) {
    if (!env.payments.razorpayWebhookSecret) return false;
    return safeEqualHex(hmac(env.payments.razorpayWebhookSecret, rawBody), signature);
  },
  async refund({ paymentId, amountPaise, notes }) {
    const refund = await this.call('POST', `/payments/${paymentId}/refund`, { amount: amountPaise, notes });
    return { refundId: refund.id, status: refund.status };
  },
};

// Development stand-in so the apps can exercise the full payment flow without a gateway account.
export const MOCK_SECRET = 'nurvia-mock-gateway';
const mock = {
  name: 'mock',
  async createOrder({ amountPaise }) {
    return { orderId: `order_mock_${crypto.randomUUID().replaceAll('-', '')}`, amountPaise, currency: 'INR', keyId: 'mock' };
  },
  verifyPayment({ orderId, paymentId, signature }) {
    return safeEqualHex(hmac(MOCK_SECRET, `${orderId}|${paymentId}`), signature);
  },
  verifyWebhook(rawBody, signature) {
    return safeEqualHex(hmac(MOCK_SECRET, rawBody), signature);
  },
  async refund() {
    return { refundId: `rfnd_mock_${crypto.randomUUID().slice(0, 8)}`, status: 'processed' };
  },
};

const gateways = { razorpay, mock };

export function paymentGateway() {
  const gateway = gateways[env.payments.gateway];
  if (!gateway) throw unavailable(`Payment gateway "${env.payments.gateway}" is not supported`);
  if (gateway === mock && env.isProd) throw unavailable('The mock payment gateway cannot be used in production');
  return gateway;
}

export const mockSignature = (data) => hmac(MOCK_SECRET, data);
