"use strict";
/**
 * utils/credits/freeAllowance.js
 * AQUIPLEX — the daily free-credit allowance. ONE source of truth.
 *
 * Policy (2026-11-10): 75 free credits per user per day, reset at IST
 * midnight, never accumulated across days. Purchased credits are a separate
 * balance and are never touched by the daily reset.
 *
 * Before this module the default lived in four places (User.js,
 * wallet.service.js, billing.routes.js, pricing.ejs), each with its own
 * `process.env.FREE_DAILY_CREDITS || 200`. Changing one and not the others is
 * exactly how a pricing page drifts from what the server enforces.
 *
 * FREE_DAILY_CREDITS in the environment still overrides the policy (operators
 * may need to run a promotion without a deploy), but an override that differs
 * from the policy is announced once at boot — a stale `FREE_DAILY_CREDITS=200`
 * left in a deployment would otherwise silently keep the old allowance.
 */

const POLICY_FREE_DAILY_CREDITS = 75;

function parseAllowance(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const n = Number(String(raw).trim());
  return Number.isInteger(n) && n >= 0 ? n : null;
}

const envValue = parseAllowance(process.env.FREE_DAILY_CREDITS);
const FREE_DAILY_CREDITS = envValue ?? POLICY_FREE_DAILY_CREDITS;

let _announced = false;
/** Log once if the environment overrides the policy (or is unparseable). */
function announceAllowance(logger = console) {
  if (_announced) return;
  _announced = true;
  const raw = process.env.FREE_DAILY_CREDITS;
  if (raw !== undefined && String(raw).trim() !== "" && envValue === null) {
    logger.warn(`[CREDITS] FREE_DAILY_CREDITS="${String(raw).slice(0, 16)}" is not a non-negative integer — using the policy value ${POLICY_FREE_DAILY_CREDITS}.`);
  } else if (envValue !== null && envValue !== POLICY_FREE_DAILY_CREDITS) {
    logger.warn(`[CREDITS] FREE_DAILY_CREDITS=${envValue} overrides the ${POLICY_FREE_DAILY_CREDITS}-credit daily policy. Remove it (or set it to ${POLICY_FREE_DAILY_CREDITS}) unless this is intentional.`);
  } else {
    logger.log(`[CREDITS] daily free allowance = ${FREE_DAILY_CREDITS} credits`);
  }
}

/**
 * The "running low" line for the free allowance: three chat messages' worth,
 * never more than a fifth of the allowance. With 75/day and 5/message that is
 * 15 credits — the moment a user has three messages left today.
 */
function lowFreeThreshold(allowance = FREE_DAILY_CREDITS, messageCost = 5) {
  return Math.max(0, Math.min(messageCost * 3, Math.floor(allowance / 5)));
}

module.exports = {
  POLICY_FREE_DAILY_CREDITS,
  FREE_DAILY_CREDITS,
  parseAllowance,
  announceAllowance,
  lowFreeThreshold,
};
