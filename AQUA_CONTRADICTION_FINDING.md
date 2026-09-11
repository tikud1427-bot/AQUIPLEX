# AQUA — the contradiction detector fires on unrelated numbers

**Status:** a measured finding, in the shape of E3/PR-10 — **not fixed here,
and the reason matters**

---

## How this was found

FLAKE-1 converted a wall-clock budget into a scaling assertion, and that found
the FI-2 intelligence pass was quadratic (3.96× for 300 → 600 facts).

Chasing it down did not end at a performance problem.

```
edgesOf across all facts    13.4ms → 107.9ms    ratio 8.08×
```

`edgesOf` is adjacency-indexed, so a scan was not the cause. The adjacency
lists themselves were the cause:

```
300 facts → 73,500 `contradicts` edges
600 facts → 297,000                        exactly 4× for 2× the facts
```

## The edges are not real

The detector's own `reason` is *"numeric disagreement about VendorCo across
files"*, between:

```
"Item 0 for VendorCo recorded value 1000"
"Item 1 for VendorCo recorded value 1001"
```

Different items. Different values. **Both true simultaneously.**

The rule appears to be: **same entity + different file + different number ⇒
contradiction.** That fires on any per-item table — an invoice, a price list, a
ledger, a metrics export — which is among the most common shapes a user
uploads.

Narrowed rather than overstated: the same rows in a **single file** produce
zero contradictions. The trigger is the documents differing, not the numbers
alone.

## Why this matters more than the performance

The audit praised AQUA for **surfacing** contradictions rather than resolving
them, and that is genuinely one of the better decisions in the codebase.

But surfacing is only valuable if a contradiction means something. At this
density it is the **dominant edge type** — over half of all edges — and a user
looking at `getForensics` sees tens of thousands of disagreements that do not
exist. A signal that fires on everything is not a signal.

The quadratic cost is a symptom. The false positives are the problem.

## Why it is not fixed in this PR

Changing a contradiction detector changes **what AQUA believes**.

There is no eval for contradiction quality. The E2 baselines cover extraction
and retrieval and say nothing about this. So any fix I shipped here would be
**unmeasurable** — I could not tell you whether it removed the false positives
without removing the true ones, and "it looks better in the case I was staring
at" is exactly the standard E2 exists to replace.

L14: a capability gets an eval before it gets a flag. That applies to a repair
as much as to a feature.

## What ships instead

The finding, **pinned as inverting tests** — the same mechanism used for E1's
ratio ceiling and E3/PR-10's write shape:

| assertion | inverts when |
|---|---|
| six unrelated ledger rows produce contradictions | the detector stops firing on per-item values |
| the reported reason names a disagreement that does not exist | the reason changes — a signal to re-read before trusting this doc |
| within one file the detector is silent | the trigger stops being cross-file |
| edge count grows quadratically | the growth becomes sub-quadratic |
| contradictions are the dominant edge type | the density drops |

Each fails loudly when someone improves this, so the fix is **noticed rather
than absorbed**.

## The honest next step

A contradiction eval — a small labelled set of genuine disagreements and
genuine non-disagreements — before touching the detector. That is a
one-afternoon dataset in the shape of `extraction-core.v1`, and without it the
repair is a guess.

## Results

```
npm test    2341 / 227 suites / 0 fail / 1 skipped-with-a-reason
eval:gate   exit 0
```

No production code changed.
