"use strict";
/**
 * Account deletion — reauthentication policy.
 *
 * Run: node --test tests/account/*.test.js   (root package)
 *
 * Covers the gate that stands in front of an irreversible operation. Deletion
 * itself is exercised engine-side (aqua/src/account/tests/accountPurge.test.js);
 * what matters HERE is that nothing reaches it without a fresh proof of
 * ownership. Pure policy — no database, no network, real bcrypt.
 */

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcrypt");

const {
  verifyReauthentication,
  authMethodFor,
  REAUTH_MAX_AGE_MS,
  GOOGLE_SENTINEL,
} = require("../../services/account/accountDeletion.service");

const PASSWORD = "correct horse battery staple";
let passwordUser;

const googleUser = { email: "gmail-user@example.com", password: GOOGLE_SENTINEL };

before(async () => {
  passwordUser = { email: "user@example.com", password: await bcrypt.hash(PASSWORD, 10) };
});

// ── Account type detection ───────────────────────────────────────────────────

test("google accounts are detected by the sentinel, not by a googleId field", () => {
  assert.equal(authMethodFor(googleUser), "google");
  assert.equal(authMethodFor(passwordUser), "password");
});

// ── Password accounts ────────────────────────────────────────────────────────

test("correct password authorizes deletion", async () => {
  const res = await verifyReauthentication({ user: passwordUser, password: PASSWORD });
  assert.equal(res.ok, true);
  assert.equal(res.method, "password");
});

test("wrong password is rejected", async () => {
  const res = await verifyReauthentication({ user: passwordUser, password: "not-it" });
  assert.equal(res.ok, false);
  assert.equal(res.error, "PASSWORD_INCORRECT");
  assert.match(res.message, /incorrect/i);
});

test("missing password is rejected", async () => {
  const res = await verifyReauthentication({ user: passwordUser });
  assert.equal(res.ok, false);
  assert.equal(res.error, "PASSWORD_REQUIRED");
});

test("a google reauth stamp cannot authorize a password account", async () => {
  // Wrong credential type must not be a bypass: the password branch ignores
  // the stamp entirely and still demands the password.
  const res = await verifyReauthentication({
    user: passwordUser,
    reauth: { at: Date.now(), email: passwordUser.email },
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, "PASSWORD_REQUIRED");
});

// ── Google accounts ──────────────────────────────────────────────────────────

test("fresh matching google reauth authorizes deletion", async () => {
  const res = await verifyReauthentication({
    user: googleUser,
    reauth: { at: Date.now(), email: googleUser.email },
  });
  assert.equal(res.ok, true);
  assert.equal(res.method, "google");
});

test("google account with no reauth is rejected", async () => {
  const res = await verifyReauthentication({ user: googleUser, reauth: null });
  assert.equal(res.ok, false);
  assert.equal(res.error, "REAUTH_REQUIRED");
});

test("expired google reauth is rejected", async () => {
  const now = Date.now();
  const res = await verifyReauthentication({
    user: googleUser,
    reauth: { at: now - REAUTH_MAX_AGE_MS - 1, email: googleUser.email },
    now,
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, "REAUTH_EXPIRED");
});

test("reauth is still valid at the boundary, invalid one millisecond past it", async () => {
  const now = Date.now();
  const atBoundary = await verifyReauthentication({
    user: googleUser,
    reauth: { at: now - REAUTH_MAX_AGE_MS, email: googleUser.email },
    now,
  });
  assert.equal(atBoundary.ok, true);
});

test("a google reauth for a DIFFERENT account is rejected", async () => {
  // The signed-in session and the OAuth round trip can be different accounts —
  // confirming with someone else's Google login must never delete this one.
  const res = await verifyReauthentication({
    user: googleUser,
    reauth: { at: Date.now(), email: "someone-else@example.com" },
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, "REAUTH_MISMATCH");
});

test("email matching is case-insensitive", async () => {
  const res = await verifyReauthentication({
    user: googleUser,
    reauth: { at: Date.now(), email: "GMAIL-USER@EXAMPLE.COM" },
  });
  assert.equal(res.ok, true);
});

test("a reauth stamp with no timestamp is rejected", async () => {
  const res = await verifyReauthentication({
    user: googleUser,
    reauth: { email: googleUser.email },
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, "REAUTH_REQUIRED");
});
