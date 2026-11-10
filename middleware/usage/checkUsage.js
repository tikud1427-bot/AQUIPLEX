"use strict";
/**
 * middleware/usage/checkUsage.js
 * AQUIPLEX — Pure credit validation helper.
 *
 * NEVER calls next(). NEVER touches Express req/res lifecycle.
 * Safe to call from routes, sockets, services, cron — anywhere.
 *
 * Usage (non-Express):
 *   const { checkUsage } = require("../middleware/usage/checkUsage");
 *   const result = await checkUsage({ userId, actionType: "chat_message" });
 *   if (!result.allowed) { return { error: result.error, message: result.message }; }
 *   req.creditContext = result.creditContext;
 *
 * Returns:
 *   { allowed: true,  cost, actionType, creditContext: { refund, commit, balanceAfter, ... } }
 *   { allowed: false, status, error, message, ...extra }
 */

const User                              = require("../../models/User");
const { getActionCost }                 = require("../../utils/credits/packs");
const {
  deductCredits, refundCredits, refreshDailyAllowance,
} = require("../../services/credits/wallet.service");
const { FREE_DAILY_CREDITS } = require("../../utils/credits/freeAllowance");
const {
  hasUnlimitedAccess,
  unlimitedAccessReason,
} = require("../../utils/credits/unlimitedAccess");
const { createLogger } = require("../../utils/logger");

const log = createLogger("CHECK_USAGE");

// ── Auth helper (safe for non-Express too — just returns null if no req) ──────

function getUid(req) {
  return (
    req?.session?.userId    ||
    req?.session?.user?._id ||
    req?.user?._id          ||
    req?.user?.id           ||
    null
  );
}

// ── Pure validator ────────────────────────────────────────────────────────────

/**
 * checkUsage({ userId, actionType, deductOnEntry })
 *
 * @param {string}  userId        — Mongo user _id string
 * @param {string}  actionType    — key from CREDIT_COSTS (e.g. "chat_message")
 * @param {boolean} deductOnEntry — true: deduct now + expose refund(); false: check-only, expose commit()
 *
 * @returns {Promise<CheckResult>}
 *
 * CheckResult (allowed):
 *   { allowed: true, cost, actionType, creditContext: { userId, cost, actionType,
 *     deducted, unlimited, refund(), commit(), balanceAfter } }
 *
 * CheckResult (blocked):
 *   { allowed: false, status: 401|402, error: string, message: string, ...extra }
 */
/** Wrap fn so it runs at most once; later calls resolve false without running it. */
function onceOnly(fn) {
  let done = false;
  return () => {
    if (done) return Promise.resolve(false);
    done = true;
    return Promise.resolve().then(fn);
  };
}

/**
 * The 402 a user sees when they cannot afford an action. Someone who has never
 * bought credits ran out of TODAY'S free allowance; someone with a purchase
 * history ran out of what they bought. Different sentences, same doorway.
 */
function insufficientCredits(user, { userId, cost, actionType }) {
  const wallet = (user && user.wallet) || {};
  const free = Number(wallet.freeCredits || 0);
  const paid = Number(wallet.paidCredits || 0);
  const neverPurchased = !(wallet.totalEarned > 0);
  log.warn("[checkUsage] insufficient credits", { userId, total: free + paid, cost, actionType });
  try {
    require("../../services/analytics/productEvents")
      .recordProductEvent(userId, "credits_insufficient", { actionType, neverPurchased });
  } catch { /* analytics never blocks */ }
  return {
    allowed:      false,
    status:       402,
    error:        "INSUFFICIENT_CREDITS",
    reason:       neverPurchased ? "FREE_DAILY_EXHAUSTED" : "BALANCE_EXHAUSTED",
    message:      neverPurchased
      ? "Your daily free credits have been used. You can continue using Aqua by purchasing additional credits, or return when your daily allowance resets."
      : "You've used your available credits. You can continue by purchasing more credits, or return when your daily free allowance resets.",
    freeResetAt:  wallet.freeResetAt || null,
    freeDailyMax: FREE_DAILY_CREDITS,
    upgradeUrl:   "/pricing?next=/aqua",
    freeCredits:  free,
    paidCredits:  paid,
    totalCredits: free + paid,
    costRequired: cost,
    actionType,
    cta:          "View credit packs",
  };
}

async function checkUsage({ userId, actionType, deductOnEntry = true }) {
  // ── 1. Auth ──────────────────────────────────────────────────────────────
  if (!userId) {
    return {
      allowed: false,
      status:  401,
      error:   "LOGIN_REQUIRED",
      message: "Please sign in to continue.",
    };
  }

  // ── 2. Lazy daily reset (atomic — see wallet.service refreshDailyAllowance)
  // Also caps a free balance left above today's allowance by the old policy.
  const user = await refreshDailyAllowance(userId);
  if (!user) {
    return {
      allowed: false,
      status:  401,
      error:   "USER_NOT_FOUND",
      message: "User account not found. Please sign in again.",
    };
  }

  // ── 3. Resolve cost ──────────────────────────────────────────────────────
  const cost  = getActionCost(actionType);
  const total = user.wallet.freeCredits + user.wallet.paidCredits;

  // ── 4. Unlimited bypass ──────────────────────────────────────────────────
  const unlimited = hasUnlimitedAccess(user);
  if (unlimited) {
    const reason = unlimitedAccessReason(user);
    log.info("[checkUsage] unlimited bypass granted", { email: user.email, reason });
    return {
      allowed: true,
      cost,
      actionType,
      creditContext: {
        userId,
        cost,
        actionType,
        deducted:  false,
        unlimited: true,
        refund:    () => Promise.resolve(),
        commit:    () => Promise.resolve(),
        balanceAfter: {
          freeCredits:     user.wallet.freeCredits,
          paidCredits:     user.wallet.paidCredits,
          total,
          isUnlimited:     true,
          unlimitedReason: reason,
        },
      },
    };
  }

  // ── 5. Insufficient credits ──────────────────────────────────────────────
  if (cost > 0 && total < cost) {
    return insufficientCredits(user, { userId, cost, actionType });
  }

  // ── 6. Free action (cost === 0) ──────────────────────────────────────────
  if (cost === 0) {
    return {
      allowed: true,
      cost:    0,
      actionType,
      creditContext: {
        userId,
        cost:      0,
        actionType,
        deducted:  false,
        unlimited: false,
        refund:    () => Promise.resolve(),
        commit:    () => Promise.resolve(),
      },
    };
  }

  // ── 7. Deduct on entry (default) ─────────────────────────────────────────
  if (deductOnEntry) {
    let deductResult;
    try {
      deductResult = await deductCredits(userId, cost, actionType);
    } catch (err) {
      // A concurrent request spent the balance between the check above and
      // this debit. That is "out of credits", not a server error.
      if (err.message !== "INSUFFICIENT_CREDITS") throw err;
      const fresh = await User.findById(userId);
      return insufficientCredits(fresh || user, { userId, cost, actionType });
    }
    log.info(`[checkUsage] DEBIT userId=${userId} cost=${cost} actionType=${actionType} remaining=${deductResult.balanceAfter?.total}`);

    return {
      allowed: true,
      cost,
      actionType,
      creditContext: {
        userId,
        cost,
        actionType,
        deducted: true,
        // ONCE per request. Every call used to credit the wallet again, so two
        // failure paths (or a route handler plus the usageGuard safety net)
        // refunding the same request minted free credits.
        refund: onceOnly(() => {
          log.warn(`[checkUsage] REFUND issued userId=${userId} cost=${cost} actionType=${actionType}`);
          // The breakdown sends free credits back to today's free balance and
          // paid credits back to the paid balance — never free → paid.
          return refundCredits(userId, cost, `${actionType}_failed`, {
            fromFree:    deductResult.fromFree,
            fromPaid:    deductResult.fromPaid,
            freeResetAt: deductResult.freeResetAt,
          });
        }),
        commit:       () => Promise.resolve(), // already deducted
        balanceAfter: deductResult.balanceAfter,
      },
    };
  }

  // ── 8. Check-only mode — caller must call commit() after success ──────────
  return {
    allowed: true,
    cost,
    actionType,
    creditContext: {
      userId,
      cost,
      actionType,
      deducted: false,
      refund:   () => Promise.resolve(),
      commit:   () => deductCredits(userId, cost, actionType),
    },
  };
}

module.exports = { checkUsage, getUid, onceOnly, insufficientCredits };
