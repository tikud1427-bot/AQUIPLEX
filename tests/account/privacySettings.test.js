"use strict";
/**
 * Privacy setting `rememberSensitive` (2026-10-28): may AQUA remember health
 * and mood details? Off by default.
 *
 * Run: node --test tests/account/*.test.js   (root package)
 *
 * Same split as sessionLogout.test.js: the decisions live in
 * services/account/privacySettings.service.js and are tested for real against
 * a fake model; that the setting reaches the engine (mounted before
 * aquaEngine) and the routes exist is asserted statically against the source.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const svc = require("../../services/account/privacySettings.service");
const User = require("../../models/User");

function fakeModel(initial = {}) {
  const docs = new Map(Object.entries(initial));
  let reads = 0;
  const chain = (v) => ({ select: () => ({ lean: async () => v }) });
  return {
    get reads() { return reads; },
    docs,
    findById(id) { reads++; return chain(docs.get(id) ?? null); },
    findByIdAndUpdate(id, { $set }) {
      const doc = docs.get(id) ?? {};
      doc.privacy = { ...(doc.privacy ?? {}), rememberSensitive: $set["privacy.rememberSensitive"] };
      docs.set(id, doc);
      return chain(doc);
    },
  };
}

test("the schema default is OFF", () => {
  const u = new User({ email: "a@b.co", password: "x" });
  assert.equal(u.privacy.rememberSensitive, false);
});

test("an account that never chose is OFF; a read failure is OFF (fails closed)", async () => {
  svc._clearCache();
  assert.deepEqual(await svc.getPrivacy("u1", { model: fakeModel({ u1: {} }) }), { rememberSensitive: false });
  svc._clearCache();
  const broken = { findById() { throw new Error("mongo down"); } };
  assert.deepEqual(await svc.getPrivacy("u2", { model: broken }), { rememberSensitive: false });
  assert.deepEqual(await svc.getPrivacy(null), { rememberSensitive: false });
});

test("set → get on this instance takes effect at once (cache updated, not stale)", async () => {
  svc._clearCache();
  const m = fakeModel({ u3: {} });
  assert.equal((await svc.getPrivacy("u3", { model: m })).rememberSensitive, false);
  await svc.setPrivacy("u3", { rememberSensitive: true }, { model: m });
  assert.equal((await svc.getPrivacy("u3", { model: m })).rememberSensitive, true);
  // only strict booleans are written
  await svc.setPrivacy("u3", { rememberSensitive: "yes" }, { model: m });
  assert.equal(m.docs.get("u3").privacy.rememberSensitive, true);
});

test("middleware hands the engine req.aquaSettings", async () => {
  svc._clearCache();
  const req = { aquaUserId: "nobody" };
  await new Promise((resolve) => svc.attachAquaSettings((r) => r.aquaUserId)(req, {}, resolve));
  assert.deepEqual(req.aquaSettings, { rememberSensitive: false });
});

test("wiring: mounted before the engine; routes exist; the engine reads it per turn", () => {
  const root = path.join(__dirname, "..", "..");
  const index = fs.readFileSync(path.join(root, "index.js"), "utf8");
  const access = index.slice(index.indexOf("const aquaAccess = ["), index.indexOf("];", index.indexOf("const aquaAccess = [")));
  assert.ok(access.indexOf("attachAquaSettings(") > -1 && access.indexOf("attachAquaSettings(") < access.indexOf("aquaEngine"));
  const routes = fs.readFileSync(path.join(root, "routes", "account", "account.routes.js"), "utf8");
  assert.match(routes, /router\.get\("\/privacy", requireLogin/);
  assert.match(routes, /router\.put\("\/privacy", requireLogin/);
  const chat = fs.readFileSync(path.join(root, "aqua", "src", "routes", "chat.js"), "utf8");
  assert.equal((chat.match(/rememberSensitive: req\.aquaSettings\?\.rememberSensitive === true/g) ?? []).length, 2, "both /chat and /chat/stream");
});
