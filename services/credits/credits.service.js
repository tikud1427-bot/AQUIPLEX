"use strict";
const User       = require("../../models/User");
const BillingLog = require("../../models/BillingLog");
const { inferActionCost } = require("../../utils/subscription/plans");
const { createLogger } = require("../../utils/logger");

const log = createLogger("CREDITS");

// ── Deduct credits ─────────────────────────────────────────────────────────────

async function deductCredits(userId, cost, actionType = "unknown") {
  const user = await User.findById(userId);
  if (!user) throw new Error("USER_NOT_FOUND");

  // Downgrade if 30-day window expired
  await checkAndDowngradeIfExpired(user);

  user._resetIfNeeded();

  if (user.credits < cost) throw new Error("INSUFFICIENT_CREDITS");
  const dailyLimit = user._dailyLimit();
  if (user.dailyUsage + cost > dailyLimit) throw new Error("DAILY_LIMIT_EXCEEDED");

  user.credits    -= cost;
  user.dailyUsage += cost;
  await user.save();

  log.info(`Deducted ${cost} credits from user=${userId} action=${actionType} remaining=${user.credits}`);
  return { remaining: user.credits, deducted: cost };
}

// ── Refund credits ────────────────────────────────────────────────────────────

async function refundCredits(userId, cost, reason = "generation_failed") {
  const user = await User.findById(userId);
  if (!user) return;

  user.credits    = Math.min(user.credits + cost, user.monthlyCredits);
  user.dailyUsage = Math.max(0, user.dailyUsage - cost);
  await user.save();

  log.info(`Refunded ${cost} credits to user=${userId} reason=${reason}`);
  return { refunded: cost, remaining: user.credits };
}

// ── Credit summary ────────────────────────────────────────────────────────────

async function getCreditSummary(userId) {
  const user = await User.findById(userId);
  if (!user) throw new Error("USER_NOT_FOUND");

  await checkAndDowngradeIfExpired(user);
  user._resetIfNeeded();
  await user.save();
  return user.creditSummary();
}

// ── Cost estimation ───────────────────────────────────────────────────────────

function estimateCost(actionType) {
  return inferActionCost(actionType);
}

// ── Monthly reset cron ────────────────────────────────────────────────────────

async function runMonthlyResetCron() {
  const now   = new Date();
  const users = await User.find({ creditsResetAt: { $lte: now } });
  let count   = 0;

  for (const user of users) {
    try {
      user._resetIfNeeded();
      await user.save();
      count++;
    } catch (e) {
      log.error(`Monthly reset failed for user=${user._id}: ${e.message}`);
    }
  }

  log.info(`Monthly reset complete: ${count} users updated`);
  return { resetCount: count };
}

/**
 * checkAndDowngradeIfExpired
 *
 * Call on any user-facing action to lazily enforce 30-day billing window.
 * Returns true if user was downgraded.
 */
async function checkAndDowngradeIfExpired(user) {
  const now = new Date();

  // Active plan expired
  if (
    user.subscriptionStatus === "active" &&
    user.currentPeriodEnd &&
    now >= new Date(user.currentPeriodEnd)
  ) {
    log.info(`Downgrading user=${user._id} — 30-day window expired`);
    await user.resetToFreePlan();
    return true;
  }

  // Cancelled plan — keep access until end, then downgrade
  if (
    user.subscriptionStatus === "cancelled" &&
    user.currentPeriodEnd &&
    now >= new Date(user.currentPeriodEnd)
  ) {
    log.info(`Downgrading user=${user._id} — cancelled plan period ended`);
    await user.resetToFreePlan();
    return true;
  }

  return false;
}

module.exports = {
  deductCredits,
  refundCredits,
  getCreditSummary,
  estimateCost,
  runMonthlyResetCron,
  checkAndDowngradeIfExpired,
};
