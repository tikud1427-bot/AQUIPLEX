"use strict";
/**
 * Wallet + payments against a REAL MongoDB (2026-11-10).
 *
 * Run: AQUA_TEST_MONGO_URI=mongodb://127.0.0.1:<port>/aqua_test node --test tests/platform/walletAndPayments.live.test.js
 *
 * Needs AQUA_TEST_MONGO_URI; skipped with a reason otherwise. NEVER point it at
 * a real database: it drops its own database (suffix _wallet) before and after.
 * Razorpay is never contacted — signatures are computed with a throwaway test
 * secret, exactly as Razorpay computes them.
 */
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const MONGO = process.env.AQUA_TEST_MONGO_URI
  ? process.env.AQUA_TEST_MONGO_URI.replace(/\/([^/?]+)(\?|$)/, "/$1_wallet$2")
  : null;
const skip = MONGO ? false : "needs a TEST MongoDB — set AQUA_TEST_MONGO_URI";

// The policy under test, not whatever a developer's shell carries.
delete process.env.FREE_DAILY_CREDITS;
const TEST_SECRET = "rzp_test_secret_for_unit_tests_only";
process.env.RAZORPAY_KEY_SECRET = TEST_SECRET;
process.env.RAZORPAY_WEBHOOK_SECRET = "rzp_test_webhook_secret_only";

const mongoose = require("mongoose");
const User = require("../../models/User");
const Payment = require("../../models/Payment");
const Transaction = require("../../models/Transaction");
const ProductEvent = require("../../models/ProductEvent");
const WebhookLog = require("../../models/WebhookLog");
const wallet = require("../../services/credits/wallet.service");
const { checkUsage } = require("../../middleware/usage/checkUsage");
const { verifyPayment } = require("../../services/billing/razorpay.service");
const { handleWebhookEvent } = require("../../services/billing/webhook.handler");

const HOUR = 3600e3;
let seq = 0;
async function mkUser({ free = 75, paid = 0, resetInMs = HOUR, totalEarned = 0, extra = {} } = {}) {
  seq++;
  return User.create({
    email: `wallet${seq}@example.test`,
    password: "x",
    wallet: { freeCredits: free, paidCredits: paid, freeResetAt: new Date(Date.now() + resetInMs), totalEarned, totalSpent: 0 },
    ...extra,
  });
}
const reload = (id) => User.findById(id).lean();
const settle = () => new Promise((r) => setTimeout(r, 60)); // fire-and-forget ledger/event writes
const sign = (orderId, paymentId) => crypto.createHmac("sha256", TEST_SECRET).update(`${orderId}|${paymentId}`).digest("hex");
async function mkOrder(user, { packId = "starter", amountPaise = 4900, creditsToAdd = 500, status = "created" } = {}) {
  seq++;
  return Payment.create({ user: user._id, packId, amountPaise, creditsToAdd, razorpayOrderId: `order_T${seq}`, status });
}
const captured = (order, paymentId, amount = order.amountPaise) => ({
  event: "payment.captured",
  payload: { payment: { entity: { id: paymentId, order_id: order.razorpayOrderId, amount, currency: "INR" } } },
});

describe("wallet + payments (live MongoDB)", { skip }, () => {
  before(async () => {
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 10000 });
    await mongoose.connection.dropDatabase();
    await Promise.all([User.init(), Payment.init(), WebhookLog.init()]);
  });
  after(async () => {
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  // ── Allowance ─────────────────────────────────────────────────────────────
  describe("daily allowance", () => {
    test("a new account has 75 free credits", async () => {
      const u = await User.create({ email: "fresh@example.test", password: "x" });
      assert.equal((await reload(u._id)).wallet.freeCredits, 75);
    });

    test("an existing account holding 200 free is capped to 75 at once — paid untouched, ledgered, idempotent", async () => {
      const u = await mkUser({ free: 200, paid: 500 });
      const s = await wallet.getWalletSummary(u._id);
      assert.equal(s.freeCredits, 75);
      assert.equal(s.paidCredits, 500);
      assert.equal(s.freeDailyMax, 75);
      await wallet.getWalletSummary(u._id);
      await settle();
      const adj = await Transaction.find({ user: u._id, type: "ADMIN_ADJUST" }).lean();
      assert.equal(adj.length, 1);
      assert.equal(adj[0].amount, -125);
      assert.equal((await reload(u._id)).wallet.paidCredits, 500);
    });

    test("the reset replaces the free balance — unused credits do not accumulate", async () => {
      const u = await mkUser({ free: 40, paid: 10, resetInMs: -1000 });
      await wallet.deductCredits(u._id, 5, "chat_message");
      const w = (await reload(u._id)).wallet;
      assert.equal(w.freeCredits, 70);
      assert.equal(w.paidCredits, 10);
      assert.ok(w.freeResetAt > new Date());
    });

    test("purchased credits survive the daily reset", async () => {
      const u = await mkUser({ free: 0, paid: 500, resetInMs: -1000 });
      const s = await wallet.getWalletSummary(u._id);
      assert.equal(s.freeCredits, 75);
      assert.equal(s.paidCredits, 500);
    });

    test("accounts with a missing or partial stored wallet can be charged; stored values are preserved", async () => {
      const shapes = {
        none: {},
        noResetAt: { wallet: { freeCredits: 200, paidCredits: 30 } },
        noPaid: { wallet: { freeCredits: 10, freeResetAt: new Date(Date.now() + HOUR) } },
      };
      const expect = { none: [70, 0], noResetAt: [70, 30], noPaid: [5, 0] };
      for (const [name, extra] of Object.entries(shapes)) {
        const { insertedId } = await User.collection.insertOne({ email: `legacy-${name}@example.test`, password: "x", ...extra });
        await wallet.deductCredits(insertedId, 5, "chat_message");
        const w = (await reload(insertedId)).wallet;
        assert.deepEqual([w.freeCredits, w.paidCredits], expect[name], name);
        assert.ok(w.freeResetAt instanceof Date, name);
      }
    });

    test("ten concurrent requests at the reset moment grant the allowance once", async () => {
      const u = await mkUser({ free: 0, paid: 0, resetInMs: -1000 });
      const results = await Promise.allSettled(Array.from({ length: 10 }, () => wallet.deductCredits(u._id, 5, "chat_message")));
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 10);
      assert.equal((await reload(u._id)).wallet.freeCredits, 25); // 75 − 10×5, not re-granted mid-flight
    });
  });

  // ── Concurrency ───────────────────────────────────────────────────────────
  describe("concurrent spending", () => {
    test("20 concurrent 5-credit requests on 75 free: exactly 15 succeed, balance never negative", async () => {
      const u = await mkUser({ free: 75, paid: 0 });
      const results = await Promise.allSettled(Array.from({ length: 20 }, () => wallet.deductCredits(u._id, 5, "chat_message")));
      const ok = results.filter((r) => r.status === "fulfilled").length;
      assert.equal(ok, 15);
      for (const r of results) if (r.status === "rejected") assert.equal(r.reason.message, "INSUFFICIENT_CREDITS");
      const w = (await reload(u._id)).wallet;
      assert.equal(w.freeCredits, 0);
      assert.equal(w.paidCredits, 0);
      assert.equal(w.totalSpent, 75);
    });

    test("free + paid split under concurrency: neither bucket goes negative", async () => {
      const u = await mkUser({ free: 10, paid: 10 });
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => wallet.deductCredits(u._id, 5, "chat_message")));
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 4);
      const w = (await reload(u._id)).wallet;
      assert.equal(w.freeCredits, 0);
      assert.equal(w.paidCredits, 0);
    });

    test("checkUsage: a request that loses the race gets a 402, not a 500", async () => {
      const u = await mkUser({ free: 5, paid: 0 });
      const [a, b] = await Promise.all([
        checkUsage({ userId: String(u._id), actionType: "chat_message" }),
        checkUsage({ userId: String(u._id), actionType: "chat_message" }),
      ]);
      assert.deepEqual([a.allowed, b.allowed].sort(), [false, true]);
      const refused = a.allowed ? b : a;
      assert.equal(refused.status, 402);
      assert.equal(refused.error, "INSUFFICIENT_CREDITS");
    });
  });

  // ── Limits and messages ───────────────────────────────────────────────────
  describe("limits", () => {
    test("no session → 401; exhausted free allowance → 402 with the daily-allowance message", async () => {
      assert.equal((await checkUsage({ userId: null, actionType: "chat_message" })).status, 401);
      const u = await mkUser({ free: 0, paid: 0 });
      const r = await checkUsage({ userId: String(u._id), actionType: "chat_message" });
      assert.equal(r.allowed, false);
      assert.equal(r.status, 402);
      assert.equal(r.reason, "FREE_DAILY_EXHAUSTED");
      assert.equal(r.message, "Your daily free credits have been used. You can continue using Aqua by purchasing additional credits, or return when your daily allowance resets.");
      assert.equal(r.upgradeUrl, "/pricing?next=/aqua");
      assert.equal((await reload(u._id)).wallet.totalSpent, 0);
    });

    test("a past buyer who is out gets the purchased-credits message", async () => {
      const u = await mkUser({ free: 0, paid: 0, totalEarned: 500 });
      const r = await checkUsage({ userId: String(u._id), actionType: "chat_message" });
      assert.equal(r.reason, "BALANCE_EXHAUSTED");
    });

    test("crossing the low line and running out each record one funnel event", async () => {
      const u = await mkUser({ free: 20, paid: 0 });
      await wallet.deductCredits(u._id, 5, "chat_message"); // 20 → 15 (low line)
      await wallet.deductCredits(u._id, 5, "chat_message"); // 15 → 10 (already low)
      await wallet.deductCredits(u._id, 10, "chat_message"); // → 0
      await settle();
      const evs = await ProductEvent.find({ userId: String(u._id) }).lean();
      assert.equal(evs.filter((e) => e.event === "free_allowance_low").length, 1);
      assert.equal(evs.filter((e) => e.event === "free_allowance_exhausted").length, 1);
    });
  });

  // ── Refunds ───────────────────────────────────────────────────────────────
  describe("refunds of failed requests", () => {
    test("a failed request paid with free credits gives back FREE credits, once — never paid ones", async () => {
      const u = await mkUser({ free: 75, paid: 0 });
      const r = await checkUsage({ userId: String(u._id), actionType: "chat_message" });
      assert.equal((await reload(u._id)).wallet.freeCredits, 70);
      await r.creditContext.refund();
      await r.creditContext.refund();
      const w = (await reload(u._id)).wallet;
      assert.equal(w.freeCredits, 75);
      assert.equal(w.paidCredits, 0);
      assert.equal(w.totalSpent, 0);
    });

    test("a mixed charge goes back to each bucket it came from", async () => {
      const u = await mkUser({ free: 3, paid: 10 });
      const d = await wallet.deductCredits(u._id, 5, "chat_message");
      assert.deepEqual([d.fromFree, d.fromPaid], [3, 2]);
      await wallet.refundCredits(u._id, 5, "test", d);
      const w = (await reload(u._id)).wallet;
      assert.deepEqual([w.freeCredits, w.paidCredits], [3, 10]);
    });

    test("after the daily reset, yesterday's free credits are not refunded on top of today's", async () => {
      const u = await mkUser({ free: 75, paid: 4 });
      const d = await wallet.deductCredits(u._id, 5, "chat_message");
      // The allowance rolls over before the failure is noticed.
      await User.updateOne({ _id: u._id }, { $set: { "wallet.freeCredits": 75, "wallet.freeResetAt": new Date(Date.now() + 2 * HOUR) } });
      await wallet.refundCredits(u._id, 5, "test", d);
      const w = (await reload(u._id)).wallet;
      assert.equal(w.freeCredits, 75);
      assert.equal(w.paidCredits, 4);
    });
  });

  // ── Payments ──────────────────────────────────────────────────────────────
  describe("payments", () => {
    test("a verified payment adds the pack's credits once and records the purchase", async () => {
      const u = await mkUser();
      const o = await mkOrder(u);
      const r1 = await verifyPayment(o.razorpayOrderId, "pay_A1", sign(o.razorpayOrderId, "pay_A1"), String(u._id));
      assert.equal(r1.credits, 500);
      const r2 = await verifyPayment(o.razorpayOrderId, "pay_A1", sign(o.razorpayOrderId, "pay_A1"), String(u._id));
      assert.equal(r2.alreadyProcessed, true);
      await settle();
      const w = (await reload(u._id)).wallet;
      assert.equal(w.paidCredits, 500);
      assert.equal(w.freeCredits, 75);
      const p = await Payment.findById(o._id).lean();
      assert.equal(p.status, "success");
      assert.ok(p.creditedAt);
      assert.equal(await Transaction.countDocuments({ user: u._id, type: "PURCHASE" }), 1);
      const ev = await ProductEvent.find({ userId: String(u._id), event: "purchase_credited" }).lean();
      assert.equal(ev.length, 1);
      assert.equal(ev[0].props.firstPurchase, true);
      assert.equal(ev[0].props.amountPaise, 4900);
    });

    test("concurrent verify ×3 + webhook ×2 for one payment credit exactly once", async () => {
      const u = await mkUser();
      const o = await mkOrder(u);
      const sig = sign(o.razorpayOrderId, "pay_C1");
      await Promise.allSettled([
        verifyPayment(o.razorpayOrderId, "pay_C1", sig, String(u._id)),
        verifyPayment(o.razorpayOrderId, "pay_C1", sig, String(u._id)),
        verifyPayment(o.razorpayOrderId, "pay_C1", sig, String(u._id)),
        handleWebhookEvent("payment.captured", captured(o, "pay_C1")),
        handleWebhookEvent("payment.captured", captured(o, "pay_C1")),
      ]);
      assert.equal((await reload(u._id)).wallet.paidCredits, 500);
      assert.equal(await Transaction.countDocuments({ user: u._id, type: "PURCHASE" }), 1);
    });

    test("a forged signature credits nothing", async () => {
      const u = await mkUser();
      const o = await mkOrder(u);
      await assert.rejects(verifyPayment(o.razorpayOrderId, "pay_F1", "ab".repeat(32), String(u._id)), /INVALID_SIGNATURE/);
      assert.equal((await reload(u._id)).wallet.paidCredits, 0);
    });

    test("someone else's order cannot be verified by another account", async () => {
      const owner = await mkUser();
      const other = await mkUser();
      const o = await mkOrder(owner);
      await assert.rejects(verifyPayment(o.razorpayOrderId, "pay_O1", sign(o.razorpayOrderId, "pay_O1"), String(other._id)), /PAYMENT_NOT_FOUND/);
      assert.equal((await reload(other._id)).wallet.paidCredits, 0);
      assert.equal((await reload(owner._id)).wallet.paidCredits, 0);
    });

    test("a failed first attempt followed by a successful retry on the same order is credited", async () => {
      const u = await mkUser();
      const o = await mkOrder(u);
      await handleWebhookEvent("payment.failed", { event: "payment.failed", payload: { payment: { entity: { id: "pay_R0", order_id: o.razorpayOrderId, error_description: "card declined" } } } });
      assert.equal((await Payment.findById(o._id).lean()).status, "failed");
      await verifyPayment(o.razorpayOrderId, "pay_R1", sign(o.razorpayOrderId, "pay_R1"), String(u._id));
      assert.equal((await reload(u._id)).wallet.paidCredits, 500);
      assert.equal((await Payment.findById(o._id).lean()).status, "success");
    });

    test("a failed payment alone credits nothing; a late failure never downgrades a credited order", async () => {
      const u = await mkUser();
      const o = await mkOrder(u);
      await handleWebhookEvent("payment.failed", { event: "payment.failed", payload: { payment: { entity: { id: "pay_X0", order_id: o.razorpayOrderId } } } });
      assert.equal((await reload(u._id)).wallet.paidCredits, 0);

      const o2 = await mkOrder(u);
      await verifyPayment(o2.razorpayOrderId, "pay_X2", sign(o2.razorpayOrderId, "pay_X2"), String(u._id));
      await handleWebhookEvent("payment.failed", { event: "payment.failed", payload: { payment: { entity: { id: "pay_X1", order_id: o2.razorpayOrderId } } } });
      assert.equal((await Payment.findById(o2._id).lean()).status, "success");
      assert.equal((await reload(u._id)).wallet.paidCredits, 500);
    });

    test("an order marked success but never credited (crash between writes) is credited by the next verify", async () => {
      const u = await mkUser();
      const o = await mkOrder(u, { status: "success" });
      const r = await verifyPayment(o.razorpayOrderId, "pay_H1", sign(o.razorpayOrderId, "pay_H1"), String(u._id));
      assert.equal(r.alreadyProcessed, undefined);
      assert.equal((await reload(u._id)).wallet.paidCredits, 500);
    });

    test("…and by the webhook", async () => {
      const u = await mkUser();
      const o = await mkOrder(u, { status: "success" });
      await handleWebhookEvent("payment.captured", captured(o, "pay_H2"));
      assert.equal((await reload(u._id)).wallet.paidCredits, 500);
    });

    test("duplicate webhook deliveries credit once", async () => {
      const u = await mkUser();
      const o = await mkOrder(u);
      const r1 = await handleWebhookEvent("payment.captured", captured(o, "pay_D1"));
      const r2 = await handleWebhookEvent("payment.captured", captured(o, "pay_D1"));
      assert.equal(r1.credited, 500);
      assert.equal(r2.skipped, true);
      assert.equal((await reload(u._id)).wallet.paidCredits, 500);
    });

    test("a redelivery of a webhook whose first processing failed is processed", async () => {
      const u = await mkUser();
      const o = await mkOrder(u);
      // First delivery logged, then died before crediting.
      await WebhookLog.create({ idempotencyKey: "payment.captured:pay_W1", event: "payment.captured", payload: {}, handled: false, error: "simulated" });
      const r = await handleWebhookEvent("payment.captured", captured(o, "pay_W1"));
      assert.equal(r.credited, 500);
      assert.equal((await reload(u._id)).wallet.paidCredits, 500);
      assert.equal((await WebhookLog.findOne({ idempotencyKey: "payment.captured:pay_W1" }).lean()).handled, true);
    });

    test("a captured amount that disagrees with the order is not credited", async () => {
      const u = await mkUser();
      const o = await mkOrder(u);
      const r = await handleWebhookEvent("payment.captured", captured(o, "pay_M1", 100));
      assert.equal(r.reason, "AMOUNT_MISMATCH");
      assert.equal((await reload(u._id)).wallet.paidCredits, 0);
    });

    test("a cancelled checkout (order created, modal closed) credits nothing", async () => {
      const u = await mkUser();
      await mkOrder(u);
      assert.equal((await reload(u._id)).wallet.paidCredits, 0);
    });

    test("a second purchase is recorded as a repeat purchase", async () => {
      const u = await mkUser();
      for (const pid of ["pay_P1", "pay_P2"]) {
        const o = await mkOrder(u);
        await verifyPayment(o.razorpayOrderId, pid, sign(o.razorpayOrderId, pid), String(u._id));
      }
      await settle();
      const evs = await ProductEvent.find({ userId: String(u._id), event: "purchase_credited" }).sort({ at: 1 }).lean();
      assert.deepEqual(evs.map((e) => e.props.firstPurchase), [true, false]);
      assert.equal((await reload(u._id)).wallet.paidCredits, 1000);
    });
  });

  // ── Operator scripts ──────────────────────────────────────────────────────
  describe("operator scripts", () => {
    test("free-allowance-cap: dry run writes nothing, apply caps free only, second apply is a no-op", async () => {
      const u = await mkUser({ free: 180, paid: 42 });
      const quiet = { log: () => {} };
      const { main } = require("../../scripts/admin/free-allowance-cap.cjs");
      const dry = await main(["--mongo", MONGO], quiet);
      assert.ok(dry.eligible >= 1);
      assert.equal((await reload(u._id)).wallet.freeCredits, 180);
      const applied = await main(["--mongo", MONGO, "--apply"], quiet);
      assert.ok(applied.changed >= 1);
      const w = (await reload(u._id)).wallet;
      assert.deepEqual([w.freeCredits, w.paidCredits], [75, 42]);
      assert.equal((await main(["--mongo", MONGO, "--apply"], quiet)).changed, 0);
    });

    test("business-metrics: revenue counts only credited payments; others are listed as not revenue", async () => {
      const u = await mkUser();
      await mkOrder(u, { status: "failed" });
      await mkOrder(u, { status: "pending" });
      const { collect } = require("../../scripts/admin/business-metrics.cjs");
      const r = await collect({ since: new Date(Date.now() - 24 * HOUR) });
      const credited = await Payment.find({ creditedAt: { $exists: true } }).lean();
      assert.equal(r.revenue.verifiedPurchases, credited.length);
      assert.equal(r.revenue.revenueINR, credited.reduce((s, p) => s + p.amountPaise, 0) / 100);
      const statuses = r.revenue.notRevenue.map((n) => n.status);
      assert.ok(statuses.includes("failed") && statuses.includes("pending") && statuses.includes("created"));
      assert.ok(r.funnel.purchase_credited.events >= credited.length);
    });
  });
});
