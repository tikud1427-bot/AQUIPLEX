#!/usr/bin/env node
"use strict";
/**
 * READ-ONLY audit of accounts, entitlements and payments affected by the
 * 2026-10-19 findings: pre-account takeover (S1), unlimited-credit bypass
 * (S2), and credit minting with the exposed Razorpay secrets.
 *
 *   node scripts/admin/account-security-audit.cjs --mongo <uri> [--allowlist-file <path>] [--since 2026-07-04] [--json out.json]
 *
 * - Performs NO writes: only find / countDocuments / distinct / aggregate.
 * - Refuses to run unless the database user is READ-ONLY (Atlas `read` role):
 *   the connection itself cannot write. --allow-write-capable-user exists for
 *   local test databases only. Mongoose index/collection auto-creation is off.
 * - Prints counts and account / order ids. Never emails, names, tokens,
 *   signatures or payload contents.
 * - The Mongo URI must be passed explicitly; .env is never read.
 * - --allowlist-file: a file with the UNLIMITED_USER_EMAILS value (comma or
 *   newline separated). The addresses are only compared, never printed.
 * - --since: start of the exposure window (default: the first commit of the
 *   leaked .env, 2026-07-04).
 *
 * What it can and cannot establish is in the report (AQUIPLEX_SECURITY_AND_VALIDATION_STATUS.md §5):
 * evidence for review, never a verdict. A forged webhook can only be
 * confirmed against Razorpay's own records (settlements / payments API).
 */
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const ROOT = path.join(__dirname, "..", "..");
const SENTINEL = "google-oauth";
const ids = (rows) => rows.map((r) => String(r._id ?? r));

/** Actions that change data. A read-only Atlas user (`read` role) has none of them. */
const WRITE_ACTIONS = new Set(["insert", "update", "remove", "createCollection", "dropCollection", "dropDatabase",
  "createIndex", "dropIndex", "renameCollectionSameDB", "collMod", "convertToCapped", "bypassDocumentValidation"]);

/**
 * Defence in depth: the code below only reads, but the CONNECTION should not
 * be able to write either. Refuses a user holding any write action, and an
 * unauthenticated connection (which on an auth-less server can do anything),
 * unless the operator explicitly accepts it with --allow-write-capable-user
 * (meant for local test databases only).
 */
async function assertReadOnlyConnection(db, { allowWriteCapable = false } = {}) {
  const status = await db.command({ connectionStatus: 1, showPrivileges: true });
  const users = status.authInfo?.authenticatedUsers ?? [];
  const actions = new Set((status.authInfo?.authenticatedUserPrivileges ?? []).flatMap((p) => p.actions ?? []));
  const writes = [...actions].filter((a) => WRITE_ACTIONS.has(a));
  if (allowWriteCapable) return { users: users.length, writes };
  if (!users.length) throw new Error("refused: unauthenticated connection — use a database user with only the `read` role (or --allow-write-capable-user for a local test database)");
  if (writes.length) throw new Error(`refused: this database user can write (${writes.slice(0, 4).join(", ")}…) — use a user with only the \`read\` role`);
  return { users: users.length, writes };
}

async function audit({ User, ProductEvent, Payment, Transaction, EntitlementAudit, db }, { allowlist = [], since }) {
  const out = { generatedAt: new Date().toISOString(), since: since.toISOString(), identity: {}, entitlements: {}, payments: {}, sessions: {} };

  // ── A. Identity ────────────────────────────────────────────────────────────
  const unverifiedPw = { password: { $ne: SENTINEL }, emailVerified: { $ne: true } };
  out.identity.accounts = await User.countDocuments({});
  out.identity.googleOnly = await User.countDocuments({ password: SENTINEL });
  out.identity.passwordAccounts = await User.countDocuments({ password: { $ne: SENTINEL } });
  out.identity.verified = await User.countDocuments({ emailVerified: true });
  out.identity.boundToGoogleIdentity = await User.countDocuments({ googleId: { $type: "string" } });
  const legacy = ids(await User.find(unverifiedPw).select("_id").lean());
  out.identity.unverifiedPasswordAccounts = legacy.length;

  // Login/signup events per method for those accounts (events carry no content).
  const ev = legacy.length ? await ProductEvent.find({ userId: { $in: legacy }, event: { $in: ["login", "signup_completed"] } })
    .select("userId event at props.method").sort({ at: 1 }).lean() : [];
  const byUser = new Map();
  for (const e of ev) { const a = byUser.get(e.userId) ?? []; a.push(e); byUser.set(e.userId, a); }
  const withGoogle = [], passwordAfterGoogle = [];
  for (const [uid, list] of byUser) {
    const firstGoogle = list.find((e) => e.props?.method === "google");
    if (!firstGoogle) continue;
    withGoogle.push(uid);
    // The strongest takeover signal: someone kept using the PASSWORD after the
    // address's owner had started signing in with Google.
    if (list.some((e) => e.props?.method === "email" && e.at > firstGoogle.at)) passwordAfterGoogle.push(uid);
  }
  out.identity.unverifiedPasswordWithGoogleSignIns = withGoogle;
  out.identity.passwordSignInsAfterFirstGoogleSignIn = passwordAfterGoogle;
  out.identity.note = "Product events exist only since analytics were added; accounts older than that have no event history (absence of evidence is not evidence of absence).";
  out.identity.oldestEvent = (await ProductEvent.findOne({}).sort({ at: 1 }).select("at").lean())?.at ?? null;

  // ── B. Entitlements ──────────────────────────────────────────────────────────
  const unlimited = await User.find({ isUnlimited: true }).select("_id emailVerified").lean();
  const audited = new Set(ids(await EntitlementAudit.distinct("userId", { action: "grant_unlimited" })));
  out.entitlements.isUnlimitedAccounts = unlimited.length;
  out.entitlements.isUnlimitedWithoutAuditRecord = unlimited.filter((u) => !audited.has(String(u._id))).map((u) => String(u._id));
  if (allowlist.length) {
    const held = await User.find({ email: { $in: allowlist } }).select("_id emailVerified password").lean();
    out.entitlements.allowlistedAddresses = allowlist.length;
    out.entitlements.allowlistedWithAccount = held.length;
    out.entitlements.allowlistedWithoutAccount = allowlist.length - held.length;   // could have been registered by anyone before the fix
    out.entitlements.allowlistedHeldByUnverifiedPasswordAccount = held.filter((u) => u.password !== SENTINEL && u.emailVerified !== true).map((u) => String(u._id));
  } else {
    out.entitlements.allowlist = "not checked (no --allowlist-file)";
  }

  // ── C. Payments (credit minting with the exposed Razorpay secrets) ──────────
  const success = await Payment.find({ status: "success", paidAt: { $gte: since } })
    .select("_id user razorpayOrderId webhookId creditedAt creditsToAdd paidAt razorpayPaymentId").lean();
  out.payments.successfulSinceExposure = success.length;
  out.payments.creditedViaWebhook = success.filter((p) => p.webhookId).length;
  out.payments.creditedViaClientVerify = success.filter((p) => !p.webhookId).length;
  out.payments.successWithoutPaymentId = success.filter((p) => !p.razorpayPaymentId).map((p) => String(p._id));
  // Every order to reconcile against Razorpay (orders only — no signatures).
  out.payments.ordersToReconcile = success.map((p) => ({ paymentDbId: String(p._id), orderId: p.razorpayOrderId, userId: String(p.user), credits: p.creditsToAdd, at: p.paidAt, via: p.webhookId ? "webhook" : "verify" }));
  // Credits that no successful payment explains.
  const purchaseNoPayment = await Transaction.find({ type: "PURCHASE", $or: [{ paymentId: null }, { paymentId: { $exists: false } }] }).select("_id user").lean();
  out.payments.purchaseTransactionsWithoutPayment = purchaseNoPayment.map((t) => String(t._id));
  const paidByUser = await Payment.aggregate([{ $match: { status: "success" } }, { $group: { _id: "$user", credits: { $sum: "$creditsToAdd" } } }]);
  const paid = new Map(paidByUser.map((r) => [String(r._id), r.credits]));
  const earners = await User.find({ "wallet.totalEarned": { $gt: 0 } }).select("_id wallet.totalEarned").lean();
  out.payments.earnedExceedsSuccessfulPayments = earners
    .filter((u) => (u.wallet?.totalEarned ?? 0) > (paid.get(String(u._id)) ?? 0))
    .map((u) => ({ userId: String(u._id), earned: u.wallet.totalEarned, backedByPayments: paid.get(String(u._id)) ?? 0 }));
  out.payments.adminAdjustments = await Transaction.countDocuments({ type: "ADMIN_ADJUST" });

  // ── D. Sessions (count only; contents never read) ───────────────────────────
  try { out.sessions.stored = await db.collection("sessions").estimatedDocumentCount(); } catch { out.sessions.stored = "unavailable"; }
  return out;
}

function readAllowlist(file) {
  if (!file) return [];
  return fs.readFileSync(file, "utf8").split(/[,\n\r]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

async function main(args = process.argv.slice(2)) {
  const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const uri = arg("--mongo");
  if (!uri) throw new Error("--mongo <uri> is required (the script never reads .env)");
  const since = new Date(arg("--since") || "2026-07-04T00:00:00Z");
  if (Number.isNaN(since.getTime())) throw new Error("--since must be a date");
  if (mongoose.connection.readyState !== 1) await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, autoIndex: false, autoCreate: false });
  await assertReadOnlyConnection(mongoose.connection.db, { allowWriteCapable: args.includes("--allow-write-capable-user") });
  const m = (f) => require(path.join(ROOT, "models", f));
  const report = await audit({ User: m("User.js"), ProductEvent: m("ProductEvent.js"), Payment: m("Payment.js"), Transaction: m("Transaction.js"), EntitlementAudit: m("EntitlementAudit.js"), db: mongoose.connection.db },
    { allowlist: readAllowlist(arg("--allowlist-file")), since });
  const i = report.identity, e = report.entitlements, p = report.payments;
  console.log(`accounts ${i.accounts} (google-only ${i.googleOnly}, password ${i.passwordAccounts}); verified ${i.verified}; bound to Google ${i.boundToGoogleIdentity}`);
  console.log(`unverified password accounts: ${i.unverifiedPasswordAccounts}; also signed in with Google: ${i.unverifiedPasswordWithGoogleSignIns.length}; password sign-ins AFTER the first Google sign-in: ${i.passwordSignInsAfterFirstGoogleSignIn.length}`);
  console.log(`isUnlimited accounts: ${e.isUnlimitedAccounts} (without audit record: ${e.isUnlimitedWithoutAuditRecord.length})` + (e.allowlistedAddresses != null
    ? `; allowlisted addresses ${e.allowlistedAddresses}: with account ${e.allowlistedWithAccount}, without ${e.allowlistedWithoutAccount}, held by an unverified password account ${e.allowlistedHeldByUnverifiedPasswordAccount.length}` : `; ${e.allowlist}`));
  console.log(`successful payments since ${report.since.slice(0, 10)}: ${p.successfulSinceExposure} (webhook ${p.creditedViaWebhook}, verify ${p.creditedViaClientVerify}); without payment id ${p.successWithoutPaymentId.length}; PURCHASE transactions without payment ${p.purchaseTransactionsWithoutPayment.length}; wallets earning more than their payments ${p.earnedExceedsSuccessfulPayments.length}; admin adjustments ${p.adminAdjustments}`);
  console.log(`sessions stored: ${report.sessions.stored}`);
  const json = arg("--json");
  if (json) { fs.writeFileSync(json, JSON.stringify(report, null, 2)); console.log(`full report (ids only): ${json}`); }
  return report;
}

if (require.main === module) {
  main().then(() => mongoose.disconnect()).catch(async (err) => { console.error(`error: ${err.message}`); await mongoose.disconnect().catch(() => {}); process.exit(1); });
}

module.exports = { audit, main, assertReadOnlyConnection, WRITE_ACTIONS };
