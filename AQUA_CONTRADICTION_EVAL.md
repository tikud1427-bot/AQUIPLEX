# AQUA — the contradiction eval

**Status:** the eval FINDING-1 said had to exist before any fix. No detector
change.

---

## Why this before the fix

FINDING-1 measured 73,500 false `contradicts` edges from 300 facts and
deliberately did not repair anything, because there was **no way to tell
whether a fix removed the false positives without removing the true ones**.

This is that way. 53 labelled statement pairs — 15 genuine contradictions, 38
independent — with 22 of the independents in the exact per-item-table shape
that fires.

## The baseline

```
precision   21.4%     22 false positives against 6 true ones
recall      40.0%     9 of 15 genuine contradictions MISSED
f1          27.9%

false_fire_per_item_table   95.5%   ← the FINDING-1 shape
false_fire_temporal_sequence 33.3%
false_fire_restatement       0.0%   ← these are fine
false_fire_unrelated         0.0%
```

## 🔴 It is worse than FINDING-1 could see

FINDING-1 showed over-firing. The eval shows the other half: **the detector
also misses most genuine contradictions.**

The predicate compares **digits and word overlap**, nothing else. So it is
blind to:

| missed | example |
|---|---|
| spelled numbers | *"runway is fourteen months"* vs *"six months"* |
| categorical conflict | *"launch is confirmed"* vs *"cancelled"* |
| entity conflict | *"Dev reports to Priya"* vs *"to Karan"* |

**Over-firing and under-detecting at once.** A fix has to move both, and
"tighten the rule" alone would make recall worse.

## Precision and recall, never averaged

The dataset is deliberately unbalanced toward independent pairs, because the
measured failure is over-firing. A single accuracy figure over an unbalanced
set would let a detector that says *"contradiction"* to everything look
respectable — which is the behaviour under investigation.

Scored explicitly, and asserted:

| detector | precision | recall |
|---|--:|--:|
| perfect | 1.00 | 1.00 |
| fires on everything | 0.28 | **1.00** |
| fires on nothing | **0.00** | 0.00 |

That last row is a guard: a naive `tp/(tp+fp)` returns 1 when nothing fires,
which would make total silence look flawless.

## It scores the SHIPPED predicate

`_conflictKindForTests` is a seam, not a copy. A duplicated rule in the harness
would drift the first time either side changed, and the baseline would then
measure a detector nobody ships.

**What a pair cannot express:** the real detector gates on cross-file
provenance before it ever calls this predicate. That gate is a policy question,
and the FINDING-1 false positives all passed it legitimately — they really were
in different files. **The text is where the error is**, and that is what this
measures. Stated in the dataset's own limitations.

## Also stated

Restatements (*"fourteen months"* / *"14 months"*) and temporal sequences
(*"at Intercom until 2024"* / *"at Nummo since 2025"*) are labelled
**independent**. One is corroboration, the other is history. Getting them wrong
would be a different bug wearing the same clothes.

Every case carries a `why`. A relevance judgment with no reason cannot be
argued with, and this dataset exists to be argued with.

## 🔴 My own fixture was wrong first

The seam test used a hand-written pair that returned `null` — four overlapping
words, and the rule needs more. **The seam was fine; the example was wrong.**
It is now anchored on real dataset cases, which is what an invented fixture
does not get to be.

## Bite, measured

| mutation | failures |
|---|---|
| report one averaged accuracy | 1 |
| make precision 1.0 when nothing fires | 1 |
| drop the per-category false-fire rates | 1 |
| *(reverted)* | **0 — 17/17** |

## Results

```
npm test    2358 / 232 suites / 0 fail / 1 skipped-with-a-reason
eval:gate   exit 0 — the new suite is gated from this commit
```

## What a fix now has to do

Beat **both** numbers, together, with the gate watching:

```
precision  21.4%  →  the per-item-table class is 95.5% of the damage
recall     40.0%  →  and tightening alone makes this worse
```

That is a real target instead of a guess, which is the whole point of having
done this first.
