# AQUA Hybrid Context — New Independent Benchmark Plan (ACIB v3)

**Sprint 5, 2026-11-11. PLAN ONLY.** No dataset, scorer or baseline was created or modified in this sprint.

## 1. Why a new benchmark

| Set | Status for the next iteration |
|---|---|
| `acib.v1` (17 scenarios) | Development / regression only (developed against since Sprint 2) |
| `acib.heldout.v1` (10) | Development only (post-hoc fixes in Sprints 3 and 4) |
| `acib.v2.dev` (40) | Development only |
| `acib.v2.eval` (100, `002208e4…`) | **Contaminated:** read item by item after its single run (Sprint 4). Kept frozen as **historical evidence**; never edited; may be run as a regression check, but never cited as independent. |

All existing records, baselines and documents are preserved unchanged.

## 2. Independence requirements

1. **Authors.**
   - At least **two scenario authors who did not build the engine or the hybrid.** For example, a contractor, a team member, or two people briefed only with this plan and the authoring guide.
   - The engine author does **not** see eval-set items before the single evaluation run.
   - If independent authors are impossible, the fallback is weaker, and that must be disclosed: scenarios derived from consented, anonymised real-traffic patterns, transformed by a templating script the engine author does not tune.
2. **Freeze before implementation.**
   - The **eval set is frozen before any hybrid code is written.** Its hash is recorded in the repository and in the report.
   - A **reviewer** (founder or delegate) signs off the freeze: scenario count, category balance, and spot-checks that annotations are reachable.
3. **Separate dev and eval.**
   - The dev set is authored independently (it may be by the engine author).
   - The eval set is only ever run by a script that prints **aggregates**. Per-item output goes to a sealed file opened after the single run.
4. **No tuning against the eval set.**
   - **Exactly one run per implementation.**
   - Any change after that run is labelled post-hoc, and is not cited as an independent result.

## 3. Composition

| Category | Eval | Dev | What it tests |
|---|---|---|---|
| Personal facts (single) | 16 | 6 | Basic recall |
| **Semantic mismatch** (question words ≠ statement words: "salary" / "I make 42k", "what car" / "I drive a…") | 24 | 8 | **The V2 failure class.** Primary hybrid target. |
| Facts spread across conversations (3–6 per question) | 16 | 6 | Coverage |
| Cross-project references | 10 | 4 | Entity attribution |
| Cross-person references (two Sams, sister vs user) | 10 | 4 | Cross-entity accuracy |
| Changing facts (explicit and implicit change verbs: "put the rent up to") | 16 | 6 | Temporal correctness |
| Contradictions (statements, files, dates, days) | 10 | 4 | Contradiction handling |
| Missing essential information (decisions) | 16 | 6 | Unknown detection, answerability |
| Irrelevant but tempting facts (shared words, same domain) | 12 | 4 | Precision under temptation |
| Negative: impersonal questions with rich personal history | 12 | 4 | No additional context |
| Decisions with situation outside common vocabularies | 8 | 2 | Generality |
| **Total** | **150** | **54** | |

- **Regimes:** short (history only) and long (history plus filler to above 9,000 characters, as v1/v2). Also add **very long** (above 60,000 characters) for latency and work-budget behaviour: 20 eval scenarios.
- **Size rationale:** with 150 paired scenarios per regime, a correctness difference of about 8 percentage points is detectable at α = 0.05 with roughly 80% power for typical discordance rates. This is an approximation; the exact power depends on discordant-pair rates, which the dev set will indicate.

## 4. Annotation schema (extends the ACIB v1/v2 schema)

Per scenario, in addition to `needs`, `distractors`, `unknowns`, `temporal`, `contradiction`, `crossEntity`:

| Field | Purpose |
|---|---|
| `needs[].paraphrase: true` | Marks needs whose evidence shares no content word with the question (semantic-mismatch accounting) |
| `answerability` | `answerable` / `answerable-with-caveat` / `needs-clarification` / `impersonal` |
| `expectedQuestion` | For `needs-clarification`: the gap a single clarifying question should target (a label, not wording) |
| `tempting[]` | Distractors that share words or domain with the question (separate from generic distractors) |
| `maxAddedTokens` | Expected upper bound for hybrid additions (budget check) |
| `authors`, `reviewedBy` | Provenance per scenario |

**Builder checks** (as `build-acib-v2.mjs`, extended): every pattern is reachable in its source text; `paraphrase` needs really share no content token with the question (checked with the recall tokenizer); ids unique; category counts as planned.

## 5. Metrics

**The scorer.** Context-level scoring needs new metrics, so a **new scorer version** (`acibScoring.v3.mjs`) is written and frozen **with** the eval set. The old scorer stays unchanged for historical runs.

| Metric | Definition |
|---|---|
| Recall | Required needs present in the context |
| **Paraphrase recall** | Recall over `paraphrase: true` needs only |
| Precision | Relevant items / all items (as v1) |
| Relevant evidence coverage | Required needs whose evidence sentence appears |
| Irrelevant evidence | Count and characters; **tempting-distractor count** separately |
| Missing-information detection | Unknowns declared and correct; plus **false unknowns**: declared unknown while the need's evidence is in context (new, critical for the hybrid) |
| Contradiction handling | As v1 (flagged = 1, both visible = 0.5) |
| Temporal correctness | Current present, stale not asserted as current |
| **Answerability decision** | The hybrid/V2 sufficiency (`sufficient` / `partial` / `insufficient` / general) vs `answerability`: accuracy and confusion matrix |
| **Clarifying-question targeting** | When a question is rendered, does it target `expectedQuestion`? |
| **Fallback rate** | Share of turns where V2/hybrid contributed nothing (by reason) |
| Context size | Prompt tokens (mean, p95); hybrid-added tokens vs `maxAddedTokens` |
| Latency | `prepareTurn` ms and engine/hybrid ms: mean, p95, max, per regime (including very long) |

**Arms:**
- A (production default);
- B (`AQUA_INFO_NEEDS=on`, replacement), as a reference;
- **H** (`AQUA_HYBRID_CONTEXT=on`);
- optionally H+prune.

## 6. Procedure

1. Write the authoring guide and annotation schema (this document) → review.
2. Independent authors write the dev and eval sets → builder validation → **reviewer sign-off** → **freeze the eval set** (sha256 plus the scorer v3 sha256) → recorded in the repository.
3. Record arm A and arm B on the eval set immediately after the freeze, before hybrid code exists. Aggregates are printed; items are sealed.
4. Implement the hybrid (architecture doc) against **dev only**.
5. Freeze the implementation (hashes) → **one** eval run of H → report aggregates and paired differences with bootstrap CIs → then open the sealed items for diagnosis (labelled post-hoc).
6. Gate baselines for v3 suites are created **only after step 2's review**. Arm baselines are created from step 3; the H baseline from step 5. No existing baseline is modified.

## 7. Success criteria (proposed; to be confirmed by the founder before the freeze)

| Criterion | Threshold |
|---|---|
| H vs A, correct cases, short | **no regression** (paired CI lower bound ≥ −2 pp) |
| H vs A, correct cases, long | improvement, CI excluding 0 |
| False unknowns (H) | ≤ 2% of scenarios |
| Paraphrase recall (H) | ≥ A |
| Contradiction / temporal (H) | ≥ B's v2 levels (0.94 / 0.82 short) |
| Added tokens (H) | mean ≤ 250, p95 ≤ 400 |
| Hybrid ms | p95 ≤ 20 on long, ≤ 50 on very long |
| Impersonal questions | H adds 0 items |

## 8. Effort estimate

| Item | Estimate |
|---|---|
| Authoring guide and schema | 0.5 day |
| Scenario authoring (204 scenarios, two authors) | 2–3 days |
| Builder and scorer v3 with tests | 1 day |
| Review and freeze | 0.5 day |
