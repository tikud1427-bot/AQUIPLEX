"use strict";
/**
 * The pricing page lists only what the server actually charges for, at the
 * price it actually charges.
 *
 * Run: node --test tests/platform/pricingTruth.test.js
 *
 * It used to advertise code generation, image generation, deep research, full
 * app generation and multi-agent orchestration — none metered by any route,
 * none offered by the product.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
// EJS comments (<%# … %>) never reach the browser, so they are not advertising.
const view = fs.readFileSync(path.join(ROOT, "views", "pricing.ejs"), "utf8").replace(/<%#[\s\S]*?%>/g, "");
const indexSrc = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
const { CREDIT_COSTS } = require("../../utils/credits/packs");

const metered = [...new Set([...indexSrc.matchAll(/usageGuard\("([a-z_]+)"\)/g)].map((m) => m[1]))];

test("index.js meters exactly the two actions the page prices", () => {
  assert.deepEqual(metered.sort(), ["chat_message", "chat_with_file"]);
});

test("every numeric price on the page is the cost of a metered action", () => {
  const tbody = view.slice(view.indexOf("<tbody>"), view.indexOf("</tbody>"));
  const prices = [...tbody.matchAll(/<td style="text-align:right;">([^<]+)<\/td>/g)].map((m) => m[1].trim());
  assert.ok(prices.length >= 2);
  const allowed = new Set(metered.map((a) => String(CREDIT_COSTS[a])).concat(["Free"]));
  for (const p of prices) assert.ok(allowed.has(p), `price "${p}" is not a metered cost`);
});

test("no capability the product does not have is advertised", () => {
  for (const phrase of [/image generation/i, /app generation/i, /multi-agent/i, /deep research/i, /code generation/i]) {
    assert.doesNotMatch(view, phrase);
  }
});
