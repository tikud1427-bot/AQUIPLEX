"use strict";
/**
 * middleware/usage/featureGuard.js
 * AQUIPLEX — Per-feature daily limit enforcement for free users.
 *
 * Usage:
 *   router.post('/generate-image', featureGuard('imageGen'), handler)
 *
 * Features: imageGen | codeMode | webSearch | websiteGen | websiteEdit
 *
 * On pass:  req.featureContext = { feature, used, limit, user }
 *           Call req.featureContext.commit() AFTER successful action to increment.
 * On block: 429 JSON with friendly message + upgrade CTA.
 *
 * Unlimited users bypass all limits.
 */

const User = require("../../models/User");
const { createLogger } = require("../../utils/logger");
const { getISTDateStr } = require("../../utils/date/getISTDayRange");

const log = createLogger("FEATURE_GUARD");

const FEATURE_LABELS = {
  imageGen:    "image generation",
  codeMode:    "code mode",
  webSearch:   "web search",
  websiteGen:  "website generation",
  websiteEdit: "website editing",
};

function getUid(req) {
  return (
    req.session?.userId    ||
    req.session?.user?._id ||
    req.user?._id          ||
    req.user?.id           ||
    null
  );
}

function featureGuard(feature) {
  return async (req, res, next) => {
    if (typeof next !== "function") {
      log.error("[FeatureGuard] CRITICAL: next is not a function — featureGuard called outside middleware chain. Route:", req?.originalUrl);
      return res?.status?.(500)?.json?.({ error: "MIDDLEWARE_CONFIG_ERROR" });
    }
    const uid = getUid(req);
    if (!uid) {
      return res.status(401).json({ error: "LOGIN_REQUIRED", message: "Please sign in to continue." });
    }

    try {
      const user = await User.findById(uid);
      if (!user) return res.status(401).json({ error: "USER_NOT_FOUND" });

      // Lazy resets
      const walletReset = user.resetFreeCreditsIfNeeded();
      const usageReset  = user.resetDailyUsageIfNeeded();
      if (walletReset || usageReset) await user.save();

      const { allowed, used, limit } = user.checkFeatureLimit(feature);

      if (!allowed) {
        const label = FEATURE_LABELS[feature] || feature;
        log.warn(`[FeatureGuard] limit reached feature=${feature} userId=${uid} used=${used}/${limit}`);
        return res.status(429).json({
          error:       "DAILY_LIMIT_REACHED",
          feature,
          featureLabel: label,
          used,
          limit,
          remaining:   0,
          message:     `You've used all ${limit} free ${label}${limit === 1 ? "" : "s"} for today.`,
          detail:      `Your free daily allowance resets at midnight. Buy credits to continue now.`,
          upgradeUrl:  "/wallet",
          resetAt:     user.wallet.freeResetAt,
          cta:         "Buy Credits",
        });
      }

      req.featureContext = {
        feature,
        used,
        limit,
        remaining: limit - used,
        userId: String(uid),
        commit: async () => {
          // FIXED: Single atomic write avoids double-increment race from two-query pattern.
          // Try matched-date $inc first; if stale/missing, reset then set feature=1.
          const today = getISTDateStr();
          const matched = await User.findOneAndUpdate(
            { _id: uid, "dailyUsage.date": today },
            { $inc: { [`dailyUsage.${feature}`]: 1 } },
            { new: false }
          );
          if (!matched) {
            await User.findOneAndUpdate(
              { _id: uid },
              {
                $set: {
                  "dailyUsage.date":        today,
                  "dailyUsage.imageGen":    0,
                  "dailyUsage.codeMode":    0,
                  "dailyUsage.webSearch":   0,
                  "dailyUsage.websiteGen":  0,
                  "dailyUsage.websiteEdit": 0,
                  [`dailyUsage.${feature}`]: 1,
                },
              }
            );
          }
          log.info(`[FeatureGuard] commit feature=${feature} userId=${uid} date=${today}`);
        },
      };

      next();
    } catch (err) {
      log.error("[featureGuard] unexpected error:", err.message, "\n", err.stack);
      return res.status(500).json({
        error:   "FEATURE_CHECK_FAILED",
        message: "We couldn't check your daily usage right now. Please try again in a moment.",
      });
    }
  };
}

module.exports = { featureGuard, FEATURE_LABELS };
