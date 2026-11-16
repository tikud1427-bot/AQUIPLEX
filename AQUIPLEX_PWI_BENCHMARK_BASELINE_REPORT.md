# PWI Benchmark v1 — Baseline Results, Failure Analysis, Thresholds, Priorities

**Date:** 2026-11-15.

**Specification:** [AQUIPLEX_PWI_BENCHMARK_SPEC.md](AQUIPLEX_PWI_BENCHMARK_SPEC.md).

**Dataset:** `pwi-v1.json`, SHA-256 `23706af2…ab001c`, frozen before the first run ([PROVENANCE](aqua/eval/pwi/dataset/PROVENANCE.md)).

**Raw results:** `aqua/eval/pwi/results/baseline-2026-11-15/`:

- `run1/` (all arms);
- `run2-determinism/`;
- `tables.md`;
- `failures-*.md`;
- the eval-gate logs.

Everything is uncommitted.

**Configuration measured:** production as it runs today, which means legacy read, no database, no model calls, and no network (0 blocked calls).

**Not measured:**

- the canonical World Model and E6 (out of scope);
- answer factuality and personalised answer quality, which need model calls that were not approved.

## 1. The answer to the question

**Does Aqua understand its users better over time? On this benchmark, no. It stores more, and understands less accurately.**

The table shows the production arm, long-history regime: the realistic one for any returning user.

| | A (initial) | B (more information) | C (changes, corrections, deletions) |
|---|---|---|---|
| Facts stored / graph nodes | 24 / 12 | 30 / 20 | 29 / 21 |
| **Claim recall** (true current facts held) | **0.607** | **0.500** | **0.447** |
| Entity recall (graph or fact) | 0.529 | 0.481 | 0.393 |
| Changes recorded as changes | — | 0 of 2 | **3 of 18** |
| Context completeness | 0.722 | 0.767 | 0.726 |
| Retrieval precision | 0.246 | 0.182 | 0.147 |
| Deletion: items fully gone | 1 / 1 | 1 / 1 | **3 / 6** |

**Reading the table:**

- **Capture:** each new stage adds information the capture layer mostly does not take in.
- **Changes:** changes overwhelmingly do not register as changes.
- **Precision:** retrieval precision falls as stored volume grows.
- **Completeness:** context completeness stays flat only because the recall lane quotes the user's own words. At stage C, 9 of 10 missing values are **capture** misses, values in no store at all.

**Reliability properties hold:**

- persistence across restarts: 100% identical;
- cross-user isolation: 0 leaks, including the deliberate shared first name "Teodor";
- sensitive (health) data not stored or shown;
- the run is fully deterministic: the second run was identical in every metric at every stage.

## 2. Results by category (production arm)

**Denominators.** They are small, so read each value with its count:

- 28–38 claims per stage;
- 13–28 entities;
- 18 changes at C;
- 16–32 probes per stage.

**Two regimes:**

- **Short history:** the user's own words stay under 8,000 characters, so recall quotes everything.
- **Long history:** more than 9,000 × stage characters.

| # | Category | Metric | Short A / B / C | Long A / B / C |
|---|---|---|---|---|
| 1 | Factual | Claim recall | .607 / .500 / .447 | same (capture does not depend on history length) |
| | | Claim recall — chat / documents (C) | .531 / **0** | .531 / **0** |
| 2 | Relationship | Entity precision / recall (graph, non-place) | 1 / .231 → .727 / .318 (C) | same |
| | | Relationship precision / recall | 1 / .231 → .800 / .412 (C) | same |
| 3 | Temporal | Temporal probe accuracy | 1 / 1 / 1 | **.667 / .667 / .667** |
| | | Stale value shown as current (structured lanes) | — / 0 / .077 | — / 0 / .077 |
| | | Stale values only in dated quotes, with no "since changed" note | 0 / 4 / 24 | 0 / 1 / 12 |
| 4 | Cross-source | Document items reaching the context | — / 1 / 1 | — / 1 / 1 (only via file-memory and quote lanes) |
| 5 | Personalised reasoning (context) | Completeness / precision | 1/.60, 1/.38, 1/.39 | .67/1, .66/.40, **.60/.33** |
| 6 | Correction propagation | Store views consistent (corrections) | 1 (2 corrections; 1 never captured, so trivially consistent) | same |
| | | Store views consistent (world changes) | — / 1 / .875 | same |
| 7 | Contradiction | Recorded in store as a change | — / 0 / **.167** | same |
| | | Handled in context | — / 1 / .923 | same |
| 8 | Uncertainty | Hedges held as fact | 0 of 2 | 0 of 2 |
| | | Unknowns acknowledged (direct questions) | **0** | **0** |
| 9 | Deletion and privacy | Store compliance | 1 / 1 / **.833** | same |
| | | Deleted values in contexts (occurrences) | 0 / 0 / **23** | 0 / 0 / **12** |
| | | Sensitive (health, no opt-in) stored or shown | 0 | 0 |
| — | Isolation | Cross-user leaks (stores / contexts) | 0 / 0 | 0 / 0 |
| 10 | Persistence | Measurements identical after restart | 1 / 1 / 1 | 1 / 1 / 1 |
| — | Retrieval | Context completeness | 1 / 1 / 1 | .722 / .767 / .726 |
| — | | Precision (relevant ÷ relevant + irrelevant) | .166 / .139 / .136 | .246 / .182 / .147 |
| — | Answers | Answer factuality, personalised answer quality | **not measured** | **not measured** |

### Other arms (same data)

**`propagation` (`AQUA_PROPAGATION=on`): identical to production on every metric.** The flag was verified active: transitions carry its outbox fields. It reconciles only changes the fact store recorded. Here that is the one case already consistent without it (Lisbon→Porto). The stale cases (March 14, June 1, Jonas) are changes the fact store never linked to the old fact.

**`hybrid` (`AQUA_HYBRID_CONTEXT=on`), long regime:**

| Metric | Production | Hybrid |
|---|---|---|
| Context completeness at C | .726 | **.823** |
| Personalised-reasoning completeness at C | .604 | **.688** |
| Personalised-reasoning precision at C | .330 | **.352** |
| "Not known" lines in C contexts | 0 | 5 |
| "No longer current" lines in C contexts | 0 | 3 |

- **Example:** "Not known: the cost of a developer … Do not guess it" on "Should I hire another engineer?".
- **Cost:** about +52 prompt tokens on average.
- **Limits:** it does not fire on direct questions about something never said (unknown-acknowledged stays 0). Its deletion violations at C are 14 occurrences, vs 12 in production.

### Stored quantity versus accuracy (the "more is not better" check)

- **Stored:** facts go 12 → 19 → 18 (short) and 24 → 30 → 29 (long); graph nodes 8 → 17 and 12 → 21.
- **Accuracy:** over the same stages, claim recall falls 0.607 → 0.447. Entity recall (graph or fact) falls 0.529 → 0.393 (short) and 0.529 → 0.393 (long).
- **What the long-regime growth is:** most of it is unlabelled facts captured from the filler conversations. Some of them are malformed, e.g. `hobbies = ["doing","crossword","puzzles","on","sunday","mornings"]`.

## 3. Failure analysis

Itemised lists, every miss with its probe, value and the context line: `results/baseline-2026-11-15/failures-prod-long.md`, `failures-prod-short.md`, `failures-hybrid-long.md`.

### F-1 (privacy, severe) — "Forget X" deletes the wrong fact or nothing; deleted values keep reaching the answer

| User request | What happened (verified in store snapshots and logs) |
|---|---|
| p4: "Please forget my manager's name." | **Deleted the user's own `name` fact** (`FORGET_CHAT … key=name`). The manager fact `custom_manager_at_Corvantis = Teodor Ilić` survives; the profile shows it and recall quotes it. **Both regimes.** |
| p3: "Please forget the print run number from the Vellum brief." | Resolved to key `country`, which p3 does not have, so a no-op. "25,000 units" stays in the file-memory lane and the quoted document (7 contexts). |
| p2: Memory-page delete of "Fenwright Partners" | **Not possible:** no stored fact shows the value (never captured), so the page has nothing to delete. The sentence keeps being quoted. The value also survives inside another fact's `sourceText`. |
| p1: "Please forget what I told you about my sister." | Worked for the fact store and the contexts. **The Mind graph still holds a `person: Rosalind` node.** |

**Root causes:**

- **Chat forget:** `memoryExtractor.detectForget` takes the text after "forget (my)", and the resolver maps it to a single key by word overlap ("my manager's **name**" → `name`).
- **No reach:** there is no forget path for document content or for statements that never became facts.
- **Mind graph:** the chat forget's Mind clean-up (`forgetValueInMind`) did not remove the graph node.

### F-2 (capture) — most of a user's world never becomes structured knowledge

- **Source of misses:** at stage C (long), 9 of 10 missing context values are capture misses.
- **Not captured by the production rules, among others:**
  - **Jobs and roles:** "teach physics at Harrowgate Academy"; "started a new job … at the Lindqvist Institute"; "promoted to staff engineer".
  - **Places:** "We live in Bristol"; "I moved to Hamburg".
  - **Money and teams:** "raised a pre-seed round of $400,000"; "three engineers on the team".
  - **Counts:** "two kids" / "three kids"; "120 beta users".
  - **Work items:** "the packaging is now due on May 12"; "waiting on Apple to approve the iOS build".
- **Wrong typing:**
  - "Quillmarsh" was captured as a *project* node labelled "a small startup called Quillmarsh";
  - "a new job this week as a research fellow" became a project node;
  - p3's business partner Jonas became `spouse`.
- **Documents:** they produce **no structured claims** at all (document claim recall 0). Their content reaches the context only as file excerpts and quotes.

### F-3 (change) — changes are not recognised as changes

- **Scale:** 15 of 18 world changes and corrections leave no trace in the fact store's history.
- **Stale values left current:**
  - p1's deadline: March 14 is still current after "We pushed the Atlas launch to April 30"; the new date was never captured.
  - p2's deadline: June 1 is still current.
  - "Jonas isn't involved … anymore": `spouse = Jonas` stays current.
  - p4's "120 users": the CSV keeps showing it as current in the file lane.
- **Supersession scope:** supersession fires only when the new statement is captured *under the same key* as the old one (Lisbon→Porto worked).

### F-4 (temporal / dated quotes) — the answer depends on the model reading dates

- **Scale:** at C, 24 (short) / 12 (long) stale values reach the context **only** as dated verbatim quotes, and **none** carries a "since changed" note.
- **Why:** legacy supersession notes exist only for captured changes (F-3).
- **Result:** the model is told "a newer statement replaces an older one" and must work it out itself.
- **What the metric shows:** the stale-unmarked rate (0–0.077) looks good only because quotes are dated.

### F-5 (uncertainty) — unknowns are never stated

- **Direct questions:** for "What's my annual revenue / salary / hourly rate / rent?", no context says it is not known (0 of 12 in every arm).
- **Hedges:** they are handled well: "I might move to Berlin" and "maybe applying for a lectureship" were never stored as facts, and never shown unmarked.

### F-6 (retrieval precision) — the context is mostly unrelated facts

- **Precision:** 0.15–0.25.
- **Volume:** 2.6–9.3 of the user's other facts per probe.
- **Short histories:** recall quotes every past message (F-05 of the November audit).
- **Long histories:** the identity card, profile and cognitive block are injected regardless of the question.

### Infrastructure failures (kept apart from the above)

**0 infrastructure failures** in every cell:

- no event, probe, upload or snapshot threw;
- every stage process exited through the production shutdown path;
- 0 network calls attempted.

**One harness defect was found and fixed after the first run, before this report:**

- **What was wrong:** "unknown acknowledged" first matched the recall block's fixed instruction header ("…an 'uncertain' note means…") and read 1.0 in the long regime.
- **Fix:** the rule now requires the line to name the unknown thing, with a regression test.
- **Rescoring:** all runs were rescored from their raw outputs (`rescore.mjs`). The superseded summaries are kept beside the new ones.

## 4. Recommended quality thresholds (proposals for founder decision; not gates yet)

| Property | Proposed threshold | Baseline (prod, long) | Status |
|---|---|---|---|
| Deletion: store compliance and context violations | **100% / 0, hard gate** | .833 / 12 | **FAIL** |
| Wrong-target deletion (add as a v2 metric) | **0, hard gate** | 1 (user's name deleted) | **FAIL** |
| Sensitive data stored or shown without opt-in | **0, hard gate** | 0 | pass |
| Cross-user isolation leaks | **0, hard gate** | 0 | pass |
| Persistence across restarts | **100%, hard gate** | 100% | pass |
| Claim recall at every stage, and non-decreasing A→C | ≥ 0.85 | .607 → .447 (decreasing) | fail |
| Changes recorded as changes | ≥ 0.80 | .167 | fail |
| Stale value unmarked in structured lanes | ≤ 0.05 | .077 | fail |
| Stale values reaching the context only as unannotated quotes | ≤ 2 per stage | 12 | fail |
| Context completeness (long history) | ≥ 0.90 | .726 | fail |
| Retrieval precision | ≥ 0.50 | .147 | fail |
| Document facts held as structured claims | ≥ 0.70 | 0 | fail |
| Unknowns acknowledged on direct questions | ≥ 0.80 | 0 | fail |
| Entity recall / precision (graph) | ≥ 0.80 / ≥ 0.90 | .318 / .727 | fail |
| Relationship recall | ≥ 0.70 | .412 | fail |
| Answer factuality / personalised quality | set after the first approved answer-level run | not measured | — |

**Hard gates** are properties a release must never regress. The others are targets that the next phases should move, measured on this frozen set and then confirmed on an independently authored set (pwi-v2) before any claim of improvement.

## 5. Next implementation priorities (ranked by severity and measured impact)

1. **Make deletion correct (F-1). Privacy, hard-gate failure.**
   - **Forget resolution:** chat forget must resolve to the fact that *holds* the named thing, and must refuse rather than guess (never the user's own name).
   - **Reach:** forget must reach document content, quotes of uncaptured statements, `sourceText` provenance and Mind graph nodes.
   - **Memory page:** it should offer deletion of things it can quote but has not captured.
   - **Benchmark:** add the wrong-target metric.
2. **Capture what the benchmark shows missing (F-2).** This is the dominant failure: 9 of 10 misses.
   - **Targets:** job and role changes, moves, money, team size, counts, moved deadlines, third-party facts, document facts.
   - **Options:**
     - (a) extend the deterministic extractor for these sentence shapes;
     - (b) promote E6 understanding once it passes its gate.

     (b) is excluded from this phase and needs approval.
   - **Measure:** both on this set and on a fresh set.
3. **Link changes to the facts they change (F-3/F-4).** A new value for the same slot must supersede the old one even when the wording differs ("pushed the launch to April 30"). That gives recall quotes their "since changed" notes, and gives propagation something to propagate.
4. **Say what is unknown (F-5).** Extend the information-needs "Not known" rendering to direct questions about unstated attributes. Hybrid context already does it for decision questions.
5. **Hybrid context as the next context step.** It is the one arm that moved completeness at C (+0.10), at about +52 tokens. Decide after an answer-level check.
6. **Answer-level evaluation (approval needed).** Use the existing answer-eval runner and judge on these probes, to measure whether the context improvements reach the answers.
7. **Independent review of pwi-v1 labels,** and an independently authored pwi-v2, before thresholds become release gates.

**Propagation** (`AQUA_PROPAGATION`) shows no measurable effect until 2–3 land. Re-measure then.

## 6. Reproduction and integrity

- **Commands:**
  - `node eval/pwi/run-pwi.mjs --arms prod,propagation,hybrid --regimes short,long`;
  - `node eval/pwi/report-table.mjs <run>`;
  - `node eval/pwi/analyze.mjs <run> <cell>`.
- **Run time:** about 2 minutes for all cells, with no network, database or credentials.
- **Determinism:** `run2-determinism` equals `run1` in every metric at every stage.
- **Existing benchmarks preserved:** the eval gate before and after Phase 2 is identical: 16 PASS, 4 BLOCKED (the same 4 suites as Sprint 6), and the same 88 regression lines. No gate baseline was created or changed.
- **Harness tests:** `eval/tests/pwiBenchmark.test.js`, 10/10.
- **Limitations** (spec §6):
  - labels are not independent;
  - small set;
  - context level, not answers;
  - line-level marking rules that favour the system;
  - the graph has no place type;
  - the canonical model is not measured.
