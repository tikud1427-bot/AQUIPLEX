# AQUA — an eval for contradiction PAIR SELECTION

**Status:** the prerequisite FIX-4 named. No production code changed.

---

## Why this exists

FIX-4 measured `detectCrossFileContradictions` doing O(N²) work for O(N)
output, and declined to fix it:

> *the repair is bucketing pairs by subject before comparing them, which
> changes WHICH PAIRS ARE EVER CONSIDERED. The contradiction eval measures the
> predicate, not the pair-selection strategy — a bucketing bug would silently
> stop finding real contradictions and score identically.*

This closes that gap. `contradiction-core.v1` scores the **predicate** on
isolated pairs; this scores **selection** over a whole corpus.

## Why a corpus, not more pairs

A pair-level test hands the detector both statements. It can never notice a
strategy that never brings those two together — which is precisely the failure
mode of any bucketing, sharding or indexing change.

So the input is **56 facts across four files** with five genuine contradictions
planted in them, plus a **40-row per-item ledger** as decoys — the shape
FINDING-1 measured firing 73,500 times.

## The baseline

```
selection_recall        100%     all 5 planted contradictions found
spurious_emitted           0     FIX-1/FIX-2 hold at corpus scale
comparisons_examined    1104
fraction_of_all_pairs   71.7%    ← the O(N²) signature
```

**A bucketing fix must hold recall at 1.0 and spurious at 0 while dropping
`fraction_of_all_pairs` well below 0.717.** That is a target, not an argument.

## Recall and cost are never combined

A change that halves the work and loses one real contradiction is a
**regression**. One score would hide that; two cannot. Asserted directly:

| | recall | comparisons |
|---|--:|--:|
| good bucketing | 1.00 | 200 |
| buggy bucketing | 0.80 | 200 |

The two differ only in recall — which is the outcome FIX-4 said the pair-level
eval could not distinguish from a real improvement.

## Cost is counted, not timed

FIX-4 paid for this three times: a lower bound on a timing ratio flakes under
load, a comparison count does not. A test asserts the suite contains no
`performance.now`.

## 🔴 My harness was wrong before the detector was

The first run reported **selection_recall 0%** — every planted contradiction
missed. Before writing that up, I probed the emitted object: the shape is
`{ id, entity, type, factIds, statements, sourceFiles, evidence, reason }`, and
I had read `factA` / `from` — **field names I invented.**

The detector was working fine. Checking the real object is the only reason this
reads 100% instead of shipping a false finding — the same discipline that
caught the three-probe extraction adapter in E2/PR-3.

**Sixth self-match** in the same PR: my "cost is counted, not timed" check
banned `Date.now`, which appears in the suite's owner-id generator and is not a
stopwatch. Narrowed to `performance.now`.

## Bite

| mutation | failures |
|---|---|
| combine recall and cost into one score | 1 |
| count spurious as recall | 1 |
| split the corpus into per-fact cases | 1 |
| *(reverted)* | **0 — 12/12** |

## Results

```
npm test    2372 / 234 suites / 0 fail / 1 skipped-with-a-reason
eval:gate   exit 0 — the selection suite is gated from this commit
```

## What is now unblocked

Bucketing the contradiction pass. Both halves are measurable: the predicate by
`contradiction-core.v1` (precision 100%, recall 93.3%) and the selection by
this one (recall 100%, 71.7% of pairs).

A fix has to satisfy both at once, which is the first time that has been true.
