/**
 * Account takeover and identity linking — live, over HTTP (2026-10-19).
 *
 * The real handlers (services/auth/authRoutes.service.js), the real policy
 * (identityPolicy.service.js), the real views and the real mongoose models,
 * mounted in a minimal Express app against a TEST MongoDB. The Google OAuth
 * round trip itself is replaced by a test-only route that hands a profile to
 * the same decision function the strategy calls (resolveGoogleLogin) and then
 * does exactly what /auth/google/callback does with the result.
 *
 * Needs AQUA_TEST_MONGO_URI (e.g. mongodb://127.0.0.1:57017/aqua_authtest);
 * skipped with a reason otherwise. Never point it at a real database: every
 * test wipes the users / pendingsignups collections of that database.
 *
 * Before this fix (reproduced on origin/main's code): an attacker's password
 * signup for victim@ and the victim's later Google sign-in landed in the SAME
 * account, and the attacker's password still opened it.
 */
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const http = require("node:http");

// Each live file gets its own database: they wipe collections, and the
// runner executes files in parallel.
const MONGO = process.env.AQUA_TEST_MONGO_URI
  ? process.env.AQUA_TEST_MONGO_URI.replace(/\/([^/?]+)(\?|$)/, "/$1_acctsec$2")
  : undefined;
const skip = MONGO ? false : "needs a TEST MongoDB — set AQUA_TEST_MONGO_URI";
const ROOT = path.join(__dirname, "..", "..");

let mongoose, express, session, bcrypt, Passport;
let User, PendingSignup, policy, mailer, createAuthHandlers, establishSession;
let server, base, mails = [], mailerOn = true;

function profile(sub, email, verified = true) {
  return { id: sub, emails: [{ value: email, verified }] };
}

/** A browser: keeps its own cookies, never follows redirects. */
function agent() {
  let cookie = "";
  async function req(method, url, form) {
    const body = form ? new URLSearchParams(form).toString() : undefined;
    const res = await fetch(base + url, {
      method, redirect: "manual",
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      body,
    });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) cookie = c.split(";")[0];
    return { status: res.status, location: res.headers.get("location"), text: await res.text(), cookie };
  }
  return {
    get: (u) => req("GET", u), post: (u, f) => req("POST", u, f),
    whoami: async () => JSON.parse((await req("GET", "/__whoami")).text).userId,
    google: (p) => req("POST", "/__google", { profile: JSON.stringify(p) }),
    get cookie() { return cookie; },
  };
}

const tokenFrom = (mail) => /token=([A-Za-z0-9_-]+)/.exec(mail.text)?.[1];

describe("account security — signup, verification, Google linking", { skip }, () => {
  before(async () => {
    mongoose = require(path.join(ROOT, "node_modules", "mongoose"));
    express = require(path.join(ROOT, "node_modules", "express"));
    session = require(path.join(ROOT, "node_modules", "express-session"));
    bcrypt = require(path.join(ROOT, "node_modules", "bcrypt"));
    ({ Passport } = require(path.join(ROOT, "node_modules", "passport")));
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 5000 });
    User = require(path.join(ROOT, "models", "User.js"));
    PendingSignup = require(path.join(ROOT, "models", "PendingSignup.js"));
    await User.init(); await PendingSignup.init();
    policy = require(path.join(ROOT, "services", "auth", "identityPolicy.service.js"));
    mailer = require(path.join(ROOT, "services", "auth", "mailer.service.js"));
    ({ createAuthHandlers } = require(path.join(ROOT, "services", "auth", "authRoutes.service.js")));
    ({ establishSession } = require(path.join(ROOT, "services", "auth", "establishSession.service.js")));
    mailer._setTransportForTests(async (m) => { mails.push(m); });

    const passport = new Passport();
    passport.serializeUser((u, done) => done(null, String(u._id)));
    passport.deserializeUser(async (id, done) => { try { done(null, await User.findById(id)); } catch (e) { done(e); } });

    const app = express();
    app.set("view engine", "ejs");
    app.set("views", path.join(ROOT, "views"));
    app.use(express.urlencoded({ extended: false }));
    app.use(session({ secret: "test-only", resave: false, saveUninitialized: true }));
    app.use(passport.initialize());
    app.use(passport.session());
    const guard = policy.enforceAuthVersion({ User, ttlMs: 0 });
    app.use(guard);
    app.use((req, res, next) => { res.locals.user = null; next(); });

    const finishLogin = (req, res, user) => req.logIn(user, (err) => {
      if (err) return res.status(500).end();
      req.session.userId = user._id;
      policy.stampSession(req, user);
      req.session.save(() => res.redirect("/home"));
    });
    const h = createAuthHandlers({
      User, PendingSignup, sendMail: mailer.sendMail,
      mailerAvailable: () => mailerOn && mailer.mailerAvailable(),
      baseUrl: () => "https://app.test", establishSession, finishLogin, versionGuard: guard,
    });
    app.post("/signup", h.signup);
    app.get("/verify-email", h.verifyForm);
    app.post("/verify-email", h.verifySubmit);
    app.get("/auth/link", h.linkForm);
    app.post("/auth/link/password", h.linkPassword);
    app.post("/auth/link/claim", h.linkClaim);
    // TEST-ONLY stand-ins for the OAuth round trip and for /login.
    app.post("/__google", async (req, res, next) => {
      try {
        const decision = await policy.resolveGoogleLogin({ User }, JSON.parse(req.body.profile));
        if (decision.kind === "login" || decision.kind === "created") return finishLogin(req, res, decision.user);
        if (decision.kind === "link-required") return h.startLink(req, res, decision);
        return res.redirect(`/login?error=google_${decision.reason}`);
      } catch (e) { next(e); }
    });
    app.post("/__password-login", async (req, res) => {
      const u = await User.findOne({ email: policy.normalizeEmail(req.body.email) });
      const ok = u && policy.isPasswordAccount(u) && await bcrypt.compare(req.body.password, u.password);
      if (!ok) return res.status(401).end();
      await establishSession(req, u);
      res.redirect("/home");
    });
    app.get("/__whoami", (req, res) => res.json({ userId: req.session.userId ? String(req.session.userId) : null }));

    server = http.createServer(app);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    mailer._setTransportForTests(null);
    await User?.deleteMany({}); await PendingSignup?.deleteMany({});
    await new Promise((r) => server ? server.close(r) : r());
    await mongoose?.disconnect();
  });

  beforeEach(async () => {
    await User.deleteMany({}); await PendingSignup.deleteMany({});
    mails = []; mailerOn = true;
  });

  // ── Takeover ───────────────────────────────────────────────────────────────

  test("ATTEMPTED TAKEOVER: an attacker's signup for the victim's address creates no account; the victim's Google sign-in gets a fresh account the attacker cannot open", async () => {
    const attacker = agent(), victim = agent();
    const r = await attacker.post("/signup", { email: "victim@example.test", password: "attacker-pw-123" });
    assert.equal(r.status, 200);
    assert.equal(await attacker.whoami(), null, "signup signed the attacker in");
    assert.equal(await User.countDocuments({}), 0, "signup created an account before verification");

    const g = await victim.google(profile("g-victim", "victim@example.test"));
    assert.equal(g.location, "/home");
    const acct = await User.findOne({ email: "victim@example.test" });
    assert.equal(acct.googleId, "g-victim");
    assert.equal(acct.password, policy.GOOGLE_SENTINEL);
    assert.equal(await victim.whoami(), String(acct._id));
    assert.equal((await attacker.post("/__password-login", { email: "victim@example.test", password: "attacker-pw-123" })).status, 401);
  });

  test("the victim opening the attacker-initiated link cannot complete it without the attacker's password", async () => {
    const attacker = agent(), victim = agent();
    await attacker.post("/signup", { email: "victim@example.test", password: "attacker-pw-123" });
    const token = tokenFrom(mails.at(-1));
    assert.ok(token);
    const r = await victim.post("/verify-email", { token, password: "victims-guess-1" });
    assert.equal(r.status, 401);
    assert.equal(await User.countDocuments({}), 0);
    assert.equal(await victim.whoami(), null);
  });

  test("EXISTING-ACCOUNT MIGRATION: a legacy squatted account is NOT entered by Google sign-in; the owner claims it, the squatter's password and session die", async () => {
    const legacy = await User.create({ email: "founder@example.test", password: await bcrypt.hash("squatter-pw-1", 4) });
    await User.collection.updateOne({ _id: legacy._id }, { $unset: { emailVerified: "" } });   // as created before the fix
    const squatter = agent(), founder = agent();
    assert.equal((await squatter.post("/__password-login", { email: "founder@example.test", password: "squatter-pw-1" })).status, 302);
    assert.equal(await squatter.whoami(), String(legacy._id));

    const before = founder.cookie;
    const g = await founder.google(profile("g-founder", "founder@example.test"));
    assert.equal(g.location, "/auth/link");
    assert.notEqual(founder.cookie, before, "the pending Google identity must live on a fresh session id");
    assert.equal(await founder.whoami(), null, "Google sign-in entered a password account automatically");
    assert.equal((await User.findById(legacy._id)).googleId, null);

    const page = await founder.get("/auth/link");
    assert.match(page.text, /removes that password/);
    assert.equal((await founder.post("/auth/link/claim", {})).status, 400, "claimed without explicit confirmation");

    const c = await founder.post("/auth/link/claim", { confirm: "yes" });
    assert.equal(c.location, "/home");
    const acct = await User.findById(legacy._id);
    assert.equal(acct.googleId, "g-founder");
    assert.equal(acct.password, policy.GOOGLE_SENTINEL, "the unverified password survived the claim");
    assert.equal(acct.emailVerified, true);
    assert.equal(acct.authVersion, 1);
    assert.equal(await founder.whoami(), String(legacy._id));
    assert.equal(await squatter.whoami(), null, "the squatter's session survived the claim");
    assert.equal((await squatter.post("/__password-login", { email: "founder@example.test", password: "squatter-pw-1" })).status, 401);
  });

  test("a legacy Google-created account (sentinel, no googleId) is bound on its next Google sign-in", async () => {
    const legacy = await User.create({ email: "g-user@example.test", password: policy.GOOGLE_SENTINEL });
    await User.collection.updateOne({ _id: legacy._id }, { $unset: { emailVerified: "" } });
    const a = agent();
    assert.equal((await a.google(profile("g-1", "G-User@Example.test"))).location, "/home");
    const acct = await User.findById(legacy._id);
    assert.equal(acct.googleId, "g-1");
    assert.equal(acct.emailVerified, true);
    assert.equal(await a.whoami(), String(legacy._id));
    assert.equal(await User.countDocuments({}), 1, "a duplicate account was created");
  });

  // ── Linking ────────────────────────────────────────────────────────────────

  test("LEGITIMATE LINKING: the owner proves the password, Google is linked, the address becomes verified, the password stays", async () => {
    const hash = await bcrypt.hash("owner-pw-1234", 4);
    const owner = await User.create({ email: "owner@example.test", password: hash });
    const a = agent();
    await a.google(profile("g-owner", "owner@example.test"));
    assert.equal((await a.post("/auth/link/password", { password: "wrong-password" })).status, 401);
    assert.equal((await User.findById(owner._id)).googleId, null);
    const r = await a.post("/auth/link/password", { password: "owner-pw-1234" });
    assert.equal(r.location, "/home");
    const acct = await User.findById(owner._id);
    assert.equal(acct.googleId, "g-owner");
    assert.equal(acct.emailVerified, true);
    assert.equal(acct.password, hash);
    assert.equal(await a.whoami(), String(owner._id));
    // Next time Google signs straight in, by identity.
    const b = agent();
    assert.equal((await b.google(profile("g-owner", "owner@example.test"))).location, "/home");
    assert.equal(await b.whoami(), String(owner._id));
  });

  test("VERIFIED MATCHING EMAIL: a verified password account is still not entered automatically by Google", async () => {
    await User.create({ email: "v@example.test", password: await bcrypt.hash("pw-12345678", 4), emailVerified: true, emailVerifiedVia: "email" });
    const a = agent();
    assert.equal((await a.google(profile("g-v", "v@example.test"))).location, "/auth/link");
    assert.equal(await a.whoami(), null);
    const page = await a.get("/auth/link");
    assert.doesNotMatch(page.text, /removes that password/, "a verified account's password is not at risk and is kept");
  });

  test("a verified account claimed with Google keeps its password; other sessions still end", async () => {
    const hash = await bcrypt.hash("pw-12345678", 4);
    const u = await User.create({ email: "kept@example.test", password: hash, emailVerified: true, emailVerifiedVia: "email" });
    const other = agent(), owner = agent();
    await other.post("/__password-login", { email: "kept@example.test", password: "pw-12345678" });
    assert.equal(await other.whoami(), String(u._id));
    await owner.google(profile("g-kept", "kept@example.test"));
    await owner.post("/auth/link/claim", { confirm: "yes" });
    const acct = await User.findById(u._id);
    assert.equal(acct.password, hash);
    assert.equal(acct.googleId, "g-kept");
    assert.equal(await other.whoami(), null);
  });

  test("UNVERIFIED GOOGLE EMAIL: rejected — no account created, an existing one untouched", async () => {
    const a = agent();
    const r = await a.google(profile("g-x", "new@example.test", false));
    assert.equal(r.location, "/login?error=google_unverified_email");
    assert.equal(await User.countDocuments({}), 0);
    const existing = await User.create({ email: "keep@example.test", password: policy.GOOGLE_SENTINEL });
    await a.google(profile("g-y", "keep@example.test", false));
    assert.equal((await User.findById(existing._id)).googleId, null);
    assert.equal(await a.whoami(), null);
  });

  test("CONFLICTING IDENTITIES: an account bound to one Google identity refuses another; one Google identity cannot bind two accounts", async () => {
    await User.create({ email: "c@example.test", password: policy.GOOGLE_SENTINEL, googleId: "g-1", emailVerified: true });
    const a = agent();
    assert.equal((await a.google(profile("g-2", "c@example.test"))).location, "/login?error=google_conflicting_identity");
    assert.equal(await a.whoami(), null);

    const pw = await User.create({ email: "d@example.test", password: await bcrypt.hash("pw-12345678", 4) });
    const r = await policy.claimWithGoogle({ User }, { googleId: "g-1", email: "d@example.test", at: Date.now() });
    assert.deepEqual([r.ok, r.reason], [false, "conflicting_identity"]);
    assert.equal((await User.findById(pw._id)).googleId, null);
    await assert.rejects(User.create({ email: "e@example.test", password: "x", googleId: "g-1" }), (e) => e.code === 11000);
  });

  test("signed-in linking from the account: verified owner may link; a different Google address needs a verified account and must not belong to another account", async () => {
    const unverified = await User.create({ email: "u@example.test", password: "h" });
    const res1 = await policy.linkGoogleToAccount({ User }, unverified._id, policy.googleIdentity(profile("g-other", "other@example.test")));
    assert.deepEqual([res1.ok, res1.reason], [false, "verify_first"]);
    const same = await policy.linkGoogleToAccount({ User }, unverified._id, policy.googleIdentity(profile("g-u", "u@example.test")));
    assert.equal(same.ok, true);
    assert.equal(same.user.emailVerified, true, "Google verified the account's own address");

    const verified = await User.create({ email: "w@example.test", password: "h", emailVerified: true });
    await User.create({ email: "taken@example.test", password: "h" });
    const res2 = await policy.linkGoogleToAccount({ User }, verified._id, policy.googleIdentity(profile("g-t", "taken@example.test")));
    assert.deepEqual([res2.ok, res2.reason], [false, "conflicting_identity"]);
    const res3 = await policy.linkGoogleToAccount({ User }, verified._id, policy.googleIdentity(profile("g-w2", "w.alt@example.test")));
    assert.equal(res3.ok, true);
    assert.equal((await User.findById(verified._id)).emailVerifiedVia, null, "a different Google address must not count as verifying this one");
  });

  test("the pending Google identity expires after 10 minutes", async () => {
    await User.create({ email: "slow@example.test", password: await bcrypt.hash("pw-12345678", 4) });
    const r = await policy.claimWithGoogle({ User }, { googleId: "g-s", email: "slow@example.test", at: Date.now() - policy.PENDING_GOOGLE_TTL_MS - 1000 });
    assert.deepEqual([r.ok, r.reason], [false, "expired"]);
    assert.equal((await agent().get("/auth/link")).location, "/login?error=google_expired");
  });

  // ── Verification links ─────────────────────────────────────────────────────

  test("signup → link + the chosen password → a VERIFIED account, signed in", async () => {
    const a = agent();
    await a.post("/signup", { email: "New@Example.test", password: "chosen-pw-123" });
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, "new@example.test");
    const token = tokenFrom(mails[0]);
    assert.match(mails[0].text, /^https:\/\/app\.test\/verify-email\?token=/m);
    assert.equal(await PendingSignup.countDocuments({ tokenHash: token }), 0, "the raw token was stored");
    const form = await a.get(`/verify-email?token=${token}`);
    assert.equal(form.status, 200);
    const r = await a.post("/verify-email", { token, password: "chosen-pw-123" });
    assert.equal(r.location, "/aqua");
    const u = await User.findOne({ email: "new@example.test" });
    assert.equal(u.emailVerified, true);
    assert.equal(u.emailVerifiedVia, "email");
    assert.equal(await a.whoami(), String(u._id));
  });

  test("EXPIRED TOKEN: refused, no account", async () => {
    await agent().post("/signup", { email: "late@example.test", password: "chosen-pw-123" });
    const token = tokenFrom(mails[0]);
    await PendingSignup.updateOne({ email: "late@example.test" }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const r = await agent().post("/verify-email", { token, password: "chosen-pw-123" });
    assert.equal(r.status, 400);
    assert.match(r.text, /expired/);
    assert.equal(await User.countDocuments({}), 0);
  });

  test("REPLAYED TOKEN: the second use is refused and creates nothing; a concurrent double submit creates one account", async () => {
    await agent().post("/signup", { email: "once@example.test", password: "chosen-pw-123" });
    const token = tokenFrom(mails[0]);
    const [x, y] = await Promise.all([agent().post("/verify-email", { token, password: "chosen-pw-123" }), agent().post("/verify-email", { token, password: "chosen-pw-123" })]);
    assert.deepEqual([x.status, y.status].sort(), [302, 400]);
    const replay = await agent().post("/verify-email", { token, password: "chosen-pw-123" });
    assert.equal(replay.status, 400);
    assert.match(replay.text, /already been used/);
    assert.equal(await User.countDocuments({ email: "once@example.test" }), 1);
  });

  test("a token is locked after 5 wrong passwords", async () => {
    await agent().post("/signup", { email: "brute@example.test", password: "chosen-pw-123" });
    const token = tokenFrom(mails[0]);
    for (let i = 0; i < 5; i++) assert.equal((await agent().post("/verify-email", { token, password: `guess-${i}-xxxx` })).status, 401);
    const r = await agent().post("/verify-email", { token, password: "chosen-pw-123" });
    assert.equal(r.status, 400);
    assert.match(r.text, /Too many wrong passwords/);
    assert.equal(await User.countDocuments({}), 0);
  });

  test("a garbage or unknown token is refused without a lookup oracle", async () => {
    for (const token of ["", "short", "x".repeat(43)]) {
      const r = await agent().post("/verify-email", { token, password: "whatever-123" });
      assert.equal(r.status, 400);
    }
  });

  test("a Google account created for the address meanwhile: the link refuses (no second account, no merge)", async () => {
    await agent().post("/signup", { email: "race@example.test", password: "chosen-pw-123" });
    const token = tokenFrom(mails[0]);
    await agent().google(profile("g-race", "race@example.test"));
    const r = await agent().post("/verify-email", { token, password: "chosen-pw-123" });
    assert.equal(r.status, 400);
    assert.match(r.text, /already exists/);
    assert.equal(await User.countDocuments({ email: "race@example.test" }), 1);
    assert.equal((await User.findOne({ email: "race@example.test" })).password, policy.GOOGLE_SENTINEL);
  });

  // ── Enumeration and availability ───────────────────────────────────────────

  test("NO ENUMERATION: signup answers identically for a new and an existing address", async () => {
    await User.create({ email: "exists@example.test", password: "h", emailVerified: true });
    const a = await agent().post("/signup", { email: "exists@example.test", password: "chosen-pw-123" });
    const b = await agent().post("/signup", { email: "fresh@example.test", password: "chosen-pw-123" });
    assert.equal(a.status, b.status);
    const norm = (t) => t.replace(/(exists|fresh)@example\.test/g, "EMAIL");
    assert.equal(norm(a.text), norm(b.text));
    assert.equal(mails.length, 2);
    assert.ok(!tokenFrom(mails.find((m) => m.to === "exists@example.test")), "the existing account's owner got a usable signup link");
  });

  test("at most 3 signup emails per address per hour (mail-bombing cap), same answer after the cap", async () => {
    for (let i = 0; i < 5; i++) assert.equal((await agent().post("/signup", { email: "cap@example.test", password: "chosen-pw-123" })).status, 200);
    assert.equal(mails.length, 3);
  });

  test("no mail transport: email signup is switched off (fail closed), nothing is stored", async () => {
    mailerOn = false;
    const r = await agent().post("/signup", { email: "off@example.test", password: "chosen-pw-123" });
    assert.equal(r.status, 503);
    assert.match(r.text, /Continue with Google/);
    assert.equal(await PendingSignup.countDocuments({}), 0);
  });

  test("weak input is refused before anything is stored", async () => {
    assert.equal((await agent().post("/signup", { email: "a@b", password: "chosen-pw-123" })).status, 400);
    assert.equal((await agent().post("/signup", { email: "ok@example.test", password: "short" })).status, 400);
    assert.equal(await PendingSignup.countDocuments({}), 0);
  });
});
