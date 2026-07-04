"use strict";
/**
 * services/billing/webhook.handler.js
 * AQUIPLEX v2 — Razorpay webhook processor.
 *
 * Razorpay fires these events for one-time payments:
 *   payment.captured  → credit wallet (primary flow)
 *   payment.failed    → mark payment failed, notify
 *   order.paid        → backup confirmation (use if payment.captured missed)
 *   refund.processed  → deduct refunded credits
 *
 * Idempotency:
 *   Every processed webhook is recorded in WebhookLog with unique idempotencyKey.
 *   Duplicate deliveries are silently skipped.
 *
 * Note: Frontend verifyPayment is the PRIMARY credit path.
 * Webhook is the BACKUP/audit path for payments that complete but frontend fails.
 */

const Payment    = require("../../models/Payment");
const WebhookLog = require("../../models/WebhookLog");
const { addPaidCredits } = require("../credits/wallet.service");
const { createLogger }   = require("../../utils/logger");

const log = createLogger("WEBHOOK");

// ── Main dispatcher ───────────────────────────────────────────────────────────

async function handleWebhookEvent(event, payload) {
  // Build idempotency key from event + payment ID
  const paymentEntity = payload?.payload?.payment?.entity;
  const orderEntity   = payload?.payload?.order?.entity;
  const refundEntity  = payload?.payload?.refund?.entity;

  const uniqueId =
    paymentEntity?.id ||
    orderEntity?.id   ||
    refundEntity?.id  ||
    JSON.stringify(payload).slice(0, 64);

  const idempotencyKey = `${event}:${uniqueId}`;

  // Idempotency check
  try {
    await WebhookLog.create({ idempotencyKey, event, payload });
  } catch (e) {
    if (e.code === 11000) {
      log.info(`Duplicate webhook skipped: ${idempotencyKey}`);
      return { skipped: true };
    }
    throw e;
  }

  log.info(`Webhook: ${event} key=${idempotencyKey}`);

  try {
    let result;
    switch (event) {
      case "payment.captured":
        result = await onPaymentCaptured(paymentEntity);
        break;

      case "order.paid":
        result = await onOrderPaid(orderEntity, paymentEntity);
        break;

      case "payment.failed":
        result = await onPaymentFailed(paymentEntity);
        break;

      case "refund.processed":
        result = await onRefundProcessed(refundEntity);
        break;

      default:
        log.info(`Unhandled webhook event: ${event}`);
        result = { handled: false };
    }

    await WebhookLog.updateOne({ idempotencyKey }, { handled: true });
    return result;

  } catch (err) {
    await WebhookLog.updateOne({ idempotencyKey }, { error: err.message });
    throw err;
  }
}

// ── payment.captured ──────────────────────────────────────────────────────────

async function onPaymentCaptured(entity) {
  if (!entity) return { handled: false, reason: "NO_ENTITY" };

  const { id: rzpPaymentId, order_id: rzpOrderId } = entity;

  const payment = await Payment.findOne({ razorpayOrderId: rzpOrderId });
  if (!payment) {
    log.warn(`Webhook payment.captured: no Payment found for orderId=${rzpOrderId}`);
    return { handled: false, reason: "PAYMENT_NOT_FOUND" };
  }

  // Already credited (frontend verify already ran)
  if (payment.creditedAt || payment.status === "success") {
    log.info(`payment.captured: already processed orderId=${rzpOrderId}`);
    return { handled: true, alreadyProcessed: true };
  }

  // Mark payment success
  await Payment.findByIdAndUpdate(payment._id, {
    razorpayPaymentId: rzpPaymentId,
    status:            "success",
    paidAt:            new Date(),
  });

  // Credit wallet
  const result = await addPaidCredits(
    payment.user,
    payment.creditsToAdd,
    payment._id,
    payment.packId
  );

  log.info(`payment.captured: credited user=${payment.user} credits=${payment.creditsToAdd}`);
  return { handled: true, credited: payment.creditsToAdd, ...result };
}

// ── order.paid (backup path) ──────────────────────────────────────────────────

async function onOrderPaid(orderEntity, paymentEntity) {
  // Delegate to payment.captured logic
  return onPaymentCaptured(paymentEntity || { id: null, order_id: orderEntity?.id });
}

// ── payment.failed ────────────────────────────────────────────────────────────

async function onPaymentFailed(entity) {
  if (!entity) return { handled: false };

  const { order_id: rzpOrderId, error_description } = entity;

  await Payment.findOneAndUpdate(
    { razorpayOrderId: rzpOrderId, status: { $in: ["created", "pending"] } },
    { status: "failed", failureReason: error_description || "Payment failed" }
  );

  log.info(`payment.failed: orderId=${rzpOrderId} reason=${error_description}`);
  return { handled: true };
}

// ── refund.processed ──────────────────────────────────────────────────────────

async function onRefundProcessed(entity) {
  if (!entity) return { handled: false };

  // Note: We DO NOT deduct credits on refund in v2.
  // Refund is a financial event — credits already consumed cannot be taken back
  // (user may have used them). Admin can manually adjust via admin panel.
  // Just log the event.
  log.info(`refund.processed: refundId=${entity.id} amount=${entity.amount}`);
  return { handled: true, note: "Credits not deducted on refund by policy" };
}

module.exports = { handleWebhookEvent };
