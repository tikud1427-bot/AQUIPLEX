# Repository audit — 2026-10-15

Branch `aquiplex/world-model-pass2`, built on HEAD `85d43e69`. The tree also
carries uncommitted provider key-pool work from an earlier session. That work is
preserved, untouched, and included in the test runs below.

Every finding carries one of three labels:

- **VERIFIED**: checked in this session by running code or reading the implementation.
- **HISTORICAL**: taken from an earlier report in the repo and not re-run.
- **INFERENCE**: reasoning, not measurement.

---

## 0. Release blockers (read first)

| # | Blocker | Evidence | Who can clear it |
|---|---|---|---|
| B1 | **Secrets are in public Git history and are still in use.** The GitHub repository `tikud1427-bot/AQUIPLEX` answers anonymous API requests (HTTP 200), so it is **public**. Fourteen secret values in today's `.env` are byte-identical to values in public commits `8da8e11b`, `324a601f`, `0e00ae77` and `6f92e731`, which are still reachable from `origin/main`. | VERIFIED. The comparison script printed key names only (§5). | Founder: rotate the secrets, then make the repo private or rewrite its history. |
| B2 | **Production lacks the 2026-10-12 hotfix.** `origin/main` is `54c8de96`, the same as the remote. The live site therefore still has two defects: (1) chat accepts a client-supplied `workspaceId`, a cross-account read; (2) "forget" leaves the conversation evidence lane, so deleted facts can still answer. Hotfix branch `hotfix/2026-10-12-auth-memory-safety` (`6dea686e`) fixes both but has not been pushed. | VERIFIED: refs compared. The defects themselves are HISTORICAL, confirmed on 54c8de96 in the 2026-10-12 audit. | Founder: approve push and deploy. **Update 2026-10-17:** a tested release candidate now carries the hotfix plus B3 and later fixes (`RELEASE_MANIFEST_RC_2026-10-17.md`). |
| B3 | **Defects fixed on this branch also exist on `main`:** cross-account memory adoption, session fixation, the bundle IDOR, anonymous LLM spend, non-idempotent refunds, the message rate limit consumed by reads, extraction lost to brief rate limits, and the cross-account intro marker. | VERIFIED: reproduced against the base code. | **Ported into the RC (2026-10-17): 0 new test failures against production on Linux.** Shipping needs founder approval. |
| B4 | **Production runs on free provider tiers.** It uses Gemini free, Groq per-organisation free quota, OpenRouter `:free`, and NVIDIA trial keys. Capacity has already run out during evaluations, and commercial use of free tiers may breach provider terms. | VERIFIED (model registry). The quota exhaustion is HISTORICAL (validation report, 2026-10-05). | Founder: a paid key on at least one provider. **Quantified 2026-10-17:** Groq free tier ≈ 10 extractions per minute for the whole product; a single onboarding burst hits it. A paid tier costs an estimated $0.0025 per turn (`PRODUCT_SCORECARD.md` §3c). |

---

## 1. What the company currently is

| Surface | What it is | State |
|---|---|---|
| `index.js`, `views/`, `routes/`, `services/`, `models/` | Express 5 platform. It handles auth (email and Google, including an Android native handoff), sessions in Mongo, Razorpay prepaid credits, account deletion, the landing page, pricing, a blog, and three legacy features: an AI-tools directory, "bundles" and "write". | Live at aquiplex.com, according to the 2026-10-12 audit. Open signup. |
| `aqua/` | The AI engine, an ESM package mounted at `/api/aqua` and `/v1`. It covers chat and streaming, provider routing with fallback, memory, the World Model (Postgres canonical claims), file and project intelligence, artifacts, reflection workers and evals. | About 4,370 tests. Most of the engineering effort lives here. |
| `aqua-frontend/` | React 19 SPA at `/aqua`, also packaged as an Android app (Capacitor). It has chat, a Memory page, a Mind page, projects and a two-minute interview onboarding. | Builds. 117 vitest tests pass. |
| `evaluation/`, `aqua/eval/` | Python AQEval, the JS eval gate (24 gates), and the Lift experiment harness with held-out sets v3 and v4. | The gate passes (§6). The v4 held-out run never finished. |
| About 70 root `*.md` files | Patch notes, blueprints and audits from August to October 2026. | Many are outdated or contradict each other. Treat them as history, not as current behaviour. |

### Request lifecycle (chat), traced in code

`POST /api/aqua/chat` (or `/chat/stream`) passes through these stages:

1. `engineLimiter`: 30 requests per minute per IP.
2. `requireLogin`.
3. `aquaJson`: the 50 MB body parser. As of today it runs only after login.
4. `req.aquaUserId` is set from the session.
5. `engineEventTap`: product events, new today.
6. `usageGuard('chat_message')`: deducts 5 credits.
7. `routes/chat.js`:
   - The `conversationId` ownership check returns 404 on a mismatch.
   - `authorizedWorkspaceId`: on this branch, not on main.
   - `prepareTurn` → `resolveOwner` → `user:<id>`.
   - Classify, then plan.
   - Memory retrieval. With Postgres reachable this is canonical World Model lanes; otherwise the legacy Mind, PIC and evidence store, via `Brain.resolveReadMode`.
   - Project retrieval, optional web search, prompt assembly with untrusted-content fences.
   - Provider router (Gemini, Groq, OpenRouter, NVIDIA fallback).
   - A verification pass, persistence, then E6 extraction jobs to the worker: claims → contradiction, embedding, reflection.

---

## 2. Capability matrix

For each capability, the columns answer:

- **Impl**: is it implemented?
- **In flow**: is it connected to the real product flow?
- **Scoped**: is it authorized and scoped to the right user?
- **Tests**: are there meaningful tests?
- **Verified**: was it checked against the current code? "Today" means in this session.
- **User-ready**: is it ready for real users?

| Capability | Impl | In flow | Scoped | Tests | Verified | User-ready |
|---|---|---|---|---|---|---|
| Email signup and login | yes | yes | yes | static + unit | today | **Now yes.** Session fixation was fixed today. |
| Google OAuth (web) | yes | yes | yes | static | HISTORICAL | yes |
| Google OAuth (Android, external browser) | yes: one-time code + App Link + WebView redemption | yes | nonce-bound | `tests/auth/nativeOAuth.test.js` passes | code read today; device not tested | Needs a device test with a release-signed build. |
| Session persistence | 30-day rolling cookie, Mongo store with matching TTL, fails fast in prod without a store | yes | — | static | code read today | Yes. The "email sessions expire" report matches the old fixed 7-day expiry and an in-memory store, both of which have been replaced. |
| Chat with fallback | yes | yes | yes (conversation 404 guard) | many | battery today | Yes, within the free-tier capacity limits in B4. |
| Cross-conversation memory (legacy Mind) | yes | yes (fallback path) | yes | many | battery today | yes |
| World Model (canonical claims, supersession, disputes) | yes | yes, when Postgres is reachable | per user | many + live PG | battery today; quality HISTORICAL | **Not proven better than simple retrieval** (§3). |
| Forget / correct | yes | yes | yes | yes | battery today | On this branch yes; **not on production** (B2). Known gaps are in §4. |
| File upload: pdf, docx, pptx, xlsx, csv, odt, epub, md, txt, json, html, images, audio, video, zip, tar, tgz | yes | yes | conversation-scoped | parser baselines, zipGuard | battery today | Yes for text formats. Archives are bounded by zipGuard: ratio, entry-count and size limits. |
| Project (codebase) intelligence: index, query, call graph, patch/edit/checkpoint | yes | yes | workspace owner check | yes | battery today | Usable, but not differentiated (§ thesis). |
| Uploaded documents → World Model claims | yes (since 2026-10-11) | yes | per user | yes | HISTORICAL measure: file questions 3% → 73% | Partial. |
| Contradictions across documents | via the general contradiction policy | yes | per user | unit | **unmeasured end to end** | The landing claim was softened today. |
| Per-project scoping of the World Model | **no.** Claims are per user only. | — | — | — | VERIFIED (schema) | Blocks multi-client use cases. |
| Onboarding interview → "what I understand" card with correction | yes | yes (`/aqua/understanding/start`) | yes | vitest | code read today | yes |
| Billing (Razorpay prepaid credits) | yes | yes | owner-scoped, atomic, idempotent | partial | code read today | Yes. Signature compare is constant-time since today. |
| Product analytics | **no**, before today | — | — | — | — | Added today (§4). |
| Bundles (AI project-plan generator) | yes | linked only from `/bundles` | **was not** (IDOR) | none, before today | today | Demote. It does not serve the chosen product. |
| AI tools directory, blog, "write" | yes | URLs redirect | — | — | — | Legacy. Remove later. |

---

## 3. Does the core technology work? (evaluation evidence)

The held-out Lift v3 result is HISTORICAL. It comes from
`aqua/eval/out/lift-heldout-v3.{before,after}.json` and was reported in
`COMPLETION_PASS_2026-10-11.md`. The setup was 7 personas, 109 questions and a
blind Nemotron judge. The answerer and extractor were NVIDIA `gpt-oss-20b`.

| Condition (after fixes) | Strict correctness | Fabrication |
|---|---|---|
| Full conversation history in the prompt | **95.3%** | 3.3% |
| Simple BM25 memory (k=8) | 78.5% | 10.8% |
| **World Model** (the main architecture) | 73.4% | 18.2% |

How to read this:

- The World Model improved by 9.6 points over its own earlier version.
- It is **not** better than simple retrieval: −4.2 points, not significant.
- It fabricates more than simple retrieval.
- At these history lengths, pasting the full history wins.

The one experiment that could show an advantage is **v4** (long histories that
do not fit in context). Both v4 runs died when the laptop slept, and **v4 has
never completed**. Until it does, "better memory" is a hypothesis, not a moat.

---

## 4. Defects fixed in this session

Details, root causes and test commands are in `IMPLEMENTATION_LOG.md`.

| # | Severity | Defect | Fix |
|---|---|---|---|
| D1 | **High** (tenant isolation) | `resolveOwner` merged any `conv:` memory into the caller's memory whenever the request named that conversation. That happened in brain GET routes (`?conversationId=`), in `/intelligence/orchestrate` and in `/project/workspace`. Only `memory.js` guarded against it. So one account could absorb another conversation's orphaned memory and tombstone it. | The ownership rule is now enforced inside `resolveOwner`. 4 tests; failing before the fix, passing after. |
| D2 | **High** (tenant isolation) | `POST /bundle/:id/run` ran **any** user's bundle by id (`findById`) and returned its contents. | Ownership check added; route is now rate-limited and metered. |
| D3 | **High** (cost / abuse) | `POST /generate-bundle` called the LLM for **anonymous** callers, with no rate limit. `/execute-step` and `/bundle/:id/run` were free for any account. | All three now require login, the engine limiter and credits. A static invariant test covers every LLM-spending route. |
| D4 | **Medium** (auth) | Email login and signup reused the pre-login session id: session fixation. The CSRF token always creates a session before login. | `establishSession` regenerates the session. Google paths already did this via Passport. |
| D5 | **Medium** (availability) | The 50 MB JSON parser ran globally and before authentication. | Non-engine routes get 1 MB. The 50 MB parser runs only after `requireLogin` on the engine mounts. |
| D6 | Low (auth) | Login said "User not found" for unknown emails, so the form revealed which emails have accounts, on a raw text page. | One message for both cases, rendered on the form. Signup errors are rendered on the form too. |
| D7 | Low (billing) | Razorpay signatures were compared with `===`. | `crypto.timingSafeEqual`, with tests. |
| D8 | Medium (trust) | The pricing page advertised code, image and app generation, deep research and "multi-agent orchestration". None of these is metered or offered. | It now lists only metered actions. A test ties the page to the usage guards. |
| D9 | Medium (trust) | The landing hero example cited "two files have changed" and "Priya asked in Tuesday's thread", which imply Git and Slack integrations that do not exist. | Rewritten to the chosen promise, with an example the welcome line can actually produce. |
| D10 | Medium (process) | The root `tests/` directory (CSRF, OAuth, sessions, account deletion, launch safety) was run by **neither** `npm test` nor CI. Three of its tests had gone stale without anyone noticing. | Added `npm run test:platform` and the `platform-tests.yml` workflow (every PR). Stale assertions were updated to the current code with the same intent. |

---

## 5. Credential inventory (redacted)

Method: a script compared the values in today's `.env` against the full text of
the four exposure commits and printed **only** key names. It is at session
scratchpad `cred-exposure.mjs`; values never left the process.

| Credential | Still current and exposed? | Impact if abused | Remediation |
|---|---|---|---|
| `MONGO_URI` (Atlas user + password) | **yes** | Read and write **all user accounts and sessions**. Session ids in the store plus `SESSION_SECRET` means account takeover. | New Atlas DB user, delete the old one, IP allow-list, review the access log. |
| `SESSION_SECRET` | **yes** | Forge signed session cookies. | New value. This logs everyone out, which is acceptable. |
| `GOOGLE_CLIENT_SECRET` | **yes** | Impersonate the OAuth client. | Reset it in Google Cloud Console. |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | **yes** | Live payment API access. | Regenerate the key pair; review payments. |
| `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` | yes, but the 2026-10-15 probe found these three **rejected** by the providers | likely none now | Delete them from `.env`. |
| `OPENROUTER_API_KEY_1..4` | **yes. They authenticated on 2026-10-15.** | Spend on your account. | Revoke and reissue. |
| `SERPER_API_KEY` | **yes** | Search quota. | Revoke and reissue. |
| `UNLIMITED_USER_EMAILS` | yes (not a secret, but exposed) | Reveals which accounts have unlimited credits. | Change it after rotation. |
| Keys exposed earlier but no longer in `.env` (other Groq, Gemini and OpenRouter keys, `HF_API_KEY`, `TOGETHER_API_KEY`) | HISTORICAL | — | Revoke them at each provider. |

**Not exposed** in those commits: `GEMINI_KEY_1..12`, `GROQ_API_KEY_1..5`,
`NVIDIA_API_KEY_1..5`, `SERPER_API_KEY_1..4`, `TAVILY_API_KEY_1..4`,
`HF_TOKEN`, and `DATABASE_URL` (which is local only).

Deleting a value from a file does not remove it from Git history. Fix it in
this order:

1. Rotate every exposed secret.
2. Make the repository private.
3. Optionally rewrite history with `git filter-repo` and force-push. This is destructive and needs coordination.

None of this was done in this session; it all needs your accounts and approval.

---

## 6. Test and gate status (run today)

| Suite | Command | Result |
|---|---|---|
| Aqua battery: live Postgres :55432 + Redis :56379, disposable | `node aqua/scripts/run-tests.mjs` with test DB env | **4,370 tests: 4,366 pass, 0 fail, 4 skipped** |
| Platform battery (root `tests/`) | `npm run test:platform` | **234 tests: 233 pass, 1 fail.** The failure is `repoHygiene`: three gitignored `*.patch` files at the repo root, one of them yours from today. It is local only, since CI checkouts do not contain them. |
| Frontend | `npx tsc -b`; `npx vitest run` | tsc clean; **117/117** |
| Eval regression gate | `cd aqua && DATABASE_URL= npm run eval:gate` | **PASS** (all gates) |
| Eval gate with `DATABASE_URL` set | same, with the test DB | **BLOCKED.** context-core and context-dense-v3 drop to 0. This is not a regression: with a database, the read path is canonical-only, and the gate's fixtures only populate legacy stores. **Finding: the context gates do not measure the production read path.** |
| Analytics end to end | seeded the disposable Mongo :57017, then ran `scripts/activation-report.mjs` | Numbers match the seeded truth exactly. |

Not run: Playwright e2e, the Android release check, a real-provider Lift, and a live-provider product journey. These need provider quota and the founder's environment.

---

## 7. Remaining risks and known gaps (not fixed today)

1. **The differentiation is unproven** (§3). This is the largest company risk, not an engineering bug.
2. **The World Model has no per-project scoping.** Two clients' facts share one user world.
3. Deletion gaps (HISTORICAL, 2026-10-12):
   - graph-node deletions;
   - beliefs re-derived from claims;
   - past deletions are not applied retroactively to derived stores;
   - the `.aqua-reasoning-graph.json` and `.aqua-ids.json` two-process race.
4. Whole-file JSON stores are written by two processes (server and worker). Only the Mind store has merge-on-flush.
5. Content-Security-Policy is deliberately off (helmet comment). An XSS-hardening pass is needed.
6. Password minimum is 6 characters and there is no email verification. Free daily credits plus open signup is an abuse vector.
7. `/v1/*` POSTs go through the form-token CSRF path, not the Origin check (`verifyCsrf` skips only `/api/`). Nothing calls `/v1` today.
8. The platform rate limiters are per instance (memory store) unless a Redis store is configured.
9. Legacy surfaces (bundles, tools directory, blog, `write`) enlarge the attack surface while serving no user of the chosen product.
10. About 70 historical root `*.md` reports contradict each other. This audit and the thesis supersede them for current state.

---

## 8. Findings added 2026-10-16/17 (session 2)

| # | Severity | Finding | Status |
|---|---|---|---|
| F1 | High (validity) | The eval gate measured only the legacy read path; with a database, its context suites read 0. | **Fixed.** Mode is explicit, the database comes only from `AQUA_TEST_DATABASE_URL`, and the new `context-canonical` gate measures the production read. |
| F2 | High (product) | The canonical read path (production with Postgres) carries **153 noise lines and 0.34 unknown honesty**, against 18 and 0.72 on the legacy path, over the same 200 queries. | **Measured and gated, not fixed.** This is the main quality gap. |
| F3 | Medium | Prompts and retrieval were nondeterministic (random UUID tie-breaks), so the same world gave different context and the extraction cache missed. | **Fixed** (content tie-breaks; proven across processes). |
| F4 | Medium | E10-migrated legacy facts become `extracted / unresolved` claims that no canonical read returns. | **Open.** Matters for any production read-mode switch. |
| F5 | High (data loss) | Extraction under a brief provider rate limit was dead-lettered after about 30 s, and the user's statement was lost. | **Fixed** (capacity backoff) and in the RC. |
| F6 | High (trust) | The Memory page showed the legacy store, not what answers; deletion missed sibling claims, subject names and legacy role slots. | **Fixed on this branch** (Memory "What Aqua knows now", per-claim forget/correct, veto). Not in the RC: it depends on the authoritative read mode. |
| F7 | Medium (billing) | `refund()` minted credits on every call; failed uploads and bundle steps were never refunded. | **Fixed**, in the RC. |
| F8 | Medium (usability) | Reads exhausted the 30/min message limit, so the next chat message failed. | **Fixed**, in the RC. |
| F9 | Low (isolation) | `intro/complete` wrote its marker onto any conversation id. | **Fixed**, in the RC. |
| F10 | Low (a11y) | Duplicate `#aqua-sidebar-search` on phones; focus lost after the artifacts panel or drawer closed. | **Fixed**, in the RC. |
| F11 | Medium (product) | A compound change ("moved the launch to May 2 **and** the price is now $39") keeps only one of its two changes. | **Open** (extraction quality). |
| F12 | Low (UI) | Narrow-viewport markdown tables split words and keep headers in stacked layout (dev spec 28/42). | **Open.** |
| F13 | Process | `main`'s test runner on Windows exits 0 having run nothing. | **Fixed** in the RC (runner ported). |

