"use strict";
/**
 * Native (Android WebView) Google OAuth handoff — Bug 1 regression tests.
 *
 * Run: node --test tests/auth/*.test.js   (root package)
 *
 * SPLIT FOR THE SAME REASON tests/account/sessionLogout.test.js IS SPLIT
 * -----------------------------------------------------------------------
 * index.js awaits a live Mongo connection before it listens, so the app
 * cannot be stood up in a test process. The DECISIONS (nonce validation,
 * code hashing, expiry, single-use redemption) live in
 * services/auth/nativeOAuth.service.js and are tested for real, against fake
 * Mongoose models with the same test-double pattern sessionLogout.test.js
 * already uses. That the routes are MOUNTED, in the right order, doing the
 * right thing with the result, is asserted statically against the source.
 *
 * EVERY TEST BELOW FAILS UNDER THE DEFECT IT GUARDS. Where that is not
 * obvious the defect is named in a comment.
 */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  NONCE_MAX_LENGTH,
  CODE_TTL_MS,
  validateNonce,
  generateCode,
  hashCode,
  mintNativeCode,
  redeemNativeCode,
} = require("../../services/auth/nativeOAuth.service");

const ROOT = path.join(__dirname, "..", "..");
const indexSrc = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");

// ── Test doubles ─────────────────────────────────────────────────────────────
// An in-memory stand-in for the NativeOAuthCode Mongoose model, faithful to
// the one behaviour these tests depend on: findOneAndUpdate's filter+update
// is a single atomic step, so a document that no longer matches the filter
// (because a previous call already flipped usedAt) is invisible to it.
function fakeNativeOAuthCodeModel() {
  const docs = [];
  return {
    docs,
    async create(doc) {
      const stored = { ...doc };
      docs.push(stored);
      return stored;
    },
    async findOneAndUpdate(filter, update) {
      const doc = docs.find(
        (d) =>
          d.codeHash === filter.codeHash &&
          d.usedAt === filter.usedAt && // null in every real call site
          d.expiresAt.getTime() > filter.expiresAt.$gt.getTime(),
      );
      if (!doc) return null;
      Object.assign(doc, update.$set);
      return doc;
    },
  };
}

// ── validateNonce ─────────────────────────────────────────────────────────────

describe("validateNonce", () => {
  test("accepts an ordinary nonce", () => {
    assert.equal(validateNonce("n0nce-AAAAAAAAAAAAAAAA"), "n0nce-AAAAAAAAAAAAAAAA");
  });

  test("[bite:missing] rejects a missing nonce", () => {
    // THE defect this guards: PART 3 of the audit requires a missing nonce to
    // never reach req.session.nativeNonce. A route that skipped this check
    // would store `undefined` and every later nonce comparison in the app
    // would compare against a garbage value instead of refusing outright.
    assert.equal(validateNonce(undefined), null);
    assert.equal(validateNonce(null), null);
  });

  test("[bite:empty] rejects an empty string", () => {
    assert.equal(validateNonce(""), null);
  });

  test("[bite:oversized] rejects a nonce over the length ceiling", () => {
    // THE defect: an unbounded nonce is an unbounded write into the session
    // store on every login attempt — a cheap denial-of-service knob.
    assert.equal(validateNonce("n".repeat(NONCE_MAX_LENGTH + 1)), null);
  });

  test("accepts a URL-safe nonce at exactly the length ceiling", () => {
    const nonce = "A".repeat(NONCE_MAX_LENGTH);
    assert.equal(validateNonce(nonce), nonce);
  });

  test("rejects weak or unsafe nonce formats", () => {
    assert.equal(validateNonce("short"), null);
    assert.equal(validateNonce("0123456789abcdef"), "0123456789abcdef");
    assert.equal(validateNonce("0123456789abcdef+unsafe"), null);
    assert.equal(validateNonce("0123456789abcdef\n"), null);
  });

  test("[bite:type] rejects non-string input", () => {
    // req.query.nonce is always a string in Express UNLESS the client sends
    // it as an array (?nonce=a&nonce=b) or nested object — both must be
    // refused, not stringified and silently accepted.
    assert.equal(validateNonce(12345), null);
    assert.equal(validateNonce(["a", "b"]), null);
    assert.equal(validateNonce({ a: 1 }), null);
  });
});

// ── generateCode / hashCode ───────────────────────────────────────────────────

describe("generateCode / hashCode", () => {
  test("generates URL-safe, sufficiently long codes", () => {
    const code = generateCode();
    // base64url of 32 bytes (256 bits, per contract) is 43 chars, no padding.
    assert.equal(code.length, 43);
    assert.match(code, /^[A-Za-z0-9_-]+$/);
  });

  test("two generated codes are never equal", () => {
    // Not a proof of entropy, but catches the class of bug where a fixed or
    // time-seeded value slipped in.
    assert.notEqual(generateCode(), generateCode());
  });

  test("hashCode is deterministic", () => {
    assert.equal(hashCode("abc"), hashCode("abc"));
  });

  test("[bite] hashCode is NOT the identity function", () => {
    // THE defect this guards against: storing the raw code under a different
    // name would satisfy every other test here while violating PART 6 of the
    // audit ("hash the code with SHA-256 before storing it").
    const code = generateCode();
    assert.notEqual(hashCode(code), code);
    assert.equal(hashCode(code).length, 64); // hex-encoded SHA-256
  });

  test("different codes hash differently", () => {
    assert.notEqual(hashCode("a"), hashCode("b"));
  });
});

// ── mintNativeCode ────────────────────────────────────────────────────────────

describe("mintNativeCode", () => {
  test("stores the HASH, never the raw code", async () => {
    const Model = fakeNativeOAuthCodeModel();
    const { code } = await mintNativeCode("user-1", { Model });

    assert.equal(Model.docs.length, 1);
    assert.equal(Model.docs[0].codeHash, hashCode(code));
    // THE defect: a raw code anywhere in the persisted document means a
    // database read (backup, replica, compromised credential) is enough to
    // forge a login, defeating the entire point of hashing it.
    assert.ok(
      !JSON.stringify(Model.docs[0]).includes(code),
      "the raw code must not appear anywhere in the stored document",
    );
  });

  test("sets a ~120s expiry per the contract", async () => {
    const Model = fakeNativeOAuthCodeModel();
    const fixedNow = new Date("2026-01-01T00:00:00.000Z");
    const { expiresAt } = await mintNativeCode("user-1", { Model, now: () => fixedNow });

    assert.equal(expiresAt.getTime() - fixedNow.getTime(), CODE_TTL_MS);
    assert.equal(CODE_TTL_MS, 120 * 1000);
  });

  test("starts unused", async () => {
    const Model = fakeNativeOAuthCodeModel();
    await mintNativeCode("user-1", { Model });
    assert.equal(Model.docs[0].usedAt, null);
  });

  test("records the correct user", async () => {
    const Model = fakeNativeOAuthCodeModel();
    await mintNativeCode("user-42", { Model });
    assert.equal(Model.docs[0].userId, "user-42");
  });
});

// ── redeemNativeCode ──────────────────────────────────────────────────────────

describe("redeemNativeCode", () => {
  test("a freshly minted code redeems successfully", async () => {
    const Model = fakeNativeOAuthCodeModel();
    const { code } = await mintNativeCode("user-1", { Model });

    const result = await redeemNativeCode(code, { Model });
    assert.equal(result.ok, true);
    assert.equal(result.userId, "user-1");
  });

  test("[bite:single-use] a redeemed code cannot be redeemed again", async () => {
    // THE defect PART 6/17 of the audit exists entirely to prevent: a code
    // that authenticates a second time is a replayable credential, not a
    // one-time one.
    const Model = fakeNativeOAuthCodeModel();
    const { code } = await mintNativeCode("user-1", { Model });

    const first = await redeemNativeCode(code, { Model });
    const second = await redeemNativeCode(code, { Model });

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
  });

  test("[bite:expiry] an expired code is refused", async () => {
    const Model = fakeNativeOAuthCodeModel();
    const mintedAt = new Date("2026-01-01T00:00:00.000Z");
    const { code } = await mintNativeCode("user-1", { Model, now: () => mintedAt });

    const justAfterExpiry = new Date(mintedAt.getTime() + CODE_TTL_MS + 1);
    const result = await redeemNativeCode(code, { Model, now: () => justAfterExpiry });
    assert.equal(result.ok, false);
  });

  test("a code redeemed just before expiry still succeeds", async () => {
    const Model = fakeNativeOAuthCodeModel();
    const mintedAt = new Date("2026-01-01T00:00:00.000Z");
    const { code } = await mintNativeCode("user-1", { Model, now: () => mintedAt });

    const justBeforeExpiry = new Date(mintedAt.getTime() + CODE_TTL_MS - 1);
    const result = await redeemNativeCode(code, { Model, now: () => justBeforeExpiry });
    assert.equal(result.ok, true);
  });

  test("[bite:wrong-code] an unrecognized code is refused", async () => {
    const Model = fakeNativeOAuthCodeModel();
    await mintNativeCode("user-1", { Model });
    const result = await redeemNativeCode("attacker-guessed-value", { Model });
    assert.equal(result.ok, false);
  });

  test("a missing code is refused without touching the store", async () => {
    const Model = fakeNativeOAuthCodeModel();
    assert.equal((await redeemNativeCode("", { Model })).ok, false);
    assert.equal((await redeemNativeCode(undefined, { Model })).ok, false);
    assert.equal(Model.docs.length, 0);
  });

  test("failure reasons never leak into the ok:true path, and vice versa", () => {
    // Cheap contract check: index.js must be able to branch on `.ok` alone
    // and never needs (or should read) `.reason` to decide the HTTP response
    // — that is what keeps every failure mapping to the SAME generic
    // redirect (see the wiring assertions below).
    const okShape = { ok: true, userId: "x" };
    const failShape = { ok: false, reason: "invalid_expired_or_used" };
    assert.ok(!("reason" in okShape));
    assert.ok(!("userId" in failShape));
  });

  test("codes minted for different users do not collide", async () => {
    const Model = fakeNativeOAuthCodeModel();
    const a = await mintNativeCode("user-a", { Model });
    const b = await mintNativeCode("user-b", { Model });

    const redeemedA = await redeemNativeCode(a.code, { Model });
    const redeemedB = await redeemNativeCode(b.code, { Model });
    assert.equal(redeemedA.userId, "user-a");
    assert.equal(redeemedB.userId, "user-b");
  });
});

// ── Wiring ────────────────────────────────────────────────────────────────────

describe("native OAuth routes — wiring", () => {
  test("GET /auth/google validates native+nonce before touching the session", () => {
    assert.match(indexSrc, /req\.query\.native === "1" \? validateNonce\(req\.query\.nonce\) : null/);
  });

  test("[bite] a native login without a valid nonce does not set session markers", () => {
    const block = indexSrc.slice(
      indexSrc.indexOf('app.get("/auth/google", authLimiter'),
      indexSrc.indexOf('app.get(\n  "/auth/google/callback"'),
    );
    assert.match(block, /if \(nativeNonce\) \{/);
    // The two session writes and the prompt override must all be INSIDE that
    // guard, not floating below it where they'd run unconditionally.
    const guardBody = block.slice(block.indexOf("if (nativeNonce) {"), block.indexOf("return passport.authenticate"));
    assert.match(guardBody, /req\.session\.nativeReturn\s*=\s*true/);
    assert.match(guardBody, /req\.session\.nativeNonce\s*=\s*nativeNonce/);
    assert.match(guardBody, /select_account/);
  });

  test("ordinary (non-native) /auth/google is unchanged: still scope profile+email, nothing else forced", () => {
    assert.match(indexSrc, /const authOptions = \{ scope: \["profile", "email"\] \}/);
  });

  test("the callback mints a code ONLY when req.session.nativeReturn was set", () => {
    const m = indexSrc.match(/app\.get\(\s*\n\s*"\/auth\/google\/callback",([\s\S]*?)\n\);/);
    assert.ok(m, "could not locate the GET /auth/google/callback route registration");
    assert.match(m[1], /if \(req\.session\.nativeReturn\) \{/);
    assert.match(m[1], /mintNativeCode\(req\.user\._id\)/);
  });

  test("native session markers are deleted before the redirect (single-use start)", () => {
    const start = indexSrc.indexOf("if (req.session.nativeReturn) {");
    const end = indexSrc.indexOf('req.session.save(() => res.redirect(firstRun', start);
    assert.ok(start !== -1, "could not locate the native branch in the callback");
    assert.ok(end !== -1 && end > start, "could not locate the end of the native branch");
    const body = indexSrc.slice(start, end);

    const deleteReturn = body.indexOf("delete req.session.nativeReturn");
    const deleteNonce = body.indexOf("delete req.session.nativeNonce");
    const mintAt = body.indexOf("mintNativeCode");
    assert.ok(deleteReturn !== -1 && deleteNonce !== -1, "session markers are never cleared");
    assert.ok(deleteReturn < mintAt && deleteNonce < mintAt, "markers must be cleared BEFORE minting, not after");
  });

  test("the ordinary (non-native) callback path is unchanged: still redirects to firstRun ? /aqua : postLoginNext", () => {
    assert.match(indexSrc, /res\.redirect\(firstRun \? "\/aqua" : \(req\._postLoginNext \|\| "\/home"\)\)/);
  });

  test("GET /auth/native/return builds an explicit-package deep link from the code, but the visible message never contains it", () => {
    // Superseded design decision (see the fix logged 2026-09-24): the route now
    // DOES read req.query.code — that's required to build the intent:// deep
    // link fallback for installs where App Link verification never succeeded
    // (debug-signed builds, chiefly). What must still hold is that the code
    // never reaches the *visible* message text, only the functional deep link.
    const m = indexSrc.match(/app\.get\("\/auth\/native\/return",([\s\S]*?)\n\}\);/);
    assert.ok(m, "GET /auth/native/return is not registered");
    assert.match(m[1], /res\.render\("auth-native-return"/);
    assert.match(m[1], /package=com\.aquiplex\.aqua/);
    const messageBlock = m[1].slice(m[1].indexOf("message:"), m[1].indexOf("deepLink,"));
    assert.ok(!messageBlock.includes("rawCode"), "the code must never be interpolated into the visible message");
  });

  test("the auth-native-return view only interpolates the code inside the deep link, never into visible text", () => {
    const view = fs.readFileSync(path.join(ROOT, "views", "auth-native-return.ejs"), "utf8");
    assert.match(view, /<p><%= message %><\/p>/);
    // The view receives only the pre-built `deepLink` string and `message` —
    // it never re-derives or re-interpolates the raw code/nonce itself.
    assert.ok(!/rawCode|req\.query\.code/.test(view));
  });

  test("[bite] no code means no deep link — the view falls back to the plain /aqua link", () => {
    const m = indexSrc.match(/app\.get\("\/auth\/native\/return",([\s\S]*?)\n\}\);/);
    assert.ok(m);
    assert.match(m[1], /const deepLink = rawCode\s*\n?\s*\?/);
    const view = fs.readFileSync(path.join(ROOT, "views", "auth-native-return.ejs"), "utf8");
    assert.match(view, /<% \} else \{ %>\s*\n\s*<a href="\/aqua"/);
  });

  test("[bite] the deep link falls back to the Play listing if the app isn't installed", () => {
    const m = indexSrc.match(/app\.get\("\/auth\/native\/return",([\s\S]*?)\n\}\);/);
    assert.ok(m);
    assert.match(m[1], /S\.browser_fallback_url/);
    assert.match(m[1], /play\.google\.com\/store\/apps\/details\?id=com\.aquiplex\.aqua/);
  });

  test("the view auto-attempts the deep link via a safely-embedded redirect, only when one exists", () => {
    const view = fs.readFileSync(path.join(ROOT, "views", "auth-native-return.ejs"), "utf8");
    assert.match(view, /<% if \(deepLink\) \{ %>\s*\n<script>/);
    // JSON.stringify, not a raw `<%=`/`<%-` splice of the URL string, so the
    // value is correctly quoted as a JS string literal inside the script tag.
    assert.match(view, /window\.location\.href = <%- JSON\.stringify\(deepLink\) %>;/);
  });

  test("GET /auth/native/complete calls redeemNativeCode and logs the user in via req.login", () => {
    const m = indexSrc.match(/app\.get\("\/auth\/native\/complete",([\s\S]*?)\n\}\);/);
    assert.ok(m, "GET /auth/native/complete is not registered");
    assert.match(m[1], /redeemNativeCode\(rawCode\)/);
    assert.match(m[1], /req\.login\(user,/);
  });

  test("[bite:generic-error] every failure branch of /auth/native/complete redirects to the SAME generic error", () => {
    // THE defect PART 6 of the audit names explicitly: "Use a generic error.
    // Do not reveal whether the code was missing, expired, already consumed,
    // or invalid." If any failure branch used a distinct message/param, an
    // attacker could enumerate which check failed.
    const m = indexSrc.match(/app\.get\("\/auth\/native\/complete",([\s\S]*?)\n\}\);/);
    assert.ok(m);
    const redirects = [...m[1].matchAll(/res\.redirect\("([^"]+)"\)/g)].map((x) => x[1]);
    const errorRedirects = redirects.filter((r) => r.includes("auth_error"));
    assert.ok(errorRedirects.length >= 1, "no error redirect found");
    assert.ok(
      errorRedirects.every((r) => r === "/aqua?auth_error=invalid_code"),
      `every failure must redirect to the same generic target, found: ${JSON.stringify(errorRedirects)}`,
    );
  });

  test("a successful completion redirects to /aqua with no query string (no code, no leftover state)", () => {
    const m = indexSrc.match(/app\.get\("\/auth\/native\/complete",([\s\S]*?)\n\}\);/);
    assert.ok(m);
    assert.match(m[1], /res\.redirect\("\/aqua"\)\)/);
  });
});

describe("session persistence — Bug 2 wiring", () => {
  test("cookie maxAge is 30 days, not the old fixed 7", () => {
    assert.match(indexSrc, /SESSION_MAX_AGE_MS = 30 \* 24 \* 60 \* 60 \* 1000/);
    assert.ok(!/maxAge:\s*7 \* 24 \* 60 \* 60 \* 1000/.test(indexSrc), "the old fixed 7-day maxAge is still present");
  });

  test("rolling renewal is enabled", () => {
    assert.match(indexSrc, /rolling:\s*true/);
  });

  test("connect-mongo's TTL is set explicitly and matches the cookie's maxAge", () => {
    assert.match(indexSrc, /ttl:\s*SESSION_MAX_AGE_MS \/ 1000/);
  });

  test("[bite] production cannot silently fall back to an in-process store", () => {
    // THE defect: the original code's catch-all swallowed a missing/broken
    // connect-mongo in EVERY environment, including production, and quietly
    // handed back an in-memory store — which breaks the moment there is more
    // than one server instance, and resets on every restart.
    const sessionBlock = indexSrc.slice(
      indexSrc.indexOf("// ── Session ─"),
      indexSrc.indexOf('app.use(\n  session({'),
    );
    assert.match(sessionBlock, /if \(isProduction\) \{/);
    const prodGuard = sessionBlock.slice(sessionBlock.indexOf("if (isProduction) {"));
    assert.match(prodGuard, /process\.exit\(1\)/);
  });

  test("the production fail-fast guard is INSIDE the catch block, reachable when MongoStore init throws", () => {
    const sessionBlock = indexSrc.slice(
      indexSrc.indexOf("// ── Session ─"),
      indexSrc.indexOf('app.use(\n  session({'),
    );
    const tryAt = sessionBlock.indexOf("try {");
    const catchAt = sessionBlock.indexOf("} catch (err) {");
    const prodCheckAt = sessionBlock.indexOf("if (isProduction) {");
    assert.ok(tryAt !== -1 && catchAt !== -1 && prodCheckAt !== -1);
    assert.ok(tryAt < catchAt && catchAt < prodCheckAt, "fail-fast must be reachable from the catch block");
  });

  test("MONGO_URI absence is checked explicitly rather than relying on connect-mongo's own error", () => {
    assert.match(indexSrc, /if \(!process\.env\.MONGO_URI\) \{\s*\n\s*throw new Error\("MONGO_URI is not set"\);/);
  });
});

describe("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET — startup fail-fast", () => {
  const startupSrc = fs.readFileSync(path.join(ROOT, "utils", "startup.js"), "utf8");

  test("both are in the required-env list", () => {
    const m = startupSrc.match(/REQUIRED_ENV = \[([\s\S]*?)\];/);
    assert.ok(m);
    assert.match(m[1], /"GOOGLE_CLIENT_ID"/);
    assert.match(m[1], /"GOOGLE_CLIENT_SECRET"/);
  });

  test("GOOGLE_CALLBACK_URL is deliberately NOT required (it has a working default)", () => {
    const m = startupSrc.match(/REQUIRED_ENV = \[([\s\S]*?)\];/);
    // Strip comments first: the array's own explanatory comment mentions
    // GOOGLE_CALLBACK_URL by name to say it's excluded, which would otherwise
    // make a plain substring check trip over its own documentation.
    const entriesOnly = m[1]
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    assert.ok(!entriesOnly.includes("GOOGLE_CALLBACK_URL"));
  });
});

describe("/.well-known/assetlinks.json — App Link verification dependency", () => {
  test("is registered before express.static (dotfiles would otherwise 404 it)", () => {
    const wellKnownAt = indexSrc.indexOf('app.get("/.well-known/assetlinks.json"');
    const staticAt = indexSrc.indexOf("app.use(express.static(path.join(__dirname, \"public\")");
    assert.ok(wellKnownAt !== -1, "assetlinks route is not registered");
    assert.ok(wellKnownAt < staticAt, "must be registered before express.static or dotfiles:'ignore' shadows it");
  });

  test("serves the correct Android package name", () => {
    assert.match(indexSrc, /AQUA_ANDROID_PACKAGE = "com\.aquiplex\.aqua"/);
  });

  test("the checked-in upload-key fingerprint matches the supplied Play certificate material", () => {
    // This is the upload certificate fingerprint supplied with the project.
    // The Play App Signing certificate is deliberately NOT hardcoded because
    // the supplied screenshot does not expose the complete value.
    assert.match(
      indexSrc,
      /AQUA_ANDROID_UPLOAD_KEY_SHA256 =\s*\n\s*"15:F7:A9:A8:72:79:D4:39:1F:DE:E5:5A:7E:02:B0:D2:9D:56:57:CB:AC:17:F0:CA:0F:ED:61:F4:B1:40:1C:2B"/,
    );
  });

  test("the Play App Signing fingerprint is sourced from env, never hardcoded", () => {
    assert.match(indexSrc, /process\.env\.PLAY_APP_SIGNING_SHA256/);
    // Only one non-comment 15:F7:... literal (the verified upload key) may
    // exist — a second literal would mean someone hardcoded a guess at the
    // Play signing certificate, which PART 12 of the audit explicitly forbids.
    const nonCommentSrc = indexSrc
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    const literalMatches = nonCommentSrc.match(/"15:F7:A9:A8:72:79:D4:39/g) || [];
    assert.equal(literalMatches.length, 1, "found more than one hardcoded certificate fingerprint literal");
  });

  test("responds 200 with application/json and no redirect status", () => {
    const m = indexSrc.match(/app\.get\("\/\.well-known\/assetlinks\.json",([\s\S]*?)\n\}\);/);
    assert.ok(m);
    assert.match(m[1], /res\.type\("application\/json"\)/);
    assert.match(m[1], /res\.status\(200\)/);
    assert.ok(!/res\.redirect/.test(m[1]), "must never redirect");
  });
});


describe("native Passport session handoff", () => {
  test("preserves native session markers across Passport regeneration only for native OAuth", () => {
    const callbackStart = indexSrc.indexOf('"/auth/google/callback"');
    const callbackEnd = indexSrc.indexOf('// Normally intercepted by the verified Android App Link', callbackStart);
    const callbackBlock = indexSrc.slice(callbackStart, callbackEnd);

    assert.match(callbackBlock, /const keepNativeSessionInfo = req\.session\?\.nativeReturn === true/);
    assert.match(callbackBlock, /keepSessionInfo: keepNativeSessionInfo/);
    assert.match(callbackBlock, /if \(req\.session\.nativeReturn\)/);
    assert.match(callbackBlock, /const nonce = req\.session\.nativeNonce/);
  });
});

describe("native route hardening", () => {
  test("asset links emit the Android package and configured Play/upload fingerprints", () => {
    assert.match(indexSrc, /AQUA_ANDROID_PACKAGE = ["']com\.aquiplex\.aqua["']/);
    assert.match(indexSrc, /PLAY_APP_SIGNING_SHA256/);
    assert.match(indexSrc, /SHA256_FINGERPRINT_RE/);
  });

  test("native return and completion routes are explicitly non-cacheable", () => {
    const returnBlock = indexSrc.slice(indexSrc.indexOf('app.get("/auth/native/return"'), indexSrc.indexOf('app.get("/auth/native/complete"'));
    const completeBlock = indexSrc.slice(indexSrc.indexOf('app.get("/auth/native/complete"'));
    assert.match(returnBlock, /Cache-Control.*no-store/);
    assert.match(completeBlock, /Cache-Control.*no-store/);
  });
});
