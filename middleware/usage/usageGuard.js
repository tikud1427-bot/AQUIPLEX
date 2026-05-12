"use strict";
/**
 * middleware/usage/usageGuard.js
 * AQUIPLEX v2 — Credit-check middleware for AI action routes.
 *
 * Usage:
 *   router.post('/generate', usageGuard('full_app_gen'), handler)
 *   router.post('/chat',     usageGuard((req) => req.body.mode === 'deep' ? 'deep_research' : 'chat_message'), handler)
 *
 * After guard passes:
 *   req.creditContext = { userId, cost, actionType, walletSnapshot }
 *
 * Deduction happens AFTER the action succeeds (in route handler via commitCredit).
 * Or use usageGuard with deductOnEntry: true for pre-deduct (with refund on failure).
 *
 * Free build bypass:
 *   Free users with 0 credits may generate ONE full app per daily reset cycle.
 *   req.freeFullBuild = true signals the route handler to mark usage after success.
 *   AI editing is NOT bypassed — ever.
 */

const User          = require("../../models/User");
const { getActionCost }  = require("../../utils/credits/packs");
const { deductCredits, refundCredits } = require("../../services/credits/wallet.service");
const {
  hasUnlimitedAccess,
  unlimitedAccessReason,
} = require("../../utils/credits/unlimitedAccess");
const { createLogger }   = require("../../utils/logger");

const log = createLogger("USAGE_MW");

// ── Auth helper ───────────────────────────────────────────────────────────────

function getUid(req) {
  return (
    req.session?.userId    ||
    req.session?.user?._id ||
    req.user?._id          ||
    req.user?.id           ||
    null
  );
}

// ── Main guard ────────────────────────────────────────────────────────────────

/**
 * usageGuard(actionTypeOrFn, options)
 *
 * options.deductOnEntry (default: true)
 *   true  → deduct before action, refund on failure. Use req.creditContext.refund() on error.
 *   false → only check balance. Call req.creditContext.commit() after successful action.
 */
function usageGuard(actionTypeOrFn = "default", options = {}) {
  const deductOnEntry = options.deductOnEntry !== false; // default true

  return async (req, res, next) => {
    const uid = getUid(req);
    if (!uid) {
      return res.status(401).json({
        error:   "LOGIN_REQUIRED",
        message: "Please sign in to continue.",
      });
    }

    try {
      const user = await User.findById(uid);
      if (!user) return res.status(401).json({ error: "USER_NOT_FOUND" });

      // Lazy daily reset
      const wasReset = user.resetFreeCreditsIfNeeded();
      if (wasReset) await user.save();

      const actionType = typeof actionTypeOrFn === "function"
        ? actionTypeOrFn(req)
        : actionTypeOrFn;

      const cost  = getActionCost(actionType);
      const total = user.wallet.freeCredits + user.wallet.paidCredits;
      const unlimited = hasUnlimitedAccess(user);

      if (unlimited) {
        log.info("[UsageGuard] unlimited bypass granted", {
          email: user.email,
          reason: unlimitedAccessReason(user),
        });

        req.creditContext = {
          userId: uid,
          cost,
          actionType,
          deducted: false,
          unlimited: true,

          refund: () => Promise.resolve(),
          commit: () => Promise.resolve(),

          balanceAfter: {
            freeCredits: user.wallet?.freeCredits || 0,
            paidCredits: user.wallet?.paidCredits || 0,
            total,
            isUnlimited: true,
            unlimitedReason: unlimitedAccessReason(user),
          },
        };

        return next();
      }

      if (total < cost) {
        log.warn("[UsageGuard] insufficient credits", {
          userId: uid,
          email: user.email,
          totalCredits: total,
          costRequired: cost,
          actionType,
        });

        return insufficientResponse(res, user, cost, actionType);
      }

      if (deductOnEntry) {
        // Deduct now — refund via req.creditContext.refund() if action fails
        const deductResult = await deductCredits(uid, cost, actionType);

        req.creditContext = {
          userId:     uid,
          cost,
          actionType,
          deducted:   true,
          refund:     () => refundCredits(uid, cost, `${actionType}_failed`),
          commit:     () => Promise.resolve(), // no-op (already deducted)
          balanceAfter: deductResult.balanceAfter,
        };
      } else {
        // Check-only mode — commit later
        req.creditContext = {
          userId:     uid,
          cost,
          actionType,
          deducted:   false,
          refund:     () => Promise.resolve(),
          commit:     () => deductCredits(uid, cost, actionType),
        };
      }

      next();

    } catch (err) {
      log.error("usageGuard error:", err.message);
      return res.status(500).json({ error: "USAGE_CHECK_FAILED" });
    }
  };
}

// ── Insufficient credits response ─────────────────────────────────────────────

function insufficientResponse(res, user, costRequired, actionType) {
  const freeCredits = user.wallet?.freeCredits || 0;
  const paidCredits = user.wallet?.paidCredits || 0;

  return res.status(402).json({
    error:        "INSUFFICIENT_CREDITS",
    message:      "You don't have enough credits. Top up your wallet to continue.",
    upgradeUrl:   "/wallet",
    freeCredits,
    paidCredits,
    totalCredits: freeCredits + paidCredits,
    costRequired,
    actionType,
    cta:          "Buy Credits",
  });
}

module.exports = { usageGuard };