# AQUIPLEX — security and validation status (updated 2026-10-19, release preparation)

Supersedes the earlier 2026-10-19 version of this file.

Labels:

- **VERIFIED**: checked in this pass, with the test, command or file named.
- **MEASURED**: a number produced in this pass.
- **HISTORICAL**: from an earlier pass, not re-measured.
- **NOT DONE**: an operation that has not been executed.

**State in one paragraph.** The account-security fixes are complete, tested, and staged on a
dedicated local branch, `security/account-takeover-and-entitlements`, as **uncommitted** changes in
a separate worktree. **Nothing has been committed, pushed, merged or deployed. No credential has been
rotated. No production system, database or configuration was read or changed.** Production
(`main` = `4c093395`, VERIFIED with `git ls-remote` today) is still exposed to the pre-account
takeover, the unlimited-credit bypass, and every exposed credential.

---

## 1. Verified security fixes

Each fix below was verified on the **release branch itself**: a fresh worktree of `main` plus only
the security changes.

| # | Defect (on `main`) | Fix | Verified by |
|---|---|---|---|
| S1 | **Pre-account takeover.** `/signup` made a usable account for any address. Google sign-in entered any account with the same email string. An attacker's password kept opening the victim's account (reproduced on `main`'s code) | No account exists until the emailed link is opened **and** the signup password re-entered (tokens hashed, single-use, 24 h, lock after 5). Google binds to the Google identity (`sub`) and needs `email_verified`. A password account with the same email is never entered automatically: `/auth/link` offers *prove the password* or *explicitly claim with Google*. Claiming an unverified account removes its password and ends all other sessions | `tests/platform/accountSecurity.live.test.js` (21, real handlers/views/models/Mongo; covers takeover, unverified email, verified matching email, conflicting identities, legitimate linking, expired and replayed tokens, legacy migration); mutation check (old email-match ⇒ 4 failures); real `index.js` smoke on the branch |
| S2 | **Unlimited credits by registering a public allowlisted address** (reproduced) | Allowlist only for `emailVerified === true`; exact matching (aliases never match). `isUnlimited` changed only by `scripts/admin/unlimited-entitlement.cjs` (by id, verified accounts only, dry run unless `--apply`, `EntitlementAudit` record). Changing email clears verification. No emails in logs | `tests/platform/unlimitedEntitlement.test.js` (11); mutation check (verified rule removed ⇒ failure) |
| S3 | **Account enumeration** (signup `409`; login timing 27 vs 877 ms, MEASURED on `main`'s logic) | Identical signup responses. Login always pays bcrypt (dummy hash). Signup hashes before it branches | Branch app: identical bodies after normalising per-session tokens; login 247 vs 294 ms (existing vs unknown, MEASURED on the branch); `identityWiring.test.js` pins both |
| S4 | Google reauth (account deletion) ignored `email_verified`; `/login?error` text; Host-header links | verified-only reauth; fixed error table; `APP_URL` for links | `identityWiring.test.js` (15) |
| S5 | **Sessions** survived security changes | `authVersion` per account and per session; a guard right after `passport.session()` ends stale sessions; existing sessions are unaffected by the deploy | live test: a squatter's session ends at claim; another session ends when a verified owner claims |
| — | Earlier fixes carried in this PR (10-16/17, tested then and now) | the intro marker only on the caller's own conversation; refund at most once; refund on any failed paid request; separate read limiter | `aqua/src/understanding/tests/introGate.test.js`, `tests/platform/creditRefund.test.js`, `launchSafety.test.js` |

**Audit of the requirements in your brief (VERIFIED on the branch):**

- **Email signup requires ownership verification.** The live test, plus the branch app: no session
  after signup, `/home` → `/login`; link plus wrong password → 401; right password → `/aqua`.
- **Google matches the verified identity, not an email string.** `index.js` has no
  `User.findOne({ email })` left (pinned). Unverified Google emails are rejected.
- **Linking requires proof.** Either the account password, or Google's proof of the address plus an
  explicit confirmation box. The pending identity lives on a regenerated session id (a planted
  session cannot complete it) and expires after 10 minutes.
- **Existing password accounts have a path.** Password login is unchanged. Google sign-in leads to
  `/auth/link`, which keeps the account and links it, or claims it.
- **Session invalidation.** Verified live.
  - Caveat: the version is cached per process for up to 5 s, so on other instances it takes effect
    within that window.
  - Caveat: an invalidated session's next page may carry a stale CSRF token, so one form submit
    fails once.
- **No existence leaks.** See S3.
- **Unlimited credits can't be obtained by choosing an email.** See S2.
- **Grants are server-side and auditable.** See S2. The script needs database access and never reads
  `.env`.
- **Clients can't modify balances or entitlements.** Pinned by source tests: no request field
  reaches a wallet, credit, role or entitlement; no mass assignment; the only `isUnlimited` write is
  `false`; purchase credits come from the server pack table.
- **Payment webhook verification is still correct.** Exercised on the branch app with a test-only
  secret: valid HMAC → 200; wrong secret → 400 `INVALID_SIGNATURE`; none → 400
  `MISSING_SIGNATURE`. `webhookSignature.test.js` passes.
  - Note: this is exactly why the exposed webhook secret is P0. Its holder gets the 200.

## 2. PR readiness and exact uncommitted changes

**Release branch:**

| | |
|---|---|
| Branch | `security/account-takeover-and-entitlements`, created from `origin/main` `4c093395` |
| Location | separate worktree `C:\Users\dell\Downloads\aquiplex-platform\aquiplex-security-release` (your working tree is untouched) |
| Commits | **0**: the changes are uncommitted in the worktree |
| Remove if unwanted | `git worktree remove ../aquiplex-security-release` and `git branch -D security/account-takeover-and-entitlements` |
| PR description | `C:\Users\dell\AppData\Local\Temp\claude\c--Users-dell-Downloads-aquiplex-platform-aquiplex-platform\0d4859f7-01e8-485c-bd3c-a854dc25c459\scratchpad\PR_BODY_security.md` |

**Diff against `main`:** 14 modified files (+409 / −98) and 17 new files.

Modified:

- `index.js` (+242/−…): auth wiring, constant-time login, read limiter.
- `models/User.js`
- `services/auth/establishSession.service.js`
- `utils/credits/unlimitedAccess.js`
- `middleware/usage/checkUsage.js`, `middleware/usage/usageGuard.js`
- `aqua/src/understanding/understandingRoutes.js` and its tests `introGate.test.js`,
  `summary.test.js`
- `tests/auth/sessionFixation.test.js`, `tests/platform/launchSafety.test.js`,
  `tests/platform/productEvents.test.js`: the same intent, re-pointed where the code moved.
- `.github/workflows/platform-tests.yml`: adds a `mongo:7` service so the live security tests
  **run** in CI instead of skipping. Parsed and checked locally; **not yet run on GitHub Actions.**
- `.gitignore`: see below.

New:

- `services/auth/identityPolicy.service.js`, `authRoutes.service.js`, `mailer.service.js`
- `models/PendingSignup.js`, `models/EntitlementAudit.js`
- `scripts/admin/unlimited-entitlement.cjs`, `audit-legacy-accounts.cjs`,
  `account-security-audit.cjs`
- `views/signup-check-email.ejs`, `views/verify-email.ejs`, `views/link-account.ejs`
- Tests: `tests/auth/identityWiring.test.js`, `tests/platform/accountSecurity.live.test.js`,
  `accountSecurityAudit.live.test.js`, `unlimitedEntitlement.test.js`, `creditRefund.test.js`
- `aqua/src/upload/tests/fixtures/project.tar.gz` (see below)

**One non-security change on the branch, flagged so you can split it out:**

- `aqua/src/upload/tests/fixtures/project.tar.gz` was **never committed**: `*.tar.gz` in
  `.gitignore` excluded it.
- Every fresh checkout, including CI's `eval-gate` job, which this PR triggers through `aqua/**`,
  fails 5 upload tests.
- MEASURED: the branch failed exactly those 5 before, and passed 101/101 after adding a
  `.gitignore` exception and the fixture. The fixture's sha256 (`55342ef9…`) matches its
  `manifest.json`.
- Without it, CI on this PR would be red for a pre-existing reason.

**Content checks on everything in the PR (VERIFIED):**

- no `.env`, patch, archive, key or log files (the one `.tar.gz` is the test fixture above);
- no credential patterns;
- none of the 49 current `.env` values appears in any file (compared in memory, nothing printed);
- every email address uses a reserved test domain (`example.test`, `example.com`);
- `node_modules` is linked into the worktree and ignored.
- The release files were byte-compared with the tested working-tree versions: 26 of 26 identical
  before the branch-only additions.

**Merge blockers:**

1. Your review and authorization to commit and push. **NOT DONE.**
2. A green GitHub Actions run (the new workflow's first run).
3. The decisions in §6: mail provider, OAuth callback, deploy timing relative to rotation.

**Your main working tree** (`aquiplex/world-model-pass2`, HEAD `e64f26cb`) still holds everything:
the security changes, the World Model work, and today's additions (the audit script and its test,
the CI workflow, the `.gitignore` exception, `attribution-dev.v1.json`).

- Backups: `C:\Users\dell\AppData\Local\Temp\claude\c--Users-dell-Downloads-aquiplex-platform-aquiplex-platform\0d4859f7-01e8-485c-bd3c-a854dc25c459\scratchpad\wip-post-security-2026-10-19.patch` + `.tgz`. **Restore-tested today:**
  rebuilding `HEAD` + patch + archive reproduced all 113 files identically.
- **Latest backups (VERIFIED):**
  - Main tree: `C:\Users\dell\AppData\Local\Temp\claude\c--Users-dell-Downloads-aquiplex-platform-aquiplex-platform\0d4859f7-01e8-485c-bd3c-a854dc25c459\scratchpad\wip-release-prep-2026-10-19.patch`
    + `.tgz` (52 untracked files).
  - Release branch: `C:\Users\dell\AppData\Local\Temp\claude\c--Users-dell-Downloads-aquiplex-platform-aquiplex-platform\0d4859f7-01e8-485c-bd3c-a854dc25c459\scratchpad\release-branch-tracked.patch` +
    `release-branch-new-files.tgz` (17 files, each byte-compared with the branch).

## 3. Test results and remaining failures (MEASURED today)

| Suite | Release branch | Main working tree |
|---|---|---|
| aqua battery, per directory, live Postgres + Redis | **4,367/4,371, 0 failed, 4 skipped** (fresh DB migrated with the branch's 24 migrations) | 4,467/4,471, 0 failed, 4 skipped |
| platform suite with test Mongo | **299/299** | 296/296 on a clean export; 295/296 in the checkout (3 ignored local `.patch` files trip the residue check) |
| frontend `vitest` | **117/117** | 117/117 |
| eval gate, with DB | **16 PASS, 0 FAIL** | 18 PASS, 0 FAIL |
| real app smoke (signup/verify/CSRF/enumeration/timing/webhook) | **all as designed** | as designed |
| founder journey (live providers) | not run on the branch (it needs the World Model launcher) | run 6: 22/24, both failures in my script, since fixed; run 7: 18/18 reached, then a timeout under rate limiting |

The 4 skipped tests are all documented environment cases: pg-mem cannot enforce a partial unique
index or roll back; Windows has no in-process SIGTERM.

**Remaining failures and open issues:**

- **`T7/T11 — facts survive process restart`** (`aqua/src/memory/tests/unified.test.js`).
  - Failed 1 of 9 directory runs yesterday, with no error text.
  - Today it was put under a stress series to capture one: see §7.
  - Unexplained so far.
- **`perfShape LINEAR`:** HISTORICAL, 1 of 3 full parallel runs (2.53× vs 2.5×). Unchanged and not
  reproduced in isolation.
- **Fixed today:**
  - the upload fixture (above);
  - `editRoutes.test.js` exit abort, fixed in the World Model tree (not part of the security PR;
    the branch passed 185/185 without it in this run).

## 4. Credential rotation status

**No credential has been rotated, no provider has confirmed any action, no dependent service has been
re-tested, and no old credential is known to be revoked.** Remediation is **not complete** for any
credential.

**Where the exposed values sit in git history (VERIFIED by name and hash only):**

- root `.env` (`8da8e11b`);
- `aqua/.env` (`8da8e11b`, `66501aec`);
- two versions of `.aqua-index.json` (`e46bc105`, `e877b5ea`).

| # | Credential | Provider | Rotation | Dependent services / config | Verification after rotation | Old value revoked? |
|---|---|---|---|---|---|---|
| 1 | `RAZORPAY_WEBHOOK_SECRET` | Razorpay | **NOT DONE** | Render web; `index.js` webhook route | dashboard test webhook → 200; old-secret payload → 400 | **No** |
| 2 | `RAZORPAY_KEY_SECRET` (+ id) | Razorpay | **NOT DONE** | Render web; `razorpay.service.js`; pricing page reads the id | ₹1 live order end to end, then refund it | **No** |
| 3 | `MONGO_URI` | MongoDB Atlas | **NOT DONE** | Render web + worker; session store; Mongo mirror | `/health`, login, chat persists, no mirror auth errors | **No** (delete the old DB user after verifying) |
| 4 | `SESSION_SECRET` | self | **NOT DONE** | Render web (forces one global logout) | an old cookie is signed out; a new login works | n/a: replacing it invalidates the old |
| 5 | `GOOGLE_CLIENT_SECRET` | Google Cloud | **NOT DONE** | Render web; OAuth callbacks | Google sign-in end to end | **No** |
| 6 | `OPENROUTER_API_KEY_1…4`, `OPENROUTER_API_KEY` | OpenRouter | **NOT DONE** | Render web + worker, key pool | key-pool diagnostics; one chat turn | **No** |
| 7 | `GEMINI_API_KEY`, `GROQ_API_KEY`, `SERPER_API_KEY` | Google AI, Groq, Serper | **NOT DONE**. HISTORICAL 10-15: our app's calls were rejected (likely revoked); unconfirmed in consoles | none | the console shows revoked | **Unconfirmed** |
| 8 | old `GEMINI_KEY_1…8`, `GROQ_API_KEY_1…4`, `HF_API_KEY`, `TOGETHER_API_KEY` | various | **NOT DONE** (confirm revoked) | none | console | **Unconfirmed** |
| 9 | `UNLIMITED_USER_EMAILS` | — | not rotatable; S2 neutralises it once deployed | Render | email signup of an allowlisted address is not unlimited (staging) | n/a |

The full procedures, ordering and rollback notes are unchanged from the previous version of this
file:

- Razorpay webhook → Razorpay keys → Mongo → session (announce a logout) → Google → OpenRouter;
- then confirm 7–8 are revoked;
- then enable GitHub secret scanning and push protection.

A history rewrite is optional hygiene and **does not revoke anything**. If done, it must cover all
three locations above. The VM experiment kits use the NVIDIA keys, which never appeared in history.

## 5. Read-only account audit: what has been established

**Production has NOT been audited.** No production database was accessed.

What exists:

- **`scripts/admin/account-security-audit.cjs`**: read-only by construction (only `find`,
  `countDocuments`, `distinct`, `aggregate`); explicit `--mongo`; never reads `.env`; prints counts
  and ids, never emails, tokens, signatures or payloads.
- **VERIFIED** by `tests/platform/accountSecurityAudit.live.test.js` (3/3):
  - it finds every seeded scenario;
  - **every collection's content hash is identical before and after a run** (writes nothing);
  - it prints no email address;
  - it refuses to run without `--mongo`.

**What it reports, and the evidence each item gives:**

| Question | Evidence collected | What it can and cannot show |
|---|---|---|
| Was an account taken over? | unverified password accounts; of those, ones also signed in with Google (the takeover shape); and **password sign-ins after the first Google sign-in** on the same account (strongest signal: someone kept using a password after the address's owner started using Google) | Built on product events, which exist only since analytics were added (the report prints the oldest event). Older accounts have no history. It suggests cases to review; it is never a verdict |
| Were unlimited credits obtained improperly? | `isUnlimited` accounts without an `EntitlementAudit` grant; allowlisted addresses with no account (registrable by anyone before the fix); allowlisted addresses held by an **unverified password** account | Needs the allowlist passed as a file (only compared, never printed) |
| Were credits minted with the leaked Razorpay secrets? | successful payments since 2026-07-04, split webhook vs client-verify; successes with no payment id; **every credited order id to reconcile**; `PURCHASE` transactions without a payment; wallets whose lifetime earnings exceed their successful payments; admin adjustments | **Confirmation needs Razorpay's records**: every listed order must appear as captured in the Razorpay dashboard or API. That reconciliation is manual |
| Sessions | stored-session count only | contents are never read |

**Recovery plan, for your approval. No step is automatic; no user is contacted automatically.**

1. **Before rotation:** take a read-only snapshot. Run the audit against production (needs your
   approval and the production URI, run by you or with you):
   `node scripts/admin/account-security-audit.cjs --mongo <prod-uri> --allowlist-file <file> --json audit.json`.
   Optionally point it at a read-only database user.
2. **Payments:** reconcile `ordersToReconcile` against Razorpay. For any order Razorpay has no
   capture for, mark it as a candidate fraudulent credit. Decide the action (reverse credits or
   leave) per case.
3. **Identity, `passwordSignInsAfterFirstGoogleSignIn` accounts:** treat as possibly compromised.
   Options, for your decision:
   - (a) wait for the owner's next Google sign-in, which offers the claim that removes the password
     and sessions;
   - (b) remove the unverified password now (`audit-legacy-accounts.cjs
     --remove-unverified-passwords-of-google-users --apply`). Recovery = Google sign-in;
   - (c) contact the owner manually.
4. **Identity, other unverified password accounts:** no action. They keep password login. A Google
   sign-in leads to `/auth/link`.
5. **Entitlements:** for each `isUnlimited` account without an audit record, decide: grant it
   properly (audited) or revoke it, through the script. Allowlisted addresses held by unverified
   password accounts: revoke, and confirm with the address owner out of band.
6. **Sessions:** rotating `SESSION_SECRET` (§4 #4) ends all sessions once. No other bulk
   invalidation is proposed.

## 6. Staging and production blockers

**Precise blockers (I cannot proceed past these):**

- **No staging environment is defined or reachable.** The repo has no `render.yaml`, staging config
  or staging credentials, and I have no Render or provider console access.
- **No production access.** That's correct as policy, but it means the audit, the deploy and every
  verification need you.
- **No mail provider chosen.** Email signup ships disabled unless one is configured.
- **Credentials unrotated** (§4).

**Staging deployment checklist**, to execute with your approval:

| Area | Check | Expected |
|---|---|---|
| Email | `MAIL_TRANSPORT` unset | `/signup` POST → 503 "continue with Google"; nothing stored |
| Email | or `resend` with `RESEND_API_KEY` + `MAIL_FROM` (verified domain) | signup → mail arrives → link + password → signed in. **The first real-provider test of this transport** |
| Email | `APP_URL` set to the staging origin | links point to staging, never to the Host header |
| Google OAuth | callback URLs registered for `/auth/google/callback`, `/auth/google/reauth/callback`, `/auth/google/link/callback` | all three round trips complete |
| Google OAuth | a staging account with a Google-verified address | new account bound to `googleId`; a second sign-in goes straight in |
| Linking and recovery | password account + Google sign-in for the same address | `/auth/link`; wrong password 401; right password links; claim without the box 400; claim with it signs in |
| Linking and recovery | legacy unverified password account claimed | its password stops working; its other sessions end |
| Sessions | two browsers on one account, then claim or link in one | the other is signed out within ≤ 5 s |
| Credits and payments | allowlisted address via email signup | **not** unlimited; via Google: unlimited |
| Credits and payments | Razorpay **test mode** order end to end | credited once; replaying the verify / webhook does not credit twice |
| Credits and payments | webhook with a wrong signature | 400 |
| Migrations | startup log | `googleId_unique_partial` and the `pendingsignups` TTL index built, no index errors; no SQL migration in this PR |
| Isolation | two accounts | neither sees the other's Memory / conversations (`aqua` isolation suites already pass) |
| Monitoring | logs | no email addresses in auth or credit logs (`[MAIL]` masks recipients); watch `[AUTH]` errors and 5xx on `/signup`, `/verify-email`, `/auth/link*` |
| Rollback | revert the PR on staging | the old flows work. **Caveat:** the takeover returns after a rollback |

**Production order (proposed):**

1. Rotate the Razorpay webhook secret and key secret (they don't depend on the deploy).
2. Read-only production audit snapshot (§5).
3. Deploy the PR after staging passes.
4. Rotate the remaining credentials.
5. Production verification (the same checklist, without the test-mode payment).
6. Act on the audit (§5).

## 7. Frozen experiment status and World Model follow-up

**Frozen experiments (VERIFIED intact today):**

- v4 kit: 7/7 manifest; code `aadda450`; dataset `86c4f7ba…`.
- Final kit: 9/9; dataset `b20c331d…`, registered to the 10-18 snapshot.
- Both `out/` folders are empty; neither dataset was opened.
- **Neither has run.** No VM is reachable from here. The exact procedure is unchanged from the
  previous version of this file (§5 there).
- **No claim of answer-level superiority can be made.**

**Person attribution (development only).** New, unfrozen cases in
`aqua/eval/datasets/attribution-dev.v1.json`: 16 cases over 6 classes, written fresh, unrelated to
the frozen sets.

First live run (MEASURED, one run, paced; the model is non-deterministic, so read as diagnosis, not a
rate):

- **9 of 16 valid**; 7 lost to provider errors (likely rate limits; the run's log was filtered, so
  not confirmed).
- Of the 9: **7 pass, 2 fail.**
- **Both failures are one class:** the user helps someone with *their* thing ("I help Maria with her
  thesis", "I'm helping Lena finish her pitch deck"). Extracted as `self task_owner "help(ing) Maria
  … her thesis"`: the owner is buried inside the object literal, and the user is credited as owner.
- Passed: Ravi (helper is the actor), sister's bakery, Omar hire, Zoe, Dev, "Priya, not me", Sam vs
  me.
- Diagnosis direction, not implemented: the extraction prompt has no rule for "X's thing that I help
  with"; the actor retry does not fire because the person *is* mentioned (inside the object).
- **Next:** at least 3 runs per class before any change. Then decide between a prompt rule and an S4
  check that flags `self` + `task_owner` when the object names another person's possession.

**Intermittent memory test (T7/T11):** stress series result is in the addendum below.

## 8. Every action requiring your approval

1. **Review the release branch** (`security/account-takeover-and-entitlements`, worktree path in §2),
   and authorize **commit + push + opening the PR** (body ready in the scratchpad). Decide whether to
   keep or split the upload-fixture fix.
2. **Rotate credentials** in the §4 order. Each needs your provider console and Render access, and
   each must be verified and the old value revoked before it counts as done.
3. **Choose the mail path:** a provider (and its credentials), or ship with email signup disabled.
4. **Register** the `/auth/google/link/callback` URL in the Google OAuth client (staging and
   production).
5. **Provide or approve a staging environment** and run the §6 checklist.
6. **Approve the read-only production audit** (§5 step 1), then decide each recovery step (payments
   reconciliation; options a/b/c for suspicious accounts; entitlement grants and revocations).
7. **Approve the production deploy** and its verification, in the order in §6.
8. **Provide a VM** for v4, then the final evaluation.
9. Later, and optional: enable GitHub secret scanning and push protection; a history rewrite as
   hygiene only.

---

### Addendum: T7/T11 stress series (MEASURED)

**Runs:**

- 6 directory-level runs of `aqua/src/memory`, each with 2 extra CPU-bound processes running
  alongside: **167/167 every time, T7/T11 failed 0 of 6.**
- Combined with yesterday's runs: on the World Model tree it failed **1 of 15** directory runs, and
  **0 of the 14 runs since**.
- The release branch also passed `src/memory` in both of its batteries.

**Status: intermittent, not reproduced, cause unknown.** The one failure's error text was lost, so I
can't say why it failed. HYPOTHESIS: the timing of the child "restart" process the test spawns.

**Change:** the battery script now keeps every directory's log, so the next occurrence will be
diagnosable.

**Not a release blocker:** the test belongs to the World Model memory layer, which the security PR
does not change.
