"use strict";
/**
 * services/credits/credits.service.js
 * AQUIPLEX — LEGACY SHIM (v1 → v2 compatibility layer)
 *
 * The old v1 credits system used: monthlyCredits, subscriptionStatus,
 * creditsResetAt, dailyUsage (number), _resetIfNeeded(), creditSummary().
 *
 * All of these are REMOVED from User.js in v2.
 * This file is kept ONLY for backward compatibility if any stale import
 * still requires it. It delegates to the live wallet.service.
 *
 * DO NOT add new logic here. Use wallet.service.js for all credit ops.
 */

const { createLogger } = require("../../utils/logger");
const walletSvc = require("./wallet.service");

const log = createLogger("CREDITS_LEGACY");

async function deductCredits(userId, cost, actionType = "unknown") {
  log.warn(`[LEGACY credits.service] deductCredits called — delegating to wallet.service userId=${userId} cost=${cost}`);
  return walletSvc.deductCredits(userId, cost, actionType);
}

async function refundCredits(userId, cost, reason = "generation_failed") {
  log.warn(`[LEGACY credits.service] refundCredits called — delegating to wallet.service userId=${userId} amount=${cost}`);
  return walletSvc.refundCredits(userId, cost, reason);
}

async function getCreditSummary(userId) {
  log.warn(`[LEGACY credits.service] getCreditSummary called — delegating to wallet.service userId=${userId}`);
  return walletSvc.getWalletSummary(userId);
}

function estimateCost(actionType) {
  const { getActionCost } = require("../../utils/credits/packs");
  return getActionCost(actionType);
}

/**
 * runMonthlyResetCron — v1 monthly reset. No-op in v2 (daily reset only).
 */
async function runMonthlyResetCron() {
  log.info("[LEGACY credits.service] runMonthlyResetCron called — no-op in v2 wallet system");
  return { resetCount: 0, message: "v2 wallet system uses lazy daily reset only" };
}

/**
 * checkAndDowngradeIfExpired — v1 subscription downgrade. No-op in v2.
 */
async function checkAndDowngradeIfExpired(user) {
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
