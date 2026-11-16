# AQUIPLEX Sprint 6 — Capture Release Preparation & Hybrid Context Implementation

**Date:** 2026-11-11

## Repository

| Item | Value |
|---|---|
| Root | `C:/Users/dell/Downloads/aquiplex-platform/aquiplex-platform` |
| Branch | `main` |
| HEAD | `839ea0d167025e1ad7085668727ff65452d51335` (verified at start and end) |
| Working tree | Start: 111 paths, all preserved. End: 133 (new files listed in §8). |
| Commits, pushes, deploys, production flag or environment changes | **none** |
| Paid model, embedding or external AI calls | **none**. Every ACIB run recorded 0 network attempts; the runner tests prove 0 external requests. |
| Real memory store | not accessed (mtime 2026-11-10 11:18:28, unchanged) |
| Frozen datasets | unchanged: v1 `d041746a…`, held-out v1 `8da1bffb…`, v2 dev `abca8916…`, v2 eval `002208e4…` |
| Historical baselines | unchanged; no file in `aqua/eval/baselines/` modified; none created |

## 1. Capture release package → [AQUIPLEX_SPRINT6_CAPTURE_RELEASE_PACKAGE.md](AQUIPLEX_SPRINT6_CAPTURE_RELEASE_PACKAGE.md)

**Verified facts:**
- `release/capture-integrity-v1/capture-integrity-v1.patch` (sha `678b0c60…`) covers **9 files**:
  - 3 capture-only files;
  - the 2 extractors, with their Sprint 1 log-privacy hunks;
  - `core/logSafety.js`;
  - 3 test files, including the new `core/tests/logSafety.test.js` (7 tests).
- **No Information Needs, hybrid, route, flag, benchmark or evaluation code is in it** (0 matches).
- **Isolation proof.**
  - The patch applies cleanly to a `git archive HEAD` export and reproduces the working-tree files byte for byte.
  - Full `src` battery, **HEAD alone: 4,572 tests, 13 fail.**
  - Full `src` battery, **HEAD + package: 4,604 tests, 12 fail.** The same failures, minus one load-sensitive timing test. **No new failure**, and all 32 added tests pass.
  - The shared failures come from exporting only `aqua/` (root files absent) and from environment-dependent tests; they fail identically on pure HEAD.

## 2. Shadow failed-turn test → [AQUA_SHADOW_FAILED_TURN_TEST.md](AQUA_SHADOW_FAILED_TURN_TEST.md)

`aqua/src/routes/tests/infoNeedsShadowFailedTurn.test.js`: **5/5 pass**.
- It covers a new user and an existing user, on `/chat` and `/chat/stream`.
- It asserts the shadow analysis **ran** on the failed turn.
- Facts, goals, beliefs, working memory and messages are byte-identical afterwards.
- A control proves the test can see writes.
- **Bite check:** with the rollback removed, 4 of 5 fail.

## 3. Hybrid context → [implementation](AQUA_HYBRID_CONTEXT_V1_IMPLEMENTATION.md) · [results](AQUA_HYBRID_CONTEXT_V1_RESULTS.md)

**Built:**
- `brain/contextEngine/hybridContext.js`;
- route step 5d³;
- `AQUA_HYBRID_CONTEXT` (default **off**), plus `MAX_TOKENS`, `MAX_MS` and `MAX_SENTENCES` settings;
- inert engine hooks (budget, scores, `needMatchScore`);
- 4 ACIB hybrid suites, plus an additive adapter change so the frozen scorer reads the block.

**What it guarantees:**
- The existing context is never altered: the `on` prompt minus the block equals the `off` prompt, byte for byte.
- It adds only strong, non-duplicate evidence.
- It keeps conflict, change, ambiguity and forgotten notes.
- It writes "Not known" only when neither V2 nor the existing context has the information; otherwise it writes "not matched", which distinguishes not retrieved from unknown.
- Token and time budgets are enforced.
- Every failure falls back to the existing context.

**Test results:**
- `hybridContext.test.js`: 19/19;
- `hybridContextRoute.test.js`: 9/9 (streaming, failed turn, long history, conflict, missing information, unrelated facts, low coverage, engine error, isolation, precedence);
- registry tests: 72/72;
- **3 bite checks, each failing as intended.**

**Results (development evidence; not independent):**
- **A and B are byte-identical to their Sprint 4 records** on all four sets: 0 metrics differ, items identical.
- **The hybrid never loses an existing-pipeline case** on any set or regime.
- **v2 eval (contaminated; regression only):**
  - short: 95 = 95, with 0 gained / 0 lost;
  - long: 74 → 79, with 5 gained / 0 lost;
  - contradiction 0.50 → 0.94;
  - unknowns 0 → 0.85 / 0.69;
  - about **+39 tokens** per turn.
- **Development sets:** unknown handling 1.00 and contradiction 1.00 on all three.
- **Trade-offs:**
  - precision and temporal accuracy stay at the existing pipeline's level (the additive design);
  - stale-as-current is +1 per regime, from a V2 change-detection limit ("put the rent up to"). Investigated, documented, not hidden.

## 4. ACIB v3 governance → [AQUA_ACIB_V3_FREEZE_AND_GOVERNANCE.md](AQUA_ACIB_V3_FREEZE_AND_GOVERNANCE.md)

**Not met, so not frozen:**
- independent authorship — no authors engaged;
- reviewer sign-off — no reviewer named.

**Built:**
- `eval/governance/acibV3Governance.mjs` and `scripts/acib-v3-freeze.mjs`;
- they refuse without at least two independent authors, a non-implementer reviewer sign-off and founder-confirmed criteria;
- they refuse an eval file inside the repository;
- they validate the 150/54 counts, category balance, reachable annotations and honest paraphrase flags;
- they never overwrite a freeze;
- 7/7 tests.

**v3 benchmark execution is not implemented,** per the brief.

## 5. Evaluation runner → [AQUA_ANSWER_EVALUATION_RUNNER.md](AQUA_ANSWER_EVALUATION_RUNNER.md)

**Built:**
- a spend ledger: a hard cap checked **before every request** including retries, default **$25**; no prices → refused; conservative accounting;
- a provider client with bounded retries (429/5xx/network only);
- a judge runner: schema validation, one re-ask then human review, resume, a clean stop at the cap, un-blinding, review queues for low confidence, judge disagreement and judge vs deterministic;
- `answer-eval.mjs` rewritten (arms A/B/H, resume, cap stop, prices required);
- `answer-judge.mjs`.

**Tests:** 25/25. The CLI runs as child processes with a fetch guard: **0 external requests**, and `--execute` without approval, credentials or prices exits 2 before any request.

**Production answering model (from code; production overrides not inspected):** routed per turn.
- Conversation, personal and memory turns: **Groq `openai/gpt-oss-120b`** (fallback `openai/gpt-oss-20b`), then **Gemini `gemini-2.5-flash`**.
- Reasoning, coding, research and high-complexity turns: Gemini first.
- No `temperature` is sent; output length comes from the orchestration budget.

**Recommendation (pending approval):**
- answering model: `openai/gpt-oss-120b`;
- judge: a different family from both gpt-oss and Gemini (for example a Claude model). OpenAI-compatible endpoint compatibility is unverified.
- No prices are stated.

## 6. Regression protection

| Command (from `aqua/`) | Result |
|---|---|
| `node scripts/run-tests.mjs` (full battery, `src` + `eval`) | **5,144 tests: 5,109 pass, 2 fail, 26 skipped, 7 todo.** The failures are `repoHygiene` (pre-existing `aqua/eval/out/*before-profile*` files) and `atomicStore` (**passes alone, 1/1**: load-sensitive, seen in Sprints 4 and 5). |
| `node eval/gate.mjs` | **BLOCKED**, by the same four suites with the same movements as Sprint 4. `acib-v1` (long-history efficiency −0.007, from the capture fixes; other moved metrics improved). `acib-v1-needs` and `acib-heldout-v1-needs` (V2 precision trade-off). `capture-core` ("dataset shape" rule; every metric improved). **No new suite regressed.** The 4 new hybrid suites and 4 v2 suites have no baseline: skipped, deliberately not created. 2 suites NOT RUN (Postgres). |
| Gate side effect | It rewrote `eval/fixtures/retrieval-core.embeddings.v1.json` (tracked); its content is **identical to HEAD** (`git status` clean, empty diff). The gate also writes the git-ignored `eval/out/gate-summary.json`. |

Baselines were not changed to make the gate pass.

## 7. Distinctions

| Kind | Items |
|---|---|
| **Verified facts** | Repository state; package isolation and battery comparison; A/B unchanged vs Sprint 4; hybrid invariants (by test and bite check); 0 external calls; production routing (from source) |
| **Test results** | §1–§6 |
| **Proposals** | Hybrid pruning flag; the V2 change-verb fix; the judge-model family; the v3 sealed runner and scorer v3 |
| **Unverified assumptions** | Production environment (provider overrides, keys, Node version, data sizes); latency on real histories (local timings vary with load); provider support for `seed` and JSON-only judging; whether development-set gains hold on an independent set |

## 8. Decisions requiring founder approval

1. **Capture release:** build the two-commit series from the package, and deploy.
2. **ACIB v3:** appoint at least two independent authors and a reviewer; confirm the success criteria. Nothing can be frozen until then.
3. **Answer-level pilot (A vs H):** answering model, judge model, prices, spend cap (default $25 each).
4. **Hybrid rollout path:** `AQUA_HYBRID_CONTEXT=shadow` after deploy (instead of, or after, `AQUA_INFO_NEEDS=shadow`).
5. **Pre-existing logging:** the `[RECALL]` log line prints the account id (`owner=user:<id>`). Approve hashing it like `[NEEDS]` / `[HYBRID]`.
6. **Gate baselines:** whether to accept the explained movements (still pending from Sprint 4).

## 9. Files (Sprint 6)

**New:**

| Area | Files |
|---|---|
| Source | `aqua/src/brain/contextEngine/hybridContext.js` |
| Tests | `aqua/src/brain/tests/hybridContext.test.js`, `aqua/src/routes/tests/hybridContextRoute.test.js`, `aqua/src/routes/tests/infoNeedsShadowFailedTurn.test.js`, `aqua/src/core/tests/logSafety.test.js`, `aqua/eval/tests/answerRunner.test.js`, `aqua/eval/tests/acibV3Governance.test.js`, `aqua/eval/tests/fixtures/fetchGuard.mjs` |
| Answer evaluation | `aqua/eval/answer/spendLedger.mjs`, `aqua/eval/answer/providerClient.mjs`, `aqua/eval/answer/judgeRunner.mjs` |
| Governance | `aqua/eval/governance/acibV3Governance.mjs` |
| Scripts | `aqua/scripts/answer-judge.mjs`, `aqua/scripts/acib-v3-freeze.mjs` |
| Suites | `aqua/eval/suites/acib-{v1,heldout-v1,v2-dev,v2-eval}-hybrid.suite.mjs` |
| Release package | `release/capture-integrity-v1/` (patch, FILES.sha256, PATCH.sha256) |
| Records | 16 ACIB records `aqua/eval/acib/results/*.s6*.json` |
| Documents | the seven deliverables |

**Modified:**

| File | Change |
|---|---|
| `aqua/src/routes/chat.js` | Hybrid step 5d³; precedence; `warnOnce`; `[NEEDS]` accounting only when `AQUA_INFO_NEEDS` is on |
| `aqua/src/brain/contextEngine/informationNeeds.js` | Inert hooks |
| `aqua/src/core/flags.js` | 1 gate, 3 settings |
| `aqua/src/core/tests/flagRegistry.test.js`, `flagReadSiteParity.test.js` | Census and probe |
| `aqua/eval/adapters/acibPipeline.mjs` | Hybrid block extraction (inert without a block) |
| `aqua/eval/suites/acibSuite.mjs`, `aqua/scripts/acib-run.mjs` | `hybridTokens` |
| `aqua/scripts/answer-eval.mjs` | Rewritten: client, ledger, resume, arms |
| `aqua/eval/answer/judgeRubric.md` | Pointer to the code prompt and the confidence field |
