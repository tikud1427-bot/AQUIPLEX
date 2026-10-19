#!/usr/bin/env node
"use strict";
/**
 * The ONLY supported way to grant or revoke unlimited credits (2026-10-19).
 *
 *   node scripts/admin/unlimited-entitlement.cjs --mongo <uri> --list
 *   node scripts/admin/unlimited-entitlement.cjs --mongo <uri> --grant  --user-id <id> --reason "<why>" --actor "<who>" [--apply]
 *   node scripts/admin/unlimited-entitlement.cjs --mongo <uri> --revoke --user-id <id> --reason "<why>" --actor "<who>" [--apply]
 *
 * - Dry run unless --apply. The Mongo URI must be passed explicitly; .env is
 *   never read, so this cannot touch production by accident.
 * - Accounts are addressed by id, never by email.
 * - A grant requires a VERIFIED account (emailVerified === true): unlimited
 *   credits are never attached to an address nobody proved they own.
 * - Every change writes an EntitlementAudit record (who, why, before/after).
 * - Output masks email addresses.
 */
const path = require("path");
const mongoose = require("mongoose");

const ROOT = path.join(__dirname, "..", "..");
const mask = (e) => { const s = String(e || ""); const at = s.indexOf("@"); return at > 0 ? `${s[0]}***${s.slice(at)}` : "***"; };

async function main(args = process.argv.slice(2)) {
  const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const has = (name) => args.includes(name);
  const uri = arg("--mongo");
  if (!uri) throw new Error("--mongo <uri> is required (the script never reads .env)");
  const mode = has("--grant") ? "grant" : has("--revoke") ? "revoke" : has("--list") ? "list" : null;
  if (!mode) throw new Error("one of --list, --grant, --revoke is required");
  if (mongoose.connection.readyState !== 1) await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, autoIndex: false, autoCreate: false });
  const User = require(path.join(ROOT, "models", "User.js"));
  const EntitlementAudit = require(path.join(ROOT, "models", "EntitlementAudit.js"));

  if (mode === "list") {
    const rows = await User.find({ isUnlimited: true }).select("_id email emailVerified").lean();
    console.log(`accounts with isUnlimited=true: ${rows.length}`);
    for (const r of rows) console.log(`  ${r._id}  ${mask(r.email)}  verified=${r.emailVerified === true}`);
    return;
  }

  const userId = arg("--user-id"), reason = arg("--reason"), actor = arg("--actor");
  if (!userId || !mongoose.isValidObjectId(userId)) throw new Error("--user-id <ObjectId> is required");
  if (!reason || reason.trim().length < 5) throw new Error('--reason "<why>" is required (5+ characters)');
  if (!actor || !actor.trim()) throw new Error('--actor "<who>" is required');

  const user = await User.findById(userId).select("_id email emailVerified isUnlimited").lean();
  if (!user) throw new Error("no such account");
  const after = mode === "grant";
  if (after && user.emailVerified !== true) throw new Error("refused: the account's email is not verified");
  console.log(`${mode} unlimited for ${user._id} (${mask(user.email)}): ${user.isUnlimited === true} → ${after}`);
  if (!has("--apply")) { console.log("dry run — nothing written. Re-run with --apply."); return; }

  const updated = await User.updateOne({ _id: user._id }, { $set: { isUnlimited: after } });
  try {
    await EntitlementAudit.create({ userId: user._id, action: `${mode}_unlimited`, reason: reason.trim(), actor: actor.trim(), before: user.isUnlimited === true, after });
  } catch (err) {
    // No change without its audit record.
    await User.updateOne({ _id: user._id }, { $set: { isUnlimited: user.isUnlimited === true } });
    throw new Error(`audit record failed, change reverted: ${err.message}`);
  }
  console.log(`done (matched ${updated.matchedCount}); audit recorded.`);
}

if (require.main === module) {
  main().then(() => mongoose.disconnect()).catch(async (err) => { console.error(`error: ${err.message}`); await mongoose.disconnect().catch(() => {}); process.exit(1); });
}

module.exports = { main };
