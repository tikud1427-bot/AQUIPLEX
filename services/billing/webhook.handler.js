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
 *   Every delivery is recorded in WebhookLog with a unique idempotencyKey.
 *   A duplicate of a delivery that was HANDLED is skipped. A duplicate of one
 *   that failed (or never finished) is processed again — before 2026-11-10 it
 *   was skipped too, so a transient DB error on the first delivery meant
 *   Razorpay's retry was dropped and a paying user was never credited.
 *   Re-processing is safe: crediting is exactly-once via Payment.creditedAt.
 *
 * Note: Frontend verifyPayment is the PRIMARY credit path.
 * Webhook is the BACKUP/audit path for payments that complete but frontend fails.
 */

const Payment    = require("../../models/Payment");
const WebhookLog = require("../../models/WebhookLog");
const { addPaidCredits } = require("../credits/wallet.service");
const { createLogger }   = require("../../utils/logger");

const log = createLogger("WEBHOOK");

function track(userId, event, props) {
  try {
    require("../analytics/productEvents").recordProductEvent(userId, event, props);
  } catch { /* analytics never fails a webhook */ }
}

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
    if (e.code !== 11000) throw e;
    const prior = await WebhookLog.findOne({ idempotencyKey }).lean();
    if (prior?.handled) {
      log.info(`Duplicate webhook skipped: ${idempotencyKey}`);
      return { skipped: true };
    }
    log.warn(`Redelivery of an unhandled webhook — processing again: ${idempotencyKey}`);
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

    await WebhookLog.updateOne({ idempotencyKey }, { handled: true, error: null });
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

  // Already credited (frontend verify already ran). creditedAt is the only
  // truth: status "success" without creditedAt is a half-finished credit
  // that this delivery must complete, not skip.
  if (payment.creditedAt) {
    log.info(`payment.captured: already credited orderId=${rzpOrderId}`);
    return { handled: true, alreadyProcessed: true };
  }

  // Defence in depth: the order fixed the amount, so a captured amount or
  // currency that disagrees with what we priced is not something to credit.
  if (Number.isFinite(entity.amount) && entity.amount !== payment.amountPaise) {
    log.error(`payment.captured: amount mismatch orderId=${rzpOrderId} captured=${entity.amount} expected=${payment.amountPaise} — NOT credited`);
    return { handled: false, reason: "AMOUNT_MISMATCH" };
  }
  if (entity.currency && entity.currency !== "INR") {
    log.error(`payment.captured: currency mismatch orderId=${rzpOrderId} currency=${entity.currency} — NOT credited`);
    return { handled: false, reason: "CURRENCY_MISMATCH" };
  }

  // Mark payment success (rzpPaymentId may be null on the order.paid path)
  const set = { status: "success", paidAt: new Date() };
  if (rzpPaymentId) set.razorpayPaymentId = rzpPaymentId;
  await Payment.updateOne({ _id: payment._id, creditedAt: { $exists: false } }, { $set: set, $unset: { failureReason: 1 } });

  // Credit wallet — exactly once (Payment.creditedAt claim)
  const result = await addPaidCredits(
    payment.user,
    payment.creditsToAdd,
    payment._id,
    payment.packId,
    { via: "webhook" }
  );

  if (result.alreadyCredited) {
    log.info(`payment.captured: credited concurrently by verify orderId=${rzpOrderId}`);
    return { handled: true, alreadyProcessed: true };
  }

  log.info(`payment.captured: credited user=${payment.user} credits=${payment.creditsToAdd}`);
  return { handled: true, credited: payment.creditsToAdd, ...result };
}

// ── order.paid (backup path) ──────────────────────────────────────────────────

async function onOrderPaid(orderEntity, paymentEntity) {
  // Delegate to payment.captured logic. Without a payment entity, check the
  // order's paid amount instead of the payment's.
  return onPaymentCaptured(paymentEntity || {
    id: null,
    order_id: orderEntity?.id,
    amount: Number.isFinite(orderEntity?.amount_paid) ? orderEntity.amount_paid : undefined,
    currency: orderEntity?.currency,
  });
}

// ── payment.failed ────────────────────────────────────────────────────────────

async function onPaymentFailed(entity) {
  if (!entity) return { handled: false };

  const { order_id: rzpOrderId, error_description } = entity;

  // Never downgrades a credited/successful order: a failed FIRST attempt can
  // arrive after the successful retry on the same order.
  const updated = await Payment.findOneAndUpdate(
    { razorpayOrderId: rzpOrderId, status: { $in: ["created", "pending"] }, creditedAt: { $exists: false } },
    { status: "failed", failureReason: error_description || "Payment failed" }
  );
  if (updated) track(updated.user, "checkout_failed", { stage: "payment" });

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
