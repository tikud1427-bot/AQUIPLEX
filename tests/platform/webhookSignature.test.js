"use strict";
/**
 * Razorpay signatures: real HMACs pass, everything else fails, and the
 * comparison is constant-time (crypto.timingSafeEqual, not ===).
 *
 * Run: node --test tests/platform/webhookSignature.test.js
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

process.env.RAZORPAY_WEBHOOK_SECRET = "test-webhook-secret";
const { verifyWebhookSignature, hexDigestEquals } = require("../../services/billing/razorpay.service");

const body = Buffer.from(JSON.stringify({ event: "payment.captured" }));
const sign = (b, s = process.env.RAZORPAY_WEBHOOK_SECRET) => crypto.createHmac("sha256", s).update(b).digest("hex");

test("a correctly signed body verifies", () => {
  assert.equal(verifyWebhookSignature(body, sign(body)), true);
});

test("a tampered body, a wrong secret, or junk does not", () => {
  assert.equal(verifyWebhookSignature(Buffer.from('{"event":"x"}'), sign(body)), false);
  assert.equal(verifyWebhookSignature(body, sign(body, "other")), false);
  for (const junk of ["", "zz", sign(body).slice(0, 10), sign(body) + "00", null, undefined, 42, {}]) {
    assert.equal(verifyWebhookSignature(body, junk), false, `accepted ${String(junk)}`);
  }
});

test("hexDigestEquals never throws on length mismatch", () => {
  assert.doesNotThrow(() => hexDigestEquals("abcd", "ab"));
  assert.equal(hexDigestEquals("abcd", "ab"), false);
  assert.equal(hexDigestEquals("abcd", "ABCD"), true);
});
