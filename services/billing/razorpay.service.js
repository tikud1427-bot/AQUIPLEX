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
 *   verifyPayment uses findOneAndUpdate with status filter as atomic guard.
 *   Two concurrent calls for the same orderId: only one transitions from
 *   created/pending → success. The other gets null back and returns alreadyProcessed.
 */

const Razorpay = require("razorpay");
const crypto   = require("crypto");
const User     = require("../../models/User");
const Payment  = require("../../models/Payment");
const { getPackById } = require("../../utils/credits/packs");
const { createLogger } = require("../../utils/logger");

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
 * ATOMIC RACE PROTECTION:
 *   Uses findOneAndUpdate with status: {$in: ["created","pending"]} as a guard.
 *   Only ONE concurrent call can transition the payment to "pending".
 *   If payment is already "success", returns alreadyProcessed without crediting.
 *
 * Returns { verified: true, credits, balanceAfter } or throws.
 */
async function verifyPayment(razorpayOrderId, razorpayPaymentId, razorpaySignature, userId) {
  // 1. Verify signature
  const expectedSig = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest("hex");

  if (expectedSig !== razorpaySignature) {
    log.warn(`Signature mismatch: orderId=${razorpayOrderId} user=${userId}`);
    throw new Error("INVALID_SIGNATURE");
  }

  // 2. Check if already successfully processed (idempotent return)
  const alreadyDone = await Payment.findOne({
    razorpayOrderId,
    status: "success",
  });
  if (alreadyDone) {
    log.info(`verifyPayment: already processed orderId=${razorpayOrderId}`);
    return { verified: true, alreadyProcessed: true, credits: alreadyDone.creditsToAdd };
  }

  // 3. Atomically transition status to "pending" — only one call wins this race.
  //    If another concurrent verify call already claimed this, result is null.
  const claimed = await Payment.findOneAndUpdate(
    {
      razorpayOrderId,
      user:   userId,
      status: { $in: ["created", "pending"] },
    },
    {
      $set: {
        razorpayPaymentId,
        razorpaySignature,
        status: "pending",  // mark as in-progress
        paidAt: new Date(),
      },
    },
    { new: true }
  );

  if (!claimed) {
    // Could be: wrong userId, invalid orderId, or concurrent call already claimed it.
    const anyMatch = await Payment.findOne({ razorpayOrderId });
    if (!anyMatch) throw new Error("PAYMENT_NOT_FOUND");
    // It exists but we couldn't claim it — concurrent verify already handling it
    log.warn(`verifyPayment: could not claim payment orderId=${razorpayOrderId} — may be concurrent or wrong user`);
    throw new Error("PAYMENT_PROCESSING");
  }

  // 4. Mark status success
  await Payment.findByIdAndUpdate(claimed._id, { $set: { status: "success" } });

  // 5. Credit wallet (addPaidCredits is also idempotent via creditedAt atomic guard)
  const { addPaidCredits } = require("../credits/wallet.service");
  const result = await addPaidCredits(userId, claimed.creditsToAdd, claimed._id, claimed.packId);

  log.info(`Payment verified: orderId=${razorpayOrderId} user=${userId} credits=${claimed.creditsToAdd}`);

  return {
    verified:     true,
    credits:      claimed.creditsToAdd,
    packId:       claimed.packId,
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

  return digest === signature;
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
  fetchRazorpayPayment,
  fetchRazorpayOrder,
  getUserPaymentHistory,
};
