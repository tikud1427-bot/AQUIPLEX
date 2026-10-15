"use strict";
/**
 * Product events + activation math.
 * Run: node --test tests/platform/productEvents.test.js
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const {
  classifyEngineRequest, sanitizeProps, recordProductEvent, engineEventTap, EVENTS,
} = require("../../services/analytics/productEvents");
const { computeActivation, isoWeek } = require("../../services/analytics/activation");

const ROOT = path.join(__dirname, "..", "..");
const indexSrc = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");

describe("classifyEngineRequest", () => {
  const cases = [
    ["POST", "/chat", 200, "chat_turn"],
    ["POST", "/chat/stream", 200, "chat_turn"],
    ["POST", "/v1/chat", 200, "chat_turn"],
    ["POST", "/upload", 200, "upload_completed"],
    ["POST", "/project/workspace/abc/files", 200, "upload_completed"],
    ["POST", "/project/workspace", 200, "project_created"],
    ["POST", "/memory/fact", 200, "memory_corrected"],
    ["POST", "/brain/claims/c1/correct", 200, "memory_corrected"],
    ["DELETE", "/memory/fact/name", 200, "memory_forgotten"],
    ["DELETE", "/memory", 200, "memory_forgotten"],
    ["POST", "/chat", 402, null],          // out of credits is not a turn
    ["POST", "/chat", 500, null],
    ["GET", "/chat", 200, null],
    ["GET", "/memory", 200, null],
    ["POST", "/project/workspace/abc/query", 200, null],
  ];
  for (const [m, p, s, want] of cases) {
    test(`${m} ${p} ${s} -> ${want}`, () => assert.equal(classifyEngineRequest(m, p, s), want));
  }
});

describe("no content is ever recorded", () => {
  test("props keep only short scalar tokens", () => {
    const out = sanitizeProps({
      method: "email", firstRun: true, n: 3,
      prompt: "My salary is 90k and my manager is Priya",    // > 32 chars, spaces
      file: { name: "contract.pdf" }, list: ["a"], "bad key": "x",
    });
    assert.deepEqual(out, { method: "email", firstRun: true, n: 3 });
  });

  test("unknown event names and missing users are dropped", () => {
    const seen = [];
    const sink = async (d) => seen.push(d);
    assert.equal(recordProductEvent("u1", "prompt_text", {}, { sink }), false);
    assert.equal(recordProductEvent(null, "chat_turn", {}, { sink }), false);
    assert.equal(seen.length, 0);
  });

  test("a recorded document has exactly userId, event, at, props", async () => {
    const seen = [];
    recordProductEvent("u1", "chat_turn", { method: "x" }, { sink: async (d) => seen.push(d) });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(Object.keys(seen[0]).sort(), ["at", "event", "props", "userId"]);
  });

  test("a failing sink never throws into the request", async () => {
    assert.doesNotThrow(() => recordProductEvent("u1", "chat_turn", null, { sink: async () => { throw new Error("db down"); } }));
    await new Promise((r) => setImmediate(r));
  });

  test("the kill switch turns recording off", () => {
    process.env.AQUA_PRODUCT_EVENTS = "off";
    try {
      assert.equal(recordProductEvent("u1", "chat_turn", null, { sink: async () => {} }), false);
    } finally {
      delete process.env.AQUA_PRODUCT_EVENTS;
    }
  });
});

test("engineEventTap uses the path seen at entry, not after nested routers rewrite req.url", async () => {
  const seen = [];
  const tap = engineEventTap({ sink: async (d) => seen.push(d) });
  const req = { method: "POST", path: "/chat", session: { userId: "u9" } };
  const res = new EventEmitter();
  tap(req, res, () => {});
  req.path = "/";                       // what a nested router leaves behind
  res.statusCode = 200;
  res.emit("finish");
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].event, "chat_turn");
  assert.equal(seen[0].userId, "u9");
});

describe("computeActivation", () => {
  const D = 24 * 3600 * 1000;
  const t0 = Date.UTC(2026, 8, 7, 10);           // Monday 2026-09-07 10:00Z
  const ev = (userId, event, offsetMs) => ({ userId, event, at: new Date(t0 + offsetMs) });

  const events = [
    // A: two chat days within 7d, back in week 1 and week 4 -> activated, retained
    ev("A", "signup_completed", 0), ev("A", "chat_turn", 5 * 60000), ev("A", "upload_completed", 10 * 60000),
    ev("A", "chat_turn", 2 * D), ev("A", "chat_turn", 8 * D), ev("A", "chat_turn", 29 * D),
    ev("A", "memory_corrected", 2 * D),
    // B: many chats, all on day 0 -> NOT activated
    ev("B", "signup_completed", 0), ev("B", "chat_turn", 60000), ev("B", "chat_turn", 120000), ev("B", "chat_turn", 180000),
    // C: never chatted
    ev("C", "signup_completed", 0),
    // D: pre-instrumentation account (no signup event) -> no cohort, but its turns count in totals
    ev("D", "chat_turn", D),
  ];

  test("activation needs a second day, not just volume", () => {
    const r = computeActivation(events, { now: t0 + 40 * D });
    assert.equal(r.cohorts.length, 1);
    const c = r.cohorts[0];
    assert.equal(c.signups, 3);
    assert.equal(c.firstChatPct, 66.7);
    assert.equal(c.gaveContextPct, 33.3);
    assert.equal(c.activated7dPct, 33.3);       // A only
    assert.equal(c.retainedW1Pct, 33.3);
    assert.equal(c.retainedW4Pct, 33.3);
    assert.equal(c.medianMinutesToFirstChat, 3);   // A=5, B=1 -> median 3
    assert.equal(r.totals.chatTurns, 8);          // A 4 + B 3 + D 1
    assert.equal(r.totals.corrections, 1);
  });

  test("windows that have not elapsed are not counted either way", () => {
    const r = computeActivation(events, { now: t0 + 3 * D });
    const c = r.cohorts[0];
    assert.equal(c.eligible7d, 0);
    assert.equal(c.activated7dPct, null);
    assert.equal(c.retainedW1Pct, null);
  });

  test("ISO week cohorts", () => {
    assert.equal(isoWeek(new Date(t0)), "2026-W37");
    assert.equal(isoWeek(new Date(Date.UTC(2027, 0, 1))), "2026-W53");
  });
});

describe("wiring", () => {
  test("signup, login and the engine tap are wired in index.js", () => {
    assert.match(indexSrc, /aquaEngine\.use\(engineEventTap\(\)\)/);
    assert.match(indexSrc, /recordProductEvent\(newUser\._id, "signup_completed"/);
    assert.match(indexSrc, /recordProductEvent\(user\._id, "login"/);
    assert.match(indexSrc, /firstRun \? "signup_completed" : "login"/);
  });

  test("account deletion removes the user's product events", () => {
    const del = fs.readFileSync(path.join(ROOT, "services", "account", "accountDeletion.service.js"), "utf8");
    assert.match(del, /ProductEvent\.deleteMany\(\{ userId: String\(uid\) \}\)/);
  });

  test("the event list is the documented one", () => {
    assert.deepEqual([...EVENTS].sort(), [
      "chat_turn", "login", "memory_corrected", "memory_forgotten", "project_created", "signup_completed", "upload_completed",
    ]);
  });
});
