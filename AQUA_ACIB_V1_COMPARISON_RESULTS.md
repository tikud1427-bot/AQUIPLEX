# ACIB v1 — Comparison: Existing Pipeline (A) vs Information Needs Engine (B)

**Date:** 2026-11-10 · Context level only (no model calls) · Production code paths at default flags without Postgres; arm B differs only by `AQUA_INFO_NEEDS=on`, scoped to each scenario run · Network attempts: 0 in every run · Engine sha256 `1f4e64c9…`

**Data and records:**

| Set | Dataset | A record | B record |
|---|---|---|---|
| Dev | `acib.v1.json` (`d041746a…`, frozen in Sprint 2, unchanged) | `eval/acib/acib-v1.baseline.json` (Sprint 2), re-run identical: `results/acib-v1.sprint3-arm-a.json` | `eval/acib/acib-v1-needs.baseline.json` |
| Held-out | `acib.heldout.v1.json` (`8da1bffb…`, frozen before the engine existed) | `eval/acib/acib-heldout-v1.baseline.json` (recorded before the engine existed) | first run `results/acib-heldout-v1-needs.first-run.json`; final `eval/acib/acib-heldout-v1-needs.baseline.json` |

**How to read it:**
- **Dev:** the engine was developed against the dev set, so its numbers show the engine *can* do it.
- **Held-out first run:** the honest generalisation measure.
- **Held-out final:** recorded after fixing three generic bugs that run exposed; contaminated by that knowledge, and labelled so.

## 1. Long history (past the recall window — where every retained user ends up)

| Metric | dev A | **dev B** | held-out A | **held-out B, first run** | held-out B, final |
|---|---|---|---|---|---|
| Context recall | 0.83 | **1.00** | 0.81 | **0.98** | 1.00 |
| Context precision | 0.14 | **0.85** | 0.16 | **0.85** | 0.85 |
| Irrelevant items (sum) | 218 | **6** | 85 | **4** | 4 |
| Unknown handling | 0.00 | **1.00** | 0.00 | **0.50** | 0.50 |
| Evidence coverage | 0.60 | **1.00** | 0.81 | **0.98** | 1.00 |
| Temporal accuracy | 0.67 | **1.00** | 1.00 | 1.00 | 1.00 |
| Contradiction handling | 0.50 | **1.00** | 0.50 | **0.50** | 1.00 |
| Cross-entity accuracy | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| Stale asserted as current | 2 | **0** | 0 | 0 | 0 |
| Forgotten leaks / failed-turn leaks | 0 / 0 | 0 / 0 | – | – | – |
| Personal items on impersonal questions | 22 | **0** | 15 | **0** | 0 |
| Correct cases | 13/17 | **17/17** | 7/10 | **9/10** | 10/10 |
| Mean prompt tokens | 1,639 | **1,304** | 1,489 | 1,290 | 1,306 |
| Mean question `prepareTurn` ms | 4.5 | 4.8 | – | 3.2 | 4.4 |
| Mean engine ms | – | 1.16 | – | 0.91 | 1.61 |

## 2. Short history (no regression allowed)

| Metric | dev A | **dev B** | held-out A | held-out B, first run | held-out B, final |
|---|---|---|---|---|---|
| Context recall | 1.00 | **1.00** | 1.00 | 0.98 | 1.00 |
| Context precision | 0.54 | **0.85** | 0.44 | 0.85 | 0.85 |
| Irrelevant items | 82 | **6** | 65 | 4 | 4 |
| Unknown handling | 0.00 | **1.00** | 0.00 | 0.50 | 0.50 |
| Evidence coverage | 1.00 | **1.00** | 1.00 | 0.98 | 1.00 |
| Temporal / contradiction | 0.67 / 0.50 | **1.00 / 1.00** | 1.00 / 0.50 | 1.00 / 0.50 | 1.00 / 1.00 |
| Correct cases | 15/17 | **17/17** | 10/10 | **9/10** | 10/10 |
| Mean prompt tokens | 1,504 | 1,304 | 1,440 | 1,290 | 1,306 |

**Short-history regression:** none on the dev set. On the held-out set, the *first run* regressed short recall 1.00 → 0.98 and correctness 10/10 → 9/10 (`ho-job-offer`). The cause was the hedge bug ("we agreed we want to stay…" discarded as speculation); it was fixed generically.

## 3. Targets (long history)

| Target | Dev B | Held-out B first run | Met? |
|---|---|---|---|
| Recall ≥ 0.95 | 1.00 | 0.98 | **yes** (both) |
| Precision ≥ 0.50 | 0.85 | 0.85 | **yes** (both) |
| Unknown handling ≥ 0.80 | 1.00 | **0.50** | dev yes, **held-out no** |
| Correct ≥ 16/17 (94%) | 17/17 | 9/10 (90%) | dev yes; **held-out first run no** (final 10/10 is post-hoc) |
| Hiring 6/6 | 6/6 | – | **yes** |
| Short history no regression | none | first run: −1 case (fixed) | dev yes |

**The unknown-handling target is not met on held-out data.** One of its two unknown-bearing scenarios (`ho-pricing`: "Is it a good time to raise our price?") needs a "churn / customer reaction" unknown. Only the generic decision template applies to it, and that template has no domain knowledge of pricing. Writing a pricing template after seeing this case would be tuning on held-out data, so it was not done. The honest held-out figure is 0.50 from 2 scenarios. A larger held-out set is needed before this number means much either way.

## 4. The critical hiring scenario — "Should I hire another developer?"

| | A short | A long | **B short** | **B long** |
|---|---|---|---|---|
| Required facts present | 6/6 | **1/6** | **6/6** | **6/6** |
| Precision | 0.50 | 0.13 | 0.86 | 0.86 |
| Items sent | 18 | 16 | 7 | 7 |
| Unknown flagged (cost of a developer) | no | no | **yes** | **yes** |
| Prompt tokens | 1,768 | 1,672 | 1,542 | 1,542 |

The arm B context is identical in both regimes:

```
--- INFORMATION NEEDS (what this question requires, from what the user told Aqua) ---
This is a request for advice (decision); it needs 8 piece(s) of information. …
- Not known: the cost of a developer (salary or hiring cost) — the user has not said. Do not guess it.
Status: insufficient. … ask ONE targeted question about the most important gap; otherwise answer conditionally …
--- END INFORMATION NEEDS ---
WHAT THE USER TOLD YOU BEFORE (… only excerpts that match this message):
[… ] We have 3 engineers: Priya, Marco and Sam.
[… ] We have $180k in the bank and we burn about $30k a month.
[… ] We need to ship the iOS app by March 1, and the payments integration is blocking it.
[… ] Last quarter we decided to hold off on hiring until we reach $20k MRR.
[… ] We're at $14k MRR right now.
[… ] Marco told me he's leaving at the end of the month.
```

Not sent: the possible designer hire, the sister's wedding, learning Portuguese, the founder's profile, filler-derived "goals" and "hobbies", inferred traits, and the question echoed as an "open question".

The one irrelevant item by the scorer's definition is the "Not known: cost of a developer" line. The benchmark's relevance patterns do not cover it, but it is the declared unknown the brief asks for.

## 5. Per-scenario changes worth noting (long history)

| Scenario | A → B | What changed |
|---|---|---|
| goal-change | stale 2 → 0 | The marathon is annotated "since changed — now: My new goal is to swim…"; the question is no longer stored as a goal; the health sentence stays withheld |
| forgotten | leak (short) → 0, unknown 0 → 1 | "Forget my address" now removes the address even though no address fact existed |
| contradiction / cross-file | 0.5 → 1 | The $50k vs $40k and $49 vs $59 conflicts are named, not left for the model to notice |
| ambiguous-relationship | unknown 0 → 1 | "which Alex — Alex Chen or Alex Rivera" |
| irrelevant-history | 22 personal items → 0 | Impersonal questions get no personal context |
| long-history | recall 0 → 1 | "dog" → "greyhound … Pixel" via the small hyponym map |
| multi-fact | recall 0.33 → 1 | Trip, partner diet and venue style found as separate requirements |

## 6. What this does not show

- **Answer quality.** This is the context the model receives, not what it answers (Stage B needs an authorised model, D-3).
- **Breadth.** Both sets are small and synthetic. The held-out set has 10 scenarios and was written by the same engineer (before the engine, but with its design in mind). Real users phrase things more variously than these lexical vocabularies cover.
- **Production behaviour.** The gate is off; nothing here has run on real traffic.
