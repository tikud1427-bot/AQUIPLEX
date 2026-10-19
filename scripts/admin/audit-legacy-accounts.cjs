#!/usr/bin/env node
"use strict";
/**
 * Existing accounts under the pre-account-takeover defect (2026-10-19).
 *
 *   node scripts/admin/audit-legacy-accounts.cjs --mongo <uri> [--ids]
 *   node scripts/admin/audit-legacy-accounts.cjs --mongo <uri> --remove-unverified-passwords-of-google-users [--apply]
 *
 * READ-ONLY by default: counts only (with --ids, account ids — never emails).
 *
 * Before the fix, a password account could be created for any address and a
 * later Google sign-in for that address entered it. The accounts that matter:
 *   LEGACY_UNVERIFIED_PASSWORD  password set, address never verified
 *   …_WITH_GOOGLE_LOGINS        of those, ones that ALSO have Google sign-in
 *                               events — the shape a takeover leaves: someone
 *                               set the password, someone (possibly someone
 *                               else) signed in with Google.
 *
 * After the fix these accounts can no longer be entered with Google without an
 * explicit choice on /auth/link, and claiming removes the unverified password.
 * Until each owner signs in with Google again, a squatter's password still
 * opens the account. The optional remediation removes that password now for
 * the WITH_GOOGLE_LOGINS group (they demonstrably have Google access to the
 * address, which is their recovery path) and ends every session on them.
 * It modifies data: dry run unless --apply, and run it only with approval.
 *
 * The Mongo URI must be passed explicitly; .env is never read.
 */
const path = require("path");
const mongoose = require("mongoose");

const ROOT = path.join(__dirname, "..", "..");
const SENTINEL = "google-oauth";
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const has = (name) => args.includes(name);

async function audit({ User, ProductEvent }) {
  const unverifiedPassword = { password: { $ne: SENTINEL }, emailVerified: { $ne: true } };
  const total = await User.countDocuments({});
  const googleOnly = await User.countDocuments({ password: SENTINEL });
  const passwordAccounts = await User.countDocuments({ password: { $ne: SENTINEL } });
  const legacy = await User.find(unverifiedPassword).select("_id").lean();
  const legacyIds = legacy.map((u) => String(u._id));
  const withGoogle = legacyIds.length
    ? await ProductEvent.distinct("userId", { userId: { $in: legacyIds }, event: { $in: ["login", "signup_completed"] }, "props.method": "google" })
    : [];
  const verified = await User.countDocuments({ emailVerified: true });
  const boundToGoogle = await User.countDocuments({ googleId: { $type: "string" } });
  return { total, googleOnly, passwordAccounts, verified, boundToGoogle, legacyUnverifiedPassword: legacyIds.length, legacyUnverifiedPasswordWithGoogleLogins: withGoogle.map(String) };
}

async function removeUnverifiedPasswords({ User }, ids, apply) {
  if (!apply) return { wouldUpdate: ids.length };
  const res = await User.updateMany(
    { _id: { $in: ids }, password: { $ne: SENTINEL }, emailVerified: { $ne: true } },
    { $set: { password: SENTINEL }, $inc: { authVersion: 1 } }
  );
  return { updated: res.modifiedCount };
}

async function main() {
  const uri = arg("--mongo");
  if (!uri) throw new Error("--mongo <uri> is required (the script never reads .env)");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, autoIndex: false, autoCreate: false });
  const User = require(path.join(ROOT, "models", "User.js"));
  const ProductEvent = require(path.join(ROOT, "models", "ProductEvent.js"));
  const r = await audit({ User, ProductEvent });
  console.log(`accounts: ${r.total} (google-only ${r.googleOnly}, password ${r.passwordAccounts}); verified ${r.verified}; bound to a Google identity ${r.boundToGoogle}`);
  console.log(`legacy password accounts with an UNVERIFIED address: ${r.legacyUnverifiedPassword}`);
  console.log(`  …of which also signed in with Google (takeover shape): ${r.legacyUnverifiedPasswordWithGoogleLogins.length}`);
  if (has("--ids")) for (const id of r.legacyUnverifiedPasswordWithGoogleLogins) console.log(`  ${id}`);
  if (has("--remove-unverified-passwords-of-google-users")) {
    const out = await removeUnverifiedPasswords({ User }, r.legacyUnverifiedPasswordWithGoogleLogins, has("--apply"));
    console.log(has("--apply") ? `passwords removed and sessions ended: ${out.updated}` : `dry run — would update ${out.wouldUpdate}. Re-run with --apply.`);
  }
}

if (require.main === module) {
  main().then(() => mongoose.disconnect()).catch(async (err) => { console.error(`error: ${err.message}`); await mongoose.disconnect().catch(() => {}); process.exit(1); });
}

module.exports = { audit, removeUnverifiedPasswords };
