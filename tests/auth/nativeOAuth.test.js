"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  NATIVE_CODE_BYTES,
  NATIVE_CODE_TTL_MS,
  validateNativeNonce,
  generateNativeOAuthCode,
  hashNativeOAuthCode,
  nativeCodeExpiresAt,
} = require("../../services/auth/nativeOAuth.service");

const ROOT = path.join(__dirname, "..", "..");
const indexSrc = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");

describe("native OAuth nonce policy", () => {
  test("accepts the Android URL-safe nonce shape", () => {
    assert.equal(validateNativeNonce("n0nce-AAAAAAAAAAAAAAAA"), "n0nce-AAAAAAAAAAAAAAAA");
  });

  test("rejects missing, short and oversized nonces", () => {
    assert.equal(validateNativeNonce(undefined), null);
    assert.equal(validateNativeNonce("short"), null);
    assert.equal(validateNativeNonce("A".repeat(257)), null);
  });

  test("rejects query/control characters", () => {
    assert.equal(validateNativeNonce("A".repeat(16) + " "), null);
    assert.equal(validateNativeNonce("A".repeat(16) + "\n"), null);
    assert.equal(validateNativeNonce("A".repeat(15) + "/"), null);
  });
});

describe("native OAuth one-time code", () => {
  test("generates 256 bits of CSPRNG entropy", () => {
    const code = generateNativeOAuthCode();
    assert.equal(Buffer.from(code, "base64url").length, NATIVE_CODE_BYTES);
  });

  test("hashes the raw code before persistence", () => {
    const code = generateNativeOAuthCode();
    const hash = hashNativeOAuthCode(code);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.notEqual(hash, code);
  });

  test("expires after 120 seconds", () => {
    const now = Date.now();
    assert.equal(nativeCodeExpiresAt(now).getTime(), now + NATIVE_CODE_TTL_MS);
  });
});

describe("native OAuth route wiring", () => {
  test("native start validates nonce and stores native state server-side", () => {
    assert.match(indexSrc, /const native = req\.query\.native === "1"/);
    assert.match(indexSrc, /const nonce = validateNativeNonce\(req\.query\.nonce\)/);
    assert.match(indexSrc, /req\.session\.nativeReturn = true/);
    assert.match(indexSrc, /req\.session\.nativeNonce = nonce/);
  });

  test("native callback creates a hashed, short-lived handoff and returns code+nonce", () => {
    assert.match(indexSrc, /generateNativeOAuthCode\(\)/);
    assert.match(indexSrc, /hashNativeOAuthCode\(rawCode\)/);
    assert.match(indexSrc, /expiresAt,/);
    assert.match(indexSrc, /NativeOAuthCode\.create\(\{/);
    assert.match(indexSrc, /returnUrl\.searchParams\.set\("code", rawCode\)/);
    assert.match(indexSrc, /returnUrl\.searchParams\.set\("nonce", native\.nonce\)/);
  });

  test("completion uses one atomic findOneAndUpdate redemption", () => {
    const start = indexSrc.indexOf('app.get("/auth/native/complete"');
    assert.notEqual(start, -1);
    const block = indexSrc.slice(start, indexSrc.indexOf('// ── Google reauthentication', start));
    assert.match(block, /findOneAndUpdate\([\s\S]*codeHash,[\s\S]*usedAt: null,[\s\S]*expiresAt: \{ \$gt: now \}/);
    assert.match(block, /\$set: \{ usedAt: now \}/);
    assert.doesNotMatch(block, /NativeOAuthCode\.find\(/);
  });

  test("completion regenerates the session before login and saves it before /aqua", () => {
    const start = indexSrc.indexOf('app.get("/auth/native/complete"');
    const block = indexSrc.slice(start, indexSrc.indexOf('// ── Google reauthentication', start));
    assert.match(block, /req\.session\.regenerate/);
    assert.match(block, /req\.login\(user/);
    assert.match(block, /req\.session\.save/);
    assert.match(block, /res\.redirect\("\/aqua"\)/);
  });

  test("generic redemption failure never distinguishes invalid/expired/replayed codes", () => {
    const start = indexSrc.indexOf('app.get("/auth/native/complete"');
    const block = indexSrc.slice(start, indexSrc.indexOf('// ── Google reauthentication', start));
    assert.match(block, /\/aqua\?auth_error=invalid_code/);
    assert.doesNotMatch(block, /expired_code|used_code|missing_code/);
  });
});

describe("persistent session policy", () => {
  test("uses a 30-day rolling persistent cookie", () => {
    assert.match(indexSrc, /const SESSION_TTL_MS = 30 \* 24 \* 60 \* 60 \* 1000/);
    assert.match(indexSrc, /rolling:\s*true/);
    assert.match(indexSrc, /maxAge:\s*SESSION_TTL_MS/);
  });

  test("production never silently falls back to MemoryStore", () => {
    assert.match(indexSrc, /if \(process\.env\.NODE_ENV === "production"\)[\s\S]{0,500}process\.exit\(1\)/);

  });

  test("Mongo session TTL is aligned with the cookie lifetime", () => {
    assert.match(indexSrc, /ttl:\s*SESSION_TTL_MS \/ 1000/);
    assert.match(indexSrc, /touchAfter:\s*24 \* 60 \* 60/);
  });

  test("Asset Links serves the real Android package and only known/deployment fingerprints", () => {
    assert.match(indexSrc, /app\.get\("\/\.well-known\/assetlinks\.json"/);
    assert.match(indexSrc, /package_name: "com\.aquiplex\.aqua"/);
    assert.match(indexSrc, /AQUA_PLAY_APP_SIGNING_SHA256/);
    assert.match(indexSrc, /15:F7:A9:A8:72:79:D4:39:1F:DE:E5:5A:7E:02:B0:D2:9D:56:57:CB:AC:17:F0:CA:0F:ED:61:F4:B1:40:1C:2B/);
  });
});

