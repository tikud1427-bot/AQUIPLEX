# AQUA — bucketing the contradiction pass

**Closes FIX-4.** Both evals were in place first, and both were needed.

---

## The result

| | before | after |
|---|--:|--:|
| comparisons, 300-fact ledger | 37,500 | **750** |
| comparisons, 600-fact ledger | 150,000 | **1,500** |
| time, 600 facts | 537 ms | **81 ms** |
| comparison ratio at 2× facts | 4.0× (quadratic) | **2.0× (linear)** |
| corpus: pairs examined | 1104 (71.7%) | **561 (36.4%)** |
| **selection_recall** | 100% | **100%** |
| **spurious_emitted** | 0 | **0** |
| predicate precision / recall | 100% / 93.3% | **unchanged** |

**The pass is linear.** Cost fell 50× on the ledger shape with correctness
untouched — which is the whole reason EVAL-2 had to exist before this PR.

## Two changes, in order of risk

**1 — Hoist the evidence lookups.** `evidenceForFact` was called twice per
*pair*: O(N²) store reads to answer a question that depends on one fact.
Computing each fact's file set once is O(N). **Zero behaviour change** — the
set of pairs reaching `conflictKind` is identical.

On its own this only moved 3.84× → 2.78×. The store reads were not the cost.

**2 — Bucket by subject.** `differentSubjects` already rejected most pairs, but
it was asked once per *pair*, so the enumeration happened anyway. Computing
each fact's subject key once and comparing only within a bucket skips the
enumeration itself.

A fact with **no** subject key joins a global bucket compared against
everything, because "no series index" means "could be about anything".
Dropping those is the silent recall loss FIX-4 refused to risk — and
`contradiction-corpus.v1` is what proves it didn't happen.

## 🔴 Bucketing first made it WORSE

1104 → **2609** comparisons. A fact with two keys sits in two buckets, `global`
is appended to each, so pairs repeat — and the `seen` check ran **after**
`conflictKind`, so every repeat was paid for.

Moving the dedup above the comparison: 2609 → **561**. The optimisation was
correct and its bookkeeping was backwards, which the comparison counter made
obvious and a stopwatch would have muddled.

## 🔴 A guard that bit nothing — and was not dead

Removing `candidateGroups.push(global)` failed **zero** tests, because
`[...bucket, ...global]` already pairs global facts *whenever a bucket exists*,
and the corpus always has one.

It is load-bearing exactly when **every** fact is keyless: `buckets` is empty,
`candidateGroups` is empty, nothing is compared, total recall loss. Now tested
with an all-keyless corpus; bite 0 → 1.

**The FIX-2 lesson again**: "bites nothing" can mean *untested edge case*, not
*dead code*. Third time that distinction has mattered.

## Also caught

An edit whose close-anchor didn't match aborted the script **before writing**,
so a run that printed plausible numbers was measuring the unchanged file. The
numbers looked fine, which is what made it dangerous. Every edit now asserts
after the write, not before.

## Bite

| mutation | failures |
|---|---|
| keyless facts never compared | 2 |
| revert to comparing every pair | 2 |
| dedupe after comparing again | 1 |
| drop the global bucket | 1 *(after the edge case was added)* |

## Two inverting pins closed

FIX-4's *"doubling the facts quadruples the pairs"* and EVAL-2's *"it examines
most of the possible pairs"* both inverted, each exactly as designed.

## Results

```
npm test    2373 / 236 suites / 0 fail / 1 skipped-with-a-reason
eval:gate   exit 0 · both contradiction baselines moved deliberately
```
