"use strict";
/**
 * services/credits/wallet.service.js
 * AQUIPLEX v2 — Atomic wallet operations.
 *
 * All credit mutations go through here. Never mutate wallet fields directly.
 *
 * Key design:
 *   - Uses findOneAndUpdate with $inc for atomicity (no read-modify-write race)
 *   - addPaidCredits uses atomic findOneAndUpdate on Payment to set creditedAt
 *     as a single operation — prevents double-credit from concurrent calls
 *   - Every mutation appends a Transaction document (ledger)
 */

const mongoose   = require("mongoose");
const User        = require("../../models/User");
const Transaction = require("../../models/Transaction");
const { createLogger } = require("../../utils/logger");
const { hasUnlimitedAccess, unlimitedAccessReason } = require("../../utils/credits/unlimitedAccess");

const log = createLogger("WALLET");
const FREE_DAILY = parseInt(process.env.FREE_DAILY_CREDITS || "200", 10);

// ── Deduct credits (atomic) ───────────────────────────────────────────────────

/**
 * deductCredits
 * Atomically consume credits: free first, then paid.
 * Throws "INSUFFICIENT_CREDITS" if total < cost.
 *
 * Returns { deducted, fromFree, fromPaid, balanceAfter }
 */
async function deductCredits(userId, cost, actionType = "default", description = "") {
  if (cost <= 0) throw new Error("INVALID_COST");

  // Fetch current wallet, applying lazy daily reset
  const user = await User.findById(userId);
  if (!user) throw new Error("USER_NOT_FOUND");

  if (hasUnlimitedAccess(user)) {
    const snapshot = user.walletSummary();
    log.info(`DEBIT bypassed for unlimited user=${userId} reason=${unlimitedAccessReason(user)} cost=${cost}`);
    return {
      deducted:  0,
      fromFree:  0,
      fromPaid:  0,
      unlimited: true,
      balanceAfter: {
        freeCredits: snapshot.freeCredits,
        paidCredits: snapshot.paidCredits,
        total: snapshot.totalCredits,
        isUnlimited: true,
        unlimitedReason: snapshot.unlimitedReason,
      },
    };
  }

  // Lazy daily reset
  const wasReset = user.resetFreeCreditsIfNeeded();
  if (wasReset) await user.save();

  const free = user.wallet.freeCredits;
  const paid = user.wallet.paidCredits;

  if (free + paid < cost) {
    throw new Error("INSUFFICIENT_CREDITS");
  }

  // Calculate split
  const fromFree = Math.min(free, cost);
  const fromPaid = cost - fromFree;

  // Atomic update using $inc
  const updated = await User.findOneAndUpdate(
    {
      _id:  userId,
      // Guard: ensure balance is still sufficient at update time
      $expr: {
        $gte: [{ $add: ["$wallet.freeCredits", "$wallet.paidCredits"] }, cost],
      },
    },
    {
      $inc: {
        "wallet.freeCredits": -fromFree,
        "wallet.paidCredits": -fromPaid,
        "wallet.totalSpent":  cost,
      },
    },
    { new: true }
  );

  if (!updated) {
    // Race condition — another request consumed credits between our read and write
    throw new Error("INSUFFICIENT_CREDITS");
  }

  // Append to ledger (non-blocking — fire and forget with error log)
  Transaction.create({
    user:        userId,
    type:        "DEBIT",
    amount:      -cost,
    balanceAfter: {
      freeCredits: updated.wallet.freeCredits,
      paidCredits: updated.wallet.paidCredits,
    },
    actionType,
    actionCost:  cost,
    description: description || `AI action: ${actionType}`,
    breakdown:   { fromFree, fromPaid },
  }).catch((e) => log.error("Transaction ledger write failed:", e.message));

  log.info(`DEBIT user=${userId} cost=${cost} fromFree=${fromFree} fromPaid=${fromPaid} remaining=${updated.wallet.freeCredits + updated.wallet.paidCredits}`);

  return {
    deducted:  cost,
    fromFree,
    fromPaid,
    balanceAfter: {
      freeCredits: updated.wallet.freeCredits,
      paidCredits: updated.wallet.paidCredits,
      total:        updated.wallet.freeCredits + updated.wallet.paidCredits,
    },
  };
}

// ── Refund credits ────────────────────────────────────────────────────────────

/**
 * refundCredits
 * Return credits to paid balance after failed generation.
 * Does NOT restore free credits (prevents free credit inflation via retries).
 */
async function refundCredits(userId, amount, reason = "generation_failed") {
  if (amount <= 0) return;

  const user = await User.findById(userId);
  if (user && hasUnlimitedAccess(user)) {
    log.info(`REFUND bypassed for unlimited user=${userId} reason=${unlimitedAccessReason(user)} amount=${amount}`);
    return;
  }

  const updated = await User.findOneAndUpdate(
    { _id: userId },
    { $inc: { "wallet.paidCredits": amount, "wallet.totalSpent": -amount } },
    { new: true }
  );

  if (!updated) return;

  Transaction.create({
    user:        userId,
    type:        "REFUND",
    amount,
    balanceAfter: {
      freeCredits: updated.wallet.freeCredits,
      paidCredits: updated.wallet.paidCredits,
    },
    description: `Refund: ${reason}`,
    breakdown:   { fromFree: 0, fromPaid: 0 },
  }).catch((e) => log.error("Refund ledger write failed:", e.message));

  log.info(`REFUND user=${userId} amount=${amount} reason=${reason}`);
}

// ── Add paid credits (after successful payment) ───────────────────────────────

/**
 * addPaidCredits
 * Atomically credit purchased credits to wallet.
 *
 * IDEMPOTENCY DESIGN:
 *   Step 1: Atomically set creditedAt on Payment ONLY IF creditedAt is unset.
 *           findOneAndUpdate with $exists:false guard — if another concurrent
 *           call already set it, this returns null → we return alreadyCredited.
 *   Step 2: Only if step 1 succeeded, credit the user wallet.
 *   Step 3: Write ledger entry.
 *
 *   This ensures credits are added EXACTLY ONCE even with:
 *   - Concurrent webhook + verify calls
 *   - Razorpay webhook retries
 *   - Network retries
 *
 * Returns { credited, balanceAfter } or { alreadyCredited: true }
 */
async function addPaidCredits(userId, amount, paymentId, packId) {
  if (amount <= 0) throw new Error("INVALID_AMOUNT");

  const Payment = require("../../models/Payment");

  // ATOMIC claim: set creditedAt only if not already set.
  // If another call already claimed it, updated will be null.
  const claimed = await Payment.findOneAndUpdate(
    {
      _id:        paymentId,
      creditedAt: { $exists: false },  // atomic guard — only succeeds once
    },
    {
      $set: { creditedAt: new Date() },
    },
    { new: true }
  );

  if (!claimed) {
    // Either payment not found, or creditedAt was already set by a concurrent call.
    const existing = await Payment.findById(paymentId);
    if (!existing) throw new Error("PAYMENT_NOT_FOUND");
    log.info(`Credits already credited for payment=${paymentId} — skipping (idempotent)`);
    return { alreadyCredited: true };
  }

  // We are the exclusive claimer — now credit the wallet
  const updated = await User.findOneAndUpdate(
    { _id: userId },
    {
      $inc: {
        "wallet.paidCredits": amount,
        "wallet.totalEarned": amount,
      },
    },
    { new: true }
  );

  if (!updated) {
    // Undo the creditedAt claim so it can be retried
    await Payment.findByIdAndUpdate(paymentId, { $unset: { creditedAt: 1 } });
    throw new Error("USER_NOT_FOUND");
  }

  // Ledger entry
  await Transaction.create({
    user:        userId,
    type:        "PURCHASE",
    amount,
    balanceAfter: {
      freeCredits: updated.wallet.freeCredits,
      paidCredits: updated.wallet.paidCredits,
    },
    paymentId,
    description: `Purchased ${amount} credits (${packId} pack)`,
    breakdown:   { fromFree: 0, fromPaid: 0 },
    metadata:    { packId },
  });

  log.info(`PURCHASE user=${userId} credits=${amount} packId=${packId} payment=${paymentId}`);

  return {
    credited: amount,
    balanceAfter: {
      freeCredits: updated.wallet.freeCredits,
      paidCredits: updated.wallet.paidCredits,
      total:        updated.wallet.freeCredits + updated.wallet.paidCredits,
    },
  };
}

// ── Get wallet summary ────────────────────────────────────────────────────────

async function getWalletSummary(userId) {
  const user = await User.findById(userId);
  if (!user) throw new Error("USER_NOT_FOUND");

  const wasReset = user.resetFreeCreditsIfNeeded();
  if (wasReset) await user.save();

  const summary = user.walletSummary();
  return {
    ...summary,
    isUnlimited: hasUnlimitedAccess(user),
    unlimitedReason: unlimitedAccessReason(user),
  };
}

// ── Get transaction history ───────────────────────────────────────────────────

async function getTransactionHistory(userId, limit = 30, skip = 0) {
  return Transaction.find({ user: userId })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();
}

module.exports = {
  deductCredits,
  refundCredits,
  addPaidCredits,
  getWalletSummary,
  getTransactionHistory,
};