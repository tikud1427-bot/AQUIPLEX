/**
 * Sprint 1 Task A (platform side) — the server's own log lines (2026-11-10).
 *
 * 1. The final error handler logged the error OBJECT. A malformed JSON body
 *    produces a body-parser SyntaxError whose `body` property is the raw
 *    request and whose message quotes it — so the user's whole message was
 *    printed. Driven here with a REAL express.json() failure.
 * 2. The native-OAuth legs logged `req.sessionID` in full — a bearer
 *    credential in the logs. They now log a keyed per-process tag.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const express = require("express");
const { sessionTag, errorSummary, stackFrames } = require("../../utils/logSafety");

const SENTINEL = "Zorblaxian-private-note";

test("a malformed JSON body never reaches the log (real body-parser error)", async () => {
  const logged = [];
  const app = express();
  app.use(express.json());
  app.post("/x", (req, res) => res.json({ ok: true }));
  // The exact statement index.js uses (asserted against the source below).
  app.use((err, req, res, next) => {
    logged.push(`Unhandled error: ${errorSummary(err)}`, `\n${stackFrames(err)}`);
    res.status(500).json({ reply: "x" });
  });
  const server = app.listen(0);
  const port = server.address().port;
  let caughtErr = null;
  app.use((err, _req, _res, _next) => { caughtErr = err; });
  const body = `{"message": "${SENTINEL} said something private",`;   // truncated JSON
  await new Promise((resolve, reject) => {
    const req = http.request({ port, path: "/x", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, res => { res.resume(); res.on("end", resolve); });
    req.on("error", reject); req.end(body);
  });
  server.close();
  const text = logged.join("\n");
  assert.match(text, /type=entity\.parse\.failed/, "the failure is still identifiable");
  assert.match(text, /status=400/);
  assert.doesNotMatch(text, new RegExp(SENTINEL), "the request body is not logged");

  // Positive control: what the OLD statement would have printed.
  const err = Object.assign(new SyntaxError(`Unexpected token in JSON: "${SENTINEL}"`), { type: "entity.parse.failed", body });
  const old = require("node:util").inspect(err);
  assert.match(old, new RegExp(SENTINEL), "console.error(err) would have printed the body");
  void caughtErr;
});

test("session ids are logged as a keyed tag, never in full", () => {
  const sid = "s%3AabcdefSESSIONSECRET1234567890.signature";
  const tag = sessionTag(sid);
  assert.match(tag, /^sess#[0-9a-f]{8}$/);
  assert.equal(tag, sessionTag(sid), "stable within the process (lines of one leg correlate)");
  assert.notEqual(tag, sessionTag(sid + "x"));
  assert.doesNotMatch(tag, /SESSIONSECRET/);
  assert.equal(sessionTag(undefined), "sess#none");
});

test("index.js uses the safe statements (no error object, no raw session id)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "index.js"), "utf8");
  assert.ok(src.includes("console.error(`Unhandled error: ${errorSummary(err)}`, `\\n${stackFrames(err)}`);"), "final handler logs the summary");
  assert.doesNotMatch(src, /console\.error\("Unhandled error:", err\)/, "the error object is not logged");
  assert.doesNotMatch(src, /session\.id=", req\.sessionID/, "no raw session id in log lines");
  assert.equal((src.match(/sessionTag\(req\.sessionID\)/g) || []).length, 3, "all three native-OAuth lines tag the session");
});
