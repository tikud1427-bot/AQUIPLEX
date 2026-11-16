# AQUIPLEX — Intelligence Evaluation, Phase 2

**Date:** 2026-11-12 · **Repository:** `main` @ `839ea0d1`

**Status:** evaluation-system improvements implemented and tested; ACIB v3 governance prepared; diagnostic run prepared but **not executed**.

> No live API request was made. Every test mocks its providers and has a network tripwire (0 external requests); offline measurements used the real pipeline under a fetch guard (0 external). No production code, routing or fallback was changed. Frozen datasets are unchanged (sha256 verified). No commits, pushes or deployments. No author or reviewer was invented or appointed.

**Standing decision (founder, 2026-11-12):**

- ACIB v2 is **development / regression evidence only**. No claim that hybrid context improves intelligence is made from it.
- The 800-request benchmark is **not** run.
- The independent test is ACIB v3.

---

## 1. Task 1: evaluation-only improvements (decision D6)

All changes are in `aqua/eval/` and the evaluation scripts. None is in `aqua/src`, `services`, `src` or `index.js` (verified by modification time).

### 1.1 Reproducible A/H order (`eval/providers/pairRunner.mjs`)

- **Per case:** `armOrder(arms, caseId, seed)` uses `sha256(seed | caseId)` to decide whether a case runs A→H or H→A, for answering **and** judging. Over 400 synthetic ids, 160–240 run H first (balanced, tested).
- **Seed:** `config.orderSeed` (default `aqua-eval-order-v1`). It is **recorded** in the run result and in every answer record (`orderSeed`, `armOrder`), so any run's order can be recomputed.
- **Pairing:** both arms of a case still run consecutively, so a pause cannot separate them by more than the pause itself.
- **Prompt status:** every answer also records `promptHashNormalised`, a prompt hash with the per-build random `UNTRUSTED-CONTENT` delimiter normalised. Equal hashes mean A and H received the same context; this is how the noise control is identified.

### 1.2 Hard token budgets (`eval/providers/providerManager.mjs`, `evalConfig.mjs`)

| Budget | Config | Before sending | Effect |
|---|---|---|---|
| Per request | `tokenBudget.perRequest.<provider>` (and `rateLimits.maxRequestTokens`; the smaller applies) | conservative estimate ≤ cap | Otherwise `stopped-rejected`, **nothing sent** |
| Per run | `tokenBudget.run.<provider>` | charged-so-far + estimate ≤ cap | Otherwise `paused (run-token-budget)` |
| Per quota group, per UTC day | `tokenBudget.group["<group id>"]` and `tokenBudget.ledgerFile` | today's ledger total + estimate ≤ cap | Otherwise `paused (group-token-budget)` until 00:00 UTC; it holds **across runs** |

- **Estimate:** characters ÷ 3, plus chat framing, plus the **full** `max_tokens`. Real English averaged 4.48 characters per token in the smoke test, so the estimate is deliberately high.
- **Charging:** after each attempt, the **provider-reported** usage (prompt + completion) is charged. An attempt without reported usage (an error or network failure) is charged its full estimate. If reported usage ever exceeds the estimate, an `estimate-exceeded` event is recorded.
- **Ledger:** a JSONL file with day, group, provider, tokens and whether the figure was reported or estimated. It holds no content or key values. One run at a time is enforced by the existing machine-wide lock.
- **Group ids:** keys whose ownership is not verified form **one** group, `unverified:<provider>`. The preflight names the exact id it needs.
- **Mandatory in existing-pool mode:** per-request, per-run and per-group budgets for every provider and group a role uses, plus a ledger. The config is refused otherwise (tested).
- **Unchanged and re-tested:** the request cap; immediate pause on any 429; no key rotation; billing and authentication stops.

### 1.3 Human-review queue (`mergeStore` in `eval/answer/evalRun.mjs`; `answer-judge.mjs --merge`)

| Reason | Rule |
|---|---|
| `malformed:<error>` | The judge reply did not parse or validate |
| `low-confidence` | Judge confidence < 0.6 |
| `ah-disagreement` | A and H of the same case differ on any core dimension (factual, grounding, personalisation, clarification) or on the hallucination flag. One item per case; the differing dimensions are listed. |
| `judge-vs-deterministic` | Judge factual correctness and the deterministic grade are 2 or more levels apart |
| `random-audit` | A seeded random sample (`--review-sample`, default 10%; `--review-seed`) of judgements **not** otherwise queued |

The rate and seed are returned with the queue, so the sample is reproducible (tested).

### 1.4 Paired statistical analysis (`eval/answer/pairedAnalysis.mjs`, `scripts/answer-analyze.mjs`)

This is offline: it reads the pair store and the dataset, and never calls a provider. The method is in §2. The output includes:

- an evidence label (always **DEVELOPMENT / REGRESSION EVIDENCE — NOT INDEPENDENT** unless the dataset matches a recorded ACIB v3 freeze);
- the code hashes used (pre-registration check);
- per label (regime): primary, sensitivity, judge score, deterministic grade, noise control, prompt-changed subset, categories, missing items;
- Holm adjustment across labels.

Current code hashes (sha256, first 16 hex characters):

| File | Hash |
|---|---|
| `pairedAnalysis` | `53a4e582cf8731ca` |
| `answerGrader` | `9fd2495d705bdd06` |
| `judgeRunner` | `f18c26dad01c3108` |
| `answer-analyze` | `b84b9938ae42877e` |

### 1.5 Stratified, recorded diagnostic sample (`scripts/answer-eval.mjs`)

`--sample-per-category N --sample-seed S` selects N scenarios per category by `sha256(S | id)`. The selection is written to `<label>.sample.json`; resuming the same label with a different sample is refused. The analysis treats the sample as the expected scenario set.

### 1.6 Tests (from `aqua/`)

| Command | Result |
|---|---|
| `node scripts/run-tests.mjs eval/tests/phase2Evaluation.test.js` (**new**) | **20/20** |
| All evaluation suites (`phase2Evaluation`, `finalPreExecution`, `preSmokeReadiness`, `founderVerifiedGemini`, `zeroCostReadiness`, `existingKeyPool`, `evalReadiness`, `evalProviderIntegration`, `evalProviderManager`, `answerRunner`, `answerGrader`, `acibV3Governance`) | **211/211** |
| `node scripts/run-tests.mjs src/providers` (production) | **199/199** |
| Bite checks (each mutation → failures; files restored, sha256 verified) | Order randomisation off → 2; run token budget off → 1; group budget off → 1; ledger not loaded (cross-run) → 1; random audit includes queued items → 1; noise control misclassified → 2; evidence always "independent" → 2; preflight token requirement off → 1; A/H disagreement off → 2 |
| Leak scan (real `.env` values, counts only) | 48 values × 12 changed or new files → **0 hits** |

**The new tests cover:**

- seeded order (deterministic, balanced, recorded, used for answering and judging);
- the normalised prompt hash;
- per-request rejection with nothing sent;
- the run budget pausing with nothing sent, with reported usage charged;
- the group budget holding across runs through the ledger and resetting the next UTC day;
- errors charged at their estimate;
- the 429 pause and request cap preserved;
- the preflight naming `unverified:groq`;
- every review reason, the audit excluding queued items, and a reproducible audit;
- hand-checked statistics: McNemar 5–0 = 0.0625, 6–0 = 0.03125, 10–2 = 158/4096, the Wilson bound, Holm, the exact sign-flip test;
- a reproducible bootstrap;
- the primary, sensitivity, noise-control and changed-subset blocks;
- the evidence label;
- the analysis CLI labelling v2 as development;
- the stratified sample CLI, including refusal of a changed sample (0 external requests).

**Existing tests adjusted (assertions preserved):**

- two tests assumed fixed A→H order; they now accept the seeded order and check that it is the recorded one;
- five production-mode test configs gained a generous `tokenBudget` (now mandatory).

---

## 2. Statistical methodology (implemented; pre-register before any v3 run)

**Unit:** the case (scenario × regime). Each case has one A answer and one H answer from the same model and settings. Only `AQUA_HYBRID_CONTEXT` differs.

| Analysis | Definition | Estimate and interval | Test |
|---|---|---|---|
| **Primary** (per regime) | **Correct** = judge factual correctness = 2 **and** no hallucination; complete pairs | Paired risk difference RD = (H-only − A-only) / n; 95% percentile bootstrap over cases (10,000 resamples, recorded seed) | **Exact McNemar** (two-sided binomial on discordant pairs); **Holm** across regimes |
| Sensitivity | Missing or invalid judgement = incorrect for that arm | Same | Same (reported, not primary) |
| Secondary: judge score | Sum of the 4 core dimensions (0–8), H − A | Mean difference, bootstrap CI, **dz** = mean / SD | Sign-flip permutation (exact ≤ 16 non-zero differences, otherwise Monte Carlo, seeded) |
| Secondary: deterministic | Annotation-based factual correctness (0–1) | Mean difference, bootstrap CI, dz | Sign-flip |
| **Noise control** | Cases whose A and H prompts are identical | **Discordance rate**, Wilson 95% CI | None (it estimates model nondeterminism) |
| **Prompt-changed subset** | Cases whose prompts differ | RD and score difference with CIs | **None, by design.** Selected by the treatment's own effect: descriptive only, never a primary result |
| Categories | Per category: n, correct per arm, RD, score difference | Counts and differences | None (8–24 per category) |
| Missing | Every incomplete case with the reason; scenarios never run | Counts | — |

**Claim rule (proposed for pre-registration):** "H improves answers" only if the analysed set is the frozen, independent ACIB v3 **and** the regime's Holm-adjusted McNemar p < 0.05 **and** the RD CI excludes 0 **and** no regime shows a significant regression. Any other outcome is reported as "no detectable difference" or "inconclusive", with the estimates.

**Power:** in ACIB v2's long regime, H gained 5 context-level cases and lost 0. Even if every gain carried through to the answer, exact McNemar 5–0 gives p = 0.0625. v3's 150 scenarios per regime, with semantic-mismatch cases targeted, are sized for roughly an 8-percentage-point difference at 80% power. The diagnostic run's noise-control discordance rate will show how realistic that is.

---

## 3. Task 2: ACIB v3 independent governance (prepared; no one appointed)

### Roles (all to be appointed by the founder)

| Role | Count | Independence requirement |
|---|---|---|
| Evaluation-set authors | **≥ 2** | Have not built the engine or hybrid; have not seen its code, design documents, results, or ACIB v1/v2 |
| Development-set author(s) | ≥ 1 | Different people, names and domains from the evaluation set (may include the engine team) |
| Reviewer | **1** | Not an implementation author (AI agents used for implementation count as implementation authors). Holds the evaluation file outside the repository. |
| Founder | — | Confirms the success criteria and the claim rule **before** the freeze |

### Process and controls

1. **Brief.** Authors receive only [AQUA_ACIB_V3_AUTHORING_BRIEF.md](AQUA_ACIB_V3_AUTHORING_BRIEF.md): categories and counts, the scenario schema (matching the grader), quality checks, rules and declarations. **It contains no hybrid or engine implementation details.**
2. **Authoring.** The evaluation set (150) is written first, sent **only** to the reviewer and stored outside the repository. The development set (54) is written afterwards by different authors and domains.
3. **Validation.** `eval/governance/acibV3Governance.mjs` (existing, tested) refuses:
   - fewer than 2 authors;
   - author/implementer overlap;
   - a missing or self-reviewing reviewer;
   - wrong counts or category balance;
   - unreachable annotations;
   - false `paraphrase` claims;
   - an evaluation file inside the repository.
4. **Freeze.** `node scripts/acib-v3-freeze.mjs --manifest <manifest>` writes `eval/datasets/acib.v3.FREEZE.json` with the evaluation, development and scorer **sha256**, authors, reviewer sign-off and rules. It never overwrites. Template: [aqua/eval/governance/acib-v3-manifest.template.json](aqua/eval/governance/acib-v3-manifest.template.json) (placeholders only).
5. **Evidence label.** `answer-analyze` labels a result **independent** only if the analysed dataset's sha256 equals the freeze record's evaluation hash (`--dataset-file` for the external file). Everything else is labelled development.
6. **Separation.** Implementation authors receive the development set and the freeze record, **never** the evaluation file. Evaluation results are aggregates only until the single run is complete.

### Gaps to close before a v3 run

- **Live runner for an external dataset.** `answer-eval` / `answer-judge` read datasets from `eval/datasets/` with a `.FROZEN.sha256`. A reviewer-run mode (`--dataset-file` verified against `acib.v3.FREEZE.json`, writing per-item results outside the repository) is needed. About 0.5 day, after the dataset exists.
- **Grader extension for v3 annotations** (`tempting`, `answerability`, `expectedQuestion`). The current deterministic grader scores v1/v2 fields. The judge rubric applies unchanged.
- **Coverage decision.** The v3 plan has **no** language-mismatch category, and indirect references are only a writing guideline. The brief allows tagged language-mismatch scenarios, but counting them needs a plan change *before* authoring (D-P2-3).

---

## 4. Task 3: cost and production safety

### Requests and tokens

**Request counts are hard caps; token figures are estimated.** The estimate uses characters ÷ 3, plus framing, plus the full output.

| Run | Requests (max) | Token ceiling (hard caps) | Expected actual |
|---|---|---|---|
| **v2 diagnostic** (§5) | **40** (20 answers + 20 judgements) | Per request 4,000; per run 70,000; group 100,000/day. Measured ceiling for this sample: 68,919 (answers) + 78,456 (judging) = 147,375 | ≈ 50k–58k |
| **ACIB v3** (150 scenarios × short, long × 2 arms, plus 20 very-long × 2) | **1,280** (640 answers + 640 judgements) | 640 × 4,000 × 2 = **5.12M** at the per-request cap | ≈ **1.4M–1.85M** (answers 0.9M–1.2M; judging 0.45M–0.65M) |
| Optional v3 development rehearsal (54 scenarios × 2 regimes × 2 arms) | 432 | ≈ 1.7M at the cap | ≈ 0.5M–0.65M |

The very-long regime's prompt sizes are not yet known. They must be measured offline on the development set before the run, because a request above the per-request cap is rejected (never sent).

### Quota accounting and production protection

- **Verified quota:** **only** `GROQ_API_KEY_1` (organisation "Personal", founder-verified free plan). Other keys are **not** assumed to have independent quotas: they are unused, or would join the single `unverified:groq` group.
- **Group budget:** at most **100,000 tokens/day** on that group, about half of Groq's ~200k/day free allowance for `gpt-oss-120b` (measured 2026-11-01; re-check in the console). The other half stays with production. The ledger counts both models (answering and judging) together, which is conservative because Groq limits each model separately.
- **v3 duration on one organisation:** about **14–19 days** of daily runs.
- **Every live run keeps:**
  - pacing at ≥ 61 s between requests and ≤ 4,000 tokens/min (half of the 8,000 TPM limit);
  - a request cap per run;
  - token caps per request, run and group;
  - an immediate pause on any 429;
  - no key rotation, no fallback, and a stop on billing or authentication errors;
  - a machine-wide run lock;
  - both approval switches;
  - a terminal with no provider credentials in its environment.

**Pause and resume:** budget, quota or rate-limit pauses end the run with `RESULT: PAUSED (<reason>)` and a resume time. Re-running the same command resumes without repeating any answer or judgement (keyed by case, arm, model and settings). The ledger carries the group budget across days.

**Zero cost:** the free plan with no payment method or billing arrangement is recorded with evidence; any billing signal stops the run. No paid model, subscription or new key is used.

---

## 5. Task 4: optional ACIB v2 diagnostic (prepared, NOT executed)

**Label:** **DEVELOPMENT / REGRESSION EVIDENCE.** It is never evidence that H improves answers. The analysis CLI enforces the label (tested).

**Purpose:**

- check the full pipeline end to end at small scale;
- measure **model noise** (identical-prompt discordance) and real token use, which inform v3 sizing and power;
- check that H does not visibly degrade answers.

**Design:**

- `acib.v2.eval`, **10 scenarios** (1 per category, seed `diag-v2-sample-1`), **long regime**, arms A and H;
- arm order seeded `diag-v2-order-1`;
- Groq `openai/gpt-oss-120b` answers; `qwen/qwen3.8-27b` judges;
- `GROQ_API_KEY_1` only.

**Caps:**

| Cap | Value |
|---|---|
| Requests | 20 per run (answers run: 20; judge run: 20; **40 in total**) |
| Tokens per request | 4,000 (measured maximum: 3,948 answer, 3,939 judge) |
| Tokens per run | 70,000 |
| Tokens per group per day | 100,000 |

These caps need your approval, by filling in `founderDecision.at` in the config.

**Independence from v3:** it uses its own label, its own config (`config-diagnostic-v2.json`) and its own caps, and shares nothing with v3 except the code.

**Config example:** `C:\Users\dell\aquiplex-eval-example\config-diagnostic-v2.example.json`, outside the repository. Checked offline:
- refused as written;
- accepted once `founderDecision.at` is filled in;
- refused without a group budget.

**Commands** (PowerShell, a new window with no provider credentials; **not authorised**):

```powershell
cd C:\Users\dell\Downloads\aquiplex-platform\aquiplex-platform\aqua
$env:AQUA_ANSWER_EVAL_APPROVED="yes"; $env:AQUA_EVAL_LIVE_APPROVED="yes"
node scripts/answer-eval.mjs --execute --answers-only --set acib.v2.eval --regime long --arms A,H --sample-per-category 1 --sample-seed diag-v2-sample-1 --label diag-v2-long-1 --provider-config C:\Users\dell\aquiplex-eval\config-diagnostic-v2.json
node scripts/answer-judge.mjs --execute --label diag-v2-long-1 --set acib.v2.eval --regime long --arms A,H --provider-config C:\Users\dell\aquiplex-eval\config-diagnostic-v2.json
Remove-Item Env:AQUA_ANSWER_EVAL_APPROVED, Env:AQUA_EVAL_LIVE_APPROVED
# offline, no requests:
node scripts/answer-judge.mjs --label diag-v2-long-1 --set acib.v2.eval --regime long --arms A,H --merge
node scripts/answer-analyze.mjs --set acib.v2.eval --labels diag-v2-long-1
```

Each run takes at least about 20 minutes because of pacing. Expected output: `RESULT: COMPLETED (answers only…)`, then `RESULT: COMPLETED`, then `EVIDENCE: DEVELOPMENT / REGRESSION EVIDENCE — NOT INDEPENDENT`.

**Interpretation limits:** 10 cases cannot support any inference about A vs H. The useful outputs are the noise-control discordance, token use and failure modes.

---

## 6. Remaining founder decisions

| # | Decision | Recommendation |
|---|---|---|
| **D-P2-1** | Appoint ≥ 2 independent evaluation authors and 1 independent reviewer (and development author(s)) | Required for any improvement claim; nothing proceeds on v3 without them |
| **D-P2-2** | Confirm the success criteria and the claim rule (§2) before the v3 freeze; record `successCriteriaConfirmedBy` | Adopt §2 |
| **D-P2-3** | v3 coverage: add language-mismatch and indirect-reference categories (changes the plan counts before authoring) or keep them as tagged extras | Decide before authors start |
| **D-P2-4** | Run the optional v2 diagnostic (40 requests, caps above) | Yes, it informs v3 noise and sizing; approve by filling in `founderDecision.at` |
| **D-P2-5** | Quota for v3: one verified organisation (~14–19 days at 100k/day) or verify ownership and billing of further organisations | Verify only if faster completion matters; never assume independence |
| **D-P2-6** | Approve the remaining v3 build items: reviewer-run live mode for the external dataset; grader extension for v3 annotations | After authors deliver; about 1 day with tests |
| **D-P2-7** | Optional second judge on a sample (inter-judge agreement) | Only if the review queue shows judge instability |

## 7. Files

| File | Change |
|---|---|
| `aqua/eval/providers/pairRunner.mjs` | Seeded A/H order (recorded), normalised prompt hash |
| `aqua/eval/providers/providerManager.mjs` | Token budgets per request, run and group; cross-run ledger; token state |
| `aqua/eval/providers/evalConfig.mjs` | Production pools require all token budgets and a ledger; docs |
| `aqua/eval/answer/evalRun.mjs` | Review queue (5 reasons, seeded audit); `orderSeed` in run results |
| `aqua/eval/answer/pairedAnalysis.mjs` | **New:** paired statistics |
| `aqua/scripts/answer-analyze.mjs` | **New:** offline analysis CLI (evidence label, Holm, code hashes, `--dataset-file`) |
| `aqua/scripts/answer-eval.mjs` | Stratified, recorded sample |
| `aqua/scripts/answer-judge.mjs` | `--review-sample`, `--review-seed` |
| `aqua/eval/tests/phase2Evaluation.test.js` | **New** (20 tests) |
| 7 existing evaluation test files | Order-independent assertions; mandatory token budgets in test configs |
| `aqua/eval/governance/acib-v3-manifest.template.json` | **New:** freeze manifest template (placeholders) |
| `AQUA_ACIB_V3_AUTHORING_BRIEF.md` | **New:** brief for independent authors and the reviewer |
| `C:\Users\dell\aquiplex-eval-example\config-diagnostic-v2.example.json` | **New**, outside the repository |
| This report | **New** |

**Git:** `main` @ `839ea0d1`. Nothing committed, pushed or stashed. 164 uncommitted paths: the 160 preserved plus 4 new top-level paths (this report, the brief, the new test file, `answer-analyze.mjs`); the other new files are inside directories that were already untracked.

**Stopped — awaiting founder review.**
