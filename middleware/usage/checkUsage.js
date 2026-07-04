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
const { deductCredits, refundCredits }  = require("../../services/credits/wallet.service");
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

  const user = await User.findById(userId);
  if (!user) {
    return {
      allowed: false,
      status:  401,
      error:   "USER_NOT_FOUND",
      message: "User account not found. Please sign in again.",
    };
  }

  // ── 2. Lazy daily reset ──────────────────────────────────────────────────
  const wasReset = user.resetFreeCreditsIfNeeded();
  if (wasReset) {
    log.info(`[checkUsage] daily IST reset fired userId=${userId} email=${user.email} newFree=${user.wallet.freeCredits}`);
    await user.save();
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
    log.warn("[checkUsage] insufficient credits", { userId, email: user.email, total, cost, actionType });
    return {
      allowed:      false,
      status:       402,
      error:        "INSUFFICIENT_CREDITS",
      message:      "You don't have enough credits. Top up your wallet to continue.",
      upgradeUrl:   "/wallet",
      freeCredits:  user.wallet.freeCredits,
      paidCredits:  user.wallet.paidCredits,
      totalCredits: total,
      costRequired: cost,
      actionType,
      cta:          "Buy Credits",
    };
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
    const deductResult = await deductCredits(userId, cost, actionType);
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
        refund: () => {
          log.warn(`[checkUsage] REFUND issued userId=${userId} cost=${cost} actionType=${actionType}`);
          return refundCredits(userId, cost, `${actionType}_failed`);
        },
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

module.exports = { checkUsage, getUid };
