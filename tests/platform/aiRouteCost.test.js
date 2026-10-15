"use strict";
/**
 * Every platform route that spends LLM tokens is signed-in, rate limited and
 * metered.
 *
 * Run: node --test tests/platform/aiRouteCost.test.js
 *
 * Before this test, POST /generate-bundle called the model for anonymous
 * callers (a script could drain the shared provider quota), and
 * /execute-step and /bundle/:id/run were free for any signed-in account.
 * index.js cannot boot without Mongo, so this asserts on the source: for each
 * `app.<verb>(...)` route whose handler reaches generateAI or runBundle, the
 * guard chain must name engineLimiter, requireLogin and usageGuard.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "..", "..", "index.js"), "utf8");

function routes() {
  const re = /\napp\.(get|post|put|patch|delete)\(\s*("[^"]+"|\[[^\]]+\]|\/[^,]+\/)/g;
  const out = [];
  let m;
  while ((m = re.exec(src))) out.push({ verb: m[1], path: m[2], start: m.index });
  return out.map((r, i) => ({ ...r, body: src.slice(r.start, out[i + 1]?.start ?? src.length) }));
}

const spending = routes().filter((r) => /\bgenerateAI\(|\brunBundle\(/.test(r.body));

test("found the AI-spending routes (guards against this test silently matching nothing)", () => {
  const paths = spending.map((r) => r.path);
  for (const p of ['"/generate-bundle"', '"/execute-step"', '"/bundle/:id/run"']) {
    assert.ok(paths.includes(p), `expected ${p} among ${paths.join(", ")}`);
  }
});

for (const r of spending) {
  test(`${r.verb.toUpperCase()} ${r.path} is signed-in, rate limited and metered`, () => {
    const header = r.body.slice(0, r.body.indexOf("async (req, res)"));
    const guards = header.includes("bundleAiGuard")
      ? src.slice(src.indexOf("const bundleAiGuard"), src.indexOf("];", src.indexOf("const bundleAiGuard")))
      : header;
    assert.match(guards, /requireLogin/);
    assert.match(guards, /engineLimiter/);
    assert.match(guards, /usageGuard\(/);
  });
}

test("/bundle/:id/run checks ownership before runBundle loads by id", () => {
  const r = spending.find((x) => x.path === '"/bundle/:id/run"');
  const own = r.body.indexOf("userId: req.session.userId");
  const run = r.body.indexOf("runBundle(");
  assert.ok(own > 0 && own < run, "ownership check must precede runBundle");
});
