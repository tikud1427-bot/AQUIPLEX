"use strict";
/**
 * services/credits/wallet.service.js
 * AQUIPLEX v2 — Atomic wallet operations.
 *
 * All credit mutations go through here. Never mutate wallet fields directly.
 *
 * Key design:
 *   - Every balance change is a single conditional findOneAndUpdate. The
 *     condition IS the invariant, so two app instances (or two requests on one
 *     instance) cannot both succeed against the same balance.
 *   - Daily free reset is a compare-and-set on wallet.freeResetAt: exactly one
 *     request grants the new day's allowance (2026-11-10 — previously a
 *     read-modify-write user.save() that concurrent requests could each run,
 *     re-granting the allowance over a deduction made in between).
 *   - Debits guard EACH bucket (free ≥ fromFree, paid ≥ fromPaid). The old
 *     guard checked only free+paid, so two concurrent debits that both planned
 *     to spend the last free credits drove freeCredits negative — spending
 *     free credits that did not exist.
 *   - Refunds return credits to the bucket they came from. The old refund put
 *     EVERYTHING into paidCredits, so a failed request paid for with today's
 *     free credits turned them into purchased credits that never expire.
 *   - addPaidCredits uses an atomic claim on Payment.creditedAt — exactly-once
 *     crediting across verify + webhook + retries.
 *   - Every mutation appends a Transaction document (ledger).
 */

const User        = require("../../models/User");
const Transaction = require("../../models/Transaction");
const { createLogger } = require("../../utils/logger");
const { hasUnlimitedAccess, unlimitedAccessReason } = require("../../utils/credits/unlimitedAccess");
const { FREE_DAILY_CREDITS, lowFreeThreshold } = require("../../utils/credits/freeAllowance");

const log = createLogger("WALLET");
const FREE_DAILY = FREE_DAILY_CREDITS;
const DEBIT_ATTEMPTS = 5;

/** Analytics are optional and must never affect a wallet operation. */
function track(userId, event, props) {
  try {
    require("../analytics/productEvents").recordProductEvent(userId, event, props);
  } catch { /* analytics never fails a wallet op */ }
}

// ── Daily allowance (atomic reset + policy cap) ───────────────────────────────

/**
 * refreshDailyAllowance
 * Bring the user's FREE balance up to date, atomically:
 *   1. If the daily reset is due, grant today's allowance — compare-and-set on
 *      the freeResetAt this caller read, so exactly one concurrent caller wins.
 *   2. If the free balance is above the current allowance (an account that
 *      still holds credits granted under the old 200/day policy), cap it.
 *      Logged to the ledger as ADMIN_ADJUST so the history explains the drop.
 * Paid credits are never read or written here.
 *
 * Accepts a user document or id. Returns the up-to-date document (or null).
 */
// A wallet field that exists only as a Mongoose default (in memory, not in
// the database): accounts created before the v2 wallet, or partially written.
// Every atomic update below filters on STORED values, so such an account
// could never be charged or reset — it saw "out of credits" forever. The
// missing fields are written once, each only where it is absent, so an
// existing value is never overwritten. freeResetAt is written in the past,
// which makes today's reset (75 free) apply on the next step.
const WALLET_FIELD_DEFAULTS = () => ({
  freeCredits: FREE_DAILY,
  paidCredits: 0,
  freeResetAt: new Date(0),
  totalEarned: 0,
  totalSpent:  0,
});

async function normalizeStoredWallet(user) {
  if (typeof user.$isDefault !== "function") return user;
  const defaults = WALLET_FIELD_DEFAULTS();
  const missing = Object.keys(defaults).filter((f) => user.$isDefault("wallet") || user.$isDefault(`wallet.${f}`));
  if (!missing.length) return user;
  for (const f of missing) {
    await User.updateOne(
      { _id: user._id, [`wallet.${f}`]: { $exists: false } },
      { $set: { [`wallet.${f}`]: defaults[f] } }
    );
  }
  log.info(`WALLET_NORMALIZED user=${user._id} filled=${missing.join(",")}`);
  return User.findById(user._id);
}

async function refreshDailyAllowance(userOrId, { now = () => new Date() } = {}) {
  let user = userOrId && userOrId.wallet ? userOrId : await User.findById(userOrId);
  if (!user) return null;
  if (hasUnlimitedAccess(user)) return user;
  user = await normalizeStoredWallet(user);
  if (!user) return null;

  for (let attempt = 0; attempt < 4; attempt++) {
    const resetAt = user.wallet?.freeResetAt ?? null;
    const due = !resetAt || now() >= resetAt;

    if (due) {
      const updated = await User.findOneAndUpdate(
        { _id: user._id, "wallet.freeResetAt": resetAt },
        { $set: { "wallet.freeCredits": FREE_DAILY, "wallet.freeResetAt": User.nextDayReset() } },
        { returnDocument: "after" }
      );
      if (updated) {
        log.info(`DAILY_RESET user=${user._id} free=${FREE_DAILY} next=${updated.wallet.freeResetAt?.toISOString?.()}`);
        return updated;
      }
      // Another request reset it first — read what it wrote and re-check.
      user = await User.findById(user._id);
      if (!user) return null;
      continue;
    }

    if ((user.wallet?.freeCredits ?? 0) > FREE_DAILY) {
      // Returns the PRE-image so the ledger can record what was removed.
      const before = await User.findOneAndUpdate(
        { _id: user._id, "wallet.freeCredits": { $gt: FREE_DAILY } },
        { $set: { "wallet.freeCredits": FREE_DAILY } },
        { returnDocument: "before" }
      );
      if (before) {
        const removed = before.wallet.freeCredits - FREE_DAILY;
        Transaction.create({
          user:         user._id,
          type:         "ADMIN_ADJUST",
          amount:       -removed,
          balanceAfter: { freeCredits: FREE_DAILY, paidCredits: before.wallet.paidCredits },
          description:  `Daily free allowance is now ${FREE_DAILY} credits`,
          breakdown:    { fromFree: removed, fromPaid: 0 },
          metadata:     { reason: "free_allowance_policy", allowance: FREE_DAILY },
        }).catch((e) => log.error("Allowance-cap ledger write failed:", e.message));
        log.info(`FREE_CAP user=${user._id} ${before.wallet.freeCredits} → ${FREE_DAILY} (paid untouched=${before.wallet.paidCredits})`);
      }
      user = await User.findById(user._id);
      if (!user) return null;
      continue;
    }

    return user;
  }
  return user;
}

// ── Deduct credits (atomic) ───────────────────────────────────────────────────

/**
 * deductCredits
 * Atomically consume credits: free first, then paid.
 * Throws "INSUFFICIENT_CREDITS" if total < cost.
 *
 * Returns { deducted, fromFree, fromPaid, freeResetAt, balanceAfter }.
 * `fromFree`/`fromPaid`/`freeResetAt` are what refundCredits needs to give the
 * credits back to the right bucket.
 */
async function deductCredits(userId, cost, actionType = "default", description = "") {
  if (!(cost > 0)) throw new Error("INVALID_COST");

  let user = await User.findById(userId);
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

  for (let attempt = 0; attempt < DEBIT_ATTEMPTS; attempt++) {
    user = await refreshDailyAllowance(user);
    if (!user) throw new Error("USER_NOT_FOUND");

    const free = Math.max(0, user.wallet.freeCredits || 0);
    const paid = Math.max(0, user.wallet.paidCredits || 0);
    if (free + paid < cost) throw new Error("INSUFFICIENT_CREDITS");

    const fromFree = Math.min(free, cost);
    const fromPaid = cost - fromFree;
    const freeResetAt = user.wallet.freeResetAt;

    // Each bucket guarded on its own, and pinned to the allowance period the
    // split was planned against. A concurrent debit that leaves enough in both
    // buckets does not make this fail; one that empties a bucket does, and we
    // re-plan against the fresh balance.
    const updated = await User.findOneAndUpdate(
      {
        _id: userId,
        "wallet.freeCredits": { $gte: fromFree },
        "wallet.paidCredits": { $gte: fromPaid },
        "wallet.freeResetAt": freeResetAt,
      },
      {
        $inc: {
          "wallet.freeCredits": -fromFree,
          "wallet.paidCredits": -fromPaid,
          "wallet.totalSpent":  cost,
        },
      },
      { returnDocument: "after" }
    );

    if (!updated) {
      user = await User.findById(userId);
      if (!user) throw new Error("USER_NOT_FOUND");
      continue;
    }

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

    // Free-allowance funnel signals — the moment a user crosses "low" and the
    // moment today's free credits run out. Fired once per crossing.
    const freeAfter = updated.wallet.freeCredits;
    const freeBefore = freeAfter + fromFree;
    const low = lowFreeThreshold(FREE_DAILY);
    if (fromFree > 0 && freeAfter === 0) {
      track(userId, "free_allowance_exhausted", { hasPaid: updated.wallet.paidCredits > 0 });
    } else if (fromFree > 0 && freeBefore > low && freeAfter <= low) {
      track(userId, "free_allowance_low", { remaining: freeAfter });
    }

    log.info(`DEBIT user=${userId} cost=${cost} fromFree=${fromFree} fromPaid=${fromPaid} remaining=${updated.wallet.freeCredits + updated.wallet.paidCredits}`);

    return {
      deducted:  cost,
      fromFree,
      fromPaid,
      freeResetAt,
      balanceAfter: {
        freeCredits: updated.wallet.freeCredits,
        paidCredits: updated.wallet.paidCredits,
        total:        updated.wallet.freeCredits + updated.wallet.paidCredits,
      },
    };
  }

  // Sustained contention: report the balance truthfully rather than guess.
  log.warn(`DEBIT contention user=${userId} cost=${cost} — gave up after ${DEBIT_ATTEMPTS} attempts`);
  throw new Error("INSUFFICIENT_CREDITS");
}

// ── Refund credits ────────────────────────────────────────────────────────────

/**
 * refundCredits
 * Return a failed request's credits to the bucket they came from.
 *
 *   fromPaid → paidCredits, always.
 *   fromFree → freeCredits, but ONLY while the same daily allowance is still
 *              running (freeResetAt unchanged) and never above the allowance.
 *              After the reset the user already has a fresh allowance; giving
 *              yesterday's free credits back would let them carry over.
 *
 * Without a breakdown (legacy callers) the amount goes to paidCredits — the
 * pre-2026-11-10 behaviour, kept only so an old call site cannot lose credits.
 * The only live caller (checkUsage) always passes the breakdown.
 */
async function refundCredits(userId, amount, reason = "generation_failed", breakdown = null) {
  if (!(amount > 0)) return;

  const user = await User.findById(userId);
  if (!user) return;
  if (hasUnlimitedAccess(user)) {
    log.info(`REFUND bypassed for unlimited user=${userId} reason=${unlimitedAccessReason(user)} amount=${amount}`);
    return;
  }

  const hasSplit = breakdown
    && Number.isFinite(breakdown.fromFree) && Number.isFinite(breakdown.fromPaid)
    && breakdown.fromFree >= 0 && breakdown.fromPaid >= 0
    && breakdown.fromFree + breakdown.fromPaid === amount;
  if (!hasSplit) log.warn(`REFUND without breakdown user=${userId} amount=${amount} — returning to paid (legacy)`);

  const fromFree = hasSplit ? breakdown.fromFree : 0;
  const fromPaid = hasSplit ? breakdown.fromPaid : amount;

  let updated = null;
  let toFree = 0;
  if (fromFree > 0 && breakdown.freeResetAt) {
    updated = await User.findOneAndUpdate(
      {
        _id: userId,
        "wallet.freeResetAt": breakdown.freeResetAt,
        "wallet.freeCredits": { $lte: FREE_DAILY - fromFree },
      },
      { $inc: { "wallet.freeCredits": fromFree, "wallet.paidCredits": fromPaid, "wallet.totalSpent": -amount } },
      { returnDocument: "after" }
    );
    if (updated) toFree = fromFree;
  }
  if (!updated && fromPaid > 0) {
    // The free part (if any) expired with yesterday's allowance; the paid part
    // is always returned.
    updated = await User.findOneAndUpdate(
      { _id: userId },
      { $inc: { "wallet.paidCredits": fromPaid, "wallet.totalSpent": -fromPaid } },
      { returnDocument: "after" }
    );
  }

  if (!updated) {
    log.info(`REFUND user=${userId} amount=${amount} reason=${reason} — nothing returned (free allowance already reset)`);
    return;
  }

  const refunded = toFree + fromPaid;
  Transaction.create({
    user:        userId,
    type:        "REFUND",
    amount:      refunded,
    balanceAfter: {
      freeCredits: updated.wallet.freeCredits,
      paidCredits: updated.wallet.paidCredits,
    },
    description: `Refund: ${reason}`,
    // For a REFUND the breakdown records where the credits went back to.
    breakdown:   { fromFree: toFree, fromPaid },
  }).catch((e) => log.error("Refund ledger write failed:", e.message));

  log.info(`REFUND user=${userId} amount=${refunded} toFree=${toFree} toPaid=${fromPaid} reason=${reason}`);
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
async function addPaidCredits(userId, amount, paymentId, packId, { via = "unknown" } = {}) {
  if (!(amount > 0)) throw new Error("INVALID_AMOUNT");

  const Payment = require("../../models/Payment");

  // ATOMIC claim: set creditedAt only if not already set.
  // If another call already claimed it, claimed will be null.
  const claimed = await Payment.findOneAndUpdate(
    {
      _id:        paymentId,
      creditedAt: { $exists: false },  // atomic guard — only succeeds once
    },
    {
      $set: { creditedAt: new Date() },
    },
    { returnDocument: "after" }
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
    { returnDocument: "after" }
  );

  if (!updated) {
    // Undo the creditedAt claim so it can be retried
    await Payment.findByIdAndUpdate(paymentId, { $unset: { creditedAt: 1 } });
    throw new Error("USER_NOT_FOUND");
  }

  // The purchase event is recorded HERE and only here: once per payment,
  // after verification, after the exclusive creditedAt claim, and the moment
  // the credits exist — before the ledger write, so a failing ledger write
  // cannot leave a credited purchase missing from the funnel.
  track(userId, "purchase_credited", {
    packId,
    credits: amount,
    amountPaise: claimed.amountPaise,
    firstPurchase: updated.wallet.totalEarned === amount,
    via,
  });

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

  log.info(`PURCHASE user=${userId} credits=${amount} packId=${packId} payment=${paymentId} via=${via}`);

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
  const user = await refreshDailyAllowance(userId);
  if (!user) throw new Error("USER_NOT_FOUND");

  const summary = user.walletSummary();
  return {
    ...summary,
    freeLowThreshold: lowFreeThreshold(FREE_DAILY),
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
  refreshDailyAllowance,
  getWalletSummary,
  getTransactionHistory,
  FREE_DAILY,
};
