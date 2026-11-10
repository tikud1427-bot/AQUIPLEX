"use strict";
/**
 * The 75-credit daily free allowance (2026-11-10) — offline checks.
 *
 * Run: node --test tests/platform/freeAllowance.test.js
 *
 * Database behaviour (atomic reset, concurrency, refunds, payments) is in
 * walletAndPayments.live.test.js, which needs a TEST MongoDB.
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");

// The policy must hold without any environment override.
const savedEnv = process.env.FREE_DAILY_CREDITS;
delete process.env.FREE_DAILY_CREDITS;
const allowance = require("../../utils/credits/freeAllowance");
const User = require("../../models/User");
const { CREDIT_COSTS, allPacksArray } = require("../../utils/credits/packs");
if (savedEnv !== undefined) process.env.FREE_DAILY_CREDITS = savedEnv;

describe("policy", () => {
  test("the daily free allowance is 75", () => {
    assert.equal(allowance.POLICY_FREE_DAILY_CREDITS, 75);
    assert.equal(allowance.FREE_DAILY_CREDITS, 75);
  });

  test("the low line is three chat messages (15 of 75)", () => {
    assert.equal(allowance.lowFreeThreshold(75, 5), 15);
    assert.equal(allowance.lowFreeThreshold(20, 5), 4); // never more than a fifth
  });

  test("overrides parse strictly", () => {
    assert.equal(allowance.parseAllowance("75"), 75);
    assert.equal(allowance.parseAllowance(" 0 "), 0);
    assert.equal(allowance.parseAllowance(""), null);
    assert.equal(allowance.parseAllowance("-5"), null);
    assert.equal(allowance.parseAllowance("7.5"), null);
    assert.equal(allowance.parseAllowance("lots"), null);
  });

  test("a stale override is announced at boot", () => {
    const { execFileSync } = require("node:child_process");
    const out = execFileSync(process.execPath, ["-e",
      "const a=require('./utils/credits/freeAllowance');a.announceAllowance({warn:m=>console.log('WARN',m),log:m=>console.log('LOG',m)});console.log('VALUE',a.FREE_DAILY_CREDITS)"],
      { cwd: ROOT, env: { ...process.env, FREE_DAILY_CREDITS: "200" }, encoding: "utf8" });
    assert.match(out, /WARN .*FREE_DAILY_CREDITS=200 overrides the 75-credit daily policy/);
    assert.match(out, /VALUE 200/);
  });
});

describe("User model", () => {
  test("a new account starts with 75 free credits and 0 paid", () => {
    const u = new User({ email: "new@example.test", password: "x" });
    assert.equal(u.wallet.freeCredits, 75);
    assert.equal(u.wallet.paidCredits, 0);
    assert.equal(u.walletSummary().freeDailyMax, 75);
  });

  test("an existing balance above the allowance is capped — free only", () => {
    const u = new User({ email: "old@example.test", password: "x" });
    u.wallet.freeCredits = 200;
    u.wallet.paidCredits = 500;
    u.wallet.freeResetAt = new Date(Date.now() + 3600e3);
    assert.equal(u.resetFreeCreditsIfNeeded(), true);
    assert.equal(u.wallet.freeCredits, 75);
    assert.equal(u.wallet.paidCredits, 500);
  });

  test("the daily reset replaces (never adds to) the free balance and leaves paid alone", () => {
    const u = new User({ email: "r@example.test", password: "x" });
    u.wallet.freeCredits = 40;
    u.wallet.paidCredits = 120;
    u.wallet.freeResetAt = new Date(Date.now() - 1000);
    u.resetFreeCreditsIfNeeded();
    assert.equal(u.wallet.freeCredits, 75);
    assert.equal(u.wallet.paidCredits, 120);
    assert.ok(u.wallet.freeResetAt > new Date());
  });

  test("unlimited accounts are untouched", () => {
    const u = new User({ email: "u@example.test", password: "x", isUnlimited: true });
    u.wallet.freeCredits = 999;
    assert.equal(u.resetFreeCreditsIfNeeded(), false);
    assert.equal(u.wallet.freeCredits, 999);
  });
});

describe("commercial terms are unchanged", () => {
  test("operation costs", () => {
    assert.equal(CREDIT_COSTS.chat_message, 5);
    assert.equal(CREDIT_COSTS.chat_with_file, 8);
    assert.equal(CREDIT_COSTS.file_analysis, 8);
    assert.equal(CREDIT_COSTS.default, 5);
  });

  test("credit packs (names, prices, credits) — defaults", () => {
    const packs = Object.fromEntries(allPacksArray().map((p) => [p.id, [p.name, p.priceINR, p.credits]]));
    // Only meaningful when no pack env overrides are set in this process.
    if (!Object.keys(process.env).some((k) => /_PACK_(PRICE|CREDITS)$/.test(k))) {
      assert.deepEqual(packs, {
        starter: ["Starter Pack", 49, 500],
        growth:  ["Growth Pack", 199, 3000],
        pro:     ["Pro Pack", 499, 8500],
        max:     ["Max Pack", 999, 20000],
      });
    }
  });
});

describe("every surface shows the server's allowance", () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

  test("no view or route hard-codes the old 200/day default", () => {
    for (const f of ["views/pricing.ejs", "views/wallet.ejs", "views/home.ejs", "views/billing.ejs", "views/signup.ejs",
      "routes/billing/billing.routes.js", "services/credits/wallet.service.js", "models/User.js"]) {
      const src = read(f);
      assert.doesNotMatch(src, /FREE_DAILY_CREDITS\s*\|\|\s*"?200/, f);
      assert.doesNotMatch(src, /freeDailyMax\s*\|\|\s*200/, f);
    }
  });

  test("the pricing page carries the free-plan copy", () => {
    const v = read("views/pricing.ejs");
    assert.match(v, /Free plan — always available/);
    assert.match(v, /<%= FREE_DAILY_CREDITS %> free credits every day\. Explore Aqua and use it for your everyday thinking\./);
    assert.match(v, /Need more\? Purchase additional credits whenever you need them\./);
    assert.match(v, /No subscription\. No recurring charges\. Purchased credits never expire\./);
  });

  test("the app exposes the constant to every view", () => {
    assert.match(read("index.js"), /app\.locals\.FREE_DAILY_CREDITS = allowance\.FREE_DAILY_CREDITS;/);
  });
});

describe("operator safety", () => {
  const { execFileSync } = require("node:child_process");
  const runCap = (envOverride) => {
    try {
      execFileSync(process.execPath, ["scripts/admin/free-allowance-cap.cjs", "--mongo", "mongodb://127.0.0.1:1/never"],
        { cwd: ROOT, env: { ...process.env, ...envOverride }, encoding: "utf8", stdio: "pipe", timeout: 30000 });
      return "";
    } catch (e) { return String(e.stderr || "") + String(e.stdout || ""); }
  };

  test("the cap script refuses a shell whose FREE_DAILY_CREDITS is not the policy — before connecting", () => {
    const out = runCap({ FREE_DAILY_CREDITS: "50" });
    assert.match(out, /FREE_DAILY_CREDITS=50, not the 75-credit policy/);
  });

  test("the Razorpay webhook acknowledges only after processing, and 500s a failure so Razorpay retries", () => {
    const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
    const route = src.slice(src.indexOf('"/api/billing/webhook"'), src.indexOf("// ── Security headers"));
    const awaitAt = route.indexOf("await handleWebhookEvent(payload.event, payload)");
    const ackAt = route.indexOf("res.status(200).json({ received: true })");
    assert.ok(awaitAt > 0 && ackAt > awaitAt, "200 must come after the awaited handler");
    assert.match(route, /return res\.status\(500\)\.json\(\{ error: "WEBHOOK_PROCESSING_FAILED" \}\)/);
  });
});

describe("AI routes that were free are metered at their chat price", () => {
  const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  const block = src.slice(src.indexOf("aquaEngine.use((req, res, next) => {"), src.indexOf("const aquaAccess = ["));

  test("project edit proposals and direct orchestration go through usageGuard('chat_message')", () => {
    assert.match(block, /\\\/project\\\/workspace\\\/\[\^\/\]\+\\\/edit\$/);
    assert.match(block, /routePath === "\/intelligence\/orchestrate"/);
    assert.match(block, /usageGuard\("chat_message"\)\(req, res, next\);\s*\n\s*\}\s*\n\s*next\(\);\s*\n\}\);\s*$/);
  });
});
