# Implementation log — 2026-10-15

Branch `aquiplex/world-model-pass2`. **Nothing was committed, pushed or
deployed.** The uncommitted provider key-pool work that was already in the tree
(22 modified and 8 untracked files) was not touched; it is included in every
test run below.

## Operating constraints observed

- Never wrote to `.env`, the dev database (:5432) or the real Mongo cluster.
- Tests used only disposable containers:
  - Postgres `aqua-test-db` on :55432;
  - Redis `aqua-test-redis` on :56379;
  - Mongo `aqua-test-mongo` on :57017, stopped again after use.
- Docker Desktop was started locally to run the live suites.
- Secret values were never printed. The credential check printed key names only.
- No external credential, DNS, deploy or repository-visibility change.

---

## Changes

### 1. Cross-account memory adoption (tenant isolation)

**Problem.** `resolveOwner({userId, conversationId})` adopts and tombstones a
pre-login `conv:` mind into the caller's `user:` mind. Several routes pass a
client-supplied `conversationId` into it:

- `routes/brain.js` `ownerOf`, for every GET (`?conversationId=`);
- `POST /intelligence/orchestrate`;
- `POST /project/workspace`.

Only `routes/memory.js` had an ownership guard (`assertLegacyConvAccess`). Any
signed-in account could name another conversation and absorb its orphaned memory.

**Root cause.** The authorization rule lived in one route instead of at the
data-access boundary that every route shares.

**Fix.** `aqua/src/memory/ownerResolver.js` adopts only when the conversation is
unknown to the store, or the store says the caller owns it. That is the same
rule chat applies before reusing a conversation.

**Test.** `aqua/src/memory/tests/ownerAdoptionIsolation.test.js` (4 tests).
With the guard removed, 2 of them fail. The existing `unified.test.js` adoption
contract (10 tests) still passes.

### 2. Session fixation on email login and signup

**Problem.** The CSRF middleware issues a token into the session on the first
page view. `/login` and `/signup` then wrote the user id into that same
pre-login session. Passport's Google paths regenerate the session; the email
paths did not.

**Fix.** New `services/auth/establishSession.service.js`: regenerate, write the
identity, then save. Both routes use it. The post-login redirect target is still
read before regeneration.

**Also changed:**

- Login gives one message for an unknown email and a wrong password, and renders it on the form. It used to send raw text that revealed whether an email had an account.
- Signup errors render on the form.
- Non-string `email` / `password` values are rejected cleanly (400) instead of throwing (500).

**Test.** `tests/auth/sessionFixation.test.js` (6 tests).

### 3. Bundles: an IDOR plus unauthenticated, unmetered LLM spend

**Problems.**

- `POST /bundle/:id/run` → `runBundle` used `Bundle.findById`, so any account could run another account's bundle and read it.
- `POST /generate-bundle` called the LLM with **no login and no rate limit**.
- `/execute-step` and `/bundle/:id/run` cost no credits.
- Error responses leaked `err.message`.

**Fix.**

- Ownership check before `runBundle`.
- `engineLimiter`, `requireLogin` and `usageGuard('chat_message')` on all three routes. Step 1 of generate-bundle returns fixed questions and stays free.
- Generic error bodies.

**Test.** `tests/platform/aiRouteCost.test.js` asserts the invariant itself:
*every* `index.js` route whose handler reaches `generateAI` or `runBundle` names
the limiter, the login check and the usage guard. So a new LLM route without
them fails the test.

### 4. 50 MB JSON parsing before authentication

**Problem.** `app.use(express.json({ limit: "50mb" }))` was global and pre-auth.

**Fix.** Engine prefixes (`/api/aqua`, `/v1`) are skipped by the global parser
and parsed by `aquaJson` (50 MB) **after** `requireLogin` inside `aquaAccess`.
Every other route gets 1 MB.

**Check.** `verifyCsrf` skips `/api/*` and never needed the body there. Nothing
calls `/v1`.

**Test.** An added assertion in `tests/platform/launchSafety.test.js`.

### 5. Razorpay signature comparison

`===` was replaced with `crypto.timingSafeEqual` over the decoded hex
(`hexDigestEquals`). It is used for both the checkout verification and the
webhook.

**Test.** `tests/platform/webhookSignature.test.js` covers valid, tampered,
wrong-secret, junk and length-mismatch cases.

### 6. Platform tests were not run by `npm test` or CI

**Problem.** Root `tests/` (CSRF, native OAuth, logout, account deletion, launch
safety) was outside both `npm test` (which ran only the aqua runner) and CI
(`eval-gate.yml` runs in `aqua/`, only for `aqua/**` paths). Three launch-safety
assertions had gone stale unseen.

**Fix.**

- Root `package.json`: `test` = `test:aqua && test:platform`; `test:platform` = `node --test "tests/**/*.test.js"`.
- New `.github/workflows/platform-tests.yml`: Node 22, every PR, no path filter.
- Stale assertions were updated to check the **same intent** against the current code. Examples: the limiter is still before `requireLogin`, now inside the `aquaAccess` array; returning users still default to `/home`, now through `takePostLoginNext`.
- `rootTestWiring.test.js` gained a test pinning the new wiring.

### 7. Product analytics: activation and retention (new)

**Problem.** There was no way to measure signup → first use → return.

**Built:**

- `services/analytics/productEvents.js`: a fixed list of 7 events. It stores user id, event and time only; properties are limited to short scalar tokens, never content. It is fire-and-forget and never fails a request. Kill switch: `AQUA_PRODUCT_EVENTS=off`.
- `engineEventTap`: records chat turns, uploads, project creation, corrections and deletions from the engine's 2xx responses. It captures the path at entry, because nested routers rewrite `req.url`.
- Signup and login events: email, plus Google new versus returning.
- `models/ProductEvent.js`: TTL of 400 days. **Deleted with the account** (`accountDeletion.service.js`).
- `services/analytics/activation.js`: a pure computation of cohorts, activation (≥ 2 chat days in 7), and week-1 and week-4 retention, with eligibility windows.
- `scripts/activation-report.mjs`: read-only. It takes an explicit `--mongo` URI and does not read `.env`.

**Tests.** `tests/platform/productEvents.test.js` (27 tests). End to end:
synthetic events were seeded into the disposable Mongo through the real
recorder and model, and the report returned the exact expected cohort numbers.

### 8. Truthful product surface

- **Pricing** (`views/pricing.ejs`): removed eight actions the product does not offer (code, image and app generation, deep research, multi-agent orchestration and others). It lists the metered actions and states that memory controls are free. "Pay once. Build forever." became "Pay for what you use."
  - Test: `tests/platform/pricingTruth.test.js` ties every price on the page to a `usageGuard` in `index.js` and its `CREDIT_COSTS` value.
- **Landing** (`views/landing.ejs`): the new hero states the chosen promise. The old hero example implied Git and Slack integrations; the new one is an example the welcome line can actually produce, plus a note saying Aqua does not read email, chat or repos. The title and meta description were updated.
- **Onboarding** (`aqua-frontend/src/pages/IntroPage.tsx`): the opener now says what to tell Aqua and that documents can be attached. It also states what Aqua cannot see.

### 9. Strategy and evidence documents

Six new documents: `REPO_AUDIT.md`, `YC_PRODUCT_THESIS.md`,
`PRODUCT_SCORECARD.md` (including the per-category stale-rate analysis
recomputed from the v3 results), `YC_APPLICATION_DRAFT.md`,
`PILOT_VALIDATION_PLAN.md`, and this file. `README.md` was updated.

---

## Decisions not taken, and why

- **The production read path was not switched to "hybrid" or full history,** even though v3 says the World Model is worst on stale facts. v4 is pre-registered with a decision rule. Changing the product path before it runs would undercut that rule, and v3 is contaminated for tuning. Next step: launch v4 (needs approval).
- **Bundles, the tools directory and the blog were not deleted.** Existing users may have data there, and there is no retention decision yet. They were secured and demoted instead.
- **The password minimum stays at 6** and **no email verification was added.** Both are policy decisions; they are recommended in the audit.
- **No per-project World Model scoping.** It is a schema change, and it is only needed for the expansion segment.
- **No pricing or plan change in code.** The thesis recommends testing a monthly founder plan with pilots first (`PILOT_VALIDATION_PLAN.md`).

---

## Test commands and results (this session)

| Command | Result |
|---|---|
| `AQUA_DISABLE_MONGO_MIRROR=1 MONGO_URI= DATABASE_URL=<test pg :55432> AQUA_TEST_DATABASE_URL=<same> AQUA_TEST_REDIS_URL=<test redis> node aqua/scripts/run-tests.mjs` (from `aqua/`) | **4,370 tests: 4,366 pass, 0 fail, 4 skipped** |
| `npm run test:platform` | **234: 233 pass, 1 fail.** `repoHygiene` "build residue" fails because of three gitignored `*.patch` files at the repo root. It is pre-existing, local only, and the files are yours, so they were not removed. |
| `cd aqua-frontend && npx tsc -b && npx vitest run` | tsc exit 0; **117/117** |
| `cd aqua && DATABASE_URL= npm run eval:gate` | **PASS**, all gates |
| `cd aqua && DATABASE_URL=<test pg> npm run eval:gate` | **BLOCKED** on context-core and context-dense-v3 (all 0). Not a code regression. The gate's context fixtures only populate legacy stores, and with a database configured, reads are canonical-only. CI runs without a DB. Logged as an eval-validity gap. |
| `node aqua/scripts/run-tests.mjs src/memory/tests/ownerAdoptionIsolation.test.js` with the guard removed | 2 of 4 fail (proves the test catches the defect) |
| `node --test tests/platform/launchSafety.test.js` on a clean HEAD export | the same 3 stale assertions fail → pre-existing, not caused by today's work |

Not run: Playwright e2e, the Android release check, provider-backed evaluations
(Lift v4, D6, E6), and the live-launcher product journey.

---

## Unresolved work (priority order)

1. **[Founder] Rotate the exposed secrets and make the repo private** (`REPO_AUDIT.md` §5).
2. **[Founder approval] Ship the hotfix.** Port today's D1–D5 fixes onto `hotfix/2026-10-12-auth-memory-safety`, then push and deploy.
3. **[Founder approval] Launch Lift v4** with the validated VM kit on a host that won't sleep. Apply its pre-registered decision.
4. Set the cost-accounting price table for whichever paid model replaces the free tiers, and report cost per activated user.
5. Make the context eval gates measure the canonical (production) read path as well as the legacy one.
6. Deletion gaps from the 2026-10-12 audit: graph nodes, re-derived beliefs, retroactive deletions, two-process JSON stores.
7. A CSP pass; email verification; a longer minimum password.
8. Remove the legacy surfaces (bundles, tools directory, blog, write) after a data-retention decision.

---

# Session 2 — 2026-10-16/17

Base: `e64f26cb` (the founder committed session 1 as "final"). Nothing committed,
pushed or deployed. The machine rebooted twice during the session (Docker and
the v4 run died with it). Disposable containers only.

## 1. Release candidate (`RELEASE_MANIFEST_RC_2026-10-17.md`)

Built `release/rc-2026-10-16` from hotfix `6dea686e` (parent = production
`54c8de96`) by selective 3-way apply. Lockfiles are identical to `main` and
there are no migrations (16 = 16).

**Defect found while testing it:** `main`'s test runner on Windows exited 0
having run **nothing** (absolute paths exceeded the command line). The runner fix
was ported. The definitive runs used Linux containers: RC versus production
3,634 versus 3,592 tests, **0 new failures**.

## 2. Database-configured eval gate

- **Root cause:** with `DATABASE_URL` set, `canonicalReadMode()` returns 'authoritative', so `contextDeps(canonicalOnly=true)` drops the legacy stores the context suites seed. Every metric became 0.
- **Fixes:**
  - Legacy suites state their mode (`canonicalOnly: false`) and call `assembleContextAsync`, which is what chat calls. All baselines are unchanged in both modes.
  - The gate maps Postgres only from `AQUA_TEST_DATABASE_URL`.
  - Suites declare `requires: ['postgres']`; a missing database prints NOT RUN, and `AQUA_GATE_REQUIRE_DB=1` makes it fail.
  - CI (`eval-gate.yml`) gets a pgvector service and a migration step.
- **New suite `context-canonical`** measures the production read with a database. The 60 facts go through `Brain.understandTurn`, replaying a recorded Groq `gpt-oss-120b` fixture. The replay matches requests with nonce and timestamp normalised and list order sorted; it stores normalised requests and fails loudly on a miss. The baseline is recorded as measured.
- **Production fixes found by building it:**
  1. **Nondeterministic prompts and retrieval.** Ties on timestamps fell to random UUIDs or row order in the extraction context, the known-entities list, lexical, structured and entity search, the graph fan-out, and the final rank sorts. Content tie-breaks were added. Proven: two processes give identical keys and rankings.
  2. **E10-migrated claims** (`extracted / unresolved`) are invisible to every canonical read. Documented, not fixed.
- **Tests:** `eval/tests/readPathParity.test.js` (adapter versus `chat.js` parity; the gate ignores an inherited `DATABASE_URL`; NOT RUN and REQUIRE_DB behaviour); `src/core/tests/extractionContextDeterminism.live.test.js` (fails without the tie-break).

## 3. Primary workflow: the Memory page shows what answers

- **Defect:** with Postgres, answers come from canonical claims, but the Memory page listed the legacy fact store.
- **Built:**
  - `GET /brain/current` (current claims with quote, source, date, disputed/scheduled flags);
  - `POST /brain/claims/:id/forget`;
  - `POST /brain/claims/:id/correct-value` (the new value becomes the stored *object*; the repository otherwise keeps the old one);
  - a "What Aqua knows now" section with Correct and Delete.
- **Deletion completeness**, each from a reproduced failure:
  - sibling claims from the same source segment are archived;
  - legacy facts holding the value, or the deleted person's name, are removed;
  - the legacy slot named by a deleted role (`cofounder`) is cleared;
  - the veto retires user-deleted values, names and role slots, so re-derived copies cannot answer.
- **Tests:** `src/memory/tests/forgetClaim.live.test.js` (7 live cases, including cross-account 404s; the veto and sibling cases fail without the fix).

## 4. Defects found by the live founder journey (`aqua/scripts/e2e-founder-journey.mjs`)

| Defect | Root cause | Fix and test |
|---|---|---|
| A stated change was permanently lost | Extraction 429 → 2ⁿ-s backoff dead-lettered the job about 30 s after the first failure | Capacity errors back off 1, 2, 4, 8 min, then the cap (`jobQueue.retryWaitMs`); `jobQueue.test.js` |
| "Where did you learn **our** price?" answered from Aquiplex's profile | The identity router's first-person check was singular only | "we/our/us" count as first person; `identityLayer.test.js` |
| A deleted fact came back | Sibling claim, subject name, garbage legacy slot | See §3 |

Journey results by run: 17/23, 12/22 (driver not waiting, fixed), 19/23, then **21/23**. The remaining failure is a compound change sentence losing one of its two changes (extraction quality; not tuned).

## 5. Defects found by the browser suite (first time run signed in against the real app)

| Defect | Fix |
|---|---|
| Ordinary browsing exhausted the 30/min message limit, and the next chat got a 429 | The limiter counts only spending methods; a separate 300/min read limiter. `launchSafety.test.js` |
| Duplicate `#aqua-sidebar-search` on phones (the shortcut focused a hidden input) | The desktop sidebar is not mounted on mobile |
| Focus not returned after the artifacts panel or drawer closed | Capture in `onOpenAutoFocus`, restore in `onCloseAutoFocus` |
| Specs navigated to absolute `/` (the site root on the real server) | Relative `./`; `e2e/make-session.mjs` + `playwright.local.config.ts` |

**Open:** the markdown-tables spec shows narrow-viewport table rendering defects (28/42).

## 6. Other fixes this session

- **Billing:** `refund()` was not idempotent (every call minted credits); now once-only. `usageGuard` refunds any charged request that ends in 4xx/5xx. `tests/platform/creditRefund.test.js`.
- **Isolation:** `intro/complete` wrote its marker onto any conversation id. It is now limited to the caller's own conversations. Two fixtures that depended on the cross-account write were corrected to production-shaped ownership.

## 7. Not completed, with reasons

- **Lift v4: no result.** Attempt 3 ran as pre-registered (tree `aadda450`, fresh DB) and died at about 40 minutes when the machine rebooted. The protocol voids crashed runs, and it was not relaunched on battery. Launch kit: `scratchpad/v4run/launch-v4.ps1` or the VM kit.
- **Not run:** Android Gradle build (no JDK); WebKit browser projects.
- **Open:** compound-change extraction; canonical-read noise and unknown-honesty; E10 unresolved claims.

## 8. Commands (this session)

| Command | Result |
|---|---|
| Per-directory aqua battery, live PG + Redis (`scratchpad/batch-battery.sh`) | 4,392: 4,388 pass, 0 fail, 4 skipped |
| `npm run test:platform` | 245/246 (local gitignored patches) |
| `cd aqua-frontend && npx tsc -b && npx vitest run` | clean; 117/117 |
| `cd aqua && AQUA_TEST_DATABASE_URL=<test db> node eval/gate.mjs` | PASS (incl. `context-canonical`) |
| `cd aqua && node eval/gate.mjs` (no DB) / with `AQUA_GATE_REQUIRE_DB=1` | PASS with NOT RUN reported / BLOCKED (exit 1), as designed |
| RC in Linux `node:20` (`scratchpad/linux-battery.sh`) | 3,617/3,634; 0 new failures against production |
| `node aqua/scripts/e2e-founder-journey.mjs` on the real launcher | 21/23 (run 4) |
| `npx playwright test -c playwright.local.config.ts` (Chromium, 7 viewports) | shell suite passing except one capacity timeout; markdown-tables 28/42 on dev |
