"use strict";
/**
 * index.js wiring of the identity policy (2026-10-19), and the mailer.
 *
 * index.js cannot boot without a live Mongo, so — like sessionFixation.test.js
 * — its use of the tested modules is asserted on the source. The behaviour
 * itself is tested for real in tests/platform/accountSecurity.live.test.js.
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const SRC = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
const at = (needle) => { const i = SRC.indexOf(needle); assert.ok(i > -1, `not found: ${needle}`); return i; };

describe("Google sign-in never matches an account by email alone", () => {
  test("the sign-in strategy delegates to resolveGoogleLogin; no email lookup is left in index.js", () => {
    assert.match(SRC, /identityPolicy\.resolveGoogleLogin\(\{ User \}, profile\)/);
    assert.doesNotMatch(SRC, /User\.findOne\(\{ email \}\)/);
    assert.doesNotMatch(SRC, /new User\(\{ email, password: "google-oauth" \}\)/);
  });

  test("the callback hands link-required to /auth/link and rejections to /login, and stamps the session", () => {
    const i = at('app.get(\n  "/auth/google/callback",');
    const block = SRC.slice(i, i + 4000);
    assert.match(block, /decision\.kind === "link-required"\) return authHandlers\.startLink\(req, res, decision\)/);
    assert.match(block, /res\.redirect\(`\/login\?error=google_\$\{encodeURIComponent\(reason\)\}`\)/);
    assert.match(block, /req\.logIn\(user, \{ keepSessionInfo: keepNativeSessionInfo \}/);
    assert.match(block, /identityPolicy\.stampSession\(req, req\.user\)/);
  });

  test("reauth and linking strategies accept only a Google-verified address", () => {
    const reauth = SRC.slice(at('"google-reauth",\n  new GoogleStrategy'), at("passport.serializeUser"));
    assert.match(reauth, /identityPolicy\.googleIdentity\(profile\)/);
    assert.match(reauth, /if \(!identity\.ok\) return done\(null, false\)/);
    const link = SRC.slice(at('"google-link",'), at('"google-reauth",\n  new GoogleStrategy'));
    assert.match(link, /identityPolicy\.googleIdentity\(profile\)/);
  });

  test("the native app completion stamps the session too", () => {
    const i = at('app.get("/auth/native/complete"');
    assert.match(SRC.slice(i, i + 3000), /identityPolicy\.stampSession\(req, user\)/);
  });
});

describe("routes", () => {
  test("every credential-handling POST is rate limited", () => {
    for (const r of ['app.post("/signup", authLimiter', 'app.post("/verify-email", authLimiter', 'app.post("/auth/link/password", authLimiter', 'app.post("/auth/link/claim", authLimiter']) at(r);
  });

  test("signed-in linking requires login and uses a session-less strategy", () => {
    at('app.get("/auth/google/link", requireLogin, authLimiter');
    const i = at('app.get(\n  "/auth/google/link/callback",');
    const block = SRC.slice(i, i + 1600);
    assert.match(block, /requireLogin/);
    assert.match(block, /passport\.authenticate\("google-link", \{ session: false/);
    assert.match(block, /identityPolicy\.linkGoogleToAccount\(\{ User \}, req\.session\.userId, req\.user\)/);
    assert.match(block, /authVersionGuard\.forget\(result\.user\._id\)/);
  });

  test("the session-version guard runs right after passport.session(), before any route", () => {
    const guard = at("app.use(authVersionGuard);");
    assert.ok(guard > at("app.use(passport.session());"));
    assert.ok(guard < at('app.get("/login"'));
  });

  test("email links never use the Host header in production", () => {
    const i = at("function linkBaseUrl(req)");
    const block = SRC.slice(i, i + 500);
    assert.match(block, /process\.env\.APP_URL/);
    assert.match(block, /if \(process\.env\.NODE_ENV === "production"\) throw/);
  });

  test("no timing oracle: login pays bcrypt for unknown emails; signup hashes before it branches on existence", () => {
    const i = at('app.post("/login"');
    const block = SRC.slice(i, i + 1600);
    assert.match(block, /bcrypt\.compare\(password, hasPassword \? user\.password : await loginDummyHash\(\)\)/);
    assert.doesNotMatch(block, /if \(!user\) return invalid\(\);/);
    const policy = fs.readFileSync(path.join(ROOT, "services", "auth", "identityPolicy.service.js"), "utf8");
    const s = policy.indexOf("async function startSignup(");
    const fn = policy.slice(s, policy.indexOf("\n}\n", s));
    assert.ok(fn.indexOf("await bcrypt.hash(password, 12)") > -1 && fn.indexOf("await bcrypt.hash(password, 12)") < fn.indexOf("if (existing)"), "signup must hash before branching on existence");
  });

  test("/login error text comes from a fixed table, never from the query string", () => {
    const i = at('app.get("/login"');
    const block = SRC.slice(i, i + 400);
    assert.match(block, /LOGIN_ERRORS\[/);
    assert.doesNotMatch(block, /error: req\.query/);
  });
});

describe("mailer", () => {
  const mailerPath = path.join(ROOT, "services", "auth", "mailer.service.js");
  const fresh = () => { delete require.cache[require.resolve(mailerPath)]; return require(mailerPath); };
  const withEnv = async (env, fn) => {
    const saved = {};
    for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
    try { return await fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  };

  test("no transport configured: unavailable, and sending reports false (fail closed)", () => withEnv({ MAIL_TRANSPORT: undefined }, async () => {
    const m = fresh();
    assert.equal(m.mailerAvailable(), false);
    assert.equal(await m.sendMail({ to: "a@example.test", subject: "s", text: "t" }), false);
  }));

  test("the log transport is refused in production (it would put live links in logs)", () => withEnv({ MAIL_TRANSPORT: "log", NODE_ENV: "production" }, async () => {
    assert.equal(fresh().mailerAvailable(), false);
  }));

  test("the log transport works outside production and masks the recipient", () => withEnv({ MAIL_TRANSPORT: "log", NODE_ENV: "development" }, async () => {
    const m = fresh();
    const lines = []; const orig = console.log; console.log = (s) => lines.push(String(s));
    try { assert.equal(await m.sendMail({ to: "founder@example.test", subject: "s", text: "t" }), true); } finally { console.log = orig; }
    assert.doesNotMatch(lines.join("\n"), /founder@example\.test/);
    assert.match(lines.join("\n"), /f\*\*\*@example\.test/);
  }));

  test("resend transport: request shape (stubbed fetch — the live provider is NOT exercised here)", () => withEnv({ MAIL_TRANSPORT: "resend", RESEND_API_KEY: "test-key", MAIL_FROM: "Aquiplex <no-reply@example.test>" }, async () => {
    const m = fresh();
    assert.equal(m.mailerAvailable(), true);
    const realFetch = global.fetch; let seen;
    global.fetch = async (url, init) => { seen = { url, init }; return { ok: true, status: 200 }; };
    try { assert.equal(await m.sendMail({ to: "a@example.test", subject: "Hi", text: "Body" }), true); } finally { global.fetch = realFetch; }
    assert.equal(seen.url, "https://api.resend.com/emails");
    assert.equal(seen.init.headers.Authorization, "Bearer test-key");
    assert.deepEqual(JSON.parse(seen.init.body), { from: "Aquiplex <no-reply@example.test>", to: ["a@example.test"], subject: "Hi", text: "Body" });
  }));

  test("a provider failure is reported as false, never thrown into the response path", () => withEnv({ MAIL_TRANSPORT: "resend", RESEND_API_KEY: "k", MAIL_FROM: "x@example.test" }, async () => {
    const m = fresh();
    const realFetch = global.fetch; const realErr = console.error;
    global.fetch = async () => ({ ok: false, status: 500 }); console.error = () => {};
    try { assert.equal(await m.sendMail({ to: "a@example.test", subject: "s", text: "t" }), false); } finally { global.fetch = realFetch; console.error = realErr; }
  }));
});
