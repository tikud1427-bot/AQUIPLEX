# AQUIPLEX — ACIB v3 Governance and Grader Readiness

**Date:** 2026-11-12 · **Repository:** `main` @ `839ea0d1`

**Status:** the evaluation machinery for ACIB v3 is built and tested. **ACIB v3 itself does not exist yet:** no author or reviewer is appointed, no dataset is written, and nothing is frozen. Execution is blocked until every D-P2-7 condition is met **and** the founder approves separately.

> **No live API request was made.** Every test mocks its providers and has a network tripwire (0 external requests). No production code, routing or fallback was changed (0 production files modified in this phase). Frozen datasets are unchanged (sha256 verified). The real freeze file `aqua/eval/datasets/acib.v3.FREEZE.json` was **never written**; freeze validation used `--dry-run` only. No commits, pushes or deployments. No person was invented or appointed; test names are synthetic.

## 0. Founder decisions recorded (2026-11-12)

| # | Decision | Where it is enforced |
|---|---|---|
| D-P2-1 | ≥ 2 independent evaluation authors and 1 independent reviewer; no one invented | `validateManifest`: ≥ 2 authors, verbatim dated declarations, no overlap with implementation or development authors; reviewer neither an implementer nor a development author |
| D-P2-2 | Primary: paired factual correctness; exact McNemar; correction for two regimes; CIs, effect sizes, minimum meaningful improvement; hallucination and critical categories separate | `pairedAnalysis.mjs` (`SPEC`, `claimVerdict`), [AQUA_ACIB_V3_ANALYSIS_SPEC.md](AQUA_ACIB_V3_ANALYSIS_SPEC.md) |
| D-P2-3 | Language-mismatch and indirect-reference scenarios included | `PLAN`: two new categories (12 eval / 4 dev each), dataset checks, grader metrics, authoring brief |
| D-P2-4 | ACIB v2 diagnostic skipped | Not run; its example config is marked deferred |
| D-P2-5 | `GROQ_API_KEY_1` only; 100,000 tokens/day; production-usage check before each evaluation day | v3 config (one key, group budget 100k); **new** `productionUsageCheck` gate (§3.6) |
| D-P2-6 | ACIB v3 kept outside the repository, hash frozen before evaluation, no influence from development results | Reviewer mode (§3.2), freeze tool (§3.5), spec §6 |
| D-P2-7 | No live evaluation until the dataset, reviewer approval, v3 grader, live mode and budget are ready **and** the founder approves separately | §5 checklist. The gate requires a dated `founderDecision` in the v3 config. |

## 1. Task 1: v3 annotation grader ([aqua/eval/answer/answerGraderV3.mjs](aqua/eval/answer/answerGraderV3.mjs))

The grader **extends** the v1/v2 grader without changing it: every v1/v2 metric is produced unchanged (tested), so historical scores stay comparable. It adds:

| Metric | Rule |
|---|---|
| `answerability_handling` | **answerable:** 1 if all required facts are given and no question asked; 0.5 if they are given but a question is asked; 0 otherwise. **answerable-with-caveat:** 1 if the facts come with a caveat or hedge; 0.5 without one. **needs-clarification:** 1 for exactly one question that targets an unknown (or `expectedQuestionMatch`) without asserting it; 0.5 for an untargeted question or a decline; 0 otherwise. **impersonal:** 1 if no personal detail is used. |
| `tempting_mentions` | A tempting (shared-word) fact appears in the answer |
| `cross_entity_errors` | Another person's or project's fact is attributed (`crossEntity.forbid`) |
| `paraphrase_recall` | Share of paraphrase needs answered (the semantic-mismatch target) |
| `indirect_resolution` | Share of indirect references resolved to the right fact |
| `language_mismatch_recall` | Factual correctness on language-mismatch scenarios (translations accepted via `match`) |

The answer's language and the wording of a clarifying question are left to the blind judge, because regexes would be unreliable proxies. The grader is frozen **with** the data (`--scorer`).

## 2. Task 2: reviewer-only evaluation mode ([aqua/eval/governance/reviewerMode.mjs](aqua/eval/governance/reviewerMode.mjs))

`answer-eval`, `answer-judge` (answering, judging and `--merge`) and `answer-analyze` accept `--v3-dataset-file <file> --results-dir <dir> --reviewer "<name>"`. They **refuse unless:**

1. `AQUA_V3_REVIEWER_MODE=yes` is set (an explicit, per-terminal switch);
2. a v3 freeze record exists, and the file's sha256 equals the frozen evaluation hash (**byte for byte**);
3. the dataset file is **outside** the repository (links resolved);
4. `--results-dir` is an existing directory **outside** the repository. Per-item answers, judgements, review queues and analyses are written only there;
5. `--reviewer` names the reviewer recorded in the freeze record.

**Labelling:**

- The analysis labels a result **independent** only with the **canonical** freeze record (`aqua/eval/datasets/acib.v3.FREEZE.json`).
- `AQUA_V3_FREEZE_FILE` can point elsewhere only to validate the machinery. Every such output says **"VALIDATION ONLY — non-canonical freeze record"** and is never labelled independent.
- **A new `very-long` regime** (the secondary v3 regime) is the long mechanism with a filler target of `veryLongFillerTargetChars`, defaulting to 60,000 characters.

## 3. Task 3–5: declarations, statistical specification, freeze

### 3.1 Declarations ([AQUA_ACIB_V3_DECLARATIONS.md](AQUA_ACIB_V3_DECLARATIONS.md))

- The canonical **author** and **reviewer** declarations are exported as constants. The manifest must carry them **verbatim**, with dates.
- Development authors must differ from evaluation authors and from the reviewer.
- The founder lists every implementation author, including AI agents.
- The manifest template is updated ([aqua/eval/governance/acib-v3-manifest.template.json](aqua/eval/governance/acib-v3-manifest.template.json), placeholders only).
- The [authoring brief](AQUA_ACIB_V3_AUTHORING_BRIEF.md) is updated with: 174 / 62 scenarios; the two new categories with their fields; the new quality checks; a link to the declarations.

### 3.2 Statistical analysis specification ([AQUA_ACIB_V3_ANALYSIS_SPEC.md](AQUA_ACIB_V3_ANALYSIS_SPEC.md); pre-registration draft)

**Primary endpoint:**

- **Definition:** **paired factual correctness** (judge factual correctness = 2), in the **short and long** regimes.
- **Effect:** paired risk difference, with a 95% case-level bootstrap CI.
- **Test:** **exact McNemar**, with **Holm** correction across the two regimes.
- **Minimum meaningful improvement:** **+5 percentage points** (for founder confirmation).

**Reported separately:**

- **hallucination** (paired McNemar; a harm endpoint);
- **critical-category regressions** (flag at RD ≤ −10 pp in `changing`, `contradiction`, `missing`, `negative`, `cross-person`, `cross-project`, `tempting`);
- judge score with effect size dz;
- deterministic v3 metrics;
- the noise control (identical prompts);
- the prompt-changed subset (no p-values);
- categories (no tests);
- the missing-data sensitivity analysis;
- the very-long regime as secondary.

**Decision rule** (`claimVerdict`, tested):

| Verdict | Meaning |
|---|---|
| `regression` | A primary regime got significantly worse |
| `not-claimable-hallucination-increase` | An improvement, but hallucination rose significantly |
| `improvement` | Significant, at or above the meaningful threshold, CI excludes 0, no harm flags |
| `improvement-with-critical-regressions` | As above, but a critical category is flagged |
| `significant-below-meaningful` | Significant, but below the meaningful threshold |
| `no-detectable-difference` | Otherwise |
| `not-applicable` | Any development evidence |

**Pre-registration:** the spec's sha256 must be entered in the manifest. The freeze tool refuses if the file changed since, and every analysis records the code hashes it used.

### 3.3 Freeze process ([aqua/scripts/acib-v3-freeze.mjs](aqua/scripts/acib-v3-freeze.mjs))

**Requires:**

- a valid manifest (declarations, authors, reviewer, criteria, spec hash);
- the evaluation set outside the repository;
- both sets passing the builder checks (174 / 62, 13 categories, reachable annotations, honest paraphrase flags, language and indirect annotations, answerability rules, filler present);
- **no development scenario sharing an id or question with an evaluation scenario**;
- `--scorer` (the v3 grader) and `--analysis-spec` whose hash matches the manifest.

**Never overwrites** an existing freeze. **`--dry-run`** runs every check and writes nothing.

**Validated:** a synthetic 174 / 62 package with all 13 categories passes the dry run, and nothing is written. Each refusal path is tested: changed spec, missing grader, evaluation set inside the repository, development/evaluation overlap.

### 3.4 Current hashes (record at pre-registration; the spec hash goes into the manifest)

| File | sha256 |
|---|---|
| `AQUA_ACIB_V3_ANALYSIS_SPEC.md` | `d855044733c0caf8afe9c90bdfc254b758939d2388be4ab0dbe0ad7c164fd4ed` |
| `aqua/eval/answer/answerGraderV3.mjs` | `4e0a2894e8168367732910c8115c0057ba1d5c64f17ab1315a46daef08ae1fd7` |
| `aqua/eval/answer/answerGrader.mjs` (v1/v2, unchanged) | `9fd2495d705bdd069c834437b804bd70a856eef143d7efd10c51358b1231efda` |
| `aqua/eval/answer/pairedAnalysis.mjs` | `89dff18b875c0f3de28399737123ffdb7b98f78c4b8bd79980d67432cc9b512b` |
| `aqua/eval/answer/judgeRunner.mjs` (judge rubric, unchanged) | `f18c26dad01c3108c33e2882b1f76b0ba0850b41f3dd4f1e35965a8ddc8a3f51` |
| `aqua/scripts/answer-analyze.mjs` | `b49c8171db0d02a847e4e8ec2b616cbc9f9ef577c7c1ae3571091b4702fe1312` |

The spec is a draft: confirming its open values (§6) changes its hash, and the confirmed hash is the one registered.

### 3.5 Daily production-usage check (D-P2-5; `zeroBudgetGate`)

Every live start with existing pools requires `productionUsageCheck { date, by, method, remainingDailyTokens }`:

- `date` must be **today in UTC**; a new UTC day needs a new check;
- the remaining daily quota must be **at least twice** the largest group budget (≥ 200,000 with the 100k ceiling), so the evaluation can never take more than half of what production has left that day.

The founder or reviewer reads the remaining quota in the Groq console; code cannot see it.

**Note:** the earlier smoke-test config (`C:\Users\dell\aquiplex-eval\config.json`) is now refused, because it has no token budgets and no daily check. That is intended; it was single-use.

## 4. Tests (from `aqua/`)

| Command | Result |
|---|---|
| `node scripts/run-tests.mjs eval/tests/acibV3Readiness.test.js` (**new**) | **15/15** |
| `node scripts/run-tests.mjs eval/tests/acibV3Governance.test.js` (updated for D-P2-3 and the declarations) | **7/7** |
| All evaluation suites (13 files) | **226/226** |
| `node scripts/run-tests.mjs src/providers` (production) | **199/199** |
| Bite checks (13 mutations; each → failures; files restored, sha256 verified; freeze file never created) | Reviewer switch, hash match, results-dir location, canonical record, spec-hash check, dev/eval overlap, daily-check date, claim-rule development guard, primary-endpoint definition, language annotation, verbatim declaration, clarification targeting, dev/eval author overlap → each caught (1–2 failures) |
| Leak scan (real `.env` values, counts only) | 48 values × 15 changed or new files → **0 hits** |

**The new tests cover:**

- the synthetic 174 / 62 set passing;
- every new dataset rule;
- the declaration, development-author and spec-hash rules;
- a freeze dry run that passes with nothing written, and its 4 refusal paths;
- freeze record contents;
- the grader for every answerability type plus the tempting, cross-entity, paraphrase, indirect and language metrics;
- v1/v2 metrics unchanged;
- the primary endpoint excluding hallucination, with hallucination reported separately;
- all 7 verdicts;
- 6 reviewer-mode refusals;
- **an end-to-end reviewer-mode validation** (answer, judge, merge, analyse as dry runs with a mock transport): all outputs outside the repository, labelled VALIDATION ONLY and DEVELOPMENT, verdict `not-applicable`, 0 external requests;
- the daily production check (missing, yesterday's date, insufficient quota, accepted, new UTC day).

**Existing tests adjusted:**

- production-mode test configs gained a same-day `productionUsageCheck`;
- the analysis CLI test reads the new `primary` field and checks the verdict;
- the governance manifest fixture gained the declarations, development authors and spec hash;
- the plan-count test now expects 174 / 62.

## 5. Final v3 execution plan (nothing runs until D-P2-7 is satisfied and the founder approves separately)

### 5.1 Readiness checklist (D-P2-7)

| Condition | Status |
|---|---|
| v3 grader | ✅ Built and tested; frozen with the data |
| Reviewer-only live mode | ✅ Built and tested (validation mode end to end) |
| Freeze process | ✅ Validated (dry run) |
| Analysis specification | 🟡 Draft. Founder confirms the open values (§6), then registers its hash. |
| Independent authors (≥ 2) and reviewer | ❌ Not appointed (D-P2-1) |
| Frozen independent dataset | ❌ Does not exist |
| Reviewer approval (signed declaration) | ❌ |
| Resource budget approved | 🟡 Proposed (§5.3) |
| Founder's separate execution approval | ❌ |

### 5.2 Steps

1. **Founder:** appoint ≥ 2 evaluation authors, ≥ 1 development author and 1 reviewer. Confirm the spec and category counts, and record the spec hash.
2. **Authors:** write the 174 evaluation scenarios (sent only to the reviewer) and the 62 development scenarios (written afterwards, different authors and domains), following the [brief](AQUA_ACIB_V3_AUTHORING_BRIEF.md). Sign the declarations.
3. **Reviewer:** add the standard filler list (`filler`, `fillerTargetChars: 9000`, `veryLongFillerTargetChars: 60000`), spot-check at least 20 scenarios and sign. Then run `node scripts/acib-v3-freeze.mjs --manifest <m> --scorer eval/answer/answerGraderV3.mjs --analysis-spec ../AQUA_ACIB_V3_ANALYSIS_SPEC.md --dry-run`, and the same without `--dry-run`. Only the hash record enters the repository.
4. **Offline sizing (no requests):**
   - measure all regimes' prompt sizes on the **development** set, especially very long, to confirm the 4,000-token per-request cap holds;
   - reviewer-mode dry run on the frozen file (mock transport, aggregates only).
5. **Founder:** approve the execution and budget, and fill in `founderDecision.at` in the reviewer's copy of `C:\Users\dell\aquiplex-eval-example\config-acib-v3.example.json`.
6. **Each evaluation day:**
   - the founder or reviewer checks the Groq console and updates `productionUsageCheck` (today's date, remaining tokens ≥ 200,000);
   - the reviewer runs the commands in §5.4; each run resumes where the previous one paused.
7. **After all answers:** judging runs, `--merge`, then `answer-analyze`. Only aggregates and the verdict are released; sealed items are opened afterwards for diagnosis, labelled post hoc.

### 5.3 Resource budget ($0; `GROQ_API_KEY_1` only)

| Item | Value |
|---|---|
| Answer requests | 174 × 2 regimes × 2 arms = **696**, plus very long (secondary; 2 per category = 26 scenarios × 2 arms) = **52** → **748** |
| Judge requests | **748** |
| **Total requests** | **1,496** |
| Expected tokens | answers ≈ 748 × 1.6k ≈ 1.2M; judging ≈ 748 × 0.8k ≈ 0.6M → **≈ 1.8M** |
| Hard ceilings | 4,000 per request (≈ 6.0M if every request hit it); **100,000 per day** for the single group; 100,000 per run; 80 requests per run |
| Duration | **≈ 18–20 evaluation days** at 100k/day; longer if the daily check finds less than 200k remaining |
| Protections | Pacing ≥ 61 s and ≤ 4,000 TPM; any 429 pauses; billing or authentication errors stop; no key rotation or fallback; one run at a time; both approval switches plus the reviewer switch; resumable without repeats |

### 5.4 Reviewer commands (PowerShell; NOT authorised; placeholders in `< >`)

```powershell
cd C:\Users\dell\Downloads\aquiplex-platform\aquiplex-platform\aqua
$env:AQUA_ANSWER_EVAL_APPROVED="yes"; $env:AQUA_EVAL_LIVE_APPROVED="yes"; $env:AQUA_V3_REVIEWER_MODE="yes"
# answers (repeat daily until each reports COMPLETED)
node scripts/answer-eval.mjs --execute --answers-only --regime short --limit 174 --arms A,H --label acib-v3-short --v3-dataset-file <eval file> --results-dir <results dir> --reviewer "<reviewer>" --provider-config <config-acib-v3.json>
node scripts/answer-eval.mjs --execute --answers-only --regime long  --limit 174 --arms A,H --label acib-v3-long  --v3-dataset-file <eval file> --results-dir <results dir> --reviewer "<reviewer>" --provider-config <config-acib-v3.json>
node scripts/answer-eval.mjs --execute --answers-only --regime very-long --sample-per-category 2 --sample-seed acib-v3-verylong-1 --arms A,H --label acib-v3-verylong --v3-dataset-file <eval file> --results-dir <results dir> --reviewer "<reviewer>" --provider-config <config-acib-v3.json>
# judging (same pattern, per label), then offline:
node scripts/answer-judge.mjs --execute --label acib-v3-short --regime short --arms A,H --v3-dataset-file <eval file> --results-dir <results dir> --reviewer "<reviewer>" --provider-config <config-acib-v3.json>
node scripts/answer-judge.mjs --label acib-v3-short --regime short --arms A,H --merge --v3-dataset-file <eval file> --results-dir <results dir> --reviewer "<reviewer>"
node scripts/answer-analyze.mjs --labels acib-v3-short,acib-v3-long --secondary-labels acib-v3-verylong --v3-dataset-file <eval file> --results-dir <results dir> --reviewer "<reviewer>"
Remove-Item Env:AQUA_ANSWER_EVAL_APPROVED, Env:AQUA_EVAL_LIVE_APPROVED, Env:AQUA_V3_REVIEWER_MODE
```

**Remaining small items before execution (evaluation code only):**

- a reviewer build helper that adds the standard filler list and validates the file in one command (about 0.25 day; today this is a documented manual step);
- the very-long prompt-size measurement on the development set (step 4).

## 6. Founder confirmations still needed

| # | Item | Proposed |
|---|---|---|
| C-1 | Minimum practically meaningful improvement | **+5 percentage points** paired risk difference |
| C-2 | Critical categories and regression flag | `changing`, `contradiction`, `missing`, `negative`, `cross-person`, `cross-project`, `tempting`; flag at RD ≤ −10 pp |
| C-3 | Counts for the new categories | language-mismatch 12 eval / 4 dev; indirect-reference 12 / 4 (total **174 / 62**) |
| C-4 | Secondary very-long regime size | 2 scenarios per category (26), stratified and seeded |
| C-5 | Appointments (D-P2-1) | The founder appoints people; none is assumed |
| C-6 | Execution and budget approval (D-P2-7) | After the checklist in §5.1 is complete |

## 6a. Founder decisions C-1 to C-6, applied (2026-11-12, later). They supersede §3.2, §3.4 and §6 where they differ.

| # | Decision | Implementation |
|---|---|---|
| C-1 | Meaningful improvement = +5 pp; both statistical and practical; significant below +5 pp is not meaningful; ≥ +5 pp without evidence is inconclusive | `SPEC.minimumMeaningfulImprovement = 0.05`. Verdicts `meaningful-improvement` (Holm p < 0.05, CI lower > 0, RD ≥ +5 pp), `significant-below-meaningful`, **`inconclusive`** (new) |
| C-2 | Six critical measures, a ≥ 10 pp decline flagged, raw counts always shown, hallucination kept separate, no concealment | `CRITICAL_MEASURES` (below). Every rate is `k/n (pct%)`. A flagged measure **blocks** the improvement claim (`not-claimable-critical-regression` / `not-claimable-hallucination`). The CLI prints all six measures and `CRITICAL FLAGS`. |
| C-3 | language-mismatch 12/4, indirect-reference 12/4 | Already in `PLAN` (174 / 62) — confirmed |
| C-4 | Very-long = 2 per category, a stress test, separate, never confirmatory | `SPEC.stressRegimes = ['very-long']`. The analysis **refuses** a very-long label as primary. Stress diagnostics per arm with raw counts: retrieval, required facts, distractor and tempting contamination, stale assertions, contradiction handling, prompt-token budget, degradation vs long. |
| C-5 | No one appointed; no impersonation; freeze blocked | The manifest requires `founder` and `priorResultsExposed[]`. The founder, implementers and anyone exposed to prior results are barred from evaluation authorship and review. Placeholder names and future dates are refused. The repository template is refused (4 placeholder errors) and the freeze CLI refuses it. |
| C-6 | Live evaluation not approved | No change to any gate. No request was sent; the protections stay as documented. |

**Final critical-measure identifiers** (dataset categories are unchanged and unmerged; they are referenced, not renamed):

| Identifier | Scope | Success per answer |
|---|---|---|
| `wrong-person-attribution` | category `cross-person` | No `crossEntity.forbid` fact in the answer **and** judge factual correctness = 2 |
| `wrong-project-attribution` | category `cross-project` | Same, for projects |
| `hallucination-unsupported-claims` | All scenarios | Judge `hallucination = false`, no ungrounded figure, no missing fact asserted as known |
| `answerability-uncertainty` | `answerable-with-caveat` / `unanswerable`, or scenarios with `unknowns[]` | `answerability_handling = 1` (or `uncertainty_handling = 1` where only unknowns are annotated) |
| `clarification-when-missing` | `needs-clarification` | Exactly one targeted question, nothing invented |
| `tempting-distractor-resistance` | Scenarios with `tempting[]` | No tempting fact used |

**Grader requirement, and a correction to my draft.**

- **What I verified:** the judge rubric gives factual correctness 2 to an answer with no wrong statement. A cautious answer was therefore not penalised.
- **The flaw that check exposed:** abstaining on an *answerable* question also scored as correct.
- **The fix — evidence-aware primary endpoint:**
  - **Evidence sufficient** (required facts exist): correct = no wrong statement **and** the required facts are given.
  - **Evidence insufficient:** correct = no wrong statement. A cautious answer or a necessary clarification is never a factual failure; a confident wrong guess is.
- **New grader fields:** `evidence_sufficient`, `required_facts_given`, `unknown_asserted`.
- **New answerability value:** `unanswerable` (additive; it must declare `unknowns[]`).
- **Unchanged:** the v1/v2 grader file and outputs (hash `9fd2495d…`, tested). Historical result files have not been modified since the previous report.
- **Distinct dimensions:** factual correctness, answerability, clarification, hallucination and personalisation remain separate measures.

**Tests:**

| Command | Result |
|---|---|
| `node scripts/run-tests.mjs eval/tests/acibV3Decisions.test.js` (**new**) | **19/19** |
| All evaluation suites (14 files) | **244/244** |
| `src/providers` | **199/199** |
| Bite checks | 13 mutations, each caught (1–3 failures): evidence-aware primary (both directions), the 10 pp flag, `inconclusive`, critical-regression and hallucination blocking, very-long-as-primary refusal, founder/exposed author bar, exposed reviewer bar, placeholders, future dates, `unanswerable` grading, guess detection |
| Leak scan | 0 hits |

**The new tests cover:**

- the founder's five grader cases (answerable correct; with-caveat qualified; unanswerable handled; ambiguous clarified; confident guess fails);
- abstention on an answerable question failing;
- v1/v2 scores unchanged;
- the six measure ids checked against the PLAN, the brief and the grader;
- 13 categories intact;
- the 10 pp flag with raw counts (−20 pp and −11.1 pp);
- `0/0` shown for empty scopes;
- aggregate improvement unable to hide hallucination or critical regressions;
- the C-1 boundaries (exactly +5 pp, below it, without significance);
- the stress test (diagnostics, refused as primary, degradation vs long);
- C-5 independence and placeholders;
- the template refused by the freeze CLI with nothing written;
- C-6 (no live transport without the switch; the v3 example refused; `GROQ_API_KEY_1` only; 100k/day; no rotation or wait).

**Updated hashes** (sha256; these supersede §3.4):

| File | sha256 |
|---|---|
| `AQUA_ACIB_V3_ANALYSIS_SPEC.md` (v2) | `97e1e804bd2b9e81336d61e728eb8cef0a9a2fc9f1f36bc4733aae1cad8b3b84` |
| `answerGraderV3.mjs` | `74401895298581101078ecb715a8f94e35b854cd34422e79283676188f20ba86` |
| `answerGrader.mjs` (unchanged) | `9fd2495d705bdd069c834437b804bd70a856eef143d7efd10c51358b1231efda` |
| `pairedAnalysis.mjs` | `e3c6f39c47a86ef33b46ce037cfeb60193e3a63e019028513580007ade5db50f` |
| `judgeRunner.mjs` (unchanged) | `f18c26dad01c3108c33e2882b1f76b0ba0850b41f3dd4f1e35965a8ddc8a3f51` |
| `answer-analyze.mjs` | `1067654fc34000e60c4a69c932090b36c3dc84fd509b1fd97f0cd55f561d3321` |

**Still open:**

- the appointments (C-5);
- execution approval (C-6, D-P2-7);
- the reviewer build helper;
- the very-long prompt-size measurement on the development set.

**Git:** 169 uncommitted paths: the 168 preserved plus `aqua/eval/tests/acibV3Decisions.test.js`.

## 6b. Final preparation stage (2026-11-12, latest). This supersedes §3.4 and §6a hashes.

### Readiness, by level. ACIB v3 is NOT frozen and NOT independently validated.

| Level | Status |
|---|---|
| **1. Tooling readiness** | ✅ **Ready, offline.** v3 grader, reviewer-only mode, reviewer build helper, freeze tooling (dry run validated), paired analysis with the final verdict rules, critical-measure denominators, hallucination guardrail, prompt-size measurement. 265/265 evaluation tests. |
| **2. Dataset readiness** | ❌ **No v3 dataset exists.** Nothing is authored or frozen. Only development data (`acib.v2.dev`) was measured. |
| **3. Independent-review readiness** | ❌ **No authors or reviewer are appointed** (C-5). The freeze is blocked; the template is refused. Fixture identities run only against non-canonical records, labelled VALIDATION ONLY. |
| **4. Live-execution authorisation** | ❌ **Not authorised** (C-6). No request has been sent; no quota has been consumed. |

### Final statistical decision rule

The full rule is in [AQUA_ACIB_V3_ANALYSIS_SPEC.md](AQUA_ACIB_V3_ANALYSIS_SPEC.md) §5.

- **Meaningful improvement, in at least one primary regime:** Holm-adjusted exact-McNemar p < 0.05 with RD > 0, **and** RD ≥ +5 pp, **and** the 95% bootstrap CI lower bound > 0.
- **The other regime:** no significant regression. A significant regression in either regime gives `regression`.
- **Guardrails** (hallucination or a critical measure) block an improvement claim.
- **Inconclusive:** RD ≥ +5 pp without sufficient evidence.
- **Never averaged:** short and long are always judged separately.
- **Precedence:** `regression` → `not-claimable-hallucination` → `not-claimable-critical-regression` → `meaningful-improvement` → `significant-below-meaningful` → `inconclusive` → `no-detectable-difference`.

**Unchanged:** α = 0.05, exact McNemar, Holm across the two regimes, a 95% percentile bootstrap over cases (10,000 resamples, seeded).

**One implementation gap closed (logic, not method):** a regime that was Holm-significant with RD ≥ +5 pp but a CI lower bound ≤ 0 fell through to `no-detectable-difference`. It now returns `inconclusive`, as the rule requires.

**Flagged for founder review (not changed):** the CI is per regime and not multiplicity-adjusted, while the test is Holm-adjusted. Requiring both is conservative. See spec §5, "Method notes".

### Critical-measure denominators

- **Eligible pairs only:** in scope, and gradable on both arms.
- **Raw counts:** both arms are printed as `k/n (pct%)`.
- **Empty scope:** both arms read `not available`, with no RD and no flag.
- **Coverage:** the output lists `eligibleCaseIds` and `inScopeButUngradable` for each measure.
- **Primary endpoint:** also `not available` when a regime has no complete pair.

### Hallucination guardrail

- **Case-level list:** `harm.cases` lists every harmful answer with its case, arm, category and type:
  - invented personal fact (with the judge's claims);
  - unsupported figure;
  - missing fact presented as known;
  - wrong-person, wrong-project or wrong-entity attribution.
- **Counts:** per-arm counts for every type, as k/n, are printed on every analysis.
- **Attached to every verdict:** the harm summary is part of every verdict, including `meaningful-improvement` and development `not-applicable`.
- **What blocks a claim:** a significant hallucination increase, or a flagged hallucination measure.

### Reviewer build helper ([aqua/scripts/acib-v3-reviewer-prepare.mjs](aqua/scripts/acib-v3-reviewer-prepare.mjs), [aqua/eval/governance/reviewerPrepare.mjs](aqua/eval/governance/reviewerPrepare.mjs))

```powershell
cd C:\Users\dell\Downloads\aquiplex-platform\aquiplex-platform\aqua
node scripts/acib-v3-reviewer-prepare.mjs --manifest <frozen manifest> --eval-file <evaluation file outside the repo> --results-dir <new or empty dir outside the repo> --reviewer "<recorded reviewer>" --dry-run
# then the same without --dry-run (creates only prepared.json and README.txt in the results directory)
```

**22 checks.** It verifies:

- the freeze record;
- the manifest: independence, verbatim dated declarations, no placeholders, no future dates;
- manifest ↔ record consistency: reviewer, sign-off date, authors, declaration dates, spec hash, spec verified at freeze, grader recorded;
- that the spec file is unchanged;
- the reviewer's identity;
- the evaluation file: outside the repository, the frozen sha256 byte for byte, not the development set, passing the role-eval checks;
- the results directory: outside the repository and empty;
- that the evaluation file is unchanged after all checks.

**What it never does:** read credentials, send a request, or write the freeze record or the evaluation file.

**Validation only:** a non-canonical freeze record (`AQUA_V3_FREEZE_FILE`) produces a VALIDATION ONLY result with `independentEligible: false`.

Sample dry run (fixture package, non-canonical record): all 22 checks ✓, `DRY RUN — nothing written`, banner `VALIDATION ONLY — non-canonical freeze record; can never produce an independent result`.

### Very-long prompt-size measurement (development data only: `acib.v2.dev`)

- **Tool:** `scripts/measure-prompt-sizes.mjs`. Only development sets are allowed; any file matching a frozen evaluation hash is refused.
- **Prompt path:** the exact evaluation path (`acibCases` → `runScenario`, capture), unmodified and untruncated.
- **Requests:** 0 external.
- **Results:** `aqua/eval/measurements/acib-v2-dev.prompt-sizes.{very-long,long}.json`, per scenario and arm.

| Very long (60,000-char history; 80 prompts) | Min | Median | Mean | p95 | Max |
|---|---|---|---|---|---|
| Prompt characters | 3,744 | 5,705 | 5,726 | 6,775 | 7,008 |
| Estimated tokens, typical (chars ÷ 4.48) | 836 | 1,273 | 1,278 | 1,512 | 1,564 |
| Conservative pre-send estimate incl. 1,500 output (what the cap checks) | — | — | — | — | **3,868** (cap 4,000) |

- **By arm:** A has a mean of 5,624 characters and a maximum of 6,802; H has a mean of 5,828 and a maximum of 7,008.
- **Largest prompts:** `d-hc-job`/H (7,008 characters, conservative 3,868), `d-hc-plan`/H (6,963), `d-mi-trip`/H (6,807), `d-hc-job`/A (6,802), `d-tp-friend`/A (6,775).
- **By category:** history-change and missing have the largest; contradiction and cross-project the smallest.
- **Risks found:** none over the per-request cap, the 8,000-tokens-per-minute limit, or the 131k context window.

**Findings:**

1. **Very-long prompts are the same size as long ones** (mean difference −15 characters; range −655 to +187). The context engine selects what goes into the prompt, so 60,000 characters of history do not enlarge it. The very-long regime therefore stresses **selection amid more history**, not the context budget.
2. **The per-request cap margin is thin.** The largest conservative estimate is 3,868 against a cap of 4,000, a margin of 3.3%. v3 scenarios with more facts per history (`spread`: 3–6 facts) could exceed it. They would be **rejected before sending** (`stopped-rejected`), never truncated. See the founder issues below.

**Limitations:**

- **Token counts are estimates.** No local provider tokenizer is available. The ratios come from two live observations (4.48 and 3.92 characters per token).
- **The very-long history repeats a small filler list.** The development filler has 40 distinct messages (1,370 characters), cycled about 44 times (up to 1,752 filler turns). Repetition may be deduplicated by the memory engine, which is less realistic than varied history.

### Tests (final stage)

| Command | Result |
|---|---|
| `node scripts/run-tests.mjs eval/tests/acibV3FinalPrep.test.js` (**new**) | **21/21** |
| All evaluation suites (15 files) | **265/265** |
| `node scripts/run-tests.mjs src/providers` | **199/199** |
| Bite checks | 11 mutations, each caught (1–3 failures): the inconclusive CI branch, the not-available rule, eligible IDs, the missing-fact harm type, harm attached to verdicts, the dev-set refusal, the empty results directory, the spec check, dry-run writes, the measurement allow-list, the canonical-record check |
| Leak scan | 48 values × 15 changed files and logs → 0 hits |

**The new tests cover:**

- every verdict branch and its precedence (including that the spec states it in order);
- regression in either regime;
- a meaningful improvement alongside a non-significant decline in the other regime;
- all guardrails;
- the CI edge cases, including a lower bound of exactly 0;
- no averaging;
- the denominator policy (empty, eligible-only, ungradable listed, primary not available);
- every harm type, case by case, with harm attached to the verdict;
- the helper: fixture success, dry run writing nothing, the real run creating only two files with no secrets, 12 refusal paths, and the CLI exit codes;
- the measurement: evaluation sets refused, method labelled as estimates, the statistics shape, 0 external requests.

**One transparency note:** during the measurement allow-list bite check, with the allow-list deliberately disabled, the test ran the tool on `acib.heldout.v1`, an old development-era set. It printed sizes to the test log only; nothing was saved. No v2 or v3 evaluation set was measured.

### Remaining human dependencies

- **Appointments:** ≥ 2 independent evaluation authors, ≥ 1 development author, 1 independent reviewer, with signed declarations (C-5).
- **Datasets:** author the 174 / 62 scenarios.
- **Spec confirmation:** confirm the spec (current hash below) and register it in the manifest.
- **Reviewer steps:** add the filler (consider a larger, varied filler list for very long), freeze, run the reviewer helper.
- **Execution approval** (C-6), and a daily production-usage check on each evaluation day.

### Issues for founder review

1. **CI and Holm:** keep the per-regime 95% CI (current, conservative) or pre-register a multiplicity-adjusted CI.
2. **Per-request cap:** 4,000 leaves a 3.3% margin on development data. Options: keep it (oversize v3 requests are rejected, never sent or truncated), or set 4,500, still well under 8,000 TPM. Decide before execution approval.
3. **Very-long filler realism:** the development filler cycles 40 short messages. Should the reviewer's v3 build use a larger, varied filler list for the very-long regime?

### Hashes (sha256; supersede earlier tables; the spec is still a draft until the founder registers it)

| File | sha256 |
|---|---|
| `AQUA_ACIB_V3_ANALYSIS_SPEC.md` | `42bd6cce83a61632c0ce5460698f8f84436c2e04eb5ef61dbc0a41e1f5b74cd7` |
| `pairedAnalysis.mjs` | `921447667ddd7929d1a1ce50bfa4fba73000d5f5ae7c7bcbc3fb8333c6999bf1` |
| `answerGraderV3.mjs` (unchanged this stage) | `74401895298581101078ecb715a8f94e35b854cd34422e79283676188f20ba86` |
| `answerGrader.mjs` (v1/v2, unchanged) | `9fd2495d705bdd069c834437b804bd70a856eef143d7efd10c51358b1231efda` |
| `answer-analyze.mjs` | `c9d1a93bc8bfe71e3e7271fe07ebb46e9ed017bb8fdd510c0f3fac6e93029aec` |
| `reviewerPrepare.mjs` | `3b6271e2d01d1cbe79e34b2afa1dc01a129a1b3551d4d3bcc45b905a8efed532` |

**Git:** `main` @ `839ea0d1`. 173 uncommitted paths: the 169 preserved plus 4 new top-level paths (`aqua/eval/measurements/`, `acibV3FinalPrep.test.js`, `acib-v3-reviewer-prepare.mjs`, `measure-prompt-sizes.mjs`). `reviewerPrepare.mjs` sits inside an already-untracked directory. Nothing committed, pushed, stashed or deployed.

## 6c. Final founder decisions D-1 to D-3 (2026-11-12). These resolve the three issues in §6b.

**D-1: confidence intervals (method unchanged).**

- **Significance:** exact McNemar, **Holm-corrected across the two primary regimes**.
- **Intervals:** every confidence interval is a **95% percentile bootstrap computed separately for each regime**. They are **not multiplicity-adjusted** and **not simultaneous**.
- **Purposes:** the two serve distinct purposes (spec §5).
- **Labels in every analysis output:**
  - `ci95Label` on every interval;
  - `mcnemarHolmPLabel` on the corrected p-value;
  - the per-regime p-value labelled "uncorrected";
  - a `method.reporting` block, and a `REPORTING (D-1)` line in the CLI.
- **CLI wording:** `95% CI [..] pp (per regime, not multiplicity-adjusted) · McNemar p … uncorrected, … Holm-corrected across the two primary regimes`.

**D-2: per-request ceiling 4,500 tokens** (was 4,000). Updated in the v3 example, the deferred v2 diagnostic example, the existing-pools example, and the measurement tool.

- **Unchanged:**
  - 100,000 evaluation tokens per day (group budget);
  - per-run budgets (v3: 100,000; diagnostic: 70,000);
  - 80 requests per run;
  - the 2× production-usage margin (remaining ≥ 200,000);
  - refusal of oversized requests before sending, never truncated;
  - no key rotation or fallback;
  - immediate stop on quota or billing.
- **One documented dependency:** the per-minute evaluation share (`rateLimits.tokensPerMinute`) is also raised from 4,000 to 4,500.
  - **Why:** a single admissible request can now be 4,500 tokens.
  - **Still safe:** requests stay at least 61 seconds apart (one per minute), well under Groq's 8,000 TPM, and daily consumption does not change.
- **New consistency rule:** a per-request cap above the per-minute share is refused.
- **Not modified:** the executed smoke-test config, which is a record of what ran.
- **Development measurements:** recorded against 4,000 and left unmodified. The largest conservative estimate (3,868) is within both caps.

**D-3: very-long filler diversity** ([brief §2a](AQUA_ACIB_V3_AUTHORING_BRIEF.md)).

- **Builder checks** (`validateDataset`):
  - at least 300 distinct messages, no duplicates;
  - at least 8 topics;
  - varied lengths (longest at least 4× the shortest);
  - complete and accurate `fillerMetadata` (composition, authors, topics, message count, length range, similar-but-irrelevant material, who reviewed answer-neutrality);
  - `veryLongFillerTargetChars` at least 60,000;
  - a **mechanical answer-neutrality check**: no filler message may contain any scenario's answer-bearing pattern.
- **Freeze checks:**
  - evaluation filler authored by evaluation authors;
  - development filler authored by development authors;
  - **no message shared** between the two libraries.
- **Declaration:** the author declaration now includes the filler: "written without knowledge of, or intent to favour, any particular system configuration, and do not change the correct answer". It is updated verbatim in the declarations document, the brief and the manifest template.
- **What stays human:** realism, and the absence of favouring, are attested by the authors and the reviewer.
- **Stress test only:** the very-long regime stays a separate stress test, refused as a primary label.

**Tests**

| Command | Result |
|---|---|
| `node scripts/run-tests.mjs eval/tests/acibV3FounderFinal.test.js` (**new**) | **12/12** |
| All evaluation suites (16 files) | **277/277** |
| `src/providers` | **199/199** |
| Bite checks | 9 mutations, each caught: CI label removed, cap consistency rule, pre-send size refusal, filler minimum, answer-neutrality check, shared-filler refusal, development filler authorship, duplicate filler, CLI interval wording |
| Leak scan | 48 values × 17 files and logs → 0 hits |

Existing fixture builders now use a shared synthetic filler fixture (`aqua/eval/tests/fixtures/acibV3Filler.mjs`, labelled TEST FIXTURE ONLY).

**Hashes** (these supersede §6b; the spec is still a draft until the founder registers it):

| File | sha256 |
|---|---|
| `AQUA_ACIB_V3_ANALYSIS_SPEC.md` | `3f3a1d7432446c64a4c3d395fdce66b2e0f51ed52cc30dffd027d8eb1025a51e` |
| `pairedAnalysis.mjs` | `96f2b67b7d8fe71766a62efa0e0e93afa4e6d9a6cc784ad4fb5c6f1b1ecd55f8` |
| `acibV3Governance.mjs` | `4524301720bbc49301d6e196f844bc647ab10a57ebdb23ef3c29123a9035e8c6` |
| `answer-analyze.mjs` | `02432233b1c0d1bd97cd9eeb645346f2375e72452f04f5e06850c3be038aa573` |
| `acib-v3-freeze.mjs` | `5d1c9cc87d31d431dbc3cabe6bee06c47eef8b183e04aecbe93472c83ca4eef1` |

**Readiness levels: unchanged.**

| Level | Status |
|---|---|
| Tooling | ✅ |
| Dataset | ❌ None authored |
| Independent review | ❌ No one appointed |
| Live execution | ❌ Not authorised |

**Remaining human dependencies:**

- appoint the authors (evaluation and development) and the reviewer, and have them sign;
- author the 174 / 62 scenarios **and** the two separate filler libraries;
- confirm and register the spec hash;
- the reviewer freezes and runs the helper;
- execution approval, and a daily production-usage check on each evaluation day.

**Git:** 174 uncommitted paths: the 173 preserved plus `aqua/eval/tests/acibV3FounderFinal.test.js`. The filler fixture sits inside an already-untracked directory.

## 7. Files

| File | Change |
|---|---|
| `aqua/eval/answer/answerGraderV3.mjs` | **New:** v3 grader |
| `aqua/eval/governance/reviewerMode.mjs` | **New:** reviewer-only mode |
| `aqua/eval/governance/acibV3Governance.mjs` | Plan 174 / 62 with 2 new categories; declarations; development authors; spec hash; new dataset checks; freeze record fields |
| `aqua/scripts/acib-v3-freeze.mjs` | `--dry-run`; required grader and spec (hash-checked); development/evaluation overlap refusal |
| `aqua/eval/answer/pairedAnalysis.mjs` | Primary = paired factual correctness; hallucination endpoint; critical-category flags; `SPEC`; `claimVerdict`; v3 grader |
| `aqua/scripts/answer-analyze.mjs` | Reviewer mode; primary / secondary labels; verdict; code hashes |
| `aqua/scripts/answer-eval.mjs`, `answer-judge.mjs` | Reviewer mode (dataset and results outside the repository) |
| `aqua/eval/answer/evalRun.mjs` | Daily production-usage check in the gate; very-long regime |
| `aqua/eval/tests/acibV3Readiness.test.js` | **New** (15 tests) |
| `aqua/eval/tests/acibV3Governance.test.js` and 6 other test files | Updated as in §4 |
| `aqua/eval/governance/acib-v3-manifest.template.json` | Declarations, development authors, spec hash (placeholders) |
| `AQUA_ACIB_V3_ANALYSIS_SPEC.md`, `AQUA_ACIB_V3_DECLARATIONS.md` | **New** |
| `AQUA_ACIB_V3_AUTHORING_BRIEF.md` | Updated (D-P2-3) |
| `C:\Users\dell\aquiplex-eval-example\config-acib-v3.example.json` | **New**, outside the repository (refused as written; accepted once filled; refused when production has used too much today) |
| `C:\Users\dell\aquiplex-eval-example\config-diagnostic-v2.example.json` | Marked deferred (D-P2-4); daily-check placeholder |

**Git:** `main` @ `839ea0d1`. Nothing committed, pushed or stashed. **168 uncommitted paths:** the 164 preserved plus 4 new top-level paths (this report, the analysis spec, the declarations, the new test file). The other new files are inside directories that were already untracked.

**Stopped — awaiting founder review.**
