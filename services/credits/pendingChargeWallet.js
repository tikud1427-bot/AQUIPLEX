"use strict";
/**
 * Phase 4B — the wallet side of pending-charge recovery.
 *
 * aqua/src/credits/pendingCharges.js owns the charge STATE (Postgres); this
 * module gives it the wallet OPERATIONS (Mongo), each idempotent on the charge
 * id. The usage guard (checkUsage) and the reconciler (worker job
 * credits.reconcile.v1, scripts/charges-reconcile.mjs) both use it, so there is
 * exactly one way a charge touches a wallet.
 */
const path = require("path");
const { pathToFileURL } = require("url");
const User = require("../../models/User");
const { deductCredits, refundCharge } = require("./wallet.service");

let modPromise = null;
/** The ESM state machine, or null when AQUA_PENDING_CHARGES is not on (or no database). */
async function loadPendingCharges() {
  modPromise ??= import(pathToFileURL(path.join(__dirname, "..", "..", "aqua", "src", "credits", "pendingCharges.js")).href);
  const mod = await modPromise;
  return mod.pendingChargesEnabled() ? mod : null;
}

function createWalletAdapter({ description = "" } = {}) {
  return {
    async debit({ chargeId, userId, amount, actionType }) {
      const r = await deductCredits(userId, amount, actionType, description, { chargeId });
      return { applied: !r.alreadyApplied && !r.unlimited, unlimited: !!r.unlimited,
        fromFree: r.fromFree ?? 0, fromPaid: r.fromPaid ?? 0, freeResetAt: r.freeResetAt ?? null, balanceAfter: r.balanceAfter };
    },
    async refund({ chargeId, userId, amount, reason, breakdown }) {
      return refundCharge({ chargeId, userId, amount, reason: reason || "request_failed", breakdown });
    },
    async userExists(userId) {
      return Boolean(await User.exists({ _id: userId }));
    },
  };
}

module.exports = { loadPendingCharges, createWalletAdapter };
