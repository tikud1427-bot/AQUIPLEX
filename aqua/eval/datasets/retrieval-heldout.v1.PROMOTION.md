# Promotion criteria — canonical relevance gate on retrieval-heldout.v1

Written 2026-10-17 13:16 IST, after the held-out BEFORE run (gate off) and BEFORE any
held-out AFTER run. Aggregates only were looked at; no per-query held-out output was read.

BEFORE (gate off, deterministic tie-breaks), 82 queries (56 answerable, 26 silence, 16 stale-labelled):

| ranker | recall@8 | MRR | top-1 | unknown honesty | noise lines | stale leaks |
|---|---|---|---|---|---|---|
| V2 (gate config) | 0.821 | 0.690 | 0.589 | 0.192 | 132 | 11/16 |
| V3 (production .env) | 0.821 | 0.712 | 0.625 | 0.192 | 120 | 11/16 |

The gate (AQUA_CANONICAL_RELEVANCE_GATE=on, default) is PROMOTED only if, for BOTH rankers:

1. unknown_honesty rises by at least +0.25 (absolute);
2. noise_lines falls by at least 50%;
3. recall@8 falls by no more than 0.054 (at most 3 of 56 answerable queries);
4. MRR falls by no more than 0.03;
5. stale_leaks does not rise.

Otherwise it is not promoted (rollback = AQUA_CANONICAL_RELEVANCE_GATE=off) and the failure is reported.
The AFTER run is executed once. Any later change motivated by held-out per-query output spends the set.

## Result (AFTER run, executed once, 2026-10-17 13:18 IST)

| ranker | recall@8 | MRR | top-1 | unknown honesty | noise lines | noisy queries | stale leaks |
|---|---|---|---|---|---|---|---|
| V2 | 0.821 → **0.839** | 0.690 → **0.718** | 0.589 → **0.625** | 0.192 → **0.654** | 132 → **26** | 21 → 9 | 11 → 10 |
| V3 | 0.821 → **0.839** | 0.712 → **0.731** | 0.625 → **0.643** | 0.192 → **0.654** | 120 → **26** | 21 → 9 | 11 → 10 |

Criteria 1–5: all met for both rankers. **Decision: PROMOTED** (gate on by default; rollback flag kept).

Not resolved by this change: 10 of 16 current-value questions still receive a value the user has
since changed. Sample is small (16); a 1-query change is noise.

After this decision the per-query output was opened to diagnose the stale leaks (write-path state, not
ranking). From here, retrieval-heldout.v1 is DEVELOPMENT data for any state/supersession change; such
changes need a new held-out set for a promotion decision.
