# AQUA — correcting a measurement, and nearly deleting a real finding

**Status:** a harness fix and an honest correction. No production code changed.

---

## What I set out to do

FIX-2 left one target: *"the FI-2 pass is still 3.81× quadratic — the
contradiction edges were only one cause, so profiling the rest is bounded."*

## What the profile said

Every stage, measured separately at 300 → 600 facts:

```
rebuildGraph    760ms →  843ms    1.11×
getForensics     97ms →  203ms    2.08×
consensus         4ms →    3ms    0.74×
gaps             22ms →    4ms    0.19×
whatCaused        1ms →    1ms    0.69×
seeding          26ms →   15ms    0.57×
```

**Nothing quadratic.** So where was 3.81× coming from?

## The suspicion, and one measurement that agreed with it

The FI-2 test's workload writes into module-level singleton stores. Each sample
leaves its owner's data behind, so the 2n sample runs against a store holding
everything before it. A single better-isolated reading:

```
accumulating store   4.11×
isolated per sample  1.90×
```

That looked conclusive. I wrote the correction, retitled the test *"scales
LINEARLY"*, and started documenting FLAKE-1's finding as an artefact.

## 🔴 It was not an artefact. I nearly deleted a real result.

The isolation was incomplete — `purgeOwner` cleared the **evidence** store and
left the UKO store and the reasoning graph. With all three purged, four
consecutive runs:

```
3.12×   3.31×   3.73×   3.09×
```

**Superlinear, close to FLAKE-1's original 3.96×.** The 1.90× was the outlier.

Two things are true and worth keeping apart:

| | |
|---|---|
| the **finding** stands | the pass is superlinear, ~3.2× |
| the **harness** was wrong | it purged one store of three, inflating the earlier figure |

**The lesson is the retraction, not the finding.** One reading is not a
measurement, and I was one commit away from deleting a real result because a
single number disagreed with it — after spending several PRs insisting that
zero-bite results be chased rather than accepted.

FINDING-1 is unaffected either way: its 73,500 contradiction edges were counted
**directly**, never inferred from a ratio.

## What actually ships

**A `reset` seam on the scaling helper**, with the failure written into its
header. `work(n)` and `work(2n)` must start from the same state, or the ratio
measures accumulation instead of the algorithm — and the helper now says so
where the next caller will read it.

**The FI-2 pin, corrected.** It purges all three stores, asserts the measured
shape (>2.4×, ceiling 4.5×), and inverts when someone makes it linear. Stable
3/3.

## What is still not known

**Which stage is superlinear.** The per-stage profile above was taken with the
same incomplete isolation, so those numbers are suspect too — the honest answer
is that I have a reliable ratio for the *whole pass* and no trustworthy
breakdown yet.

Recorded as the open question rather than guessed at. Re-profiling with full
isolation per stage is the next concrete step, and it is now cheap because the
`reset` seam exists.

## Results

```
npm test    2358 / 232 suites / 0 fail / 1 skipped-with-a-reason
eval:gate   exit 0
```

---

## FIX-4 — the open question, answered

FIX-3 recorded: *"which stage is superlinear is still unknown."* Answered, with
all three singleton stores purged per sample and dependencies reinstalled
(the previous profile ran against a stale `node_modules` and could not even
resolve `uuid`).

```
seed only                4ms →   17ms
rebuildOwnerGraph      207ms →  618ms      ← dominates absolute time
  └ resolveEntities      0ms →    1ms      1.74×
  └ buildRelationships   0ms →    0ms      1.79×
  └ detectContradictions 140ms → 537ms     3.84×   ← THE STAGE
getForensics            84ms →  145ms      1.73×
```

`getForensics` swung between 1.73× and 7.72× across runs — small absolute time,
cache-sensitive, and **not** reliably superlinear. Reporting it as the culprit
on one high reading would have repeated exactly the mistake FIX-3 documented.

## The shape, not one ratio

```
n= 150     61ms          nodes=157  edges=306
n= 300    151ms  ×2.48   nodes=307  edges=606
n= 600    608ms  ×4.03   nodes=607  edges=1206
n=1200   2299ms  ×3.78   nodes=1207 edges=2406
```

**Edges grow linearly. Time grows ~4× per doubling.** The pass does O(N²) work
to produce O(N) output. At 1,200 facts that is 2.3 seconds of graph rebuild.

## Why this survived FIX-1 and FIX-2

Those fixed what the detector **emits** — 73,500 false edges became 0. They did
not change what it **examines**: it still compares every cross-file pair in
order to decide not to emit anything.

The subject gate made each comparison cheap and correct. It did not stop there
being N²/2 of them. **Output and cost are separate problems, and fixing the
first is what made the second visible.**

## 🔴 Pinning O(N²) with a stopwatch was the wrong instrument

The first version of this test measured a timing ratio. It passed alone and
failed in the battery — the third time in this project a **lower bound on a
timing ratio** has flaked, because contention inflates the small sample and
pushes the ratio toward the threshold.

It now counts **pairs examined**. A comparison count is a fact about the
algorithm; a millisecond figure is a fact about the machine on the day. The
counter is exact, load-independent, and costs one increment.

It also fixed the FI-2 timing test as a side effect — with the contradiction
pass no longer competing for time under battery load, that assertion stopped
flaking too. Battery stable at **2360/0 across two consecutive runs**.

## Not fixed here

The repair is bucketing pairs by subject before comparing them, which changes
**which pairs are ever considered**. The contradiction eval measures the
predicate, not the pair-selection strategy — a bucketing bug would silently
stop finding real contradictions and score identically.

Same reasoning FINDING-1 gave, and it still holds: the eval has to be able to
see the failure before the change is safe to make.

## Bite

| mutation | failures |
|---|---|
| stop counting comparisons | 1 |
| let false contradictions return | 1 |
| *(reverted)* | **0 — 3/3, stable across three runs** |

## Results

```
npm test    2360 / 233 suites / 0 fail / 1 skipped-with-a-reason
eval:gate   exit 0 · no production behaviour changed (one counter increment)
```
