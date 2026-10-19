"use strict";
/**
 * A charged request that fails is refunded — once.
 *
 * Run: node --test tests/platform/creditRefund.test.js
 *
 * Before 2026-10-16: creditContext.refund() credited the wallet on EVERY call
 * (two failure paths refunding one request minted free credits), and only the
 * chat routes refunded at all — a failed upload, a 400/404 after the charge, or
 * a failed bundle step kept the user's credits.
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const { onceOnly } = require("../../middleware/usage/checkUsage");
const { refundOnFailure } = require("../../middleware/usage/usageGuard");

const ROOT = path.join(__dirname, "..", "..");

describe("refund is once-only", () => {
  test("a second call does not run the refund again", async () => {
    let n = 0;
    const refund = onceOnly(async () => { n++; return true; });
    assert.equal(await refund(), true);
    assert.equal(await refund(), false);
    assert.equal(await Promise.resolve(refund()), false);
    assert.equal(n, 1);
  });

  test("checkUsage's deduct-on-entry refund is wrapped", () => {
    const src = fs.readFileSync(path.join(ROOT, "middleware", "usage", "checkUsage.js"), "utf8");
    assert.match(src, /refund: onceOnly\(\(\) => \{/);
  });
});

describe("usageGuard refunds a charged request that ends in an error status", () => {
  function run(status) {
    let refunds = 0;
    const req = { creditContext: { refund: onceOnly(async () => { refunds++; }) } };
    const res = new EventEmitter();
    refundOnFailure(req, res);
    res.statusCode = status;
    res.emit("finish");
    return new Promise((r) => setImmediate(() => r({ refunds, req })));
  }

  for (const status of [400, 404, 500, 503]) {
    test(`${status} → refunded`, async () => assert.equal((await run(status)).refunds, 1));
  }
  for (const status of [200, 201, 304]) {
    test(`${status} → kept`, async () => assert.equal((await run(status)).refunds, 0));
  }

  test("a route that already refunded is not refunded twice by the net", async () => {
    let refunds = 0;
    const req = { creditContext: { refund: onceOnly(async () => { refunds++; }) } };
    const res = new EventEmitter();
    refundOnFailure(req, res);
    await req.creditContext.refund();          // the route's own failure path
    res.statusCode = 500;
    res.emit("finish");
    await new Promise((r) => setImmediate(r));
    assert.equal(refunds, 1);
  });

  test("usageGuard installs the net on every charged request", () => {
    const src = fs.readFileSync(path.join(ROOT, "middleware", "usage", "usageGuard.js"), "utf8");
    assert.match(src, /req\.creditContext = result\.creditContext;\s*\n\s*refundOnFailure\(req, res\);/);
  });
});
