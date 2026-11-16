# ACIB v2 — Contextual Intelligence Benchmark, version 2

**Sprint 4, 2026-11-10/11.** Context level: what the model *receives*, scored with the unchanged ACIB scorer (`eval/suites/acibScoring.mjs`). Answer-level evaluation is separate: see [AQUA_ANSWER_QUALITY_EVALUATION.md](AQUA_ANSWER_QUALITY_EVALUATION.md).

## 1. Datasets

| Set | File | sha256 | Scenarios | Role |
|---|---|---|---|---|
| **Evaluation** | `aqua/eval/datasets/acib.v2.eval.json` | **`002208e4737bd917…`** (`acib.v2.eval.FROZEN.sha256`) | **100** | Frozen before any Sprint 4 code change. Never used for development. One untouched run of the new implementation. |
| Development | `aqua/eval/datasets/acib.v2.dev.json` | `abca8916…` (`acib.v2.dev.FROZEN.sha256`) | 40 | Written after the eval freeze. Used to build Information Needs V2. |
| Sources | `eval/datasets/src/acib.v2.{eval,dev}.source.mjs` | eval source `94cf61d7…` (`src/acib.v2.eval.source.sha256`) | — | Compact authoring form. |
| Builder | `aqua/scripts/build-acib-v2.mjs` | — | — | Expands the sources into the shared ACIB schema. Refuses to overwrite an existing freeze. |

Earlier sets remain as development and regression sets:
- `acib.v1` (17 scenarios): dev, Sprint 2;
- `acib.heldout.v1` (10 scenarios): contaminated post-hoc in Sprint 3.

**Eval categories** (the brief's list):

| Category | Scenarios |
|---|---|
| personal context | 10 |
| long histories (30 filler messages inside one conversation) | 10 |
| cross-project reasoning | 10 |
| historical changes | 12 |
| contradictions (one across two uploaded files) | 8 |
| missing information | 12 |
| financial decisions | 12 |
| employment decisions | 8 |
| third-party relationships | 10 |
| negative / irrelevant | 8 |

Every scenario is run in **two regimes**:
- **short:** the history only;
- **long:** the history, then filler conversations until the user's past messages exceed 9,000 characters.

That gives 200 cases per arm.

## 2. Creation process

1. **Timing.** Authored on 2026-11-10 *before* any Sprint 4 code change, against the same schema and scorer as v1 and with no scorer change.
2. **Phrasing.** Deliberately everyday phrasing, varied away from the engine's vocabularies: "a few grand", "the missus", "my old firm", tenure, competition, appositive names, uploads.
3. **Pre-freeze checks.**
   - The builder verifies that every need's `match` and `evidence` pattern occurs in the scenario's own source text. A typo'd expectation cannot silently become unreachable.
   - Two loose patterns were tightened (an unknown matching `for`; a placeholder distractor). This happened before the freeze and before any run.
4. **Freeze, then baselines.** Frozen with a sha256 of the built JSON (line endings normalised), then the "before" baselines were recorded:
   - arm A: `results/acib-v2-eval.sprint4-before.json`;
   - arm B with the Sprint 3 engine: `results/acib-v2-eval-needs.sprint4-before.json`.
5. **Development without the eval set.** Only the eval set's **aggregates** were looked at during development, never its items. Development used `acib.v2.dev` (written afterwards, with different people and domains), `acib.v1` and `acib.heldout.v1`.
6. **Implementation frozen, single run.** The changed files were hashed (`results/sprint4-implementation.hashes.txt`), then the eval set was run **once** per arm (`*.sprint4-after-first-run.json`).
7. **No changes after the run.** Failures were read after that run for this report and **were not fixed**. The only later change was a behaviour-neutral test seam; the re-run is identical (0 of 133 metrics differ).

**Limits of independence.** The eval set was written by the same agent that built the engine, before Sprint 4 code but with full knowledge of the engine's design and of Sprint 3's known gaps. It is independent of the Sprint 4 *implementation* in time, not of its *author*. A set written by someone else, or sampled from real (consented, anonymised) traffic, would be stronger. The answer-level protocol recommends one.

## 3. Results on the evaluation set (single run)

### Headline

| Metric | A before | A after (capture fixes) | B before (Sprint 3) | **B after (V2)** |
|---|---|---|---|---|
| **Short history** | | | | |
| Recall | 0.98 | 0.98 | 0.63 | **0.94** |
| Precision | 0.55 | 0.55 | 0.60 | **0.80** |
| Temporal accuracy | 0.73 | 0.73 | 0.55 | **0.82** |
| Contradiction handling | 0.50 | 0.50 | 0.44 | **0.94** |
| Unknown handling | 0.00 | 0.00 | 0.23 | **0.85** |
| Cross-entity accuracy | 1.00 | 1.00 | 1.00 | 1.00 |
| Irrelevant items (sum) | 452 | 451 | 50 | 65 |
| Stale asserted as current | 4 | 4 | 1 | 3 |
| Personal items on impersonal | 15 | 15 | 4 | **0** |
| Correct cases | **95** | **95** | 58 | 88 |
| Mean prompt tokens | 1,393 | 1,392 | 1,211 | 1,307 |
| **Long history** | | | | |
| Recall | 0.79 | 0.79 | 0.63 | **0.86** |
| Precision | 0.16 | 0.16 | 0.60 | **0.68** |
| Temporal accuracy | 0.55 | 0.55 | 0.55 | **0.64** |
| Contradiction handling | 0.50 | 0.50 | 0.44 | **0.94** |
| Unknown handling | 0.00 | 0.00 | 0.23 | **0.69** |
| Irrelevant items (sum) | 703 | 702 | 51 | 165 |
| Personal items on impersonal | 77 | 77 | 4 | 13 |
| Correct cases | 74 | 74 | 58 | **82** |
| Mean prompt tokens | 1,418 | 1,417 | 1,214 | 1,321 |

"Correct" means the production context holds every required need and leaks nothing it must not (stale, cross-entity, forgotten, failed-turn). Turn timing on this machine (`prepareTurn`, both arms) was 5–14 ms, and varied with machine load during runs. The engine's own time is reported in §4.

### V2 (B after) by category

| Category | Short: recall / precision / correct | Long: recall / precision / correct |
|---|---|---|
| personal (10) | 1.00 / 0.88 / 10 | 0.70 / 0.65 / 7 |
| long-history (10) | 1.00 / 1.00 / 10 | 1.00 / 1.00 / 10 |
| cross-project (10) | 0.95 / 0.90 / 9 | 0.95 / 0.90 / 9 |
| history-change (12) | 1.00 / 0.67 / 10, temporal 0.82 | 0.75 / 0.52 / 8, temporal 0.64 |
| contradiction (8) | 1.00 / 1.00 / 8, contradiction 0.94 | same |
| missing (12) | 0.92 / 0.43 / 11, unknowns 0.83 | 0.92 / 0.37 / 11, unknowns 0.67 |
| financial (12) | 0.85 / 0.67 / 8 | 0.76 / 0.44 / 7 |
| employment (8) | 0.81 / 0.88 / 5 | 0.81 / 0.67 / 5 |
| third-party (10) | 0.90 / 0.77 / 9, unknowns 1.00 | 0.90 / 0.69 / 9 |
| negative (8) | — / 1.00 / 8 | — / 0.75 / 8 (13 personal items, from one fallback) |

### Targets (from Sprint 3) on the evaluation set

| Target | Result | Met? |
|---|---|---|
| Recall ≥ 0.95, long history | 0.86 | **no** |
| Precision ≥ 0.50 | 0.68 long / 0.80 short | yes |
| Unknown handling ≥ 0.80 | 0.69 long / 0.85 short | short only |
| No short-history regression vs arm A | 88 vs 95 correct | **no** |

## 4. Cost

- **Engine time:** mean 3.4 ms, p95 6.8 ms over 200 eval cases.
- **No model calls.**
- **Prompt tokens:** 6–7% fewer than arm A.

## 5. How to run

```
cd aqua
node scripts/acib-run.mjs --suite acib-v2-eval --label <label>         # arm A
node scripts/acib-run.mjs --suite acib-v2-eval-needs --label <label>   # arm B
node scripts/acib-run.mjs --suite acib-v2-dev[-needs] --label <label>  # development set
node scripts/build-acib-v2.mjs dev                                     # rebuild the dev set from source (eval is frozen)
```

- Each suite **refuses to run** if its dataset hash differs from the freeze.
- The adapter blocks all non-loopback network access. Every run reported here recorded **0** network attempts.

## 6. Rules for the next version

- The eval set changes only as a reviewed new version (`acib.v3.eval`), frozen before it is used.
- This set's expectations are never edited to improve a score.
- After this report, `acib.v2.eval` has been read item by item. It is now **contaminated for development**: the next generalisation claim needs a new frozen set.
