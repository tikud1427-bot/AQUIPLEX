"use strict";
/**
 * services/billing/razorpay.service.js
 * AQUIPLEX v2 — Razorpay Orders API + Standard Checkout integration.
 *
 * Uses ONLY:
 *   - Razorpay Orders API (POST /v1/orders)
 *   - Standard Checkout (frontend SDK)
 *   - Payment verification (HMAC-SHA256)
 *
 * Does NOT use: subscriptions, recurring, mandates, autopay, tokenization.
 *
 * RACE PROTECTION:
 *   Crediting is exactly-once through the atomic Payment.creditedAt claim in
 *   wallet.service addPaidCredits. Two concurrent verify calls (or verify +
 *   webhook) for the same order: one credits, the other returns
 *   alreadyProcessed. "Already done" is decided by creditedAt, never by status.
 */

const Razorpay = require("razorpay");
const crypto   = require("crypto");
const User     = require("../../models/User");
const Payment  = require("../../models/Payment");
const { getPackById } = require("../../utils/credits/packs");
const { createLogger } = require("../../utils/logger");

/** Constant-time compare of two hex HMAC digests; false on any shape mismatch. */
function hexDigestEquals(expectedHex, givenHex) {
  if (typeof givenHex !== "string" || !/^[0-9a-f]+$/i.test(givenHex)) return false;
  const a = Buffer.from(expectedHex, "hex");
  const b = Buffer.from(givenHex, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const log = createLogger("RAZORPAY");

// ── Razorpay client (lazy-init, singleton) ────────────────────────────────────

let _rzp = null;
function getRzp() {
  if (_rzp) return _rzp;
  const keyId     = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new Error("RAZORPAY credentials not configured in env");
  _rzp = new Razorpay({ key_id: keyId, key_secret: keySecret });
  return _rzp;
}

// ── Create Razorpay order ─────────────────────────────────────────────────────

/**
 * createOrder
 * Creates a Razorpay order and a local Payment document.
 *
 * Returns { orderId, amount, currency, packId, packName, credits, keyId }
 * for the frontend Razorpay Standard Checkout config.
 */
async function createOrder(userId, packId) {
  const user = await User.findById(userId);
  if (!user) throw new Error("USER_NOT_FOUND");

  const pack = getPackById(packId);
  if (!pack) throw new Error("INVALID_PACK");

  const amountPaise = pack.priceINR * 100;

  // Create Razorpay order
  const rzpOrder = await getRzp().orders.create({
    amount:   amountPaise,
    currency: "INR",
    receipt:  `aqx_${userId.toString().slice(-8)}_${Date.now()}`,
    notes: {
      userId:  userId.toString(),
      packId,
      credits: pack.credits.toString(),
      source:  "aquiplex_wallet",
    },
  });

  // Persist Payment record.
  // IMPORTANT: webhookId and razorpayPaymentId are intentionally omitted here.
  // Setting them to null/undefined would defeat the sparse unique index.
  const payment = await Payment.create({
    user:             userId,
    packId,
    amountPaise,
    creditsToAdd:     pack.credits,
    razorpayOrderId:  rzpOrder.id,
    status:           "created",
    metadata: {
      packName:  pack.name,
      priceINR:  pack.priceINR,
      rzpReceipt: rzpOrder.receipt,
    },
  });

  log.info(`Order created: rzpOrderId=${rzpOrder.id} user=${userId} pack=${packId} amount=₹${pack.priceINR}`);

  return {
    orderId:     rzpOrder.id,
    paymentDbId: payment._id.toString(),
    amount:      amountPaise,
    currency:    "INR",
    packId,
    packName:    pack.name,
    credits:     pack.credits,
    priceINR:    pack.priceINR,
    keyId:       process.env.RAZORPAY_KEY_ID,
    prefill: {
      email:   user.billingEmail || user.email,
      contact: user.phone || "",
    },
  };
}

// ── Verify payment signature (called from frontend after checkout) ─────────────

/**
 * verifyPayment
 * Verifies Razorpay signature, atomically marks payment success, credits wallet.
 *
 * Razorpay signs: HMAC-SHA256(orderId + "|" + paymentId, key_secret)
 *
 * EXACTLY-ONCE CREDITING:
 *   Payment.creditedAt is claimed atomically inside addPaidCredits, so a
 *   concurrent verify, the webhook, and any retry credit the wallet once.
 *   A payment whose creditedAt is set returns alreadyProcessed.
 *
 * Returns { verified: true, credits, balanceAfter } or throws.
 */
async function verifyPayment(razorpayOrderId, razorpayPaymentId, razorpaySignature, userId) {
  // 1. Verify signature
  const expectedSig = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest("hex");

  if (!hexDigestEquals(expectedSig, razorpaySignature)) {
    log.warn(`Signature mismatch: orderId=${razorpayOrderId} user=${userId}`);
    throw new Error("INVALID_SIGNATURE");
  }

  // 2. Find THIS user's order. Another user's order id is "not found" — the
  //    route must not confirm that someone else's order exists.
  const payment = await Payment.findOne({ razorpayOrderId, user: userId });
  if (!payment) throw new Error("PAYMENT_NOT_FOUND");

  // 3. Already credited? creditedAt is the truth (2026-11-10). It used to be
  //    status === "success", which is written BEFORE the wallet is credited:
  //    a crash or DB error between the two writes left an order "success" with
  //    no credits, and every later verify (and the webhook) skipped it as done.
  if (payment.creditedAt) {
    log.info(`verifyPayment: already credited orderId=${razorpayOrderId}`);
    return { verified: true, alreadyProcessed: true, credits: payment.creditsToAdd, packId: payment.packId };
  }

  // 4. Record the verified payment. Any status may move to success here —
  //    including "failed": Razorpay lets a customer retry on the same order,
  //    so a failed first attempt (payment.failed webhook) followed by a
  //    successful second one is normal, and the signature above proves the
  //    second one. Previously that order could not be claimed and the paying
  //    user got PAYMENT_PROCESSING.
  await Payment.updateOne(
    { _id: payment._id, creditedAt: { $exists: false } },
    {
      $set: {
        razorpayPaymentId,
        razorpaySignature,
        status: "success",
        paidAt: new Date(),
      },
      $unset: { failureReason: 1 },
    }
  );

  // 5. Credit wallet — exactly once across verify, webhook and retries
  //    (addPaidCredits claims Payment.creditedAt atomically).
  const { addPaidCredits } = require("../credits/wallet.service");
  const result = await addPaidCredits(userId, payment.creditsToAdd, payment._id, payment.packId, { via: "verify" });

  if (result.alreadyCredited) {
    log.info(`verifyPayment: credited concurrently (webhook/verify) orderId=${razorpayOrderId}`);
    return { verified: true, alreadyProcessed: true, credits: payment.creditsToAdd, packId: payment.packId };
  }

  log.info(`Payment verified: orderId=${razorpayOrderId} user=${userId} credits=${payment.creditsToAdd}`);

  return {
    verified:     true,
    credits:      payment.creditsToAdd,
    packId:       payment.packId,
    balanceAfter: result.balanceAfter || null,
  };
}

// ── Webhook signature verification ───────────────────────────────────────────

/**
 * verifyWebhookSignature
 * Razorpay signs webhook with HMAC-SHA256(rawBody, RAZORPAY_WEBHOOK_SECRET).
 * Digest is hex-encoded.
 */
function verifyWebhookSignature(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) throw new Error("RAZORPAY_WEBHOOK_SECRET not set");

  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  return hexDigestEquals(digest, signature);
}

// ── Get payment status from Razorpay (for reconciliation) ────────────────────

async function fetchRazorpayPayment(razorpayPaymentId) {
  return getRzp().payments.fetch(razorpayPaymentId);
}

async function fetchRazorpayOrder(razorpayOrderId) {
  return getRzp().orders.fetch(razorpayOrderId);
}

// ── Get user payment history ──────────────────────────────────────────────────

async function getUserPaymentHistory(userId, limit = 20) {
  return Payment.find({ user: userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

module.exports = {
  createOrder,
  verifyPayment,
  verifyWebhookSignature,
  hexDigestEquals,
  fetchRazorpayPayment,
  fetchRazorpayOrder,
  getUserPaymentHistory,
};
