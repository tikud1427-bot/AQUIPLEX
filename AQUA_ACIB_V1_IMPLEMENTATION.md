# ACIB v1 — Implementation

**Date:** 2026-11-10 · **Benchmark version:** `acib-1.0.0` · **Stage:** A (context level; no model) · **Design:** [AQUA_CONTEXTUAL_INTELLIGENCE_BENCHMARK.md](AQUA_CONTEXTUAL_INTELLIGENCE_BENCHMARK.md) · **Results:** [AQUA_ACIB_V1_BASELINE_RESULTS.md](AQUA_ACIB_V1_BASELINE_RESULTS.md)

## 1. What it measures

Does the personal context Aqua assembles for a question contain **what the question needs, and only that**? It answers this on the **production pipeline** at **code-default flags without Postgres** — the documented production configuration. Answer quality (Stage B) is out of scope until an authorised model is available (D-3).

## 2. Files

All under `aqua/`, reusing the existing eval framework (`eval/core/runner.mjs`, `eval/gate.mjs`, baselines, `isolateDataDir`). No new test framework.

| File | Role |
|---|---|
| `eval/datasets/acib.v1.json` | 17 scenarios, a neutral filler set, regime definitions |
| `eval/datasets/acib.v1.FROZEN.sha256` | SHA-256 of the dataset (line endings normalised); a mismatch makes every case SKIPPED |
| `eval/adapters/acibPipeline.mjs` | Drives the production write and read paths; network guard; configuration capture |
| `eval/suites/acibScoring.mjs` | Item extraction and metrics (pure) |
| `eval/suites/acib-v1.suite.mjs` | The suite: cases = scenario × regime; freeze and configuration checks |
| `eval/baselines/acib-v1.v1.json` | Gate baseline (213 metrics) |
| `eval/acib/acib-v1.baseline.json` (+ `.sha256`) | Frozen reproducibility record (expected and retrieved evidence per case) |
| `eval/acib/results/acib-v1.determinism-{a,b}.json` | Two independent runs used to establish determinism |
| `scripts/acib-run.mjs` | Run and write a record; `--freeze-baseline` refuses to overwrite an existing baseline |
| `eval/core/gate.mjs` | +`LOWER_IS_BETTER_SUFFIXES` / `isLowerBetter()` (per-arm error counts are gated in the right direction) |

## 3. Pipeline under test

**Write path, per history message** — what `routes/chat.js` does, minus the model call:
1. `prepareTurn` — observation and retrieval.
2. Persist the user message.
3. `commitTurnMemory`.
4. Persist an assistant reply ("Noted.").
5. `runPostTurn`.

A message marked `fail` stops where a failed request stops: no persistence, then rollback (the Sprint 1 route behaviour). Uploads go through the real `POST /upload` route on loopback. Deferred post-turn jobs are drained before the question.

**Read path:** `prepareTurn` for the question in a **new conversation**. The model's personal context is three blocks:
- `memoryBlock` — identity, profile, cognitive model, graph, episodes, file memory;
- `knowledgeContext` — the PIC lane;
- the recall block — verbatim past messages.

No model is called (`skipReasoningPass`; nothing calls generate). Each case uses its own user id; the data dir is a fresh temp dir.

**Regimes:**
- `short` — the history only.
- `long` — the history followed by filler conversations until the user's own words exceed **9,000 characters**, past the 8,000-char whole-history recall window. Every long-term user ends up here.

## 4. Arms and metrics

**Arms** (executed comparisons):
- `production` — all three blocks;
- `recall`, `memory`, `knowledge` — each block alone;
- `planner` — `buildQueryPlan()` from `brain/contextEngine/queryPlan.js`, **plan only**: which required needs its slots would ask for. It retrieves nothing in production.

**Not executed (proposed):**
- Context Engine V2/V3 retrieval: needs `AQUA_CONTEXT_V2=on` + Postgres, and enabling disabled features for the benchmark was excluded.
- Canonical World Model (arm C2 of the design).
- Base-LLM and conventional-RAG arms (Stage B).

**Items** (`acibScoring.mjs`). One line the model reads as a separate piece of information:
- a profile or identity bullet;
- one clause of the cognitive model (`Current state:` is split on `|`);
- a graph, episode or file-memory bullet;
- a knowledge bullet;
- one recall excerpt with its `↳ since changed` note attached.

Headers, guidelines and instructions are not items. `structured` = Aqua's own assertion (profile, identity, cognitive, graph, knowledge). Recall quotes and file contents are evidence, not assertions.

**Matching:** case-insensitive regexes from the dataset, one item at a time.

| Metric | Definition (per case, per arm) | Better |
|---|---|---|
| `context_precision` | items matching any need ÷ items (no items and no needs = 1) | ↑ |
| `context_recall` | required needs matched by ≥ 1 item ÷ required needs | ↑ |
| `evidence_coverage` | required needs whose verbatim source phrase appears ÷ required needs | ↑ |
| `context_efficiency` | characters of relevant items ÷ all item characters | ↑ |
| `temporal_accuracy` | 1 if the current value is present **and** no structured item asserts the stale value without a change annotation | ↑ |
| `stale_as_current` | structured items asserting a stale value unannotated | ↓ |
| `contradiction_handling` | 1 = conflict flagged; 0.5 = both values visible, unflagged; 0 = one side missing | ↑ |
| `unknown_handling` | declared unknowns that some item explicitly marks as unknown ÷ unknowns | ↑ |
| `cross_entity_accuracy` / `_violations` | structured items attributing another person's or project's fact to the wrong entity | ↑ / ↓ |
| `irrelevant_items`, `irrelevant_chars`, `distractor_items` | noise (distractors = scenario-declared irrelevant facts) | ↓ |
| `critical_missing` | required needs absent | ↓ |
| `critical_miss_with_noise` | 1 if required needs are missing **and** irrelevant items were sent (the hiring rule: penalise noise while decision-critical facts are missing) | ↓ |
| `forgotten_leaks`, `failed_turn_leaks` | items containing forgotten / failed-turn content | ↓ |
| `personal_items_on_impersonal` | personal items sent for an impersonal question | ↓ |
| `planner_need_coverage` | required needs whose declared slot the plan contains | ↑ |
| `<regime>_network_attempts` | non-loopback attempts (blocked) | ↓ |

**Gate metric names:**
- `<arm>_<regime>_<metric>` — means for rates, sums for counts;
- `critical_<arm>_<regime>_<metric>` for the hiring scenario;
- `planner_<regime>_need_coverage`.

A case is `correct` when the production context holds every required need and has zero leaks, violations or stale assertions.

## 5. Scenarios (17 × 2 regimes = 34 cases)

The 16 required categories plus the critical one:
`personal-fact`, `long-history`, `multi-project`, `cross-conversation`, `cross-file`, `historical-current`, `contradiction`, `correction`, `goal-change`, `missing-info`, `ambiguous-relationship`, `third-party`, `irrelevant-history`, `multi-fact`, `forgotten`, `failed-turn`, **`hiring-decision`** (critical).

**`hiring-decision`:**
- **Required needs:** team size (3 engineers), Marco's announced departure, finances ($180k, $30k/month burn), roadmap (iOS app by March 1, blocked by payments), the previous hiring decision (hold until $20k MRR), current revenue ($14k MRR).
- **Distractors:** a possible designer hire next year, a sister's wedding, learning Portuguese.
- **Declared unknown:** the cost of a developer.

## 6. Reproducibility

Every record (`scripts/acib-run.mjs`) contains:
- benchmark version;
- dataset id, version, SHA-256 and whether it matches the freeze;
- pipeline version: git commit, dirty flag, and a SHA-256 over all 369 non-test source files under `aqua/src` (captures uncommitted code);
- execution configuration: every gate's resolved value, overrides, infrastructure present;
- timestamp, Node version, platform;
- per case: regime, task type, classifier confidence, read mode, prompt tokens, network attempts, **expected evidence** (needs with patterns), **retrieved items** (lane, structured, text), all arm metrics, planner slots and coverage.

**Isolation and determinism:**
- Network: a guard is installed only while a scenario runs (other suites in the gate are unaffected). It blocks and counts any non-loopback `fetch`/`http(s).request`. Baseline: **0 attempts**.
- Configuration: any context-relevant gate overridden makes every case SKIPPED. The mirror and logging gates are exempt — isolation requires the mirror off.
- Determinism: two full runs gave **213/213 identical metrics** and identical retrieved items (dates aside). Run time ≈ 8–9 s for 34 cases.

## 7. Change control — what was modified before the freeze, and the rule after it

The dataset was validated against the pipeline **before** freezing. Each change fixed a defect in the benchmark, not a result:

1. **`goal-change` / `injury` → optional.** "I injured my knee" is a health sentence. At default privacy settings the sensitivity policy withholds it from every lane by design, so requiring it penalised intended behaviour.
2. **`failed-turn` redesigned.** Disabling the Sprint 1 rollback showed the first version could not detect a leak: an engagement sentence produces nothing the read path surfaces.
3. **`failed-turn` rephrased.** The second version ("I just started a new job at …") is not captured by the extractor at all — itself a finding. The final failed message, "Actually I now work at Solberg Marine.", overwrites the stored employer if it leaks. With rollback disabled the benchmark reports 2–3 leaks and long-regime recall 1 → 0; with the fix, 0 leaks.

**Verified mechanisms:**
- A dataset not matching its freeze skips every case (tested by corrupting the hash).
- `acib-run.mjs --freeze-baseline` refuses to overwrite.
- `eval:gate -- acib-v1 --update` must name the suite (existing gate rule).

**Rule from now on:** a change to `acib.v1.json`, its freeze file or either baseline is a **separate, reviewed change** that states why the expected result was wrong. It must never be made in the same change as a pipeline improvement it would flatter. Corrections that make the benchmark stricter or fairer go into `acib.v2`, with v1 kept for comparison.

## 8. Known limitations

- **Development set, written with the audit in view** — not held out. A held-out set authored independently is required before claiming generalisation.
- **Regex matching** can miss paraphrases and over-match. Mitigated by per-item matching and by inspecting retrieved items (they are in every record).
- **Context level only:** having the right context is necessary, not sufficient, for a good answer.
- **One synthetic user per case**, small histories. The long regime models the recall-window cliff, not years of use.
- **Planner coverage** depends on the dataset's need→slot mapping (a judgement), and measures a plan production does not execute.
- **No `knowledge` lane content from chat** — expected, because `AQUA_BRAIN_INGEST` is off by default. That lane only carries uploaded-file facts.
