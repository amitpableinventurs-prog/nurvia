import express, { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../common/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../../common/errors.js';
import { runWithTenant } from '../../common/tenancy.js';
import { objectId, validate } from '../../common/validate.js';
import { paymentGateway } from '../../integrations/payments.js';
import { Booking } from '../bookings/booking.model.js';
import { isActive } from '../bookings/booking.service.js';
import { notify } from '../notifications/notify.js';
import { SubscriptionOrder } from '../plans/plan.model.js';
import { activateOrder, failOrder } from '../plans/subscription.service.js';
import { ShopOrder } from '../shop/shop.model.js';
import { markOrderPaid } from '../shop/shop.service.js';

const router = Router();

// Starts an online payment for a booking. The amount always comes from the booking's price
// snapshot on the server, never from the client.
router.post('/bookings/:bookingId/order', authenticate, validate({ params: { bookingId: objectId } }), async (req, res) => {
  const booking = await Booking.findById(req.valid.params.bookingId);
  if (!booking) throw notFound('Booking');
  if (String(booking.user) !== String(req.user._id)) throw forbidden();
  if (!isActive(booking)) throw conflict(`Cannot pay for a booking that is ${booking.status}`);
  if (booking.payment.status === 'paid') throw conflict('This booking is already paid');
  const amountPaise = booking.serviceSnapshot.pricePaise;
  if (!amountPaise) throw badRequest('This service has no online payment amount');

  const gateway = paymentGateway();
  const order = await gateway.createOrder({ amountPaise, receipt: booking.code, notes: { bookingId: String(booking._id), tenant: booking.tenant } });
  booking.payment = { status: 'pending', gateway: gateway.name, orderId: order.orderId, amountPaise };
  await booking.save();
  res.status(201).json({ ...order, bookingId: booking._id, bookingCode: booking.code });
});

// Starts an online payment for a shop order placed with paymentMethod "online".
router.post('/shop-orders/:orderId/order', authenticate, validate({ params: { orderId: objectId } }), async (req, res) => {
  const order = await ShopOrder.findOne({ _id: req.valid.params.orderId, user: req.user._id });
  if (!order) throw notFound('Order');
  if (order.paymentMethod !== 'online') throw conflict('This order is cash on delivery');
  if (order.payment.status === 'paid') throw conflict('This order is already paid');
  if (order.status !== 'pending_payment') throw conflict(`Cannot pay for an order that is ${order.status}`);

  const gateway = paymentGateway();
  const amountPaise = order.pricing.totalPaise;
  const gatewayOrder = await gateway.createOrder({ amountPaise, receipt: order.code, notes: { shopOrderId: String(order._id), tenant: order.tenant } });
  order.payment = { status: 'pending', gateway: gateway.name, orderId: gatewayOrder.orderId, amountPaise };
  await order.save();
  res.status(201).json({ ...gatewayOrder, shopOrderId: order._id, orderCode: order.code });
});

// A gateway order belongs to either a booking or a shop order.
async function findPayable(filter) {
  const booking = await Booking.findOne(filter);
  if (booking) return { kind: 'booking', doc: booking };
  const order = await ShopOrder.findOne(filter);
  return order ? { kind: 'shop', doc: order } : null;
}

const settle = (payable, paymentId) => (payable.kind === 'shop' ? markOrderPaid(payable.doc, paymentId) : markPaid(payable.doc, paymentId));

async function markPaid(booking, paymentId) {
  if (booking.payment.status === 'paid') return booking;
  booking.payment.status = 'paid';
  booking.payment.paymentId = paymentId;
  booking.payment.paidAt = new Date();
  booking.payment.failureReason = undefined;
  await booking.save();
  await notify([booking.vendorOwner], {
    type: 'booking.paid',
    title: 'Booking paid online',
    body: booking.code,
    data: { bookingId: String(booking._id) },
  });
  return booking;
}

// Called by the app after the gateway checkout succeeds. The webhook below is the source of
// truth; this endpoint only lets the app show "paid" immediately.
router.post(
  '/verify',
  authenticate,
  validate({ body: { orderId: z.string().min(1).max(100), paymentId: z.string().min(1).max(100), signature: z.string().min(1).max(256) } }),
  async (req, res) => {
    const { orderId, paymentId, signature } = req.valid.body;
    const payable = await findPayable({ 'payment.orderId': orderId, user: req.user._id });
    if (!payable) throw notFound('Payment order');
    if (!paymentGateway().verifyPayment({ orderId, paymentId, signature })) throw badRequest('Payment signature is invalid');
    res.json(await settle(payable, paymentId));
  },
);

// Gateway webhook. Needs the raw body for signature verification, so it is mounted with
// express.raw before the JSON parser. The tenant comes from the order notes set when it was created.
export const paymentWebhook = [
  express.raw({ type: 'application/json', limit: '1mb' }),
  async (req, res) => {
    const gateway = paymentGateway();
    const raw = req.body instanceof Buffer ? req.body.toString('utf8') : '';
    if (!gateway.verifyWebhook(raw, req.get('x-razorpay-signature') ?? req.get('x-webhook-signature'))) {
      return res.status(400).json({ error: { code: 'BAD_SIGNATURE', message: 'Invalid webhook signature' } });
    }

    const event = JSON.parse(raw);
    const payment = event.payload?.payment?.entity;
    const refund = event.payload?.refund?.entity;
    const tenant = payment?.notes?.tenant ?? refund?.notes?.tenant;
    const orderId = payment?.order_id;

    if (!tenant) return res.json({ ok: true, ignored: true });

    await runWithTenant(tenant, async () => {
      if (event.event === 'payment.captured' && orderId) {
        const payable = await findPayable({ 'payment.orderId': orderId });
        if (payable) await settle(payable, payment.id);
        // A vendor buying a plan (plans/subscription.service.js).
        const subscriptionOrder = !payable && (await SubscriptionOrder.findOne({ 'payment.orderId': orderId }));
        if (subscriptionOrder) await activateOrder(subscriptionOrder, payment.id);
      } else if (event.event === 'payment.failed' && orderId) {
        for (const Model of [Booking, ShopOrder]) {
          await Model.updateOne({ 'payment.orderId': orderId, 'payment.status': 'pending' }, { 'payment.status': 'failed', 'payment.failureReason': payment.error_description });
        }
        await failOrder(orderId, payment.error_description);
      } else if (event.event === 'refund.processed' && refund?.payment_id) {
        for (const Model of [Booking, ShopOrder]) {
          await Model.updateOne({ 'payment.paymentId': refund.payment_id }, { 'payment.status': 'refunded', 'payment.refundId': refund.id, 'payment.refundedAt': new Date() });
        }
      }
    });
    res.json({ ok: true });
  },
];

export default router;
