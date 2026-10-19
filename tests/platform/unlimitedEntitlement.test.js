/**
 * Unlimited credits: who can get them (2026-10-19).
 *
 * Before this fix (reproduced on origin/main): any signup that typed an
 * address on UNLIMITED_USER_EMAILS got unlimited credits — the addresses are
 * public (committed to git history) and signup did not verify ownership.
 *
 * Unit tests need nothing. The `live` block (the audited grant script, the
 * legacy-account audit) needs AQUA_TEST_MONGO_URI and is skipped without it.
 */
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const { hasUnlimitedAccess, unlimitedAccessReason } = require(path.join(ROOT, "utils", "credits", "unlimitedAccess.js"));

function withAllowlist(list, fn) {
  const before = process.env.UNLIMITED_USER_EMAILS;
  process.env.UNLIMITED_USER_EMAILS = list;
  try { return fn(); } finally {
    if (before === undefined) delete process.env.UNLIMITED_USER_EMAILS; else process.env.UNLIMITED_USER_EMAILS = before;
  }
}

describe("UNLIMITED_USER_EMAILS honours only verified addresses", () => {
  const LIST = " Founder@Example.test , ops@example.test ";

  test("ORDINARY SIGNUP: an unverified account with an allowlisted address gets nothing", () => withAllowlist(LIST, () => {
    assert.equal(hasUnlimitedAccess({ email: "founder@example.test" }), false);                         // legacy (no flag)
    assert.equal(hasUnlimitedAccess({ email: "founder@example.test", emailVerified: false }), false);
    assert.equal(unlimitedAccessReason({ email: "founder@example.test" }), null);
  }));

  test("VERIFIED SIGNUP: the verified owner of an allowlisted address keeps unlimited access", () => withAllowlist(LIST, () => {
    assert.equal(hasUnlimitedAccess({ email: "founder@example.test", emailVerified: true }), true);
    assert.equal(unlimitedAccessReason({ email: "founder@example.test", emailVerified: true }), "email_allowlist_verified");
  }));

  test("EMAIL ALIASES: case and spaces normalise; provider aliases never widen the grant", () => withAllowlist(LIST, () => {
    assert.equal(hasUnlimitedAccess({ email: "  FOUNDER@example.TEST ", emailVerified: true }), true);
    for (const alias of ["founder+x@example.test", "f.ounder@example.test", "founder@example.test.evil", "xfounder@example.test", "founder@example"]) {
      assert.equal(hasUnlimitedAccess({ email: alias, emailVerified: true }), false, alias);
    }
  }));

  test("the audited database flag still grants, independent of email", () => withAllowlist("", () => {
    assert.equal(hasUnlimitedAccess({ email: "anyone@example.test", isUnlimited: true }), true);
    assert.equal(unlimitedAccessReason({ isUnlimited: true }), "isUnlimited_flag");
    assert.equal(hasUnlimitedAccess(null), false);
  }));

  test("no email address is logged by the entitlement check", () => {
    const src = fs.readFileSync(path.join(ROOT, "utils", "credits", "unlimitedAccess.js"), "utf8");
    assert.ok(!/console\.(log|info|warn|error)/.test(src));
  });
});

describe("clients cannot set their own balance or entitlements", () => {
  const files = ["index.js", "routes/billing/billing.routes.js", "services/billing/razorpay.service.js", "services/billing/webhook.handler.js", "services/credits/wallet.service.js", "middleware/usage/checkUsage.js", "middleware/usage/usageGuard.js", "middleware/usage/featureGuard.js"]
    .map((f) => [f, fs.readFileSync(path.join(ROOT, f), "utf8")]);

  test("no request field reaches a wallet, credit, role or entitlement", () => {
    for (const [f, src] of files) {
      assert.ok(!/req\.(body|query|params)\.(credits?|amount|wallet|paidCredits|freeCredits|isUnlimited|role|creditsToAdd|emailVerified|googleId)\b/.test(src), f);
      assert.ok(!/new User\(\s*req\.body/.test(src) && !/Object\.assign\(\s*user\s*,\s*req\.body/.test(src) && !/\.set\(\s*req\.body/.test(src), `${f}: mass assignment`);
    }
  });

  test("the only isUnlimited write in the app is the downgrade (false)", () => {
    for (const [f, src] of files) {
      for (const m of src.matchAll(/isUnlimited\s*=(?!=)\s*([^;\n]+)/g)) assert.match(m[1].trim(), /^false\b/, `${f}: ${m[0]}`);
      assert.ok(!/\$set:\s*\{[^}]*isUnlimited:\s*true/.test(src), `${f} sets isUnlimited: true`);
    }
  });

  test("purchased credits come from the server's pack table, never the request", () => {
    const billing = files.find(([f]) => f === "routes/billing/billing.routes.js")[1];
    assert.match(billing, /const validPacks = \["starter", "growth", "pro", "max"\];/);
    const rz = files.find(([f]) => f === "services/billing/razorpay.service.js")[1];
    assert.match(rz, /addPaidCredits\(userId, claimed\.creditsToAdd/);
  });
});

// Each live file gets its own database: they wipe collections, and the
// runner executes files in parallel.
const MONGO = process.env.AQUA_TEST_MONGO_URI
  ? process.env.AQUA_TEST_MONGO_URI.replace(/\/([^/?]+)(\?|$)/, "/$1_entitle$2")
  : undefined;
describe("live: the audited grant process and the legacy-account audit", { skip: MONGO ? false : "needs a TEST MongoDB — set AQUA_TEST_MONGO_URI" }, () => {
  let mongoose, User, EntitlementAudit, ProductEvent, script, audit;
  const run = async (argv) => {
    const saved = process.argv;

    const logs = []; const orig = console.log; console.log = (...a) => logs.push(a.join(" "));
    try { await script.main(["--mongo", MONGO, ...argv]); return logs.join("\n"); } finally { console.log = orig; process.argv = saved; }
  };

  before(async () => {
    mongoose = require(path.join(ROOT, "node_modules", "mongoose"));
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 5000 });
    User = require(path.join(ROOT, "models", "User.js"));
    EntitlementAudit = require(path.join(ROOT, "models", "EntitlementAudit.js"));
    ProductEvent = require(path.join(ROOT, "models", "ProductEvent.js"));
    script = require(path.join(ROOT, "scripts", "admin", "unlimited-entitlement.cjs"));
    audit = require(path.join(ROOT, "scripts", "admin", "audit-legacy-accounts.cjs"));
    await User.deleteMany({}); await EntitlementAudit.deleteMany({}); await ProductEvent.deleteMany({});
  });
  after(async () => {
    await User?.deleteMany({}); await EntitlementAudit?.deleteMany({}); await ProductEvent?.deleteMany({});
    // main() connects with the same mongoose; disconnect once at the end.
    await mongoose?.disconnect();
  });

  test("CHANGED EMAIL ADDRESS: verification does not follow an address change, so neither does the allowlist", async () => {
    const u = await User.create({ email: "old@example.test", password: "h", emailVerified: true, emailVerifiedVia: "email" });
    u.email = "founder@example.test";
    await u.save();
    const after = await User.findById(u._id);
    assert.equal(after.emailVerified, false);
    assert.equal(after.emailVerifiedVia, null);
    assert.equal(withAllowlist("founder@example.test", () => hasUnlimitedAccess(after)), false);
  });

  test("a grant is refused for an unverified account; a dry run writes nothing; --apply writes the flag AND an audit record", async () => {
    const unverified = await User.create({ email: "u1@example.test", password: "h" });
    await assert.rejects(run(["--grant", "--user-id", String(unverified._id), "--reason", "pilot founder", "--actor", "ops"]), /not verified/);
    const v = await User.create({ email: "v1@example.test", password: "h", emailVerified: true });
    const dry = await run(["--grant", "--user-id", String(v._id), "--reason", "pilot founder", "--actor", "ops"]);
    assert.match(dry, /dry run/);
    assert.doesNotMatch(dry, /v1@example\.test/, "output must mask the address");
    assert.equal((await User.findById(v._id)).isUnlimited, false);
    await run(["--grant", "--user-id", String(v._id), "--reason", "pilot founder", "--actor", "ops", "--apply"]);
    assert.equal((await User.findById(v._id)).isUnlimited, true);
    const rec = await EntitlementAudit.findOne({ userId: v._id }).lean();
    assert.deepEqual([rec.action, rec.reason, rec.actor, rec.before, rec.after], ["grant_unlimited", "pilot founder", "ops", false, true]);
    await run(["--revoke", "--user-id", String(v._id), "--reason", "pilot ended", "--actor", "ops", "--apply"]);
    assert.equal((await User.findById(v._id)).isUnlimited, false);
    assert.equal(await EntitlementAudit.countDocuments({ userId: v._id }), 2);
  });

  test("the legacy audit finds unverified password accounts that also signed in with Google; remediation is dry-run unless applied", async () => {
    await User.deleteMany({}); await ProductEvent.deleteMany({});
    const squat = await User.create({ email: "s@example.test", password: "bcrypt-hash" });
    const plain = await User.create({ email: "p@example.test", password: "bcrypt-hash" });
    await User.create({ email: "g@example.test", password: "google-oauth" });
    await User.collection.updateMany({}, { $unset: { emailVerified: "" } });
    await ProductEvent.create({ userId: String(squat._id), event: "login", props: { method: "google" } });
    await ProductEvent.create({ userId: String(plain._id), event: "login", props: { method: "email" } });
    const r = await audit.audit({ User, ProductEvent });
    assert.equal(r.legacyUnverifiedPassword, 2);
    assert.deepEqual(r.legacyUnverifiedPasswordWithGoogleLogins, [String(squat._id)]);
    assert.deepEqual(await audit.removeUnverifiedPasswords({ User }, r.legacyUnverifiedPasswordWithGoogleLogins, false), { wouldUpdate: 1 });
    assert.equal((await User.findById(squat._id)).password, "bcrypt-hash");
    await audit.removeUnverifiedPasswords({ User }, r.legacyUnverifiedPasswordWithGoogleLogins, true);
    const after = await User.findById(squat._id);
    assert.equal(after.password, "google-oauth");
    assert.equal(after.authVersion, 1);
    assert.equal((await User.findById(plain._id)).password, "bcrypt-hash", "an account without Google sign-ins was touched");
  });
});
