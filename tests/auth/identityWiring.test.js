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

  // Resend's documented error bodies: { statusCode, name, message }.
  const RESEND = "re_test_key";
  const capture = async (fn) => {
    const out = []; const e = console.error, l = console.log;
    console.error = (s) => out.push(String(s)); console.log = (s) => out.push(String(s));
    try { return { value: await fn(), log: out.join("\n") }; } finally { console.error = e; console.log = l; }
  };
  const withFetch = async (impl, fn) => { const real = global.fetch; global.fetch = impl; try { return await fn(); } finally { global.fetch = real; } };

  test("Resend rejects an unverified sender domain: false, and the log carries Resend's reason and what to fix", () => withEnv({ MAIL_TRANSPORT: "resend", RESEND_API_KEY: RESEND, MAIL_FROM: "Aquiplex <no-reply@aquiplex.example>" }, async () => {
    const m = fresh();
    const { value, log } = await withFetch(async () => ({ ok: false, status: 403, json: async () => ({ statusCode: 403, name: "validation_error", message: "The aquiplex.example domain is not verified. Please, add and verify your domain on https://resend.com/domains" }) }),
      () => capture(() => m.sendMail({ to: "founder@example.test", subject: "s", text: "secret-link-token" })));
    assert.equal(value, false);
    assert.match(log, /responded 403 \(validation_error: The aquiplex\.example domain is not verified/);
    assert.match(log, /MAIL_FROM domain is not verified in Resend/);
    assert.doesNotMatch(log, /founder@example\.test/, "recipient must be masked");
    assert.doesNotMatch(log, /secret-link-token/, "the message body (which holds the link) must never be logged");
    assert.doesNotMatch(log, new RegExp(RESEND), "the API key must never be logged");
  }));

  test("Resend rejects the API key: false, logged as a key problem", () => withEnv({ MAIL_TRANSPORT: "resend", RESEND_API_KEY: RESEND, MAIL_FROM: "x@aquiplex.example" }, async () => {
    const m = fresh();
    const { value, log } = await withFetch(async () => ({ ok: false, status: 401, json: async () => ({ name: "missing_api_key", message: "Missing API key in the authorization header" }) }),
      () => capture(() => m.sendMail({ to: "a@example.test", subject: "s", text: "t" })));
    assert.equal(value, false);
    assert.match(log, /401 \(missing_api_key/);
    assert.match(log, /RESEND_API_KEY/);
  }));

  test("addresses inside a provider message are masked too (testing-mode refusal names the account owner)", () => withEnv({ MAIL_TRANSPORT: "resend", RESEND_API_KEY: RESEND, MAIL_FROM: "x@aquiplex.example" }, async () => {
    const m = fresh();
    const { log } = await withFetch(async () => ({ ok: false, status: 403, json: async () => ({ name: "validation_error", message: "You can only send testing emails to your own email address (owner@company.test)." }) }),
      () => capture(() => m.sendMail({ to: "a@example.test", subject: "s", text: "t" })));
    assert.doesNotMatch(log, /owner@company\.test/);
    assert.match(log, /o\*\*\*@company\.test/);
  }));

  test("network failure or timeout: false, never thrown; the request carries a timeout signal", () => withEnv({ MAIL_TRANSPORT: "resend", RESEND_API_KEY: RESEND, MAIL_FROM: "x@aquiplex.example" }, async () => {
    const m = fresh(); let signal;
    const { value, log } = await withFetch(async (url, init) => { signal = init.signal; throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); },
      () => capture(() => m.sendMail({ to: "a@example.test", subject: "s", text: "t" })));
    assert.equal(value, false);
    assert.ok(signal, "fetch to Resend must have a timeout");
    assert.match(log, /send failed .*timeout/);
  }));

  test("a delivered message logs the Resend id (and only a masked recipient)", () => withEnv({ MAIL_TRANSPORT: "resend", RESEND_API_KEY: RESEND, MAIL_FROM: "x@aquiplex.example" }, async () => {
    const m = fresh();
    const { value, log } = await withFetch(async () => ({ ok: true, status: 200, json: async () => ({ id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" }) }),
      () => capture(() => m.sendMail({ to: "founder@example.test", subject: "s", text: "link-xyz" })));
    assert.equal(value, true);
    assert.match(log, /\[MAIL\] sent to=f\*\*\*@example\.test id=49a3999c/);
    assert.doesNotMatch(log, /link-xyz|founder@example\.test/);
  }));
});

describe("mailer status — actionable diagnostics, never secret values", () => {
  const mailerPath = path.join(ROOT, "services", "auth", "mailer.service.js");
  const fresh = () => { delete require.cache[require.resolve(mailerPath)]; return require(mailerPath); };
  const ALL = ["MAIL_TRANSPORT", "RESEND_API_KEY", "MAIL_FROM", "APP_URL", "NODE_ENV"];
  const withEnv = async (env, fn) => {
    const saved = {};
    for (const k of ALL) { saved[k] = process.env[k]; delete process.env[k]; if (env[k] !== undefined) process.env[k] = env[k]; }
    try { return await fn(); } finally { for (const k of ALL) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  };
  const PROD_OK = { NODE_ENV: "production", MAIL_TRANSPORT: "resend", RESEND_API_KEY: "re_live_secret_value", MAIL_FROM: "Aquiplex <no-reply@aquiplex.com>", APP_URL: "https://aquiplex.com" };

  test("production, fully configured: ready", () => withEnv(PROD_OK, () => {
    const s = fresh().mailerStatus();
    assert.deepEqual([s.ready, s.transport, s.problems, s.warnings], [true, "resend", [], []]);
  }));

  test("production with nothing set (the reported outage): not ready, and each missing variable is named", () => withEnv({ NODE_ENV: "production" }, () => {
    const s = fresh().mailerStatus();
    assert.equal(s.ready, false);
    assert.match(s.problems.join("\n"), /MAIL_TRANSPORT is not set/);
    assert.match(s.problems.join("\n"), /APP_URL is not set/);
  }));

  for (const [missing, re] of [["RESEND_API_KEY", /RESEND_API_KEY is not set/], ["MAIL_FROM", /MAIL_FROM is not set/], ["APP_URL", /APP_URL is not set/]]) {
    test(`production without ${missing}: not ready, named`, () => withEnv({ ...PROD_OK, [missing]: undefined }, () => {
      const s = fresh().mailerStatus();
      assert.equal(s.ready, false);
      assert.match(s.problems.join("\n"), re);
    }));
  }

  test("production with MAIL_TRANSPORT=log: not ready (links would be logged)", () => withEnv({ ...PROD_OK, MAIL_TRANSPORT: "log" }, () => {
    const s = fresh().mailerStatus();
    assert.equal(s.ready, false);
    assert.match(s.problems.join("\n"), /refused when NODE_ENV=production/);
  }));

  test("an unknown transport, a malformed MAIL_FROM or a relative APP_URL: not ready", () => withEnv({ ...PROD_OK, MAIL_TRANSPORT: "smtp" }, async () => {
    assert.match(fresh().mailerStatus().problems.join(), /"smtp" is not supported/);
    await withEnv({ ...PROD_OK, MAIL_FROM: "no-reply" }, () => assert.match(fresh().mailerStatus().problems.join(), /MAIL_FROM is not an address/));
    await withEnv({ ...PROD_OK, APP_URL: "aquiplex.com" }, () => assert.match(fresh().mailerStatus().problems.join(), /APP_URL must be an absolute URL/));
  }));

  test("a key that does not look like a Resend key is a warning, not a block", () => withEnv({ ...PROD_OK, RESEND_API_KEY: "sk-something" }, () => {
    const s = fresh().mailerStatus();
    assert.equal(s.ready, true);
    assert.match(s.warnings.join(), /does not start with "re_"/);
  }));

  test("development with MAIL_TRANSPORT=log: ready, APP_URL optional", () => withEnv({ NODE_ENV: "development", MAIL_TRANSPORT: "log" }, () => {
    const s = fresh().mailerStatus();
    assert.deepEqual([s.ready, s.transport], [true, "log"]);
  }));

  test("the startup line names what is missing and never prints the API key", () => withEnv({ ...PROD_OK, MAIL_FROM: undefined }, () => {
    const out = []; const e = console.error, l = console.log, w = console.warn;
    console.error = console.log = console.warn = (s) => out.push(String(s));
    try { fresh().logMailerStatus(); } finally { console.error = e; console.log = l; console.warn = w; }
    const log = out.join("\n");
    assert.match(log, /Email signup: OFF/);
    assert.match(log, /MAIL_FROM is not set/);
    assert.doesNotMatch(log, /re_live_secret_value/);
  }));

  test("the request-path warning is throttled", () => withEnv({ NODE_ENV: "production" }, () => {
    const m = fresh(); const e = console.error; console.error = () => {};
    try {
      assert.equal(m.warnUnavailable(undefined, 1_000_000_000), true);
      assert.equal(m.warnUnavailable(undefined, 1_000_000_000 + 60_000), false);
      assert.equal(m.warnUnavailable(undefined, 1_000_000_000 + 11 * 60_000), true);
    } finally { console.error = e; }
  }));

  test("index.js gates /signup on mailerStatus().ready (transport + APP_URL in production), and startup reports it", () => {
    const i = at("const authHandlers = createAuthHandlers({");
    const block = SRC.slice(i, i + 800);
    assert.match(block, /mailer\.mailerStatus\(\)/);
    assert.match(block, /return status\.ready;/);
    assert.match(fs.readFileSync(path.join(ROOT, "utils", "startup.js"), "utf8"), /mailer\.service"\)\.logMailerStatus\(\)/);
  });
});
