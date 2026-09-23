"use strict";

const crypto = require("crypto");

const NATIVE_NONCE_MAX_LENGTH = 256;
const NATIVE_CODE_BYTES = 32;
const NATIVE_CODE_TTL_MS = 120 * 1000;

/**
 * Android generates a URL-safe CSPRNG nonce. Keep the accepted alphabet narrow
 * so the value can safely round-trip through query strings and be compared
 * without accepting arbitrary control/whitespace data.
 */
function validateNativeNonce(value) {
  if (typeof value !== "string") return null;
  if (value.length < 16 || value.length > NATIVE_NONCE_MAX_LENGTH) return null;
  if (!/^[A-Za-z0-9._~-]+$/.test(value)) return null;
  return value;
}

function generateNativeOAuthCode() {
  return crypto.randomBytes(NATIVE_CODE_BYTES).toString("base64url");
}

function hashNativeOAuthCode(rawCode) {
  return crypto.createHash("sha256").update(rawCode, "utf8").digest("hex");
}

function nativeCodeExpiresAt(now = Date.now()) {
  return new Date(now + NATIVE_CODE_TTL_MS);
}

module.exports = {
  NATIVE_NONCE_MAX_LENGTH,
  NATIVE_CODE_BYTES,
  NATIVE_CODE_TTL_MS,
  validateNativeNonce,
  generateNativeOAuthCode,
  hashNativeOAuthCode,
  nativeCodeExpiresAt,
};
