"use strict";
/**
 * Google OAuth callbacks are accepted only on the session that started the
 * flow, once (services/auth/googleOAuthOptions.service.js).
 *
 * Drives the REAL passport-google-oauth20 strategy with the options index.js
 * uses; only Google's token endpoint and profile fetch are stubbed. Before
 * 2026-10-28 the strategies had no `state`, and every "[bite]" test below
 * authenticated the forged callback.
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Strategy: GoogleStrategy } = require("passport-google-oauth20");
const { googleStrategyOptions, SESSION_KEYS } = require("../../services/auth/googleOAuthOptions.service");

const ENV = { GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "test-secret" };
const PROFILE = { id: "g-123", emails: [{ value: "founder@example.com", verified: true }], _json: { email_verified: true } };

function makeStrategy(flow = "signin") {
  const s = new GoogleStrategy(
    googleStrategyOptions(flow, "https://aquiplex.com/auth/google/callback", ENV),
    (accessToken, refreshToken, profile, done) => done(null, { id: profile.id }),
  );
  s.exchanges = [];
  s._oauth2.getOAuthAccessToken = (code, params, cb) => {
    s.exchanges.push({ code, params });
    cb(null, "access-token", "refresh-token", {});
  };
  s.userProfile = (accessToken, done) => done(null, PROFILE);
  return s;
}

/** Runs one strategy.authenticate() and resolves with what passport would do. */
function run(strategy, req, options = {}) {
  return new Promise((resolve) => {
    const action = Object.create(strategy);
    action.redirect = (url) => resolve({ kind: "redirect", url });
    action.success = (user, info) => resolve({ kind: "success", user, info });
    action.fail = (challenge, status) => resolve({ kind: "fail", challenge, status });
    action.error = (err) => resolve({ kind: "error", err });
    action.pass = () => resolve({ kind: "pass" });
    action.authenticate(req, { scope: ["profile", "email"], ...options });
  });
}

const startReq = (session) => ({ query: {}, body: {}, session, headers: {}, url: "/auth/google" });
const callbackReq = (session, query) => ({ query, body: {}, session, headers: {}, url: "/auth/google/callback" });

async function start(strategy, session) {
  const r = await run(strategy, startReq(session));
  assert.equal(r.kind, "redirect");
  return new URL(r.url);
}

describe("Google OAuth start", () => {
  test("the authorization URL carries a state handle and an S256 PKCE challenge", async () => {
    const session = {};
    const url = await start(makeStrategy(), session);
    assert.equal(url.host, "accounts.google.com");
    const state = url.searchParams.get("state");
    assert.ok(state && state.length >= 16);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.ok(url.searchParams.get("code_challenge"));
    assert.equal(session[SESSION_KEYS.signin].state.handle, state);
  });

  test("each flow keeps its pending state in its own session slot", () => {
    const keys = new Set(["signin", "link", "reauth"].map((f) => googleStrategyOptions(f, "/cb", ENV).sessionKey));
    assert.equal(keys.size, 3);
    assert.throws(() => googleStrategyOptions("other", "/cb", ENV), TypeError);
  });
});

describe("Google OAuth callback", () => {
  test("the session that started the flow completes it, and the exchange proves PKCE", async () => {
    const strategy = makeStrategy();
    const session = {};
    const url = await start(strategy, session);
    const r = await run(strategy, callbackReq(session, { code: "auth-code", state: url.searchParams.get("state") }));
    assert.equal(r.kind, "success");
    assert.deepEqual(r.user, { id: "g-123" });
    const verifier = strategy.exchanges[0].params.code_verifier;
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    assert.equal(challenge, url.searchParams.get("code_challenge"));
    assert.equal(session[SESSION_KEYS.signin], undefined, "pending state is consumed");
  });

  test("[bite:forged] a callback on a session that never started a flow is refused", async () => {
    const strategy = makeStrategy();
    const attacker = {};
    const url = await start(strategy, attacker);
    const victim = {};
    const r = await run(strategy, callbackReq(victim, { code: "attacker-code", state: url.searchParams.get("state") }));
    assert.equal(r.kind, "fail");
    assert.equal(strategy.exchanges.length, 0, "the code is never exchanged");
  });

  test("[bite:missing] a callback without state is refused", async () => {
    const strategy = makeStrategy();
    const session = {};
    await start(strategy, session);
    const r = await run(strategy, callbackReq(session, { code: "auth-code" }));
    assert.equal(r.kind, "fail");
    assert.equal(strategy.exchanges.length, 0);
  });

  test("[bite:mismatch] a wrong state is refused and burns the pending one", async () => {
    const strategy = makeStrategy();
    const session = {};
    const url = await start(strategy, session);
    const wrong = await run(strategy, callbackReq(session, { code: "auth-code", state: "not-the-handle" }));
    assert.equal(wrong.kind, "fail");
    const retry = await run(strategy, callbackReq(session, { code: "auth-code", state: url.searchParams.get("state") }));
    assert.equal(retry.kind, "fail", "a guess cannot be followed by the right value");
    assert.equal(strategy.exchanges.length, 0);
  });

  test("[bite:replay] a completed callback cannot be replayed", async () => {
    const strategy = makeStrategy();
    const session = {};
    const url = await start(strategy, session);
    const query = { code: "auth-code", state: url.searchParams.get("state") };
    assert.equal((await run(strategy, callbackReq(session, query))).kind, "success");
    assert.equal((await run(strategy, callbackReq(session, query))).kind, "fail");
    assert.equal(strategy.exchanges.length, 1);
  });

  test("[bite:cross-flow] a pending link flow does not satisfy the sign-in callback", async () => {
    const session = {};
    const url = await start(makeStrategy("link"), session);
    const signin = makeStrategy("signin");
    const r = await run(signin, callbackReq(session, { code: "auth-code", state: url.searchParams.get("state") }));
    assert.equal(r.kind, "fail");
    assert.ok(session[SESSION_KEYS.link], "the link flow's state is untouched");
  });
});

describe("index.js wiring", () => {
  const SRC = fs.readFileSync(path.join(__dirname, "..", "..", "index.js"), "utf8");

  test("all three Google strategies are built from googleStrategyOptions", () => {
    assert.match(SRC, /googleStrategyOptions\("signin", process\.env\.GOOGLE_CALLBACK_URL \|\| "\/auth\/google\/callback"\)/);
    assert.match(SRC, /googleStrategyOptions\("link", process\.env\.GOOGLE_LINK_CALLBACK_URL \|\| "\/auth\/google\/link\/callback"\)/);
    assert.match(SRC, /googleStrategyOptions\("reauth", process\.env\.GOOGLE_REAUTH_CALLBACK_URL \|\| "\/auth\/google\/reauth\/callback"\)/);
    assert.equal((SRC.match(/new GoogleStrategy\(/g) || []).length, 3);
    assert.doesNotMatch(SRC, /new GoogleStrategy\(\s*\{/, "no strategy is built from a hand-written options object");
  });
});
