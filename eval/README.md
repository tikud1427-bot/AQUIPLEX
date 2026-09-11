# AQUA Eval

**Blueprint:** Epic E2 · Constitution **L14 — a capability gets an eval before it gets a flag**

## Why this exists

Three harnesses now, and they answer different questions:

| Harness | Question |
|---|---|
| `flagproof.mjs` | does this flag do anything at all? |
| `rollout.mjs` | what does turning it on cost me? |
| **`eval/`** | **is it right?** |

Until the third existed, every extraction and retrieval change in this project
shipped on an opinion. That is not hypothetical — the comprehension layer has
been patched repeatedly (capitalisation gates, sentence splitting, closed goal
verbs, closed self-declaration verbs) and each fix was judged by reading
examples. E6 replaces that layer wholesale. Without a number for what the regex
extractor scores **today**, E6 has nothing to beat and no way to fail.

## Not the same thing as `evaluation/`

`evaluation/` at the repo root is **AQEval** — 2,163 lines of Python measuring
model capability on public benchmarks (MMLU, GSM8K, MATH, code). It references
the engine's extraction and retrieval zero times, by design.

`eval/` measures whether **this system understood a sentence**. Precision on
negation is not something MMLU can tell you. Different instruments, both
needed, and neither is a superset of the other.

What `eval/` borrows from AQEval, because it was already right: the
reproducibility manifest, and the rule that a case which cannot run is reported
**NOT EXECUTED with a reason** — never estimated.

## Running

```bash
npm run eval                     # every suite
npm run eval -- selftest         # one suite by id
npm run eval -- --json out.json  # machine record
```

**Exit codes**

| code | meaning |
|---|---|
| 0 | every suite ran to completion |
| 1 | a suite was malformed, or `metrics()` threw |
| 2 | a suite ran but was **INCOMPLETE** — skips or errors |

The distinct code for incomplete is deliberate. A partial run is not a pass and
not a crash; it is a result nobody should quote. CI treating it as green is how
a harness quietly stops measuring half its dataset.

## Three outcomes, never two

```
ok        executed and scored
skipped   COULD NOT RUN — reported with a reason, never scored, never estimated
error     run() threw — an execution failure, NOT a wrong answer
```

Collapsing `error` into "incorrect" makes a crash look like a quality
regression and sends someone debugging the model instead of the harness. It is
the single assertion with the most bite in the suite.

## Writing a suite

Drop a `*.suite.mjs` into `eval/suites/`. The runner knows nothing about AQUA —
it executes cases and hands them to your scorer. E2/PR-2 through PR-5 add
datasets this way and **none of them edits the runner**. If a suite needs the
runner changed, the contract was wrong; that is a design conversation, not a
special case.

```js
export default {
  id: 'extraction-core',
  title: '…',
  about: 'why this suite exists — required, and printed in the report',
  cases: [{ id: 'c1', /* whatever run() understands */ }],
  run:     async (c, ctx) => ({ status: 'ok', actual }),   // or { status:'skipped', reason }
  score:   (c, actual)    => ({ correct: true, ...detail }),
  metrics: (scored)       => ({ precision: 0.9 }),
};
```

## The comparable body

A report splits into `manifest` (clock, commit — changes every run) and
`result` (must not). Two runs of the same commit over the same suite produce a
**byte-identical** `result`. Case order is normalised, timings are excluded.

That property is what E2/PR-6's regression gate will stand on: if `result`
moved, behaviour moved, and nothing else can explain it.

## What ships in PR-1

The harness and **no dataset**. A harness with nothing to grade is unprovable,
so it grades itself: `selftest.suite.mjs` exercises every runner path with
known outcomes — a correct answer, a wrong answer, a case that cannot run, and
a case that throws.

It measures the measuring device, and it says so out loud. A green 66.7% there
is not a result about AQUA.

**Next:** PR-2 adds the extraction dataset (200 labelled sentences including
negation, temporal, modality, decisions and tasks); PR-3 scores the **current
regex extractor** against it and publishes the baseline E6 must beat.

---

## The regression gate — E2/PR-6

```bash
npm run eval:gate              # compare against the committed baselines
npm run eval:gate -- --update  # regenerate them (a deliberate act)
```

Until PR-6 the baselines were numbers in a file nobody was obliged to look at.
This makes them a **merge condition**, which is what L14 actually asks for.

### The noise band is zero, and that was measured

The blueprint says bands come from three consecutive runs. They were run: the
comparable body is **byte-identical across three**, and Ananya's Node 20
reproduced Node 22's figures to four decimals. Neither suite makes a model call
or reads a clock, so the band is genuinely 0.

`EPSILON` (1e-9) therefore absorbs IEEE-754 drift, **not real variation**. A
generous band "to be safe" would hide exactly the small regressions the gate
exists to catch — a 2% drop in negation fidelity is the kind of thing that
never gets noticed once it sits inside a tolerance.

### Five things block a merge

| | why |
|---|---|
| a metric got **worse** | the obvious one |
| a measurement **disappeared** | a metric vanishing is not an improvement |
| the **dataset changed** (fingerprint) | two runs over different data are not comparable; a delta would be invented |
| the dataset **shape** changed | dropping 40 positives makes every other metric mean something else |
| the run was **incomplete** | a partial run's numbers are not comparable at any level |

The last three are **refusals**, not failures — the gate declines to produce a
comparison rather than guessing one.

### Direction is declared, not assumed

Most metrics are higher-is-better. `noise_lines`, `noisy_queries` and
`false_positives` are **lower**-is-better. A gate that assumed one direction
everywhere would wave through a doubling of noise as an improvement — the
precise failure the retrieval dataset was built to expose. A test scans both
committed baselines for metric names that *read* like wrongness measures and
fails if any is gated backwards.

### Proven to block, end to end

Narrowing the retrieval suite's result window from 8 to 2 — a real, if
artificial, regression:

```
↓ recall_at_8      0.6369 → 0.5714
↓ ndcg_at_8        0.5548 → 0.5161
↓ recall_category  0.4063 → 0.2813
… 7 blocking reasons,  gate exit 1
```

Reverted: exit 0.

### A PR-1 defect this PR found

`toJSON` only understood a **single** report, so `npm run eval -- --json out.json`
across several suites wrote a 25-byte file containing `{"schemaVersion":1}` —
no error, no warning, and the gate could not have read it. Fixed here rather
than behind a flag: a bug fix behind a flag is a bug that stays.

### CI

`.github/workflows/eval-gate.yml` runs the battery and then the gate on every
PR touching `aqua/`, pinned to Node 20 — the version the baselines were
reproduced on. It is inert until the repository has Actions enabled; the
`npm run eval:gate` command is the part that matters and works today.

### `--update` is not an escape hatch

The gate never regenerates a baseline on failure. Moving a number is a
deliberate act that belongs in a PR whose description says **why** it moved.
A gate that fixed its own baseline would be a rubber stamp.

### E2/PR-6b — three flaws `--update` exposed

The gate went red on the first real tree it met, and all three causes were
mine.

**1. It gated the harness self-test.** PR-6 excluded `selftest` by relying on
the **absence** of a baseline file. That held right up until `--update`
regenerated a baseline for every suite — after which the gate blocked forever
on a suite that is *designed* to be incomplete. Exclusion is now by **name**
(`NOT_GATED`). An invariant that depends on a file not existing is not an
invariant.

**2. `--update` destroyed the hand-written note.** It overwrote `note` with a
generic string — the one part of a baseline file a human wrote on purpose, and
the part two suites assert on. It is now **preserved** across regeneration.

**3. `--update` rewrote everything at once.** One command replaced three
baselines. It now **requires a suite id**:

```bash
npm run eval:gate -- extraction-core --update
```

Rewriting every baseline from one command is how a baseline gets replaced by
accident, and a baseline replaced by accident is worse than no baseline —
it looks authoritative.

**Bite:** stop excluding the self-test → 1 fail · let `--update` flatten the
note → 2.
