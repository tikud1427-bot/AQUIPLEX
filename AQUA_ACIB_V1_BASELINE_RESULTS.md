# ACIB v1 — Baseline Results (frozen)

**Recorded:** 2026-11-10T10:57:34Z · **Benchmark** `acib-1.0.0` · **Dataset** `acib.v1` sha256 `d041746a8576…` (intact) · **Pipeline** HEAD `839ea0d1` + uncommitted Sprint 1 tree, source sha256 `96cd6496ab57…` (369 files) · **Config** code defaults, no `DATABASE_URL` → read mode `legacy`; only override `AQUA_DISABLE_MONGO_MIRROR=1` (isolation) · **Network attempts** 0 · **Coverage** 34/34 executed
**Record:** `aqua/eval/acib/acib-v1.baseline.json` (sha256 in `.sha256`) · **Gate baseline:** `aqua/eval/baselines/acib-v1.v1.json` · Method: [AQUA_ACIB_V1_IMPLEMENTATION.md](AQUA_ACIB_V1_IMPLEMENTATION.md)

These numbers **describe** today's production pipeline at the context level. They are not targets and say nothing about answer quality.

## 1. Headline

| | short history | long history (past the recall window) |
|---|---|---|
| Cases whose production context is "correct" (all required needs present, no leaks) | 15 / 17 | 13 / 17 |
| Production context recall | **1.00** | **0.83** |
| Production context precision | 0.54 | **0.14** |
| Production evidence coverage | 1.00 | 0.60 |
| Irrelevant items sent (sum) | 82 | **218** |
| Personal items sent for an impersonal question | 8 | 22 |
| Unknown handling | **0** | **0** |
| **Hiring decision — required facts present** | 6 / 6 | **1 / 6** |

The pattern is consistent with the audit:
- **Short history:** episodic recall quotes *everything* the user ever said. Recall is perfect and precision is poor.
- **Long history:** recall becomes keyword-ranked. Decision questions lose their decisive facts, while noise grows 2.7×.

Nothing anywhere marks information as unknown.

## 2. Per arm (means for rates, sums for counts)

| Metric | production s / l | recall s / l | memory s / l | knowledge s / l |
|---|---|---|---|---|
| context_precision | 0.54 / 0.14 | 0.63 / 0.35 | 0.46 / 0.11 | 0.15 / 0.15 |
| context_recall | 1.00 / 0.83 | 1.00 / 0.46 | 0.53 / 0.53 | 0.03 / 0.03 |
| evidence_coverage | 1.00 / 0.60 | 1.00 / 0.46 | 0.21 / 0.21 | 0.03 / 0.03 |
| context_efficiency | 0.60 / 0.16 | 0.63 / 0.35 | 0.51 / 0.12 | 0.15 / 0.15 |
| temporal_accuracy | 0.67 / 0.67 | 1.00 / 0.33 | 0.67 / 0.67 | 0 / 0 |
| contradiction_handling | 0.50 / 0.50 | 0.50 / 0.50 | 0.25 / 0.25 | 0 / 0 |
| unknown_handling | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| cross_entity_accuracy | 1 / 1 | 1 / 1 | 1 / 1 | 1 / 1 |
| irrelevant_items | 82 / 218 | 46 / 65 | 35 / 152 | 1 / 1 |
| critical_missing | 0 / 8 | 0 / 15 | 16 / 16 | 26 / 26 |
| critical_miss_with_noise | 0 / 3 | 0 / 7 | 7 / 8 | 1 / 1 |
| stale_as_current | 2 / 2 | 0 / 0 | 2 / 2 | 0 / 0 |
| forgotten_leaks | 1 / 0 | 1 / 0 | 0 / 0 | 0 / 0 |
| failed_turn_leaks | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |

**Question planner (plan only, not executed in production):** need coverage 0.67 in both regimes. Its decision template names slots for every hiring need, but it only runs inside the disabled Context Engine V2 over canonical predicates.

**Reading the arms:**
- **Recall** carries production's recall in the short regime and collapses in the long one (1.00 → 0.46).
- **Memory** (profile + cognitive model) finds about half of what questions need in either regime. Its precision falls from 0.46 to 0.11 as unrelated history accumulates, because filler conversations become profile facts, goals and "anticipated needs".
- **Knowledge** (PIC) carries only uploaded-file facts. Chat ingest is off by default, so it contributes almost nothing to personal questions.

## 3. Per scenario (production arm)

| Scenario | short P | short R | short items | long P | long R | long items | long missing | other checks (short / long) |
|---|---|---|---|---|---|---|---|---|
| ambiguous-relationship | 0.80 | 1 | 5 | 0.40 | 1 | 10 | – | unknown 0 / 0 |
| contradiction | 1 | 1 | 2 | 0.18 | 1 | 11 | – | contradiction 0.5 / 0.5 (visible, never flagged) |
| correction | 1 | 1 | 3 | 0.25 | 1 | 12 | – | stale 0 / 0 |
| cross-conversation | 0.60 | 1 | 5 | 0.13 | 1 | 15 | – | |
| cross-file | 0.71 | 1 | 7 | 0.26 | 1 | 19 | – | contradiction 0.5 / 0.5 ($49 vs $59 never flagged) |
| failed-turn | 0.60 | 1 | 5 | 0.12 | 1 | 17 | – | failed-turn leaks 0 / 0 (Sprint 1) |
| forgotten | 0 | – | 2 | 0 | – | 6 | – | **forgotten leak 1** / 0; unknown 0 / 0 |
| goal-change | 0.55 | 1 | 11 | 0.20 | 1 | 20 | – | **stale-as-current 2 / 2** |
| **hiring-decision** | 0.50 | 1 | 18 | **0.13** | **0.17** | 16 | team-size, departure, finances, prior-decision, revenue | unknown 0 / 0 |
| historical-current | 1 | 1 | 4 | 0.13 | 1 | 16 | – | stale 0 / 0 |
| irrelevant-history | 0 | – | 8 | 0 | – | 22 | – | personal items on an impersonal question 8 / 22 |
| long-history | 0.03 | 1 | 38 | 0 | **0** | 7 | dog-name | |
| missing-info | 1 | 1 | 6 | 0.31 | 1 | 13 | – | unknown 0 / 0 |
| multi-fact | 0.50 | 1 | 6 | 0.05 | **0.33** | 20 | trip, style | |
| multi-project | 0.20 | 1 | 5 | 0.08 | 1 | 12 | – | cross-entity 0 / 0 |
| personal-fact | 0.60 | 1 | 5 | 0.12 | 1 | 17 | – | |
| third-party | 0.17 | 1 | 6 | 0.05 | 1 | 20 | – | cross-entity 0 / 0 |

## 4. The critical hiring scenario — "Should I hire another developer?"

The question was classified `simple_qa` at confidence 0.45 (so in production it also pays for a reasoning pass and verification).

| Required fact | short: in context? | long: in context? | via |
|---|---|---|---|
| Team size (3 engineers) | yes | **no** | recall quote only |
| Marco's announced departure | yes | **no** | recall quote only |
| Finances ($180k, $30k/month) | yes | **no** | recall quote only |
| Roadmap (iOS by March 1, payments blocking) | yes | yes | Mind goal / deadline (+ recall in short) |
| Previous decision (hold until $20k MRR) | yes | **no** | recall quote only |
| Current revenue ($14k MRR) | yes | **no** | recall quote only |
| Unknown flagged (cost of a developer) | no | no | — |

**Short history:** precision 0.50, 18 items. All three distractors were present: the designer remark, the wedding, Portuguese.

**Long history:** precision 0.13 — 1 of 6 facts, 14 irrelevant items. `critical_miss_with_noise` = 1, the penalty the brief asked for. The only recall excerpt was **"I might hire a designer next year, not sure yet."** The rest of the context was:
- the profile — founder, Tidewell, plus filler that became facts: "Goals: drink more water…", "Hobbies: doing, crossword, puzzles, on, sunday, mornings", "likes: listening to jazz piano";
- inferred traits ("researcher (inferred, 73%)");
- the question itself as an "open question".

**Structured capture of the decision-critical facts: 1 of 6** (only the roadmap deadline, via the Mind). The other five exist only as verbatim history, so they reach the model only while recall quotes everything.

## 5. What the baseline shows (defects, with the case that shows each)

1. **The recall cliff** (`hiring-decision`, `multi-fact`, `long-history`): past 8,000 characters of history, keyword recall drops what decision and planning questions need ("What's my dog called?" ↛ "rescue greyhound … Pixel").
2. **Capture gaps:**
   - team, finances, revenue, departure and prior decisions are never structured;
   - "now work at Northbeam" is not captured ("Company: none current");
   - "I just started a new job at Y" is not captured at all.
3. **Capture noise:** casual filler becomes profile facts, goals, hobbies and anticipated needs (memory precision 0.46 → 0.11).
4. **The question becomes a goal / open question** before retrieval, and then supersedes an earlier goal in the recall note (`goal-change`: marathon quote annotated "now: Help me plan my training this week"; "Active goals: run a marathon" still asserted — stale_as_current 2).
5. **Contradictions are never flagged** (`contradiction`, `cross-file`: both values visible at best).
6. **No unknown handling anywhere (0.00):** missing salary or burn, which Alex, a forgotten address.
7. **Forget does not reach history-only data** (`forgotten@short`: the address remains in recall when no address *fact* existed).
8. **Impersonal questions carry personal context** (8 / 22 items for "At what temperature does water boil?").
9. **Held, as intended:**
   - cross-entity attribution in these scenarios (third-party, multi-project): 0 violations;
   - failed-turn integrity after Sprint 1: 0 leaks;
   - the sensitivity policy (the health sentence is withheld at default settings).

## 6. Comparisons — executed vs. proposed

| Comparison | Status |
|---|---|
| Production recall lane vs. Mind/memory lane vs. PIC lane vs. full production context | **Executed** (above) |
| Question planner — plan coverage | **Executed** (plan only; production does not run it) |
| Context Engine V2/V3 retrieval | **Not executed** — needs `AQUA_CONTEXT_V2=on` and Postgres; enabling disabled features for the benchmark was excluded |
| Canonical World Model (E6 + Postgres) | **Not executed** — proposed arm C2 (disposable test DB) |
| Base LLM / conventional RAG / answer quality | **Not executed** — Stage B, needs an authorised model (D-3) |
