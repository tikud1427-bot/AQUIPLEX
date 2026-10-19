# World Model — validation, data integrity and production readiness (2026-10-18 → 10-19)

Labels used throughout:

- **VERIFIED**: checked in this pass, with the command or output named.
- **MEASURED**: a number produced in this pass.
- **HISTORICAL**: a number from an earlier pass, not re-measured.
- **ESTIMATE**: reasoning, not measurement.
- **HYPOTHESIS**: unconfirmed.

Nothing in this pass was committed, pushed or deployed. No credential was rotated. No production
system was touched.

## 0. Short version

- **v4 and the final answer-level evaluation still have not run.** Both VM kits re-verified today
  (VERIFIED); they wait on a VM. No v4 answer, grade or per-question output has been seen.
- **Fixed and tested:**
  - **Background understanding is now idempotent.** Retries no longer add a second reading. Ten
    live tests cover every retry scenario the brief lists.
  - **Duplicate detection is bounded.** At 20,000 claims in one bucket: 46 ms against 553 ms, 200
    candidates against 20,000, 1.5 MB heap against 25 MB.
  - **Who-did-what:** a targeted extraction retry when a named actor is dropped.
- **Two defects found by this pass's own test runs, and fixed:**
  - Migration 0025 did not run on the in-memory Postgres harness. This cancelled 174 core tests.
  - Memory-page corrections printed retyped words twice ("clinics clinics").
- **Test state (MEASURED):**
  - aqua battery: 4455/4459 passed, 0 failed, 4 skipped (documented environment skips);
  - platform suite: 246/246 on a clean export;
  - frontend: 117/117;
  - eval gate: PASS (18 suites with a database, 16 without);
  - founder journey: 22/23.
- **Security:**
  - Correction to the 10-18 report: production `main` **does** contain the 10-15 security fixes.
  - Seven further fixes are uncommitted.
  - **18** credentials (not 17) in public git history are identical to current values. The
    18th, newly found, is the Razorpay **webhook** secret. It is P0: it can forge payments.
  - **New, unfixed, in production:**
    - pre-account takeover: unverified email signup plus Google login by email;
    - unlimited-credit bypass via the public allowlist.
- **Superiority:** no claim can be made. The controlled answer-level evaluation that would decide
  it has not run.

---

## 1. Repository state (VERIFIED 2026-10-19)

| | |
|---|---|
| Branch | `aquiplex/world-model-pass2`, HEAD `e64f26cb` (= `origin/aquiplex/world-model-pass2`) |
| Remote `main` | `4c093395` (merge of PR #1, 2026-10-15). `git ls-remote` today. Its **tree is identical to `e64f26cb`'s** (`79520d21`) |
| Uncommitted | 56 tracked files modified (+2,363 / −166), 33 untracked files. `git diff origin/main` = `git diff HEAD`: this tree **is `main` plus the uncommitted work** |
| Backup | `C:\Users\dell\AppData\Local\Temp\claude\c--Users-dell-Downloads-aquiplex-platform-aquiplex-platform\0d4859f7-01e8-485c-bd3c-a854dc25c459\scratchpad\wip-2026-10-19.patch` (reverse-applies cleanly) and `…\scratchpad\wip-untracked-2026-10-19.tgz` (33 files) |
| Older RC | `release/rc-2026-10-16` / `hotfix/2026-10-12-auth-memory-safety` (`6dea686e`, local only, not pushed). Their patch does **not** apply cleanly to current `main` (conflicts in `IntroPage.tsx`, `run-tests.mjs`, `ownerResolver.js`, `index.js`, `package.json`). The release path is this working tree, not that branch |
| Local `main` | `54c8de96`, behind `origin/main`; not used |
| Untracked local residue | `aqua-latex-fix.patch`, `aquiplex-stream-finalization-fix-20260929-portable.patch`, `gemini-3.6-flash-migration.patch` at the root: gitignored, never in history, dated 09-29 / 10-01 / 10-15. Left in place (not mine to delete) |

## 2. Defects fixed in this pass

| # | Defect | Evidence before | After |
|---|---|---|---|
| D1 | **Retried understanding added a second reading.** A segment whose first reading committed nothing wrote no ledger row, so a retry (cold extraction cache, different model reading) committed claims the first application never had | MEASURED 10-18 in `idem-probe.mjs` | A segment is ledgered once it has been **validated**, even when its successful reading was empty. A reading whose every claim fails validation is a failed reading: not ledgered, so the retry applies |
| D2 | **Concurrent first commit failed** with a unique violation on `aqua_sources_id_owner_uq` (two workers, same turn) | MEASURED, `conc-probe.mjs` | `INSERT INTO aqua_sources … ON CONFLICT DO NOTHING` (both insert sites); the ledger decides which reading wins |
| D3 | **S8 duplicate detection loaded all history**: 553 ms and 25 MB heap per segment at 20k claims in one bucket; unbounded | MEASURED (§4) | Bounded history (newest 200 current claims per (entity, predicate) bucket, plus exact identity, roles and text). Rules that need a complete bucket **abstain** when it was cut, instead of deciding on a partial view |
| D4 | **A named actor was dropped**: "Kofi is helping me build Atlas" → only (self, builds, Atlas) | MEASURED: 13/15 baseline battery, Kofi reproduced; again 1 of 3 today | Actor retry: code asks the model once more, naming the missing person; only claims about that person are added |
| D5 | **Migration 0025 broke the in-memory test harness** (pg-mem lacks `<> ALL (ARRAY…)` and `btrim`): 4 failed + 174 cancelled core tests | MEASURED today, `core.log` | Predicate written `NOT IN (…)`; harness registers `btrim` with Postgres semantics. On real Postgres the stored index definition is **byte-identical** (`state <> ALL (ARRAY['superseded'::text, 'archived'::text])`, VERIFIED via `pg_indexes`) |
| D6 | **Memory-page correction garbled the sentence**: "…is that clinics **clinics** not finishing onboarding" (live journey run 5). The stored value was correct; the displayed statement was not | MEASURED | `substituteValue` drops the words before the old value that the new value repeats |

Defects found and **not** fixed (§10, §13):

- validation drops an actor's claim after the retry has looked;
- the provenance answer calls the founder's own message an "internal note";
- one intermittent timing test.

## 3. Files and functions changed (this pass)

**World Model storage**

- `aqua/src/core/worldModel/worldModelRepository.js`:
  - `findClaimsForDedup` (mode `bounded` | `full` | `compare` from `AQUA_S8_HISTORY`);
  - `boundedDedupCandidates`: ① exact identity (UNION, index-friendly), ② newest-N per (entity,
    predicate) on the subject and object sides, ②′ same-kind attribute rivals, ③ `related_to` roles,
    ④ text candidates; it returns a non-enumerable `truncation` record;
  - `dedupRows`;
  - both `aqua_sources` inserts use `ON CONFLICT DO NOTHING`.
- `aqua/src/core/db/migrations/0025_dedup_bounded_history.sql`: three additive indexes, no table or
  constraint change (`aqua_claims_subject_recent_idx`, `aqua_claims_object_recent_idx`,
  `aqua_claims_exact_literal_idx`).

**Understanding pipeline**

- `aqua/src/brain/understanding/claimDedup.js`:
  - truncation guards (`cut.soleValue / subjectAndText / roles / text`): abstain with
    `history-truncated:<kind>`;
  - `ACTIVITY_PREDICATES` (responsibility-ended rule);
  - plan-cancelled rule matches the cancelled thing's subject.
- `aqua/src/brain/understanding/pipeline.js`:
  - `completedSegments`, recorded after S4/g8 validation;
  - `uncoveredActors`, `actorRetryEnabled`, `mergeActorRetry`, plus the retry block.
- `aqua/src/brain/understanding/extractionClient.js`: `actorHint` is part of the extraction cache
  key and is passed to the prompt.
- `aqua/src/brain/understanding/extractionPrompt.js`: actor note, appended only with a hint. The
  prompt without a hint is byte-identical to before.
- `aqua/src/brain/index.js`:
  - S8 history arguments (`sameKind`, stored vocabulary), passing `truncation`;
  - compare mode and the `s8HistoryCompare` counters;
  - the commit ledgers `completedSegments`;
  - `substituteValue`.

**Flags**

- `aqua/src/core/flags.js`: `AQUA_E6_ACTOR_RETRY` (gate, default on) and `AQUA_S8_HISTORY` (setting,
  default bounded).
- `src/core/tests/flagRegistry.test.js`: the census, now 35 gates and 45 settings.

**Tests and fixtures**

- `aqua/src/core/tests/helpers/memoryPg.mjs`: `btrim(text)`.
- New tests:
  - `src/core/tests/dedupBoundedHistory.live.test.js` (7 scenarios, full vs bounded);
  - `src/brain/tests/understandingIdempotency.live.test.js` (10);
  - `src/brain/tests/actorRetry.test.js` (6);
  - `src/brain/tests/substituteValue.test.js` (6).
- Extended: `claimDedup.test.js` (76).
- Updated source-shape contracts: `provisionalMinter.test.js` and
  `e6WorldModelIntegrationContract.test.js`. The early return now also ledgers empty but validated
  segments.
- Eval data: `eval/fixtures/retrieval-heldout.e6-replay.v1.json` re-recorded (46 calls, 0 failures);
  `eval/baselines/context-canonical-heldout.v1.json` re-baselined, with a note.

**Documents**

- `PILOT_FOUNDER_SESSION_PROTOCOL.md` (new).

## 4. Correctness and performance, before and after (MEASURED unless marked)

**Duplicate detection at scale** (`eval/out/s8-scale.mjs`, test DB, 2026-10-19; output
`…\scratchpad\s8-scale-2026-10-19.jsonl`; time = history load + S8 per segment):

The "worst" shape puts every claim in one bucket; the "spread" shape distributes them over subjects
and predicates.

| shape, claims | full: candidates / queries / ms / heap | bounded: candidates / queries / ms / heap | truncated |
|---|---|---|---|
| worst, 1k | 1,000 / 1 / 46.6 / 3.8 MB | 200 / 7 / 28.7 / 1.8 MB | yes |
| worst, 5k | 5,000 / 1 / 166.6 / 14.9 MB | 200 / 7 / 28.7 / 1.5 MB | yes |
| worst, 20k | 20,000 / 1 / **553.4** / 25.3 MB | 200 / 7 / **46.0** / 1.5 MB | yes |
| spread, 1k | 250 / 1 / 17.7 / 0.7 MB | 25 / 7 / 17.1 / 0.3 MB | no |
| spread, 5k | 1,250 / 1 / 47.3 / 2.0 MB | 125 / 7 / 24.5 / 0.9 MB | no |
| spread, 20k | 5,000 / 1 / 158.7 / 16.1 MB | 200 / 7 / 52.3 / 1.4 MB | yes |

- Bounded cost is flat in history size. Its price is seven small indexed queries instead of one
  large one. At small history, bounded is no faster (spread 1k: 17.1 vs 17.7 ms).
- **No new database or index service.** Postgres with three partial indexes meets the requirement.

**Accuracy of bounded vs full:**

- **106 real segments** from the dev and held-out worlds, replayed through the production path with
  `AQUA_S8_HISTORY=compare`: **0 decision differences**. Re-measured today, `s8-compare.mjs`.
- Caveat: these worlds are small (mean 3 history rows; bounded mean 1 candidate). This shows the
  bounded path changes nothing at today's scale. It does not show equivalence at large scale.
- Large scale is covered by 7 live scenarios (`dedupBoundedHistory.live.test.js`). Where the bucket
  was cut, a rule that needs the whole bucket abstains (`history-truncated:*`) rather than
  superseding on a partial view.
- Cost of abstaining: an update in a bucket above 200 current claims becomes a possible conflict
  for later resolution rather than an immediate supersession. That is safe, but not free.

**Idempotency** (`understandingIdempotency.live.test.js`, 10/10, live Postgres):

| Scenario from the brief | Test | Result |
|---|---|---|
| repeated processing | same source three times, with different readings | state after the first application unchanged; ledger 2 |
| retry after partial persistence | segment 2 errors; the retry re-reads segment 1 differently | segment 2 applied; segment 1 **not** re-applied (no `Fly.io`) |
| crash after extraction (before commit) | provider error / failed reading | not ledgered; the retry applies it exactly once |
| crash after some writes | a constraint fails on the 2nd claim of a segment | claims, evidence **and** ledger roll back together; the retry applies once; a further retry is skipped |
| concurrent retries | two workers, two valid but different readings | exactly one reading per segment |
| empty but successful reading | `[]` first, real claims on retry | the first (empty) application is final |
| invalid reading | every claim fails validation | not ledgered; the retry applies |
| deletion during retry | user archives a claim between attempts | stays archived |
| **correction** during retry (new today) | user corrects Render → Vercel between attempts | Vercel stays current; the failed segment is still applied |
| **duplicate events with distinct meanings** (new today) | the same words in two turns, different readings | both applied: idempotency is keyed by source and segment, not by text |
| restatement | the same sentence and reading in a new turn | one claim, evidence from both turns |

The concurrency test runs both attempts in one process. Separate workers do not share the in-memory
extraction cache, which makes them strictly easier than this test.

**Who-did-what** (live Groq `gpt-oss-120b`, development batteries; each run is noisy):

| run | result |
|---|---|
| attribution battery, before | 13/15 (Kofi dropped; "I help Maria with her thesis" credited to the user as owner) |
| attribution battery, after | 12/15. Different failures: Fennel (provider rate limit), Omar (no `role` claim), Maria (unchanged). None is an actor-retry case |
| actor battery (12 "X is helping me…" sentences), retry off / on | 11/12 vs 11/12. The retry fired 3× in 36 readings across runs, recovered 3, added 0 wrong claims |
| raw-reading probes today, 2 × 9 readings (`raw-probe.mjs`) | **Kofi**: misattributed in 1 of 6 readings → retry fired → `kofi builds atlas` recovered. **Jun**: in **3 of 6** readings the raw reading named Jun, so the retry correctly did not fire, and then S4 discarded the claim (object "help me prepare…" is not in the sentence's "helping me prepare…"). **Fennel**: 4 of 6 lost to `transport: All Groq keys rate limited or cooling down`, after 8 calls across the 5 free key slots |

- **Verdict:** the retry repairs the failure it targets and has added nothing wrong.
- **Not shown:** a run-level improvement. At this sample size the model's run-to-run variance is as
  large as the effect.
- **Larger remaining loss:** validation discarding the actor's claim *after* the retry's coverage
  check. It is more frequent than the misattribution the retry fixes (3/6 vs 1/6 on these
  sentences). Open (§13).

**Retrieval and state** (held-out set, DEVELOPMENT data; deterministic replay, re-recorded after the
fixes):

| metric | result |
|---|---|
| changes applied as supersessions | 10/10, 0 wrong |
| stale leaks | 1/16 |
| V3 recall@8 | 0.893 |
| MRR | 0.811 |
| top-1 | 0.750 |
| unknown-honesty | 0.615 |
| noise lines | 24 |

**Founder journey** (`scripts/e2e-founder-journey.mjs`, the real launcher on local test stores, live
providers): **22/23** (HISTORICAL 21/23 on 10-17).

- Latency, 8 chat turns: p50 4.6 s, p90 9.8 s.
- Time from saying a fact to it reaching memory: onboarding plus upload 97 s; a change 27 s.
- 0 dead jobs.
- The failure is provenance (§10).

## 5. Tests run (MEASURED 2026-10-19, after all fixes)

| Suite | Command | Tests | Pass | Fail | Skip |
|---|---|---|---|---|---|
| aqua, per directory, live Postgres + Redis | `batch-battery.sh` (`run-tests.mjs` per `src/*`, `eval/`) | 4,459 | 4,455 | **0** | 4 |
| aqua `npm test`, all files in one parallel run, no DB | `npm test` in `aqua/`, 3 runs | 4,263 | 4,247 / 4,248 / 4,248 | **1** / 0 / 0 | 15 |
| platform | `npm run test:platform`, clean export of this tree | 246 | 246 | 0 | 0 |
| platform | same, in the checkout | 246 | 245 | 1 | 0 |
| frontend | `vitest run`; `tsc -b && vite build` | 117 | 117 | 0 | — |
| eval gate, with DB | `npm run eval:gate` | 18 gated | 18 PASS | 0 | 3 no baseline, 1 ungated |
| eval gate, no DB | same | 16 gated | 16 PASS | 0 | 2 not run (need Postgres) |

**Skips:**

- 4 per-directory: pg-mem cannot enforce a partial unique index or roll back (the real-Postgres
  versions run in the live suites), and Windows has no in-process SIGTERM, which 2 deploy-survival
  tests need.
- 15 without a DB: live suites, each skipped with a reason.

**Every failure, investigated:**

- **`perf shape — LINEAR work passes`**: 1 of 3 full parallel runs, measured 2.53× against a 2.5×
  ceiling.
  - Its workload is a fixed arithmetic loop with no repository code, so no change in this tree can
    affect it.
  - Reruns, ratio: alone 1.75–2.02 (10 runs); with 8 busy processes ≤ 2.28 (10); with 16 busy
    processes ≤ 2.29 (24, best-of-2 and best-of-5 alike).
  - It passed in the other 2 full runs and in every per-directory run.
  - **Classified:** intermittent, caused by scheduling when the whole suite runs in parallel. Not a
    regression.
  - **Not "fixed"** by raising the ceiling: that would weaken the test. Recommendation: run perf
    tests serially (§13).
- **Platform `build residue does not accumulate at the root`**: the three gitignored local `.patch`
  files (§1). Baseline reproduced: the same tree exported without ignored files passes 246/246.
- **Earlier today, fixed:** migration 0025 on pg-mem (D5), and two stale source-shape contracts.
  Before the fix: 4 failed and 174 cancelled in `src/core`; after: 841/845, 0 failed.

**Lint:** `src/` is clean. The 2 ESLint errors are in generated Android build output
(`aqua-frontend/android/app/build/intermediates/**/native-bridge.js`).

**Not run:**

- Playwright browser e2e (needs a running stack and browsers; last run 10-17).
- The live-provider eval suites outside the gate.

## 6. v4: validity and decision

- **Status: NOT RUN. No valid run exists.** HISTORICAL: attempts 1–4 crashed. Attempt 4 died when
  the machine was put to sleep on 10-17. Under the preregistration a crash voids a run.
- **Integrity (VERIFIED today):**
  - the kit at `C:\Users\dell\aquiplex-vm-kits\v4-vm-kit\` passes its `MANIFEST.sha256`, 7/7 files;
  - its archive is tree `aadda450`;
  - the frozen dataset `aqua/eval/lift/world-model-lift-heldout.v4.json` is sha256 `86c4f7ba…`, as
    registered;
  - `out/` is empty: nothing has run, nothing has been read.
- **Decision: none possible.** The registered decision rule is applied only to
  `out/lift-v4.prereg.json` after a complete run. No work in this pass used v4 data.
- **Exact procedure** (Ubuntu 22.04/24.04 VM, Docker, 4 vCPU, 8 GB; outbound HTTPS to NVIDIA and
  Google only; no route to production):

```
# on your machine — the script writes only the key slots the run needs; never commit secrets.env
./make-secrets-env.sh /path/to/aquiplex-platform/.env > secrets.env && chmod 600 secrets.env
# copy v4-vm-kit/ (with secrets.env) to the VM, then on the VM:
chmod +x run-v4.sh make-secrets-env.sh
./run-v4.sh check      # manifest, archive = aadda450, dataset sha, npm ci, schema — no keys used
./run-v4.sh smoke      # one persona, throwaway DB — proves keys and network
./run-v4.sh v4         # the registered run, detached, no restart policy (a crash = void run, as registered)
./run-v4.sh status     # repeat until exit=0; then copy out/ back
```

Keep the VM on mains power, with no sleep and no auto-update reboot for the duration (several hours).

## 7. Final answer-level evaluation: validity and decision

- **Status: NOT RUN.**
- **Integrity (VERIFIED today):**
  - the kit at `C:\Users\dell\aquiplex-vm-kits\final-vm-kit\` passes its manifest, 9/9 files;
  - the frozen set `aqua/eval/lift/world-model-final.v1.json` is sha256 `b20c331d…`;
  - `out/` is empty.
- **Not tuned against:** no file in this pass read the final set. It was authored by an isolated
  agent and frozen on 10-18.
- **What it will measure:** the registration (`PREREG-final-2026-10-18.md`) fixes two trees and
  forbids any code change before both runs end:
  - "current" = `aadda450`;
  - "improved" = the **10-18 snapshot** (manifest `bc89f710…`, schema 24).
- **Consequence:** this pass's changes (bounded S8, idempotency, actor retry, D5, D6) are **not**
  what it measures. That is correct under the protocol.
  - Measuring today's tree needs its own registered run **after** this one completes.
  - That registration must be written before any result is seen. A different set would be cleaner,
    since this one will then have been scored.
- **Second judge and the 60-item blinded human sheet:** prepared in `aqua/eval/lift/finalAnalysis.mjs`;
  they run only on the two output JSONs. Not run.
- **Exact procedure** (after v4's `status` shows `exit=0`; never concurrently, since they share the
  NVIDIA keys):

```
cd final-vm-kit && chmod +x run-final.sh make-secrets-env.sh
cp ../v4-vm-kit/secrets.env . && chmod 600 secrets.env
./run-final.sh check     # hashes, npm ci, schema 24/24 for both trees — no keys used
./run-final.sh final     # both registered runs, sequentially, detached
./run-final.sh status    # until both show exit=0   (after a VM restart: ./run-final.sh resume)
# copy out/ back, then ./run-final.sh teardown. Locally, only after both JSONs exist:
cd aqua
I=../out/improved/final.improved.json; C=../out/current/final.current.json   # wherever you copied out/
node eval/lift/finalAnalysis.mjs endpoints    $I $C --out final-endpoints.json
node eval/lift/finalAnalysis.mjs second-judge $I $C --out judge2.json
node eval/lift/finalAnalysis.mjs human-sheet  $I $C --out sheet.csv --key key.json   # 60 blinded items; do not open key.json
# after you grade sheet.csv (1 = correct, 0 = not) and save it as sheet-graded.csv:
node eval/lift/finalAnalysis.mjs human-agreement sheet-graded.csv key.json $I $C
```

## 8. World Model vs memory, history and hybrid

**No answer-level comparison exists.** The conditions are registered and the runs are packaged (§7),
but nothing has been measured:

- `history`: the production 12k window;
- `fullHistory`;
- `memory` / `memoryMatched`: BM25;
- `wm-current`, `wm-improved`, `hybrid-improved`.

What can be said:

- **State tracking** (MEASURED, development data): changes are applied as supersessions, with the
  old values kept as history (10/10, 0 wrong). Neither raw history nor BM25 has an equivalent
  mechanism. Whether that produces better *answers* is exactly what E1–E3 test.
- **Abstention** (HISTORICAL 10-18): the canonical read returns nothing for 62% of unanswerable
  held-out questions, against 19% before.
- **Not supported:** "Aqua is superior to memory, history or ChatGPT/Claude/Gemini". Do not use it.

## 9. Security exposure and remediation

**Release state, corrected:**

- Production `main` (`4c093395`, tree identical to `e64f26cb`) **contains** the 10-15 fixes:
  - owner-adoption guard;
  - session fixation;
  - bundle IDOR;
  - anonymous LLM spend;
  - pre-auth body limit;
  - Razorpay timing-safe compare.
- The 10-18 report said otherwise; that was wrong. VERIFIED by tree hash, and by the same code
  present in `origin/main`.
- What production *runs*: **unverified.** I have no Render access and cannot see which commit is
  deployed or its environment overrides.

**Security fixes still uncommitted** (all in this tree, all tested):

| Fix | File | Risk if missing |
|---|---|---|
| Intro marker only on the caller's own conversation | `aqua/src/understanding/understandingRoutes.js` | any account can write a marker onto another account's conversation (cross-account write) |
| Refund at most once per request | `middleware/usage/checkUsage.js` (`onceOnly`) | two failure paths each refund: free credits |
| Refund on any failed request | `middleware/usage/usageGuard.js` (`refundOnFailure`) | uploads and bundle errors charge without delivering |
| Read limiter (300/min) separate from the 30/min spend limiter | `index.js` | page loads exhausted the spend limiter (429 on chat); unauthenticated GET floods were bounded only by the spend limiter |
| Capacity backoff for jobs | `aqua/src/core/jobs/jobQueue.js` | provider 429s burn job attempts into dead jobs |
| Plural first person routes to the user's own company | `aqua/src/identity/identityRouter.js` | "our price" answered from Aquiplex's own profile |
| Memory controls reach every store; per-claim forget/correct endpoints, owner-scoped (404 for others) | `aqua/src/memory/forget.js`, `aqua/src/routes/brain.js` | a deleted fact answers again from a sibling store |

- **Compatibility with `main`:** total. This tree is `main` plus these changes (§1). They ship as a
  normal PR from this branch.
- **Tests that must pass before merge:**
  - `tests/platform/creditRefund.test.js`;
  - `src/understanding/tests/introGate.test.js` (cross-account case);
  - `src/identity/tests/identityLayer.test.js`;
  - `src/memory/tests/forgetClaim.live.test.js`;
  - `src/core/tests/jobQueue.test.js`;
  - the full battery and the gate (§5).

**Credential exposure (VERIFIED by name and hash only; no value printed or copied):**

- The `.env` committed in `8da8e11b` ("Initial commit") is in public history. Comparing sha256 of
  each history value with the current `.env`:
  - **29 identical names**, of which 18 are credentials or sensitive configuration;
  - **12 changed** (`GEMINI_KEY_1…8`, `GROQ_API_KEY_1…4`);
  - **2 only in history** (`HF_API_KEY`, `TOGETHER_API_KEY`).
- Changing `.env`, rewriting history or making the repository private does **not** invalidate any of
  these. Only the provider can revoke them.

**Prioritized rotation plan.** Nothing below has been done. Each step needs your explicit approval and
is done by you in the provider console and in Render.

| Pri | Credential (category) | Service / consumers in code | What an attacker can do | Procedure | Dependent config | Verify | Rollback |
|---|---|---|---|---|---|---|---|
| **P0** | `RAZORPAY_WEBHOOK_SECRET` (payment webhook) | Razorpay → `services/billing/razorpay.service.js` (webhook signature) | forge "payment captured" events: mint credits, mark orders paid | Razorpay Dashboard → Webhooks → edit the webhook → new secret | Render env `RAZORPAY_WEBHOOK_SECRET`; redeploy | dashboard "test webhook" → 200, signature accepted; a forged event with the old secret → rejected; `tests/platform/webhookSignature.test.js` | the old secret is invalid once changed: if verification fails, set a new one again (do not revert to the exposed one). Also review webhook-credited orders since 2026-09 |
| **P0** | `RAZORPAY_KEY_SECRET` (+ `RAZORPAY_KEY_ID`, public) | `razorpay.service.js` (orders, signature verify); key id in `views/pricing.ejs` and `utils/startup.js` | create orders and refunds, read payment data via the API | Dashboard → API Keys → Regenerate (live mode). The old key stops working; schedule a few minutes' checkout downtime | Render `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` together; redeploy | one ₹1 live test order end to end, plus its refund; checkout loads the new key id | if checkout fails: regenerate again and re-enter (the exposed pair is gone). Review API logs for unknown refunds and payouts |
| **P0** | `MONGO_URI` (primary database credential) | `index.js` (mongoose), `aqua` Mongo mirror | read and modify every user's data | Atlas → Database Access → create a new user and strong password → new URI → (after verification) delete the old user. Also Network Access: remove `0.0.0.0/0` if present | Render `MONGO_URI` (web and worker); redeploy | `/health`; login; chat persists; no `[MIRROR]` auth errors in logs | keep the old user until verification passes (revert the env var); then delete it. Review Atlas access logs |
| **P0** | `SESSION_SECRET` (session signing) | `index.js` (`express-session`, single secret) | forge session cookies: log in as any user | generate 32+ random bytes; set in Render; redeploy. **Everyone is logged out once** (the code takes one secret) | Render `SESSION_SECRET` | an old cookie → logged out; a fresh login works | revert the env var (forgery stays possible). Optional code change, not made: accept `[new, old]` for a soft cutover |
| **P1** | `GOOGLE_CLIENT_SECRET` (+ `GOOGLE_CLIENT_ID`, public) | `index.js` (passport Google OAuth) | impersonate the app in OAuth flows | Google Cloud → Credentials → OAuth client → add a secret → deploy with it → disable and delete the old one | Render `GOOGLE_CLIENT_SECRET`; redeploy | sign in with Google end to end | re-enable the old secret in the console (it is listed until deleted) |
| **P1** | `OPENROUTER_API_KEY_1…4` (paid LLM) | `aqua` provider key pool (`providers/keyPool.cjs`) | spend on your account | OpenRouter → Keys → create new → swap → revoke old. **HISTORICAL 10-15: these four were VALID** | Render `OPENROUTER_API_KEY_1…4` | `keyPool` startup diagnostics show the slots accepted; one chat turn | keep the old key until the new one answers; then revoke |
| **P2** | `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `SERPER_API_KEY` (unnumbered) | key pool, `ai.client.js` (Serper) | spend / quota abuse | HISTORICAL 10-15 probe: the unnumbered keys were **rejected** (likely already revoked). Confirm in each console that the exposed key is revoked; if not, revoke | none (the numbered slots serve) | the console shows the key revoked or deleted | n/a |
| **P2** | `GEMINI_KEY_1…8`, `GROQ_API_KEY_1…4` (old values), `HF_API_KEY`, `TOGETHER_API_KEY` | none now (values changed or removed) | spend, if not revoked | confirm in each console that the old keys are revoked | none | console | n/a |
| **P1** | `UNLIMITED_USER_EMAILS` (allowlist, personal data) | `utils/credits/unlimitedAccess.js` (matches `user.email`) | **unlimited credits**, see S2 below: the addresses are public and email signup does not verify them | the list cannot be "rotated". Fix S2 (honour the allowlist only for Google-authenticated or verified accounts) and check that every allowlisted address already has an account its owner controls | Render | sign up with an allowlisted address via email/password on staging → **not** unlimited | — |
| — | `APP_URL`, `BUILDER_ENGINE_URL`, pricing and credit values, `NODE_ENV`, `PORT` | config | not secrets | no rotation; `BUILDER_ENGINE_URL` should require auth if it is a reachable service (not verified) | — | — | — |

Order: Razorpay webhook → Razorpay keys → Mongo → session (announce the logout) → Google →
OpenRouter 1–4 → confirm the rest revoked. Then add secret scanning (for example GitHub push
protection) so a `.env` cannot be committed again.

**Two account-security defects found in this pass.** Both are in production `main` and both are
UNFIXED. Code was read; no exploit was attempted.

| # | Defect | Where | Effect | Remediation (needs your decision: it changes signup) |
|---|---|---|---|---|
| **S1** | **Pre-account takeover.** `/signup` creates an email/password account **without verifying the email**. Google login then attaches to **any** existing account with that email (`User.findOne({ email })`, no check of how it was created) | `index.js` `/signup` (≈1609); Google strategy (≈393; `origin/main:index.js:375`) | an attacker registers `victim@…` with a password before the victim's first Google login. The victim then uses an account whose password the attacker knows, and the attacker reads their company data | (a) require email verification before a password account is usable; (b) when Google login meets an unverified password account, do not merge: reset its password, or refuse and ask to verify; (c) a one-off audit of existing password accounts later used via Google |
| **S2** | **Unlimited-credit bypass.** The unlimited allowlist matches `user.email`, which a password signup sets without verification; the allowlisted addresses are in public history | `utils/credits/unlimitedAccess.js`; `/signup` | anyone can register an allowlisted address that has no account yet and use paid models without limit | honour the allowlist only for Google-authenticated (or verified) accounts. A small change, testable with a platform test; not made in this pass |

## 10. Release blockers and checklist

**Blockers (must close before a founder uses it):**

1. Credential rotation, P0 and P1 (§9).
2. **S1 (pre-account takeover) and S2 (unlimited-credit bypass)** fixed (§9). Founders will put
   real company data into accounts.
3. Merge this tree to `main` through a PR, with your approval. It carries the 7 uncommitted security
   fixes plus D1–D6.
4. Deployment verification on staging, then production. I cannot verify Render.
5. A paid extraction key. HISTORICAL: the free tier serves about 10 extractions per minute
   product-wide. MEASURED today: all 5 Groq slots rate-limited after 8 calls in about a minute.

**Not blockers, but open:**

- **Provenance attribution:** asked "Where did you learn our current price?", the answer gave the
  right value and the right supersession, but called the founder's own chat message "internal
  pricing information… the later internal note" (journey check 1 of 23). Answer-prompt work; not
  changed in this pass.
- **Actor claim lost at validation** (§4).
- The perf test under parallel runs (§5).

**Checklist:**

| Item | State |
|---|---|
| Security fixes | 10-15 set in `main`. 7 more in this tree (§9), tested |
| Migrations | one new: **0025** (three additive partial indexes; plain `CREATE INDEX` inside the migrator's transaction takes a **write lock on `aqua_claims` while it builds**). Before deploying: count `aqua_claims` rows in production (read-only). If large, build the three indexes `CONCURRENTLY` by hand beforehand; 0025's `IF NOT EXISTS` then makes the migration a no-op. Verified: applies on fresh and existing DBs (4 live test DBs, and fresh pg-mem in every migrating test); `IDEMPOTENT: a second run applies nothing` passes. Rollback: `DROP INDEX` the three, plus `AQUA_S8_HISTORY=full` |
| Config / env | no new env var is required. Rotate the credentials (§9) |
| Flags (defaults in code) | `AQUA_CANONICAL_RELEVANCE_GATE` on (rollback `off`, verified to reproduce old rankings); `AQUA_E6_ACTOR_RETRY` on (rollback `off`; at most one extra extraction call per segment with a dropped actor); `AQUA_E6_COMPOUND_RETRY` off; `AQUA_S8_HISTORY` bounded (rollback `full`; `compare` runs both and logs differences). Render overrides: **unverified** |
| Regression tests | all in §5; the new ones in §3 |
| Rollback | code: revert the merge PR. Data: no schema change other than indexes; idempotency changes write no new tables. Flags as above |
| Deployment verification | after deploy: `/health`; schema version 25; `node aqua/scripts/e2e-founder-journey.mjs` against staging (expect ≥ 22/23); worker logs show `claim.contradiction.v1 … done` and no dead jobs; `s8HistoryCompare` counters if `compare` is enabled briefly |
| Uncommitted work | backed up (§1) |

## 11. Founder pilot: design and unmeasured metrics

- **Design:**
  - `PILOT_VALIDATION_PLAN.md`: recruiting, cadence, decision rules;
  - **new** `PILOT_FOUNDER_SESSION_PROTOCOL.md`: preconditions, consent text read aloud, a fixed
    7-step 45-minute script, an observer scoring sheet with explicit denominators, and reporting
    rules.
- **Status:** no participant has taken part, and no participant data exists or is implied.
- **Measured by the protocol, all UNMEASURED:**
  - capture rate;
  - change-application rate and compound completeness;
  - stale-answer and fabrication counts;
  - evidence attribution;
  - honesty;
  - correction persistence;
  - re-explanation;
  - perceived accuracy and usefulness, and the "very disappointed" share;
  - latency and cost per session;
  - over the following weeks: activation, week-1 and week-4 retention, corrections per 100 turns,
    payments.
- **Preconditions:** the blockers in §10.

## 12. Strongest defensible YC evidence today

Defensible, with reproduction commands:

1. **State correctness on a frozen world (development data, deterministic replay):** 10/10 real
   changes applied as supersessions, 0 wrong, old values retained as history. At the start of the
   10-11 pass: 0 applied in the eval.
2. **Data integrity under failure:**
   - retries, crashes mid-commit, concurrent workers, and user deletions or corrections between
     attempts leave exactly one application;
   - 10 live tests.
3. **Scales without new infrastructure:**
   - duplicate detection is flat in history size: 46 ms and 1.5 MB at 20,000 claims in one bucket,
     against 553 ms and 25 MB;
   - 0 decision changes on 106 real segments;
   - abstains rather than guesses when its view is cut.
4. **Engineering discipline:**
   - preregistered experiments, with frozen hashes verified today;
   - a final set authored by an isolated agent, never read by the implementation;
   - every failing test investigated (§5);
   - one prior claim corrected publicly (§9).
5. **End-to-end product path:** 22/23 on the scripted founder journey on the real launcher, including
   cross-account isolation and delete/correct persistence.

**Not evidence yet:**

- better *answers* than history, memory or a hybrid (§7–8);
- any user or customer metric (§11).

## 13. Next three priorities

1. **Run the VM kits:** v4, then the final evaluation (§6–7). Apply v4's registered rule; compute
   E1–E3, the second judge, and grade the 60-item blinded sheet. This is the only path to an
   answer-level claim.
2. **Rotate the credentials (§9, P0 first), decide the S1/S2 signup fix, and ship this tree through a
   PR.** Then verify the deploy with the founder journey on staging. All of this needs your approval
   and your console access.
3. **Close the two measured quality gaps, on development data only:**
   - re-check actor coverage after S4 validation, so a claim discarded on a near-miss literal ("help
     me" vs "helping me") triggers the retry;
   - fix provenance wording, so the founder's chat message is cited as what they said.
   - Smaller: run the perf-shape tests serially, so suite parallelism cannot fail them.
