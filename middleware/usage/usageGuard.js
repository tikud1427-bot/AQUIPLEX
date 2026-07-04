"use strict";
/**
 * middleware/usage/usageGuard.js
 * AQUIPLEX — Express middleware wrapper for credit checking.
 *
 * This file ONLY handles Express plumbing: calling next(), sending res.
 * All validation logic lives in checkUsage.js.
 *
 * Usage (Express routes only):
 *   router.post('/generate', usageGuard('full_app_gen'), handler)
 *   router.post('/chat',     usageGuard((req) => req.body.mode === 'deep' ? 'deep_research' : 'chat_message'), handler)
 *
 * For non-Express callers (sockets, services, cron):
 *   const { checkUsage } = require("./checkUsage");
 *   const result = await checkUsage({ userId, actionType: "chat_message" });
 *
 * After guard passes:
 *   req.creditContext = { userId, cost, actionType, deducted, refund(), commit(), balanceAfter }
 */

const { checkUsage, getUid } = require("./checkUsage");
const { createLogger }       = require("../../utils/logger");

const log = createLogger("USAGE_MW");

function usageGuard(actionTypeOrFn = "default", options = {}) {
  const deductOnEntry = options.deductOnEntry !== false;

  return async (req, res, next) => {
    try {
      const userId = getUid(req);
      const actionType = typeof actionTypeOrFn === "function"
        ? actionTypeOrFn(req)
        : actionTypeOrFn;

      log.info(`[usageGuard] checking userId=${userId} actionType=${actionType} route=${req.originalUrl}`);

      const result = await checkUsage({ userId, actionType, deductOnEntry });

      if (!result.allowed) {
        const { allowed, status, ...body } = result;
        return res.status(status || 500).json(body);
      }

      req.creditContext = result.creditContext;
      log.info(`[usageGuard] PASS userId=${userId} actionType=${actionType} cost=${result.cost} route=${req.originalUrl}`);
      next();

    } catch (err) {
      log.error("[usageGuard] unexpected error:", err.message, "\n", err.stack);
      return res.status(500).json({
        error:   "USAGE_CHECK_FAILED",
        message: "We couldn't verify your usage right now. Please try again in a moment.",
      });
    }
  };
}

module.exports = { usageGuard };
