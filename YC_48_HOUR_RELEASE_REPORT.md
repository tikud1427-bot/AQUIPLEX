# YC 48-hour release report — 2026-10-28

Only results verified during this run are stated as fact. Results from earlier
sessions are labelled **historical**. Nothing was committed, pushed, merged,
deployed, migrated or rotated, and no production data was written.

## 0. Baseline

| Item | Verified state |
|---|---|
| Release base | Worktree `aquiplex-fix`, branch `fix/yc-demo-safety-2026-10-28` = `origin/main` `8f1c92cd` + 4 local commits from earlier today (`PATCH_2026-10-28.md`). This run's work is **uncommitted** on top. |
| Security branch | `security/account-takeover-and-entitlements` (`2b207fa3`) is not an ancestor of main, but all 29 code/test files are **byte-identical** in `origin/main`. Only `SECURITY_RELEASE_CHECKLIST.md` (a doc) is absent. Nothing is left to port. |
| `aquiplex/world-model-pass2` (main tree) | Still holds the uncommitted episodic-recall work. Left untouched. That work was ported into the release branch (see §1.5). |
| Deployed version | **Unverified.** Production serves from Render behind Cloudflare. The only production read made was `GET /.well-known/assetlinks.json` (public, read-only). |
| Repository visibility | **Public, 0 forks**, by anonymous GitHub API in this run. |

## 1. Changes made (uncommitted, worktree `aquiplex-fix`)

### 1.1 P0: Google OAuth login-CSRF and link-CSRF (account takeover)

**Root cause.** None of the three Google strategies (`google`, `google-link`,
`google-reauth`) used OAuth `state`. A callback URL carrying any valid
authorization code was accepted on whatever session arrived with it.

- **Sign-in:** an attacker sends a victim their own callback URL, and the victim is signed into the attacker's account.
- **Link:** the victim is signed in, and the session cookie is `SameSite=Lax`, so it is sent on a top-level GET. The attacker's Google identity is then bound to the victim's account. The attacker can then sign in as the victim with Google.

Demonstrated in this run: on main's options, a forged callback on a fresh session returned `SUCCESS as attacker-google-id`.

**Fix.**
- `services/auth/googleOAuthOptions.service.js` (new): `state: true`, `pkce: true` (S256), and a separate session slot per flow.
- `index.js`: all three strategies use it.
- Failures go through the existing paths: `/login?error=google_failed`, and the existing `failureRedirect` for link and reauth.

**Native app leg.** State lives in the Chrome session that started the flow. That is the same session the existing `nativeReturn` marker already depends on, so the leg gains no new dependency.

**Tests.**
- `tests/auth/googleOAuthState.test.js` (9 tests) drives the real passport-google-oauth20 strategy. Only Google's token and profile calls are stubbed.
- It covers: authorization URL carries state and challenge; PKCE verifier matches the challenge; forged, missing, wrong and replayed callbacks refused; a wrong guess burns the state; a link flow cannot satisfy a sign-in callback; source wiring.
- HTTP smoke against the real booted server (fake config): **8/8**. The same refusals happen over HTTP, and no session is authenticated (`/api/account` → 401).

**Operator prerequisite.** None. PKCE needs no Google Console change.

### 1.2 P0/P1: Android Google sign-in leaves the app signed out

Traced end to end:
- `MainActivity.beginNativeGoogleAuth` opens Chrome.
- `/auth/google?native=1&nonce` leads to the callback, which mints a code and redirects to `/auth/native/return`.
- The App Link brings the code back to the app, and the WebView loads `/auth/native/complete`.

The server and app code are correct on paper and covered by `tests/auth/nativeOAuth.test.js` and `NativeOAuthSecurityTest`.

**Most likely root cause (production configuration, verified in this run).**
- Production `assetlinks.json` lists only the upload-key fingerprint (`15:F7:…:1C:2B`), so `PLAY_APP_SIGNING_SHA256` is not set on Render.
- An app installed from Google Play is signed with the Play App Signing key, so Android cannot verify the App Link.
- `/auth/native/return` then renders in Chrome. The script `intent://` jump is commonly blocked without a tap, and the page said "Finishing sign-in…".
- The user is signed in inside Chrome while the app stays signed out. This matches the report.
- **Not yet confirmed on a device.** Confirm with `adb shell pm get-app-links com.aquiplex.aqua` (expect `aquiplex.com: verified`) on a Play-installed build.

**Fixes in this run.**
- `index.js`: the fallback page now says "You're signed in. Tap Open Aqua App to finish signing in on your phone." The explicit-package intent behind that button works even when verification failed.
- **Operator fix (required):** Play Console → App integrity → App signing key certificate → SHA-256. Set it as `PLAY_APP_SIGNING_SHA256` on Render, redeploy, then on a device run `adb shell pm verify-app-links --re-verify com.aquiplex.aqua`.
- **Second check for the operator:** if `GOOGLE_CALLBACK_URL` on Render is an absolute URL on a host other than `aquiplex.com` (e.g. `www.` or `*.onrender.com`), the host-only session cookie from the start of the leg is not sent to the callback. The native marker and the OAuth state are then lost. After this change that shows as `/login?error=google_failed` in Chrome.
- **Diagnostics:** the existing `[native oauth] … nativeReturn=` log lines tell the two cases apart.

### 1.3 P1: email sessions lost overnight (Android)

Server side was checked and is sound:
- 30-day rolling cookie with `Max-Age`.
- Persistent Mongo session store; production refuses to start without it.
- `SameSite=Lax`.
- Every login path stamps `authVersion`.
- The SPA treats only a real 401 as signed out (`sessionStore`, `api/account.ts`).

**Root cause found in the app.** The Android WebView writes cookies to disk lazily, and neither Capacitor nor `MainActivity` ever called `CookieManager.flush()`. A login, or a native handoff, followed by the OS killing the backgrounded app before that write comes back signed out. This is consistent with "sometimes, after a long idle or the next day".

**Fix.** `MainActivity.java`: `persistCookies()` runs in `onPause()` and after each `/aqua` page load. It persists only what the WebView's own jar holds. No tokens in URLs or local storage, and no longer session lifetime.

**Verified:** `gradlew --offline :app:compileDebugJavaWithJavac :app:testDebugUnitTest` passes. **Not verified on a device.**

### 1.4 P1: Understanding page numbers nothing supports

The previous commit `1c2b4128` (historical, earlier today) fixed:
- goal shown as profession ("billionaire");
- the "zero and I'm a student" fact;
- `event` rows;
- `alpha`/`frac` topics;
- `custom_` headings.

This run removed the remaining invented numbers. Display only, so no stored data changed.

| Number shown | What it really was | Now |
|---|---|---|
| "NN% understanding" in the ring | 0.45·avg confidence + 0.25·coverage + 0.15·depth + 0.15·goal count | **N things learned**: live beliefs plus goals not dropped (`learnedCount`) |
| Goal progress bar | +0.2 per "made progress"-style phrase, capped at 0.9 | removed; the status label stays |
| Goal confidence badge | constant 0.55 at creation | "mentioned N×" |
| Forecast "probability" % | hard-coded constants (e.g. 0.7) | removed; label, real basis and ranking stay |
| Knowledge "NN% · K obs" bar | uncalibrated belief confidence | "seen K×"; bar relative to the best-evidenced row |

Files: `NowSections.tsx`, `ModelSections.tsx`, `UnderstandingRing.tsx`, `WorldModelCard.tsx`, `stores/mindStore.ts`.

Test: `src/test/unsupportedNumbers.test.tsx` (4 tests). Against the HEAD versions of those files **4/4 fail**. With the change, 4/4 pass.

### 1.5 P1: current facts over stale ones; compound changes (episodic recall, ported)

The 2026-10-20 episodic-recall work (historical, uncommitted in the main tree) was ported onto the release branch.
- Chat quotes the user's own earlier words, dated and owner-scoped.
- "Since changed" notes come from the World Model.
- Forget redaction applies.
- Flag `AQUA_EPISODIC_RECALL` (on; `off` = complete rollback).

All files applied cleanly except `aqua/src/routes/chat.js`, which was ported by hand.

**Gap closed while porting.** Recall had no health/mood filter, so it would have quoted "my right eye is moving automatically" back into prompts and bypassed today's `4fa5da35`. Now:
- `recallRedaction()` applies the turn's sensitive policy to every recalled sentence, alongside the forget list;
- `chat.js` runs the same `scrubSensitiveLines` backstop as the knowledge lane, and counts withheld lines in `[SENSITIVE]`.

**Tests.** `episodicRecall.test.js` has 3 new tests (23/23 pass). They cover: a sensitive sentence withheld and its neighbouring company fact kept (positive control); quoted only when opted in and on topic; the forget list still applies. Disabling the new check makes **3/3 fail**.

**Measured gains are historical** (2026-10-20, v3, which is now a *dev* set, so not a held-out claim):
- WM 73.4% → WM+recall 90.2% answer-level;
- stale 15.2% → 0.0%;
- fabrication 18.2% → 8.4%;
- founder journey compound change fixed (23/24).

**Not re-measured in this run** (needs provider keys, see §5).

### 1.6 Repository hygiene

- Redacted scan of all 1,624 tracked files (key/token/URI/private-key patterns): 10 hits, **all test fixtures or placeholders** (`.env.example`, `pipeline.test.js`, `dbPool.test.js`, `secretGuard.test.js`).
- `aqua-frontend/e2e/.auth/` is ignored and was never committed (`git log --all` empty).
- **Gap fixed:** `e2e-founder-journey.mjs E2E_SESSION_OUT=state.json` writes a live session cookie to `aqua/state.json`, which nothing ignored. `.gitignore` now ignores `.auth/`, `state.json` and `*.storageState.json`.
- No gitleaks or trufflehog is installed. History rewrite was not attempted.

### 1.7 Test reliability: `accountSecurityAudit.live.test.js`

**Symptom.** "The audit modified the database" (`payments` hash) on 3 consecutive full live runs. The file passed when run alone.

**Root cause.** The test's own seeding models built indexes in the background. The snapshot hashes index names, so a build landing after the "before" snapshot read as an audit write.

**Fix.** Test only: `await model.init()` before seeding. An index the audit itself created would still fail the test.

**Result.** 3/3 full runs pass.

## 2. Security status

**Fixed in code (this run):** OAuth login-CSRF and link-CSRF account takeover (§1.1).

**Verified present on main (this run, by file identity with the security branch):**
- verified signup;
- Google identity bound by verified `sub`, never by email;
- link requires proof;
- `authVersion` session invalidation;
- server-side unlimited entitlement and refund audit.

The live tests pass against a disposable Mongo (see §3).

**Outstanding. Cannot be done in code, needs an authorized operator:**
1. **Rotate credentials.** Earlier today (historical, `SECURITY_ROTATION_CHECKLIST.md`), 19 current `.env` values matched the public git history. The categories are:
   - MongoDB Atlas user/password;
   - `SESSION_SECRET`;
   - Razorpay webhook secret and key pair;
   - Google OAuth client secret;
   - OpenRouter keys;
   - Serper key;
   - the historical provider keys listed there;
   - plus the `UNLIMITED_USER_EMAILS` review.

   The checklist gives order and console per item. **Nothing has been rotated.** Not re-compared in this run: reading `.env` is refused in this environment.
2. **Make the repository private.** It is still public (verified above).
3. Set `PLAY_APP_SIGNING_SHA256` on Render (§1.2).
4. **Remains unsafe until those happen:** anyone with the public history may hold working database, session-signing and payment-webhook secrets. A forged `SESSION_SECRET` cookie, or a forged Razorpay webhook, would bypass every code fix above.

## 3. Test results (this run, worktree `aquiplex-fix`)

| Command | Result |
|---|---|
| `npm run test:platform` (offline) | **287/287** (was 278 + 9 new) |
| `AQUA_TEST_MONGO_URI=mongodb://127.0.0.1:57017/<fresh db> npm run test:platform` (live account-security tests on disposable Mongo) | **315/315 on 3 consecutive runs** after the §1.7 test fix. Before it: 1 pass, then 3 consecutive runs at 314/315. |
| Aqua battery per directory (`batch-battery.sh`, Postgres :55432 `aqua_migcheck`, Redis :56379) | **4,522 tests: 4,518 pass, 0 fail, 4 skipped** (`src/prompts` has no test files) |
| `cd aqua && node scripts/run-tests.mjs src/memory/tests/episodicRecall.test.js` | **23/23** |
| `cd aqua-frontend && npx tsc -b` | clean |
| `cd aqua-frontend && npx vitest run` | **134/134** (incl. ported `recallSources`, new `unsupportedNumbers`) |
| `cd aqua-frontend/android && gradlew --offline :app:compileDebugJavaWithJavac :app:testDebugUnitTest` (Studio JBR) | **pass** |
| Real server boot (`node index.js`, fake config, disposable Mongo) + `oauth-smoke.mjs` | **boots; 8/8**. Startup validation correctly refused to boot without Razorpay config. |
| `npm run eval:gate` with `DATABASE_URL=` (as CI) | **PASS, 16 suites gated, all metrics unchanged.** `context-canonical` and `context-canonical-heldout` NOT RUN (no Postgres in CI mode) |
| Founder journey on real providers (`E2E_SCRIPT=yc`) | **NOT RUN.** Needs provider keys from `.env`; loading `.env` from this session is refused. |
| Held-out v3 / preregistered v4 / final eval | **NOT RUN** (provider-backed; v4 and final are VM kits, historical). No frozen question, expected output or baseline was touched. |
| Markdown/math rendering | not affected by this run's changes. `markdownRenderer.test.tsx` 43/43 within the vitest run. |

## 4. Product status (founder workflow)

| Step | Status |
|---|---|
| 1–3 Describe the startup, upload a doc, inspect stored facts | Historical: 23/24 on the real launcher (2026-10-20, main tree). Not re-run on this branch. |
| 4–5 Update launch date and price in a new conversation; ask status in another | Recall path covered by `prepareTurn` end-to-end tests (said in one conversation, used in another; never in another user's prompt). Real-provider run: **not run**. |
| 6 Investor update | Not verified in this run. |
| 7 Correct a fact, verify later answers | Forget/correct reach recall (redaction tests pass); real-provider run **not run**. |
| Demo risk (historical) | YC script steps 3/6 need the canonical (Postgres) read; production serves legacy (`PATCH_2026-10-28.md`). |

## 5. Outstanding blockers

- Credential rotation and repository visibility (§2).
- `PLAY_APP_SIGNING_SHA256` on Render; device confirmation of the App Link and the cookie flush. Shipping the cookie fix needs a new Android build.
- Provider keys for the founder journey and evals: the user must start them (command in `PATCH_2026-10-28.md` §5).
- Push, PR, CI and deploy all need approval (`DEPLOY_2026-10-28.md`).

## 6. Release recommendation

**Ready for a controlled demo on a test account once the founder journey has been run once on this branch with real providers.** The code changes here are tested at unit, integration and server-boot level.

**Not ready for production** until credentials are rotated and the repository is private. Those secrets defeat the auth fixes regardless of code.

**Not ready for staging sign-off** of the Android fixes until checked on a device.

## 7. Next actions (founder / operator, in order)

1. Make the GitHub repository private; rotate per `SECURITY_ROTATION_CHECKLIST.md` (Mongo and `SESSION_SECRET` first).
2. Review and commit this worktree's changes; open the PR; let CI run.
3. Run the YC founder journey on this branch with real keys (command in `PATCH_2026-10-28.md` §5).
4. Set `PLAY_APP_SIGNING_SHA256` on Render. Build and install a Play/internal-track app; check `pm get-app-links`, then Google sign-in, then kill the app and reopen it.
5. Deploy per `DEPLOY_2026-10-28.md`; smoke on a test account.
