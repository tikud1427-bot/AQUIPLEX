"use strict";
/**
 * Email login and signup must authenticate a FRESH session id.
 *
 * Run: node --test tests/auth/sessionFixation.test.js   (root package)
 *
 * index.js cannot boot in a test process (it awaits live Mongo), so — as in
 * tests/account/sessionLogout.test.js — the decision lives in a pure module
 * tested for real here, and its use by the routes is asserted on the source.
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { establishSession } = require("../../services/auth/establishSession.service");

const indexSrc = fs.readFileSync(path.join(__dirname, "..", "..", "index.js"), "utf8");

/** Minimal express-session double: regenerate() swaps in a new id and empty data. */
function fakeReq(initial = {}) {
  let n = 0;
  const req = {};
  const fresh = () => {
    const s = {
      id: `sid-${n++}`,
      regenerate(cb) { req.session = fresh(); cb(null); },
      save(cb) { s.saved = true; cb(null); },
    };
    return s;
  };
  req.session = Object.assign(fresh(), initial);
  return req;
}

const user = { _id: "507f1f77bcf86cd799439011", email: "Asha@example.com" };

describe("establishSession", () => {
  test("the authenticated session has a different id than the pre-login one", async () => {
    const req = fakeReq({ _csrfToken: "pre-login-token" });
    const before = req.session.id;
    await establishSession(req, user);
    assert.notEqual(req.session.id, before);
    assert.equal(req.session.userId, user._id);
    assert.equal(req.session.saved, true);
  });

  test("nothing from the pre-login session survives", async () => {
    const req = fakeReq({ _csrfToken: "pre-login-token", planted: "x" });
    await establishSession(req, user);
    assert.equal(req.session._csrfToken, undefined);
    assert.equal(req.session.planted, undefined);
  });

  test("a regenerate failure rejects rather than signing in on the old id", async () => {
    const req = fakeReq();
    req.session.regenerate = (cb) => cb(new Error("store down"));
    await assert.rejects(establishSession(req, user), /store down/);
    assert.equal(req.session.userId, undefined);
  });
});

describe("routes use it", () => {
  const routeBody = (method, p) => {
    const start = indexSrc.indexOf(`app.${method}("${p}"`);
    assert.ok(start >= 0, `route ${p} not found`);
    const end = indexSrc.indexOf("\napp.", start + 1);
    return indexSrc.slice(start, end);
  };

  test("POST /login signs in through establishSession, never by writing the session directly", () => {
    const body = routeBody("post", "/login");
    assert.match(body, /establishSession\(req,/);
    assert.doesNotMatch(body, /req\.session\.userId\s*=/);
  });

  // Since 2026-10-19 /signup signs NO ONE in (it only emails a verification
  // link); the email-signup sign-in happens at POST /verify-email, in
  // services/auth/authRoutes.service.js verifySubmit.
  const authRoutesSrc = fs.readFileSync(path.join(__dirname, "..", "..", "services", "auth", "authRoutes.service.js"), "utf8");
  const fnBody = (name) => {
    const start = authRoutesSrc.indexOf(`async function ${name}(`);
    assert.ok(start >= 0, `${name} not found`);
    return authRoutesSrc.slice(start, authRoutesSrc.indexOf("\n  }\n", start));
  };

  test("POST /signup and /verify-email are wired to the auth handlers", () => {
    assert.match(indexSrc, /app\.post\("\/signup", authLimiter, authHandlers\.signup\)/);
    assert.match(indexSrc, /app\.post\("\/verify-email", authLimiter, authHandlers\.verifySubmit\)/);
  });

  test("signup never signs anyone in", () => {
    const body = fnBody("signup");
    assert.doesNotMatch(body, /establishSession|req\.session\.userId\s*=|req\.logIn/);
  });

  test("verify-email signs in through establishSession, never by writing the session directly", () => {
    const body = fnBody("verifySubmit");
    assert.match(body, /establishSession\(req,/);
    assert.doesNotMatch(body, /req\.session\.userId\s*=/);
  });

  test("the session records the account's authVersion (so a later security change can end it)", async () => {
    const req = fakeReq();
    await establishSession(req, { ...user, authVersion: 3 });
    assert.equal(req.session.authVersion, 3);
  });

  test("login gives one answer for unknown email and wrong password", () => {
    const body = routeBody("post", "/login");
    assert.doesNotMatch(body, /User not found/);
  });
});
