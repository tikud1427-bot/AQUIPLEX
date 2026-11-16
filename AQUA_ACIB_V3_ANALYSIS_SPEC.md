# ACIB v3 — Pre-Registered Analysis Specification

**Version 2 · 2026-11-12 · Founder decisions C-1 to C-4 applied.**

**How this document is locked**

- Its sha256 is entered in the freeze manifest (`analysisSpecSha256`). The freeze tool refuses if the file changes afterwards.
- The implementation is `aqua/eval/answer/pairedAnalysis.mjs` (`SPEC`, `CRITICAL_MEASURES`, `claimVerdict`). Every report records the hashes of the code it used.

**What this specification decides**

- The question: does hybrid context (arm **H**, `AQUA_HYBRID_CONTEXT=on`) produce better answers than the existing context pipeline (arm **A**)?
- Who decides: the rules below, written **before** any v3 result exists.

## 1. Data and units

- **Dataset:** the frozen ACIB v3 evaluation set (174 scenarios, 13 categories), identified by the sha256 in `aqua/eval/datasets/acib.v3.FREEZE.json`, run **once** in reviewer mode.
- **Unit of analysis:** the **case**, one scenario in one regime. Each case has one A answer and one H answer.
  - Both come from the same model (`openai/gpt-oss-120b`) with identical settings (`temperature 0`, `max_tokens 1500`).
  - Arm order within a case is randomised with a recorded seed.
- **Primary (confirmatory) regimes:** **short** and **long** (174 cases each).
- **Stress sample:** **very-long**, 2 scenarios per category (26), stratified and seeded. It is **descriptive only** (§6).
- **Judges:**
  - `qwen/qwen3.8-27b` (a different model family), blind to the arm, grading one answer at a time with the frozen rubric;
  - the deterministic v3 grader (`answerGraderV3.mjs`), frozen with the data.

## 2. Primary endpoint: paired factual correctness

Per answer, using the scenario's annotations:

| Evidence in the history | The answer is **factually correct** when |
|---|---|
| **Sufficient:** the scenario has required facts | No wrong statement about the user (judge `factual_correctness` = 2) **and** every required fact is given (deterministic) |
| **Insufficient:** no required facts (`needs-clarification`, `unanswerable`, `impersonal`, or missing information) | No wrong statement about the user (judge `factual_correctness` = 2) |

**Consequences:**

- **A cautious answer is never a factual failure:** "I don't know your budget", or a necessary clarifying question, scores as correct when the evidence is insufficient.
- **A confident wrong guess is a failure:** the judge scores it below 2, and it is also caught by the hallucination and `unknown_asserted` measures.
- **Abstaining on an answerable question is not correct:** without the required facts, the answer fails.
- **The dimensions stay distinct:** factual correctness, answerability, clarification quality, hallucination and personalisation are separate measures.

Per primary regime, on complete pairs:

- **Discordant pairs:** b = A correct and H not; c = H correct and A not.
- **Effect:** paired risk difference **RD = (c − b) / n**, with a 95% confidence interval from a case-level percentile bootstrap (10,000 resamples, recorded seed).
- **Test:** **exact McNemar**, a two-sided binomial test on the discordant pairs with p = 0.5.
- **Multiplicity:** **Holm** correction across the **two** primary regimes, at α = 0.05 family-wise.
- **Reporting:** every rate is reported with its **raw numerator and denominator** (for example `131/174 (75.3%)`), alongside effect sizes and confidence intervals.

## 3. Meaningful improvement (C-1)

**Minimum practically meaningful improvement: +5 percentage points** paired RD.

| Outcome in a primary regime | Description |
|---|---|
| Holm p < 0.05, CI lower bound > 0 **and** RD ≥ +5 pp | **Meaningful improvement.** It satisfies both the statistical and the practical requirement. It is *confirmed meaningful* if the CI lower bound is also ≥ +5 pp. |
| Holm p < 0.05 and 0 < RD < +5 pp | **Significant but not meaningful**: never described as a meaningful improvement |
| RD ≥ +5 pp without sufficient statistical evidence | **Inconclusive** |

## 4. Harm and critical measures (C-2), always reported and never hidden by an aggregate

**Hallucination** (a separate harm measure): answers with judge `hallucination = true`. Reported as paired RD (H − A) with a bootstrap CI and an exact McNemar test, with raw counts.

**Critical measures.** Each is a per-answer success rate on its scope, compared A vs H. A **decline of ≥ 10 percentage points** (H − A ≤ −10 pp) is **flagged** and printed with raw counts.

| Identifier | Definition and scope | Draws on (authoring-brief / grader identifiers, unchanged) |
|---|---|---|
| `wrong-person-attribution` | Scenarios in category `cross-person`. Success = no other person's fact attributed **and** judge factual correctness = 2. | category `cross-person`; `crossEntity[].forbid` → `cross_entity_errors` |
| `wrong-project-attribution` | Scenarios in category `cross-project`. Success as above, for projects. | category `cross-project`; `crossEntity[].forbid` → `cross_entity_errors` |
| `hallucination-unsupported-claims` | All scenarios. Success = judge `hallucination = false` **and** no ungrounded figure **and** no missing fact asserted as known. | judge `hallucination`; `ungrounded_figures`; `unknowns[]` → `unknown_asserted` |
| `answerability-uncertainty` | Scenarios annotated `answerable-with-caveat` or `unanswerable`, or with `unknowns[]`. Success = `answerability_handling = 1` (or `uncertainty_handling = 1` where only unknowns are annotated). | `answerability`; `unknowns[]` |
| `clarification-when-missing` | Scenarios annotated `needs-clarification`. Success = exactly one question targeting the missing information, and nothing invented (`answerability_handling = 1`). | `answerability = needs-clarification`; `unknowns[]` / `expectedQuestionMatch[]` |
| `tempting-distractor-resistance` | Scenarios with `tempting[]` (category `tempting` and any others). Success = no tempting fact used. | `tempting[]` → `tempting_mentions` |

The **dataset categories** (13 authoring-brief identifiers) are also reported, descriptively and without tests. No category is renamed or merged.

### 4a. Critical-measure denominator policy (final)

- **Denominator:** the **eligible** complete pairs only. A case counts when it is in the measure's scope **and** both arms are gradable for it. Out-of-scope cases never count.
- **Reporting:** A and H are each reported as **numerator/denominator (percentage)**, for example `18/24 (75.0%)`.
- **Empty scope:** with no eligible case, both arms read **`not available`**. The rate is never shown as 0 % or 100 %, there is no risk difference, and the measure is never flagged.
- **Coverage:** the analysis output lists every measure's **`eligibleCaseIds`**, plus any **`inScopeButUngradable`** case IDs, so the reviewer can inspect coverage.
- **Primary endpoint:** the same "not available" rule applies when a regime has no complete pair.

### 4b. Hallucination guardrail (final)

- **A separate harm measure:** the hallucination endpoint (§4) and the `hallucination-unsupported-claims` critical measure.
- **Case-level visibility:** the analysis lists **every answer** with a harm signal (`harm.cases`: case, arm, category, type), and prints per-arm counts as k/n for every type on every run, whatever the verdict. The types are:
  - `invented-personal-fact` (judge, with its `hallucinated_claims`);
  - `unsupported-figure` (deterministic);
  - `missing-fact-presented-as-known` (deterministic);
  - `wrong-person-attribution`, `wrong-project-attribution`, `wrong-entity-attribution` (deterministic).
- **Attached to every verdict:** the harm summary is part of every verdict object, including `meaningful-improvement` and development `not-applicable`. An aggregate improvement therefore never appears without its harm cases beside it.
- **What blocks a claim:** a significant hallucination increase, or a flagged hallucination measure, makes the result `not-claimable-hallucination`.
- **What does not block a claim:** individual harm cases below those thresholds. They are **reported**, never hidden.

## 5. Decision rule (claim verdict)

Applied by `claimVerdict()` to the **two primary regimes only**. Development evidence (any non-v3 or non-canonical run) is always **"not-applicable"**.

**Final rule.**

- **Per regime, never averaged:** short and long are judged separately; they are never combined into an average.
- **A meaningful improvement requires, in at least one primary regime, all of:**
  1. statistically significant improvement after the pre-registered Holm correction (exact McNemar, Holm-adjusted p < 0.05, RD > 0);
  2. RD ≥ +5 percentage points;
  3. the regime's 95% bootstrap CI lower bound > 0 (a lower bound of exactly 0 is not "above zero").
- **The other regime** must not show a statistically significant regression. A significant regression in **either** regime gives `regression`.
- **Guardrail failures** (hallucination or any critical measure) block an improvement claim.
- **Inconclusive:** if RD ≥ +5 pp in a regime but the statistical evidence is insufficient (not Holm-significant, **or** significant but CI lower bound ≤ 0), the result is `inconclusive`.

**Precedence** is first match wins, in this exact order (`VERDICT_PRECEDENCE`): `regression` → `not-claimable-hallucination` → `not-claimable-critical-regression` → `meaningful-improvement` → `significant-below-meaningful` → `inconclusive` → `no-detectable-difference`.

**Significance and confidence intervals (founder decision D-1, 2026-11-12; the method is unchanged):**

- **Significance:** exact McNemar testing, **Holm-corrected across the two primary regimes** (family-wise α = 0.05).
- **Intervals:** every confidence interval is a **95% percentile bootstrap interval computed separately for each regime**. The intervals are **not multiplicity-adjusted**, and they are **not simultaneous** intervals. They must never be described as either.
- **Distinct purposes:** the corrected p-value decides statistical significance across the two primary regimes; the per-regime interval describes the size and precision of the effect within that regime.
- **How a claim uses them:** a meaningful-improvement claim requires both; requiring both is conservative.
- **Labels in every output:** `ci95Label` ("95% percentile bootstrap CI, computed separately for this regime; not multiplicity-adjusted and not a simultaneous interval"), `mcnemarHolmPLabel`, and the uncorrected per-regime p-value is labelled as such.
- **When the procedures disagree:** at the boundary (significant, but CI lower bound ≤ 0) the result is `inconclusive`. Before 2026-11-12 this case fell through to `no-detectable-difference`; that implementation gap is closed to match this rule.

| Verdict | Condition (checked in this order) |
|---|---|
| `regression` | Any primary regime: Holm p < 0.05 and RD < 0 |
| `not-claimable-hallucination` | A meaningful improvement (§3), but hallucination rose significantly (p < 0.05, RD > 0) in a primary regime, or `hallucination-unsupported-claims` is flagged |
| `not-claimable-critical-regression` | A meaningful improvement, but another critical measure is flagged (decline ≥ 10 pp) |
| `meaningful-improvement` | Holm p < 0.05, CI lower bound > 0, RD ≥ +5 pp; no hallucination increase; no critical flag |
| `significant-below-meaningful` | Holm p < 0.05 and 0 < RD < +5 pp |
| `inconclusive` | RD ≥ +5 pp without sufficient statistical evidence |
| `no-detectable-difference` | Otherwise |

**The claim wording is fixed:** "On the independent ACIB v3 benchmark, hybrid context improved paired factual correctness by RD pp [95% CI] (A k/n → H k/n) in the <regime> regime (Holm-adjusted p)". The hallucination result and all six critical measures, with raw counts, are always stated alongside it.

## 6. Very-long stress sample (C-4): reported separately, never confirmatory

- **Scope:** 2 scenarios per category (26), stratified and seeded.
- **Reporting:** a separate section; not Holm-adjusted; never passed to the verdict. The analysis tool **refuses** a very-long label passed as a primary label.
- **Filler (D-3):** a large, varied, answer-neutral library (≥ 300 distinct messages, ≥ 8 topics, varied lengths, some similar-but-irrelevant material), written by the evaluation authors and described in `fillerMetadata`. Long and very-long versions of a scenario keep identical answer-bearing evidence; filler is only added.
- **Diagnostics, per arm, with raw counts:**
  - long-history retrieval (factual correctness);
  - required facts given;
  - distractor contamination;
  - tempting contamination;
  - stale facts asserted as current;
  - contradiction handling;
  - context-budget behaviour (mean and maximum prompt tokens reported by the provider);
  - **degradation with history length** (the same scenarios, long vs very long).

## 7. Other reports (descriptive)

| Report | Purpose |
|---|---|
| Judge score: sum of 4 core dimensions (0–8) | Paired mean difference, bootstrap CI, dz, sign-flip p |
| Deterministic grader | Factual correctness and the v3 metrics, per arm and as paired differences |
| **Noise control** | Cases whose A and H prompts are identical: discordance with raw counts and a Wilson CI. Any difference there is model nondeterminism. |
| Prompt-changed subset | Estimates with raw counts and CIs only, **no p-values** (the subset is selected by the treatment itself) |
| Missing data | Every incomplete case with its reason. **Sensitivity analysis:** a missing or invalid judgement counts as incorrect. |

## 8. Integrity rules

- **One run:** one evaluation run per implementation. Results stay aggregate-only until the run is complete.
- **No retuning:** no change to the engine, hybrid, prompts, grader, judge rubric, dataset or this specification after the freeze. A change is a new version with a new freeze.
- **Unchanged inputs:** the code hashes in the report must equal those recorded at freeze time (grader) or pre-registration (analysis).
- **Separation:** development results (ACIB v1, v2, the v3 development set) never alter the frozen evaluation set or this specification.
- **Small samples:** no improvement is claimed from a subset, a category, a critical measure, the stress sample, or the prompt-changed subset.
