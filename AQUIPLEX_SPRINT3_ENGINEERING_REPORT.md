# AQUIPLEX Sprint 3 — Engineering Report: Information Needs Engine

**Date:** 2026-11-10 · **Branch** `main` · **HEAD** `839ea0d1` (unchanged) · **State:** uncommitted, not pushed, not deployed · Gate `AQUA_INFO_NEEDS` **off by default** — nothing changes for production users until it is turned on.

Documents: [design](AQUA_INFORMATION_NEEDS_ENGINE_DESIGN.md) · [implementation](AQUA_INFORMATION_NEEDS_ENGINE_IMPLEMENTATION.md) · [ACIB comparison](AQUA_ACIB_V1_COMPARISON_RESULTS.md)

## 1. Pre-flight (verified before any change)

- Repository root, `main`, HEAD `839ea0d1`.
- The 63 Sprint 1–2 paths were intact. Their hashes were intact: dataset `d041746a…`, baseline record `ae600d0d…`.
- `acib-v1` reproduced its 213 frozen metrics.
- The question planner (`brain/contextEngine/queryPlan.js`) had one production caller, `e8Pipeline.js`. That runs only inside Context Engine V2, which needs `AQUA_CONTEXT_V2=on` and Postgres canonical lanes, so it is not executed in production.
- **Production stores used:**
  - `longTermMemory.getFacts`;
  - the conversation store via `episodicRecall.collectUnits`, which is `meta.userId`-scoped and includes files from other conversations;
  - the recall redaction store;
  - the sensitivity policy.

## 2. What was built

A deterministic engine on the existing planner logic and production stores. It:
1. understands the question;
2. derives the requirements this question has;
3. retrieves evidence for each requirement;
4. labels each requirement found, missing, uncertain, contradictory, outdated, forgotten or ambiguous;
5. decides sufficiency;
6. renders the smallest sufficient context.

It is wired into the real chat path (`prepareTurn` step 5c¹, both endpoints) behind `AQUA_INFO_NEEDS`:
- **`off`** — byte-identical to before (default);
- **`shadow`** — computed and logged as counts only;
- **`on`** — replaces the broad personal lanes on the turns it understands, and falls back to the existing pipeline on the others or on any error.

No new store, no Postgres, no model call, no embeddings, no change to memory writes or the Sprint 1 commit safety.

## 3. Results (context level, ACIB; full tables in the comparison document)

| Long history | A (existing) | B dev | B held-out, first run | B held-out, final |
|---|---|---|---|---|
| Recall | 0.83 (dev) / 0.81 (ho) | **1.00** | **0.98** | 1.00 |
| Precision | 0.14 / 0.16 | **0.85** | **0.85** | 0.85 |
| Irrelevant items | 218 / 85 | **6** | **4** | 4 |
| Unknown handling | 0 / 0 | **1.00** | **0.50** | 0.50 |
| Correct cases | 13/17 / 7/10 | **17/17** | **9/10** | 10/10 |
| Prompt tokens (mean) | 1,639 / 1,489 | 1,304 | 1,290 | 1,306 |

**Hiring scenario:** 1/6 → **6/6** required facts in long history. The cost of a developer is declared "Not known" with a one-question directive. The designer, wedding and Portuguese distractors are no longer sent.

**Targets:**
- **Met on the dev set:** recall ≥ 0.95, precision ≥ 0.50, unknown ≥ 0.80, ≥ 16/17 correct, hiring 6/6, no short-history regression.
- **On the held-out first run** (the generalisation measure): recall and precision met. **Unknown handling 0.50 and 9/10 correct are below target.** The 9/10 became 10/10 after a generic fix. Unknown handling remains 0.50: a pricing decision without a pricing template, deliberately not patched on held-out data.

**Cost:**
- engine ≈ 1 ms per turn;
- 0 extra LLM calls;
- −13% to −20% prompt tokens.

## 4. How the work was done (and why the numbers can be trusted as far as they go)

1. **Held-out set first.** It was written and hash-frozen *before* any engine code, and arm A was recorded on it before the engine existed.
2. **Developed on the dev set by reading the items**, not the metrics. Several fixes *lowered* noise the scorer did not penalise:
   - question-derived facts;
   - stem collisions;
   - duplicate quotes;
   - a false "since changed" note.
3. **One untouched held-out run**, reported as-is.
4. **Three generic bugs** from that run were fixed and labelled post-hoc. One domain gap (pricing) was deliberately left.
5. **Integrity checks:**
   - arm A re-run equals the Sprint 2 frozen baseline (0 of 213 metrics differ);
   - arm B is deterministic;
   - the dataset and scorer were not modified.

## 5. Pre-existing defects surfaced (not fixed at source)

The engine works around these; fixing them at the source changes memory semantics and needs approval:
1. **The observer stores facts from questions:** "Where does my sister work?" adds `Work` to `siblings`; "What's my dog called?" writes `pets: [object Object]`; "Plan a dinner for my partner…" writes `spouse: And`.
2. **The extractor truncates numbers at thousands separators:** "earn 58,000" is stored as "…earn 58".
3. **The Mind records the user's question as a goal**, which then produces false "since changed" notes in legacy recall.
4. **"I just started a new job at Y"** and "now work at Northbeam" are not captured.
5. **The multi-sentence forget hint bug** (from Sprint 1) remains.

## 6. Tests executed (actual results)

| Scope | Result |
|---|---|
| `brain/tests/informationNeeds.test.js` (new) | 24/24 |
| `routes/tests/informationNeedsRoute.test.js` (new, real route, real prompt sent to the provider) | 7/7 |
| Flag registry and parity tests (with `AQUA_INFO_NEEDS`) | 71/71 |
| Full engine battery (17 directories) + `eval/tests` | memory 503/504 (1 todo), mind 193/199 (6 todo), routes 329/329, brain 1371/1379 (8 skipped, live Postgres), core 857/865 — **1 failure = pre-existing `repoHygiene`** (untracked `aqua/eval/out/*before-profile*`); account, understanding, pic, cognition, embeddings, upload, files, search, project, providers, intelligence, orchestrator all pass; eval/tests 273/284 (11 skipped, 0 failures) |
| Platform tests | 323/324 — **1 failure = pre-existing `repoHygiene`** (three root `.patch` files) |
| Full `eval:gate` (DB-free) | **19 PASS**, including all four ACIB suites (`acib-v1` 213 metrics unchanged = production default unchanged; `acib-v1-needs` 213; `acib-heldout-v1` 197; `acib-heldout-v1-needs` 197). **1 BLOCKED = pre-existing `capture-core`** (every metric improved; the gate reads outcome counts as dataset shape, known since 2026-11-02). 2 NOT RUN (need Postgres), 3 without baselines. |

**Bite checks:**
- Forcing the engine off fails 3 route tests.
- Removing the question-source fact rule initially passed — a gap. A dedicated test was added, and it now fails as it should.

Not run: live Postgres suites, frontend, any provider-backed or answer-level evaluation.

## 7. Remaining limitations

- **Context, not answers.** Whether the model answers better with this context is unmeasured (Stage B, D-3).
- **Lexical, hand-built vocabularies and templates.** Paraphrases outside them, and decision kinds without a template, degrade to the generic decision needs. The held-out set is small (10 scenarios) and written by the same engineer.
- **`memoryRetrieve` still runs** when the engine owns the context (bookkeeping), so its cost is not saved yet.
- **The engine reads no Mind beliefs, goals, predictions or graph** — by design, while they are polluted by questions — so personalisation from inferred traits (tone, expertise) is absent on engine turns.
- **Production status:** off. Turning it on for real users is a separate decision. The recommended route is `shadow` first on Render, comparing `[NEEDS]` counts and `features` against real traffic, then `on` for a cohort.

## 8. Files

- **New:**
  - engine and tests: `aqua/src/brain/contextEngine/informationNeeds.js`, `aqua/src/brain/tests/informationNeeds.test.js`, `aqua/src/routes/tests/informationNeedsRoute.test.js`;
  - eval suites: `aqua/eval/suites/acibSuite.mjs`, `acib-v1-needs.suite.mjs`, `acib-heldout-v1.suite.mjs`, `acib-heldout-v1-needs.suite.mjs`;
  - held-out dataset: `aqua/eval/datasets/acib.heldout.v1.json` (+ `.FROZEN.sha256`);
  - baselines and records: 3 gate baselines, 3 frozen records, development / held-out records in `aqua/eval/acib/results/`;
  - 4 documents.
- **Modified:**
  - `aqua/src/routes/chat.js`, `aqua/src/core/flags.js`;
  - `aqua/eval/suites/acib-v1.suite.mjs` (factory, same behaviour), `aqua/eval/adapters/acibPipeline.mjs`, `aqua/scripts/acib-run.mjs`;
  - `aqua/src/core/tests/flagRegistry.test.js`, `flagReadSiteParity.test.js`.
- **Not modified:** the ACIB v1 dataset, its freeze, the scorer, the v1 baselines; billing, auth, credits; production env; data.
