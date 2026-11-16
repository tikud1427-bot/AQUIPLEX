# AQUA Hybrid Context V1 — Results

**Sprint 6, 2026-11-11.** Context level (what the model receives), unchanged frozen ACIB scorer, 0 network attempts in every run.

> **Not an independent evaluation.** Every set below has been seen by the implementation author:
> - development sets: `acib.v1`, `acib.heldout.v1` (post-hoc since Sprint 3), `acib.v2.dev`;
> - `acib.v2.eval`, contaminated since Sprint 4 and used here **only as a regression check**.
>
> The independent test is ACIB v3, which is not yet frozen ([governance](AQUA_ACIB_V3_FREEZE_AND_GOVERNANCE.md)). Answer quality is unmeasured (no paid run).

**Arms:**
- **A:** production defaults.
- **B:** `AQUA_INFO_NEEDS=on` (replacement, Sprint 4 V2).
- **H:** `AQUA_HYBRID_CONTEXT=on`.

**H records:** `eval/acib/results/*-hybrid.s6b.json` (final). The first H run, `*.s6.json`, came before the wording alignment described in §4.

## 1. A and B are unchanged by the Sprint 6 code

A and B were re-run on all four sets (`*.s6.json`) and compared with their Sprint 4 records:
- `acib-v1`, `acib-heldout-v1`, `acib-v2-dev`, `acib-v2-eval`;
- `acib-v1-needs`, `acib-heldout-v1-needs`, `acib-v2-dev-needs`, `acib-v2-eval-needs`.

In all **8 comparisons, 0 metrics differ and every item is identical.** With the hybrid off, the route, engine and adapter changes are inert.

## 2. Results

### Correct cases (production context holds every required need, no leaks)

| Set (scenarios) | A short | B short | **H short** | A long | B long | **H long** |
|---|---|---|---|---|---|---|
| v1 dev (17) | 15 | 17 | **15** | 13 | 17 | **15** |
| held-out v1 (10) | 10 | 10 | **10** | 7 | 10 | **10** |
| v2 dev (40) | 39 | 40 | **39** | 32 | 40 | **35** |
| v2 eval (100, contaminated) | **95** | 88 | **95** | 74 | **82** | 79 |

**Paired, H vs A, on v2 eval:**
- short: **0 gained, 0 lost**;
- long: **5 gained, 0 lost**.

**Across all sets and both regimes, H never lost a case A had.**

### Context quality, v2 eval (contaminated; regression reading)

| Metric | A short | B short | H short | A long | B long | H long |
|---|---|---|---|---|---|---|
| Recall | 0.98 | 0.94 | **0.98** | 0.79 | **0.86** | 0.83 |
| Precision | 0.55 | **0.80** | 0.50 | 0.16 | **0.68** | 0.17 |
| Temporal accuracy | 0.73 | **0.82** | 0.73 | 0.55 | **0.64** | 0.55 |
| Contradiction handling | 0.50 | **0.94** | **0.94** | 0.50 | **0.94** | **0.94** |
| Unknown handling | 0.00 | **0.85** | **0.85** | 0.00 | **0.69** | **0.69** |
| Stale asserted as current | 4 | 3 | 5 | 3 | 2 | 4 |
| Personal items on impersonal | 15 | **0** | 15 | 77 | 13 | 77 |
| Irrelevant items (sum) | 451 | 65 | 489 | 702 | 165 | 730 |
| Mean prompt tokens | 1,392 | 1,307 | 1,431 | 1,417 | 1,321 | 1,456 |

### Development sets (H)

| Set | Contradiction | Unknown handling | Temporal | Correct short / long |
|---|---|---|---|---|
| v1 | 0.50 → **1.00** | 0 → **1.00** | 0.67 (= A) | 15 / 15 (A: 15 / 13) |
| held-out v1 | 0.50 → **1.00** | 0 → **1.00** | 1.00 | 10 / 10 (A: 10 / 7) |
| v2 dev | 0.50 → **1.00** | 0 → **1.00** | 0.80 (= A) | 39 / 35 (A: 39 / 32) |

### Cost

| Measure | Value |
|---|---|
| Block present | 37–40 of 100 eval turns; 5–25 of the dev turns |
| Tokens added (eval) | mean **+39**, max 206 (budget 400) |
| Tokens added (dev) | mean +45 to +94, max 223 (budget 400) |
| `prepareTurn` time | v2 eval: H 11.5 / 18.1 ms vs A 5.4 / 7.1 ms (short/long). Separate runs on a shared development machine, so timings vary with load (the same H suite took 80 s in one run and 328 s in another). Dev sets (s6b): 4.5–8.4 ms short. A controlled latency measurement is still needed. |
| Engine time | as Sprint 4: mean ≈3.4 ms |
| Model calls | none |

## 3. Reading

**What the hybrid does, as designed:**
- keeps A's recall (0.98 short) and **never loses an A case**;
- adds what A lacks: contradictions flagged (0.50 → 0.94), verified unknowns (0 → 0.85 short / 0.69 long), and missing evidence on long histories (+5 eval cases, +2 / +3 / +3 dev cases).

**What it does not do (v1 by design, the precision work deferred):**
- **Precision and personal-items-on-impersonal are A's levels.** The block adds lines the frozen scorer counts as non-relevant: its notes and "Not known" lines, as in Sprint 3. So precision dips slightly: 0.55 → 0.50 short.
- **Temporal accuracy is A's.** A's stale profile lines stay. The hybrid's "No longer current" note is a separate line, so the scorer still counts A's line.

**H vs B:**
- **H beats B on short histories:** 95 vs 88 correct on v2 eval, where B's replacement loses A's broad context.
- **B beats H on long histories** (82 vs 79) and on precision and temporal accuracy, because B removes noise.

This matches the Sprint 5 design: the hybrid is the **safe** composition. Precision gains need the separate pruning step.

## 4. Investigated, not hidden

| Finding | Cause | Action |
|---|---|---|
| **H stale-as-current +1 in each regime** (`hc-rent`) | V2 does not read "the landlord **put the rent up to** 1,050" as a change (a Sprint 4 limit), so it reports a **conflict**. The hybrid's conflict note quotes "950", and the scorer counts a structured line with the old value and no change word as stale. | The hybrid flags both values and asks which is right, which is the safe direction. **Not fixed in Sprint 6:** the general fix belongs in V2's change detection ("put/raised/increased/cut … (up/down) to <amount>"), and making it would move arm B against its frozen Sprint 4 records. Recommended for the next V2 change, measured on v3. |
| **H precision −0.05 (short, eval)** | Note lines (unknowns, conflicts) are items the frozen scorer does not match to needs | Expected for an additive design. The pruning flag is the lever. |
| **First H run (`s6`) had lower unknown handling on dev** (v1 0.50, v2-dev 0.83) | The hybrid worded ambiguity ("Ambiguous: which Alex…") and forgotten topics ("Do not use or reconstruct…") differently from V2's own rendering ("Not known: …") | Aligned to V2's wording (dev-set change, made before the final `s6b` run). Final dev unknown handling 1.00. |
| A conflict V2 misses ("is about 17,500" vs "the dealer said the price is 19,000") | The two sentences share too few words for V2's same-subject rule | Recorded. The route test uses an unambiguous conflict. |
| A third-party statement added as "situation" ("My brother Teo is training to be a pilot", for a van purchase) | A stem collision ("training" → transport `train`) plus first-person "My" | **Fixed generally:** a family member's or friend's situation is not the user's. Unit and route tests added. |

## 5. Recommendation

- **`AQUA_HYBRID_CONTEXT` is the candidate for shadow, then cohort `on`.** It does not lose an existing-pipeline case on any set seen, and adds conflict and unknown handling at about 40 tokens per turn. `AQUA_INFO_NEEDS=on` (replacement) is not, because it loses short-history cases.
- **Before `on`:**
  1. ACIB v3, independently authored and frozen; one run of H vs A.
  2. The answer-level A vs H pilot (runner ready; needs approval and prices).
  3. Shadow observation of `[HYBRID]` lines (`reason`, `unknowns`, `not_matched`, `tokens`, `ms`).
