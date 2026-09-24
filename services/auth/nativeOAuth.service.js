"use strict";
/**
 * services/auth/nativeOAuth.service.js
 *
 * The server-side half of docs/OAUTH_NATIVE_HANDOFF.md (aqua-android repo):
 * Chrome and the Android WebView have separate cookie jars, so the browser
 * leg of Google OAuth cannot leave a session the WebView can see. This
 * module mints a short-lived, single-use, hashed handoff code the WebView
 * itself redeems, so the session cookie is set on a request the WebView
 * actually made.
 *
 * PURE VS DB, SPLIT ON PURPOSE
 * -----------------------------
 * index.js cannot be required in a test process (see tests/account/
 * sessionLogout.test.js for why). validateNonce/generateCode/hashCode need
 * no DB and are tested directly. mintNativeCode/redeemNativeCode take an
 * injectable Model + clock so their logic (hashing, expiry, single-use) is
 * tested against a fake store with the same test-double pattern already
 * used in tests/account/sessionLogout.test.js, without requiring a live
 * Mongo connection.
 */
const crypto = require("crypto");
const DefaultNativeOAuthCode = require("../../models/NativeOAuthCode");

/** Reject a nonce longer than this without inspecting it further. */
const NONCE_MAX_LENGTH = 64;

/** Contract: ~120s TTL (docs/OAUTH_NATIVE_HANDOFF.md). */
const CODE_TTL_MS = 120 * 1000;

/** 256 bits of CSPRNG entropy per the contract. */
const CODE_BYTES = 32;

/**
 * Validates a nonce supplied on the `/auth/google?native=1&nonce=` leg.
 * Returns the nonce unchanged when acceptable, or null when the caller
 * should treat this as an ordinary (non-native) OAuth request — see the
 * call site in index.js for why "ignore" rather than "error page" is the
 * safer failure mode here.
 */
function validateNonce(raw) {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > NONCE_MAX_LENGTH) return null;
  return raw;
}

/** A fresh one-time code. Never logged, never stored raw — see hashCode. */
function generateCode() {
  return crypto.randomBytes(CODE_BYTES).toString("base64url");
}

/** SHA-256 of a code, hex-encoded. This is what actually gets stored. */
function hashCode(code) {
  return crypto.createHash("sha256").update(code, "utf8").digest("hex");
}

/**
 * Mints a one-time native handoff code for `userId` and stores its hash.
 * Called from GET /auth/google/callback once Passport has authenticated the
 * user on a request that started as `native=1`.
 *
 * @returns {Promise<{code: string, expiresAt: Date}>} `code` is the raw,
 *   unhashed value to put in the redirect URL exactly once. It is not
 *   recoverable afterward — only its hash is persisted.
 */
async function mintNativeCode(userId, { Model = DefaultNativeOAuthCode, now = () => new Date() } = {}) {
  const code = generateCode();
  const codeHash = hashCode(code);
  const expiresAt = new Date(now().getTime() + CODE_TTL_MS);
  await Model.create({ codeHash, userId, expiresAt, usedAt: null });
  return { code, expiresAt };
}

/**
 * Redeems a one-time native handoff code from GET /auth/native/complete.
 *
 * Race-safety is the whole point: two concurrent requests bearing the same
 * code must not both succeed. findOneAndUpdate's filter+update is a single
 * atomic operation at the MongoDB storage layer — the second racer's filter
 * (`usedAt: null`) no longer matches once the first has flipped it, so it
 * gets back null instead of a document. A find() then update() pair would
 * have a window between the two calls where both could pass the find.
 *
 * @returns {Promise<{ok: true, userId} | {ok: false, reason: string}>}
 *   `reason` is for logs/tests only — index.js must map every `ok: false`
 *   to the SAME generic `/aqua?auth_error=invalid_code`, never surfacing
 *   which check failed (missing vs expired vs already-used vs wrong).
 */
async function redeemNativeCode(rawCode, { Model = DefaultNativeOAuthCode, now = () => new Date() } = {}) {
  if (typeof rawCode !== "string" || rawCode.length === 0) {
    return { ok: false, reason: "missing_code" };
  }

  const codeHash = hashCode(rawCode);
  const record = await Model.findOneAndUpdate(
    { codeHash, usedAt: null, expiresAt: { $gt: now() } },
    { $set: { usedAt: now() } },
    { new: true },
  );

  if (!record) return { ok: false, reason: "invalid_expired_or_used" };
  return { ok: true, userId: record.userId };
}

module.exports = {
  NONCE_MAX_LENGTH,
  CODE_TTL_MS,
  CODE_BYTES,
  validateNonce,
  generateCode,
  hashCode,
  mintNativeCode,
  redeemNativeCode,
};
