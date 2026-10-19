/**
 * scripts/admin/account-security-audit.cjs — finds each seeded scenario, and
 * WRITES NOTHING (every collection hashed before and after). 2026-10-19.
 *
 * Needs AQUA_TEST_MONGO_URI (a TEST database; this file uses its own db name
 * suffix and wipes it). Skipped with a reason otherwise.
 */
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const MONGO = process.env.AQUA_TEST_MONGO_URI
  ? process.env.AQUA_TEST_MONGO_URI.replace(/\/([^/?]+)(\?|$)/, "/$1_audit$2")
  : undefined;

describe("read-only account security audit", { skip: MONGO ? false : "needs a TEST MongoDB — set AQUA_TEST_MONGO_URI" }, () => {
  let mongoose, M, script, seeded;

  async function snapshot() {
    const db = mongoose.connection.db;
    const out = {};
    for (const { name } of await db.listCollections().toArray()) {
      const docs = await db.collection(name).find({}).sort({ _id: 1 }).toArray();
      // Index definitions too: loading models must not build indexes (a write).
      const indexes = (await db.collection(name).indexes()).map((i) => i.name).sort();
      out[name] = crypto.createHash("sha256").update(JSON.stringify({ docs, indexes })).digest("hex");
    }
    return out;
  }

  before(async () => {
    mongoose = require(path.join(ROOT, "node_modules", "mongoose"));
    await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 5000 });
    await mongoose.connection.db.dropDatabase();
    const m = (f) => require(path.join(ROOT, "models", f));
    M = { User: m("User.js"), ProductEvent: m("ProductEvent.js"), Payment: m("Payment.js"), Transaction: m("Transaction.js"), EntitlementAudit: m("EntitlementAudit.js") };
    script = require(path.join(ROOT, "scripts", "admin", "account-security-audit.cjs"));
    const t = (iso) => new Date(iso);

    // Identity scenarios (legacy accounts: no emailVerified field, as before the fix)
    const squatted = await M.User.create({ email: "victim@example.test", password: "bcrypt-hash" });         // password set, then Google, then password again
    const shared = await M.User.create({ email: "both@example.test", password: "bcrypt-hash" });            // password then Google only
    const plain = await M.User.create({ email: "plain@example.test", password: "bcrypt-hash" });            // password only
    const google = await M.User.create({ email: "g@example.test", password: "google-oauth" });
    const verified = await M.User.create({ email: "ok@example.test", password: "bcrypt-hash", emailVerified: true });
    await M.User.collection.updateMany({ _id: { $in: [squatted._id, shared._id, plain._id, google._id] } }, { $unset: { emailVerified: "" } });
    await M.ProductEvent.insertMany([
      { userId: String(squatted._id), event: "signup_completed", at: t("2026-08-01"), props: { method: "email" } },
      { userId: String(squatted._id), event: "login", at: t("2026-08-05"), props: { method: "google" } },
      { userId: String(squatted._id), event: "login", at: t("2026-08-09"), props: { method: "email" } },
      { userId: String(shared._id), event: "signup_completed", at: t("2026-08-01"), props: { method: "email" } },
      { userId: String(shared._id), event: "login", at: t("2026-08-02"), props: { method: "google" } },
      { userId: String(plain._id), event: "login", at: t("2026-08-02"), props: { method: "email" } },
    ]);

    // Entitlement scenarios
    const flagged = await M.User.create({ email: "flag@example.test", password: "google-oauth", isUnlimited: true, emailVerified: true });
    const granted = await M.User.create({ email: "granted@example.test", password: "google-oauth", isUnlimited: true, emailVerified: true });
    await M.EntitlementAudit.create({ userId: granted._id, action: "grant_unlimited", reason: "pilot", actor: "ops", before: false, after: true });
    const allowSquat = await M.User.create({ email: "founder@example.test", password: "bcrypt-hash" });
    await M.User.collection.updateOne({ _id: allowSquat._id }, { $unset: { emailVerified: "" } });

    // Payment scenarios
    const buyer = await M.User.create({ email: "buyer@example.test", password: "google-oauth", emailVerified: true, wallet: { totalEarned: 500 } });
    const minted = await M.User.create({ email: "minted@example.test", password: "google-oauth", emailVerified: true, wallet: { totalEarned: 900 } });
    const p1 = await M.Payment.create({ user: buyer._id, packId: "starter", amountPaise: 9900, creditsToAdd: 500, razorpayOrderId: "order_A", razorpayPaymentId: "pay_A", status: "success", paidAt: t("2026-09-01"), creditedAt: t("2026-09-01") });
    await M.Payment.create({ user: minted._id, packId: "starter", amountPaise: 9900, creditsToAdd: 500, razorpayOrderId: "order_B", status: "success", paidAt: t("2026-09-02"), webhookId: "wh_B", creditedAt: t("2026-09-02") });
    await M.Payment.create({ user: minted._id, packId: "starter", amountPaise: 9900, creditsToAdd: 500, razorpayOrderId: "order_old", razorpayPaymentId: "pay_old", status: "success", paidAt: t("2026-06-01") });
    await M.Transaction.create({ user: minted._id, type: "PURCHASE", amount: 400, balanceAfter: { freeCredits: 0, paidCredits: 900 } });
    await M.Transaction.create({ user: buyer._id, type: "PURCHASE", amount: 500, balanceAfter: { freeCredits: 0, paidCredits: 500 }, paymentId: p1._id });
    await mongoose.connection.db.collection("sessions").insertMany([{ _id: "s1" }, { _id: "s2" }]);
    seeded = { squatted, shared, plain, flagged, granted, allowSquat, minted, verified };
  });

  after(async () => {
    await mongoose?.connection.db.dropDatabase().catch(() => {});
    await mongoose?.disconnect();
  });

  test("finds every seeded scenario, and writes nothing", async () => {
    const allowFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "audit-")), "allow.txt");
    fs.writeFileSync(allowFile, "Founder@Example.test, nobody-yet@example.test\nok@example.test");
    const before = await snapshot();
    const logs = []; const orig = console.log; console.log = (...a) => logs.push(a.join(" "));
    let r;
    // The local test server has no auth, so the read-only-user check is waived explicitly here.
    try { r = await script.main(["--mongo", MONGO, "--allowlist-file", allowFile, "--since", "2026-07-04", "--allow-write-capable-user"]); } finally { console.log = orig; }
    assert.deepEqual(await snapshot(), before, "the audit modified the database");

    const id = (u) => String(u._id);
    assert.equal(r.identity.unverifiedPasswordAccounts, 4);   // squatted, shared, plain, allowSquat
    assert.deepEqual(r.identity.unverifiedPasswordWithGoogleSignIns.sort(), [id(seeded.squatted), id(seeded.shared)].sort());
    assert.deepEqual(r.identity.passwordSignInsAfterFirstGoogleSignIn, [id(seeded.squatted)]);
    assert.deepEqual(r.entitlements.isUnlimitedWithoutAuditRecord, [id(seeded.flagged)]);
    assert.equal(r.entitlements.allowlistedAddresses, 3);
    assert.equal(r.entitlements.allowlistedWithoutAccount, 1);
    assert.deepEqual(r.entitlements.allowlistedHeldByUnverifiedPasswordAccount, [id(seeded.allowSquat)]);
    assert.equal(r.payments.successfulSinceExposure, 2, "a payment before the exposure window was counted");
    assert.equal(r.payments.creditedViaWebhook, 1);
    assert.equal(r.payments.successWithoutPaymentId.length, 1);
    assert.deepEqual(r.payments.ordersToReconcile.map((o) => o.orderId).sort(), ["order_A", "order_B"]);
    assert.equal(r.payments.purchaseTransactionsWithoutPayment.length, 1);
    assert.deepEqual(r.payments.earnedExceedsSuccessfulPayments, []);   // minted: 900 earned, 1000 paid (incl. the June payment)
    assert.equal(r.sessions.stored, 2);

    const printed = logs.join("\n") + JSON.stringify(r);
    assert.doesNotMatch(printed, /@example\.test/i, "the audit printed an email address");
  });

  test("a wallet that earned more than its successful payments is flagged", async () => {
    await M.User.updateOne({ _id: seeded.minted._id }, { $set: { "wallet.totalEarned": 5000 } });
    const r = await script.audit({ ...M, db: mongoose.connection.db }, { allowlist: [], since: new Date("2026-07-04") });
    assert.deepEqual(r.payments.earnedExceedsSuccessfulPayments, [{ userId: String(seeded.minted._id), earned: 5000, backedByPayments: 1000 }]);
  });

  test("refuses to run without an explicit --mongo (never reads .env)", async () => {
    await assert.rejects(script.main([]), /--mongo <uri> is required/);
  });

  test("the CONNECTION must be read-only: an unauthenticated or readWrite user is refused, a read-only user accepted", async () => {
    const db = mongoose.connection.db;
    await assert.rejects(script.assertReadOnlyConnection(db), /unauthenticated connection/);
    const dbName = db.databaseName;
    const pw = crypto.randomBytes(12).toString("hex");
    for (const [user, role] of [["audit_rw", "readWrite"], ["audit_ro", "read"]]) {
      try { await db.command({ dropUser: user }); } catch { /* not there */ }
      await db.command({ createUser: user, pwd: pw, roles: [{ role, db: dbName }] });
    }
    const base = MONGO.replace("mongodb://", "");
    const as = async (user) => {
      const conn = await mongoose.createConnection(`mongodb://${user}:${pw}@${base}${base.includes("?") ? "&" : "?"}authSource=${dbName}`, { autoIndex: false }).asPromise();
      try { return await script.assertReadOnlyConnection(conn.db); } finally { await conn.close(); }
    };
    await assert.rejects(as("audit_rw"), /this database user can write/);
    const ok = await as("audit_ro");
    assert.equal(ok.writes.length, 0);
    for (const user of ["audit_rw", "audit_ro"]) await db.command({ dropUser: user });
  });
});

describe("account-security-audit.cjs contains no write operations (static)", () => {
  test("only reads: no insert/update/delete/save/drop/bulk/index calls", () => {
    const src = fs.readFileSync(path.join(ROOT, "scripts", "admin", "account-security-audit.cjs"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");   // ignore comments
    const writes = src.match(/\.(insert\w*|update\w*|replace\w*|delete\w*|remove\w*|save|create(?!Hash|Connection)\w*|drop\w*|bulkWrite|findOneAnd\w*|findByIdAnd\w*|createIndex\w*|syncIndexes|ensureIndexes)\s*\(/g) ?? [];
    assert.deepEqual(writes, []);
    assert.match(src, /autoIndex: false, autoCreate: false/);
  });
});
