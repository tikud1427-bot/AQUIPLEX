"use strict";
/**
 * services/account/accountDeletion.service.js
 * AQUIPLEX — permanent account deletion (Google Play User Data policy).
 *
 * Two halves, one transaction-shaped sequence:
 *   1. ENGINE  — everything AQUA accumulated for this user (conversations,
 *                memory/mind, uploaded-file intelligence, artifacts,
 *                workspaces). Owned by aqua/src/account/accountPurge.js.
 *   2. PLATFORM — Mongo documents (user, wallet, billing) + every active
 *                session, so no device stays logged in after deletion.
 *
 * ORDER MATTERS. The engine runs FIRST: engine data is keyed by the platform
 * userId, so deleting the User document before the purge would orphan it
 * permanently with no key left to find it by. If the engine purge reports
 * errors we stop and surface them — a partial erasure is a failed deletion,
 * and the user must be able to retry against an account that still exists.
 *
 * REAUTHENTICATION is verified by the route before anything here runs (see
 * routes/account/account.routes.js) — this module never deletes on its own.
 *
 * RETENTION (disclosed on /delete-account and in the Privacy Policy):
 *   • BillingLog rows are ANONYMIZED (user reference unset), not deleted:
 *     each row carries the unique `webhookId` that makes Razorpay webhook
 *     delivery idempotent. Deleting them would let a replayed webhook credit
 *     a recreated account. No personal data remains on the row.
 *   • Directory submissions are reassigned to "anonymous" — they are public
 *     listings about third-party tools, not personal data.
 *   • Payment/Transaction documents ARE deleted here. Razorpay keeps its own
 *     records under financial-regulation retention; that copy is outside our
 *     systems and outside the user's account.
 */

const path     = require("path");
const bcrypt   = require("bcrypt");
const mongoose = require("mongoose");

const User        = require("../../models/User");
const Bundle      = require("../../models/Bundle");
const Tool        = require("../../models/Tool");
const Payment     = require("../../models/Payment");
const Transaction = require("../../models/Transaction");
const BillingLog  = require("../../models/BillingLog");

const { createLogger } = require("../../utils/logger");

const log = createLogger("ACCOUNT_DELETE");

/** Sentinel stored as the password for Google-created accounts (see index.js). */
const GOOGLE_SENTINEL = "google-oauth";

/** How long a completed OAuth reauthentication stays valid. */
const REAUTH_MAX_AGE_MS = 10 * 60 * 1000;

/** connect-mongo's default collection (see the session store in index.js). */
const SESSION_COLLECTION = "sessions";

// ── Identity ─────────────────────────────────────────────────────────────────

/**
 * Which credential proves ownership of this account.
 * Google accounts hold a sentinel instead of a real hash, so a password
 * prompt can never authenticate them — they must complete a fresh OAuth round
 * trip instead.
 * @returns {"password"|"google"}
 */
function authMethodFor(user) {
  return user && user.password === GOOGLE_SENTINEL ? "google" : "password";
}

/**
 * Verify that the caller just proved they own this account.
 *
 * Pure except for the bcrypt comparison — no database access, no mutation —
 * so the policy itself is unit-testable (tests/account/accountDeletion.test.js).
 *
 * @param {object}      args
 * @param {object}      args.user      the Mongoose user document
 * @param {object|null} args.reauth    session.accountDeleteReauth, if any
 * @param {string}      [args.password] submitted password (password accounts)
 * @param {number}      [args.now]     injectable clock
 * @returns {Promise<{ ok: boolean, method: string, error?: string, message?: string }>}
 */
async function verifyReauthentication({ user, reauth, password, now = Date.now() }) {
  const method = authMethodFor(user);

  if (method === "google") {
    if (!reauth || !reauth.at) {
      return {
        ok: false,
        method,
        error: "REAUTH_REQUIRED",
        message: "Confirm it's you with Google before deleting your account.",
      };
    }
    if (now - reauth.at > REAUTH_MAX_AGE_MS) {
      return {
        ok: false,
        method,
        error: "REAUTH_EXPIRED",
        message: "That confirmation expired. Sign in with Google again to continue.",
      };
    }
    // The OAuth round trip must have returned THIS account, not another one
    // the user happens to also be signed into.
    if (String(reauth.email || "").toLowerCase() !== String(user.email || "").toLowerCase()) {
      return {
        ok: false,
        method,
        error: "REAUTH_MISMATCH",
        message: "That Google account doesn't match the one you're signed in with.",
      };
    }
    return { ok: true, method };
  }

  if (!password) {
    return {
      ok: false,
      method,
      error: "PASSWORD_REQUIRED",
      message: "Enter your password to confirm deletion.",
    };
  }

  const matches = await bcrypt.compare(password, user.password);
  if (!matches) {
    return {
      ok: false,
      method,
      error: "PASSWORD_INCORRECT",
      message: "That password is incorrect.",
    };
  }

  return { ok: true, method };
}

// ── Engine erasure ───────────────────────────────────────────────────────────

/**
 * Load the engine's purge module. AQUA is ESM and lives in its own package;
 * the platform is CommonJS, so it is reached the same way index.js reaches
 * the engine router — a dynamic import(). Node's ESM cache is keyed by
 * resolved URL, so this returns the SAME live module instance (and therefore
 * the same in-memory stores) the mounted engine is using. Deleting through a
 * second copy of the stores would erase nothing.
 */
async function loadEnginePurge() {
  const url = require("url")
    .pathToFileURL(path.join(__dirname, "..", "..", "aqua", "src", "account", "accountPurge.js"))
    .href;
  return import(url);
}

// ── Platform erasure ─────────────────────────────────────────────────────────

/**
 * Delete every session belonging to this user so no other device, tab, or
 * mobile client stays authenticated. Sessions are stored by connect-mongo as
 * `{ _id, expires, session: "<json>" }`; the userId appears inside that JSON,
 * so the document is matched on the serialized payload. The id is a Mongo
 * ObjectId hex string, so it is safe to use directly in a regex.
 */
async function deleteSessions(userId) {
  const conn = mongoose.connection;
  if (!conn || conn.readyState !== 1) return 0;
  const res = await conn.collection(SESSION_COLLECTION).deleteMany({
    session: { $regex: String(userId) },
  });
  return res.deletedCount || 0;
}

/**
 * Permanently delete an account and everything associated with it.
 *
 * @param {object} args
 * @param {string} args.userId
 * @returns {Promise<{ ok: boolean, engine: object, platform: object, errors: string[] }>}
 */
async function deleteAccount({ userId }) {
  if (!userId) throw new Error("deleteAccount requires a userId");
  const uid = String(userId);

  // 1. ENGINE FIRST — see header. A failure here aborts before the account
  //    row (the only key back to this data) disappears.
  const { purgeOwnerData } = await loadEnginePurge();
  const engine = await purgeOwnerData({ userId: uid });

  if (engine.errors.length) {
    log.error(`Engine purge incomplete user=${uid}:`, engine.errors.join(" | "));
    return {
      ok: false,
      engine,
      platform: null,
      errors: engine.errors,
    };
  }

  // 2. PLATFORM — user-owned documents.
  const [bundles, payments, transactions, billing, tools] = await Promise.all([
    Bundle.deleteMany({ userId: uid }),
    Payment.deleteMany({ user: uid }),
    Transaction.deleteMany({ user: uid }),
    // Anonymized, not deleted — webhook idempotency (see header).
    BillingLog.updateMany({ user: uid }, { $unset: { user: "" } }),
    // Public directory listings — reassigned, not deleted (see header).
    Tool.updateMany({ submittedBy: uid }, { $set: { submittedBy: "anonymous" } }),
  ]);

  // 3. The account itself, then every session it opened. Sessions go last so
  //    a crash mid-way never leaves a live session for a deleted user.
  const userResult = await User.deleteOne({ _id: uid });
  const sessions   = await deleteSessions(uid);

  const platform = {
    user:             userResult.deletedCount || 0,
    bundles:          bundles.deletedCount || 0,
    payments:         payments.deletedCount || 0,
    transactions:     transactions.deletedCount || 0,
    billingAnonymized: billing.modifiedCount || 0,
    toolsAnonymized:  tools.modifiedCount || 0,
    sessions,
  };

  log.info(
    `Account deleted user=${uid} conversations=${engine.conversations} ` +
    `artifacts=${engine.artifacts} bundles=${platform.bundles} sessions=${platform.sessions}`,
  );

  return { ok: true, engine, platform, errors: [] };
}

module.exports = {
  deleteAccount,
  verifyReauthentication,
  authMethodFor,
  REAUTH_MAX_AGE_MS,
  GOOGLE_SENTINEL,
};
