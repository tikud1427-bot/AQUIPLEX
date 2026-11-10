#!/usr/bin/env node
"use strict";
/**
 * Cap existing free balances at the current daily allowance (2026-11-10).
 *
 *   node scripts/admin/free-allowance-cap.cjs --mongo <uri>            # dry run: count only
 *   node scripts/admin/free-allowance-cap.cjs --mongo <uri> --apply    # write
 *
 * You do NOT need to run this for the policy to apply. Every wallet read and
 * every debit already caps a free balance above the allowance, atomically
 * (services/credits/wallet.service.js refreshDailyAllowance). This script only
 * makes stored balances match that immediately — e.g. for reporting.
 *
 * - Dry run unless --apply. The Mongo URI must be passed explicitly; .env is
 *   never read, so this cannot touch production by accident.
 * - Touches ONLY wallet.freeCredits, and only where it is above the allowance.
 *   paidCredits, totalEarned, totalSpent and every other field are untouched.
 * - Idempotent: a second run finds nothing to change.
 * - Each change is recorded in the ledger (Transaction ADMIN_ADJUST), the same
 *   record the lazy cap writes. Nothing is deleted.
 * - Unlimited accounts are skipped (they have no free balance to cap).
 * - Refuses to run when this shell's FREE_DAILY_CREDITS differs from the
 *   75-credit policy, unless --confirm-allowance is passed.
 */
const path = require("path");
const mongoose = require("mongoose");

const ROOT = path.join(__dirname, "..", "..");

async function main(args = process.argv.slice(2), { log = console.log } = {}) {
  const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const uri = arg("--mongo");
  if (!uri) throw new Error("--mongo <uri> is required (the script never reads .env)");
  const apply = args.includes("--apply");
  const { FREE_DAILY_CREDITS, POLICY_FREE_DAILY_CREDITS } = require(path.join(ROOT, "utils", "credits", "freeAllowance.js"));
  const { hasUnlimitedAccess } = require(path.join(ROOT, "utils", "credits", "unlimitedAccess.js"));

  // The cap target comes from THIS shell's environment. A stray
  // FREE_DAILY_CREDITS here (a sourced .env, a typo) would cap every account
  // to the wrong number, so a value other than the policy must be confirmed.
  if (FREE_DAILY_CREDITS !== POLICY_FREE_DAILY_CREDITS && !args.includes("--confirm-allowance")) {
    throw new Error(`this shell has FREE_DAILY_CREDITS=${FREE_DAILY_CREDITS}, not the ${POLICY_FREE_DAILY_CREDITS}-credit policy. ` +
      "Unset it, or re-run with --confirm-allowance if that value is really what production uses.");
  }
  if (!String(process.env.UNLIMITED_USER_EMAILS || "").trim()) {
    log("note: UNLIMITED_USER_EMAILS is not set in this shell — accounts unlimited ONLY by that allowlist are treated as normal here " +
      "(harmless: unlimited accounts are never charged, but they would get an ADMIN_ADJUST ledger row).");
  }

  if (mongoose.connection.readyState !== 1) await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, autoIndex: false, autoCreate: false });
  const User = require(path.join(ROOT, "models", "User.js"));
  const Transaction = require(path.join(ROOT, "models", "Transaction.js"));

  const candidates = await User.find({ "wallet.freeCredits": { $gt: FREE_DAILY_CREDITS } })
    .select("_id email role isUnlimited emailVerified wallet").lean();
  const eligible = candidates.filter((u) => !hasUnlimitedAccess(u));
  const excess = eligible.reduce((s, u) => s + (u.wallet.freeCredits - FREE_DAILY_CREDITS), 0);

  log(`allowance: ${FREE_DAILY_CREDITS} free credits/day`);
  log(`accounts above it: ${eligible.length} (skipped unlimited: ${candidates.length - eligible.length}); free credits above allowance: ${excess}`);
  if (!apply) { log("dry run — nothing written. Re-run with --apply."); return { eligible: eligible.length, changed: 0 }; }

  let changed = 0;
  for (const u of eligible) {
    // Conditional: a debit or reset since the read above is respected.
    const before = await User.findOneAndUpdate(
      { _id: u._id, "wallet.freeCredits": { $gt: FREE_DAILY_CREDITS } },
      { $set: { "wallet.freeCredits": FREE_DAILY_CREDITS } },
      { returnDocument: "before" }
    ).lean();
    if (!before) continue;
    const removed = before.wallet.freeCredits - FREE_DAILY_CREDITS;
    await Transaction.create({
      user: u._id,
      type: "ADMIN_ADJUST",
      amount: -removed,
      balanceAfter: { freeCredits: FREE_DAILY_CREDITS, paidCredits: before.wallet.paidCredits },
      description: `Daily free allowance is now ${FREE_DAILY_CREDITS} credits`,
      breakdown: { fromFree: removed, fromPaid: 0 },
      metadata: { reason: "free_allowance_policy", allowance: FREE_DAILY_CREDITS, source: "admin_script" },
    });
    changed++;
  }
  log(`done: ${changed} account(s) capped; paid credits untouched.`);
  return { eligible: eligible.length, changed };
}

if (require.main === module) {
  main().then(() => mongoose.disconnect()).catch(async (err) => { console.error(`error: ${err.message}`); await mongoose.disconnect().catch(() => {}); process.exit(1); });
}

module.exports = { main };
