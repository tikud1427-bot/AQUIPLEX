# Release candidate manifest — 2026-10-17

**Status: prepared and tested; NOT committed, pushed, deployed or migrated.** All
of those need the founder's approval.

## Identity

| | |
|---|---|
| Production today | `origin/main` = **`54c8de96`** (verified against the remote) |
| RC branch | `release/rc-2026-10-16` (local only), worktree at session scratchpad `rc/` |
| RC base commit | **`6dea686e`**: the 2026-10-12 hotfix, whose parent is `54c8de96` |
| RC content | base + the staged changes below; staged tree **`3de125d0`** (`git write-tree`) |
| Size | 42 files, +1,403 / −74 |

The RC was built by selective `git apply --3way` from this branch. The patch
base was identical to `main` for every file except `index.js`, `package.json`
and two routes, and those differed only in unrelated regions. Every hunk applied
cleanly. Lockfiles (`package-lock.json`, `aqua/`, `aqua-frontend/`) are
byte-identical to `main`, so there are **no dependency changes**.

## Included

### From the 2026-10-12 hotfix (`6dea686e`)

- Chat accepts only a `workspaceId` the caller owns. This closes a cross-account read on production.
- Forget and correct reach every store that answers (legacy facts, canonical claims, the conversation evidence lane).
- Deletions hold across the two processes (mind-store merge on flush).

### Security and abuse

- Cross-account memory adoption is blocked inside `resolveOwner` (`aqua/src/memory/ownerResolver.js`).
- Session fixation: email login and signup regenerate the session (`services/auth/establishSession.service.js`).
- Login gives one answer for an unknown email and a wrong password. Errors render on the form.
- Bundles:
  - ownership is checked before `runBundle`;
  - `/generate-bundle`, `/execute-step` and `/bundle/:id/run` require login, the rate limiter and credits.
- The 50 MB JSON parser runs only after login on the engine mounts. Everything else gets 1 MB.
- Razorpay webhook and checkout signatures are compared in constant time.
- `POST /understanding/intro/complete` writes its marker only onto the caller's own conversation. Two test fixtures that relied on the cross-account write were corrected.

### Billing correctness

- `creditContext.refund()` runs at most once per request. Before, every call minted credits again.
- `usageGuard` refunds any charged request that ends in 4xx or 5xx. Before, failed uploads, the 400/404 exits after the charge, and failed bundle steps kept the credits.

### Reliability

- The engine's **30/min limit now counts only spending requests** (POST, PUT, PATCH, DELETE). Reads get a separate 300/min ceiling, also before login.
  - Defect found by the browser suite: ordinary browsing exhausted the limit, and the next chat message got a 429.
- Durable jobs: **provider-capacity failures** (rate limit, 429, quota, cooling down) retry after 1, 2, 4, 8 minutes, then the 15-minute cap.
  - Before, the 2ⁿ-seconds schedule dead-lettered an extraction about 30 seconds after the first failure, and the user's message was lost (reproduced live).
- Identity router: "our"/"we" questions are about the user's company, not Aquiplex. "Where did you learn our price?" had been answered from Aquiplex's own profile.

### Product truth and UX

- The pricing page lists only metered actions.
- Landing hero rewritten; no integrations implied.
- The onboarding opener says what to bring and what Aqua can't see.
- Phones: the hidden desktop sidebar is no longer mounted, which removes a duplicate `#aqua-sidebar-search`.
- Focus returns to the trigger when the artifacts panel or the mobile drawer closes.

### Measurement, tests, CI

- Content-free product events (`services/analytics/*`, `models/ProductEvent.js`), deleted with the account, plus the read-only `scripts/activation-report.mjs`.
- Root `npm test` = the aqua battery + root platform tests; new workflow `.github/workflows/platform-tests.yml`.
- `aqua/scripts/run-tests.mjs`:
  - relative paths (on Windows, `main`'s version silently ran nothing);
  - spawn errors are reported;
  - Postgres only via `AQUA_TEST_DATABASE_URL`.
- Browser e2e can now run signed in against a local real server (`e2e/make-session.mjs`, `playwright.local.config.ts`); spec navigation is relative to the base URL.

## Excluded, and why

| Change (on this branch) | Why it is not in the RC |
|---|---|
| Provider key-pool refactor (`keyPool.cjs`, adapters, `services/ai.client.js`) | Large, separate concern. It shifts root traffic onto the numbered Groq pool. Ship it on its own after a provider decision. |
| Memory page "What Aqua knows now" + `/brain/current`, `/brain/claims/:id/forget`, `/correct-value`; user-deletion veto | Depends on this branch's **authoritative** read mode (canonical claims answer by default). `main` reads canonical claims only with `AQUA_CANONICAL_READ=on`. Needs the read-mode release first. |
| Deterministic tie-breaks in canonical retrieval and extraction context | Canonical read path only; same dependency. |
| `context-canonical` eval suite, gate DB isolation, CI Postgres service | Tests this branch's canonical path. |
| Pass-2 world-model changes (`353ad922..85d43e69`) | Product-behaviour changes still under evaluation (Lift v4 not completed). |
| Strategy documents | Not code. |

## Migrations and configuration

- **Database migrations: none.** `main` and the RC both have 16 migrations; the RC adds none. Verified: `db/cli.mjs` applied 16 on a fresh database.
- **Mongo:** one new collection, `productevents`. It is created on first write, with a TTL index of 400 days.
- **New optional environment variable:** `AQUA_PRODUCT_EVENTS=off` disables product events. Nothing new is required.
- **Behaviour users will notice:**
  - a failed answer or upload no longer costs credits;
  - reads no longer consume the message rate limit.

## Test status (this exact RC)

| Suite | Environment | Result |
|---|---|---|
| Aqua battery | Linux `node:20` container, fresh Postgres (16 migrations), test Redis | **3,634 tests: 3,617 pass, 14 fail, 2 skipped. All 14 failures also fail on production `54c8de96` (3,592: 3,574 pass, 15 fail). 0 new failures.** The tree tested was before the rate-limit and UI ports, which touched only `index.js`, platform tests and frontend files (verified separately below). |
| Platform tests (root `tests/`) | Windows, after all ports | **231/231** (production `main`: 167/173; its 6 failures are stale assertions fixed here) |
| Platform tests | Linux | 230/230 (before the rate-limit test was added) |
| Frontend | `tsc -b` + vitest | tsc clean; **110/110** |
| Eval gate | `DATABASE_URL=` (as CI) | **PASS** |
| Android static release check | after `npx cap copy android` (the config file is generated and gitignored) | **PASS** |
| Android Gradle/APK build | — | **NOT RUN**: no JDK or Android SDK on this machine |

The 14 pre-existing Linux failures:

- archive and gzip fixture parity;
- parser fixture integrity;
- repository hygiene (`*backup*` names);
- E6 wiring expectations of the older base.

They are identical on production.

## Known risks

1. **Secrets are still exposed in the public repo** (`REPO_AUDIT.md` §5). Shipping the RC does not fix this. Rotate first.
2. The refund-on-failure rule refunds every 4xx after a charge. A client that deliberately sends invalid requests after the charge gets its credits back, which is the intended outcome, not a hole: nothing was delivered.
3. The capacity backoff keeps jobs alive for about 30 minutes. A provider outage longer than that still ends in the dead-letter queue (requeue with `npm run doctor:dlq`).
4. Product events add a Mongo write per chat turn (fire-and-forget).

## Rollback

There are no migrations, so rollback is a redeploy of `54c8de96`.

- The `productevents` collection can stay (it is ignored) or be dropped.
- Sessions created by the RC remain valid on the old code (same cookie and store).

## To ship (needs approval)

```bash
cd <rc worktree>
git commit -m "Release candidate 2026-10-17: hotfix + security, billing, reliability fixes"
# review, then push the branch and open a PR to main; deploy after CI (eval-gate + platform-tests) is green
```
