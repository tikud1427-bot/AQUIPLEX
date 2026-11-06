# Follow-up relevance v1 (frozen 2026-11-05, before implementation)

This is an independent offline test of two things in episodic recall (`src/memory/episodicRecall.js`):
- the follow-up admission model `AQUA_RECALL_FOLLOWUP_V2`;
- the forgotten-text privacy fixes, which apply unconditionally.

It was written and frozen **before** either was implemented. It isn't derived from the v1 or v2 semantic-recall results, and it shares none of their names.

## Freeze
`MANIFEST.sha256` covers `dataset.v1.json`, `grade.mjs` and this README. The grader refuses to run if any of them changed. `--unfrozen-ok` was used only while authoring, before the freeze.

## Run (offline: no key, no network, private data dir)
```
node eval/followup-relevance-v1/grade.mjs [--json <file>] [--verbose]
```

## What is graded
| Group | Cases | Checks |
|---|---|---|
| admit | N1–N14 | a legitimate continuation is quoted as `follow-up` with the expected `relation` |
| uncertainty | U1 | a hedged statement is admitted as `speculative`, `hedged: true`, and never closes the open state |
| reject | X1–X12 | the later statement is not quoted |
| budget | B1–B3 | per-root cap 2 (descendants count against the root), meaning-only seed 1, bounded chains, hedged last |
| privacy | P1–P8 | forgotten sentences contribute no keywords, names, identifiers or transitions; forgotten parents seed nothing; forget-everything holds; other owners and deleted conversations never participate. Graded with the flag **off and on**, through the production entry (`recallForTurn`) and the production forget store |

**Preconditions** (with follow-ups off):
- the seed is chosen by ranking, as `match` in keyword mode or `semantic` in meaning mode;
- no expected target is selected, except in privacy cases, where the ranking itself is under test;
- no case text is classified sensitive.

**Invariants:** quotes are in date order, the seed is never dropped, and follow-ups stay within the budget.

**Informational, not graded:** how the legacy follow-up step (flag off) handles the admission cases.

Expected outcomes follow the approved design. Its relation order is: correction, closure, update, revalue, decision, change, speculative, mention.
