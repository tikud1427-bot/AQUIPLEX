# AQUIPLEX Sprint 2 — Engineering Notes (ACIB v1)

**Date:** 2026-11-10 · For engineers running, extending or changing ACIB. What it measures: [implementation](AQUA_ACIB_V1_IMPLEMENTATION.md) · numbers: [baseline results](AQUA_ACIB_V1_BASELINE_RESULTS.md).

## Running it

```bash
cd aqua
npm run eval:gate                          # every gate suite, incl. acib-v1 (DATABASE_URL must be blank, as in CI)
node eval/gate.mjs acib-v1                 # ACIB only, against eval/baselines/acib-v1.v1.json
node scripts/acib-run.mjs --label my-change # full record → eval/acib/results/acib-v1.my-change.json
```

- About 9 s for 34 cases.
- No provider, database or external network is needed. The suite isolates its own data dir, and a guard blocks and counts any non-loopback call.
- Set no `AQUA_*` gate: an override makes every case SKIPPED. `AQUA_DISABLE_MONGO_MIRROR` and the logging gates are exempt.

## Design decisions

1. **The existing eval framework, not a new one.** ACIB is an ordinary suite (`cases / run / score / metrics`). The gate gives it baselines, fingerprinting, refusals and direction rules. The only framework change is `isLowerBetter()` in `eval/core/gate.mjs`: suffix-declared error counts (`_irrelevant_items`, `_critical_missing`, …), so 200+ per-arm metrics are gated in the right direction without hand-listing them. `evalGate.test.js` checks it, including that more irrelevant items **block**.
2. **The production path, not a model of it.** History goes through `prepareTurn` → persist → `commitTurnMemory` → `runPostTurn`, and uploads through the real route, so the benchmark sees exactly what a user's history produces — including capture noise. The model call is the only stage removed.
3. **Two regimes**, because the audit's central finding is a cliff at the 8,000-character recall window. A benchmark measuring only short histories would report perfect recall.
4. **Lanes as arms.** "Which lane carried it" is what the next change needs to know: recall carries production today, and memory and knowledge barely contribute to decision questions.
5. **The planner is plan-only.** It is the existing question-driven component, but production does not execute it. Its coverage shows what a store-agnostic version could ask for (R-5).
6. **Dataset frozen by hash; baseline write-once.** Changing expected results is a separate, reviewed act (implementation §7).
7. **Every check has been shown to bite:**
   - the failed-turn scenario detects leaks when the Sprint 1 rollback is disabled (2–3 leaks; long-regime recall 1 → 0);
   - a corrupted freeze skips every case;
   - re-freezing is refused;
   - two runs are identical.

## Harness validation log (pre-freeze)

| Found | Kind | Action |
|---|---|---|
| Configuration check rejected `AQUA_DISABLE_MONGO_MIRROR=1` | harness bug | context-neutral gates exempted |
| Runner drops `actual` from records | harness gap | expected and retrieved evidence put into each case's score |
| `injury` required, but withheld by the sensitivity policy | dataset error | made optional, with a note |
| `failed-turn` could not detect a leak | dataset weakness | redesigned and re-verified by disabling the fix |
| "I just started a new job at …" not extracted | **product defect** | recorded; scenario rephrased |

## Product defects the baseline surfaced (input for the next sprint, not fixed here)

See [baseline results §5](AQUA_ACIB_V1_BASELINE_RESULTS.md) and [Sprint 1 report](AQUIPLEX_SPRINT1_PRODUCTION_SAFETY_REPORT.md). In priority order for intelligence work:

1. Recall cliff on decision and planning questions (`hiring-decision`, `multi-fact`, `long-history`).
2. Decision-critical facts never structured: team, finances, revenue, departures, prior decisions.
3. No unknown handling anywhere.
4. The question is stored as a goal or open question before retrieval.
5. Filler becomes profile facts and goals (capture precision).
6. Contradictions never flagged.
7. Forget does not reach history-only data.
8. Multi-sentence forget hits the wrong fact.

## Recommended next step

The roadmap's R-5 — a store-agnostic information-needs model on the production path — measured on ACIB:
- **Must improve:** `critical_production_long_context_recall` (0.17), `production_long_context_precision` (0.14), `production_*_unknown_handling` (0).
- **Must not regress** any other gated metric. The gate enforces this.

Before claiming generalisation, write a **held-out** ACIB set authored independently of the change. Stage B (answer level) still needs D-3.

## Caveats for anyone reading the numbers

- Dates inside recall excerpts change day to day; the metrics do not (verified).
- Regex matching is per item. Check `retrieved` in the record before trusting a surprising number.
- The baseline was recorded on the **uncommitted** Sprint 1 tree (source SHA in the record). If Sprint 1 is changed before commit, re-run and compare before trusting the frozen numbers.
