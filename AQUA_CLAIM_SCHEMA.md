# AQUA Claim Schema — E5

**Blueprint:** Epic E5 · D2 (the claim atom) · L8 / L9 / L19
**Status:** PR-1 — the tables. Nothing reads or writes them yet.

---

## Why E5 now

E3 closed against its exit criterion and, in closing, produced a finding:
**the substrate got durable and concurrent but not scalable.** A one-owner
change still rewrites a 6 MB blob at 5,000 owners. Per-owner rows measured 30×
faster and flat.

So E5 now carries two things at once:

- the **comprehension** unlock — predicate 0%, fidelity 0%, negation stored
  positively, all structural because the current lane has nowhere to put them
- the **scaling** fix — claims are per-row and per-owner from the first
  migration, so the blob rewrite never happens here

That is what makes it the right epic to take before E4's job runner: a job
runner is only worth building once there is something better than a blob to
write.

## PR-1 — the shape, and nothing else

Two migrations, seven tables, **no code**. A test asserts no production module
references them. The extraction that fills them is PR-3 onward.

Shipping the shape alone is the same ordering rule E3 used: never move two
risky things at once. If claims are wrong here, the schema is wrong. If they
are wrong when extraction lands, the extractor is wrong. Debugging both
together is how migrations fail.

## The five non-negotiable properties, and what each one fixes

| property | the measured failure it addresses |
|---|---|
| **polarity** | *"Priya no longer works at Aquiplex"* is stored as `member_of(Priya, Aquiplex)`. Negation recall **20%**, and every captured one stored positively. Negation that inverts meaning is worse than no extraction. |
| **modality** | *"I want to hire a designer"* is an **intent**; *"what if we moved to Bangalore?"* is a **hypothetical**. Storing all three as fact is how an assistant becomes confidently wrong about someone's life. |
| **three timestamps** | `valid_from`/`valid_to` = when the world was this way. `asserted_at` = when it was said. Conflating them is why *"where do I work"* returns the **old** employer — superseded recall **20%**. |
| **evidence** | Mandatory, enforced by constraint. A claim with no span is a hallucination with a database row. |
| **opaque subject** | L8. The self entity is currently labelled `"You"`, which needed special-casing in **five** places. Here the label is display-only and never a key. |

## Constraints live in the schema, not in code

A code-level rule holds until the second writer. A database-level one holds for
every writer, including the ones nobody has written yet.

Each constraint is tested by being **fed the bad value and asserted to refuse
it**, then fed the good one:

- exactly one object form — two objects is two claims; zero is not a claim
- polarity and modality from a closed set, refused rather than stored as a typo
- a validity range that ends before it starts
- a superseded claim must name its successor
- **one active self entity per owner** — two would reintroduce exactly the
  ambiguity opaque ids remove
- a merged entity must say what it merged into
- evidence cannot have an empty quote

## Merges are audited and reversible

L5 and L9. Today a merge is unrecoverable and unattributed. Here the loser
keeps its id, old claims resolve forward through `merged_into`, `actor` records
who did it, and `reverted_at` makes the undo a recorded event rather than a
manual repair.

## L19 is structural, not conventional

**Every index leads with `owner_id`** — asserted by a test that parses the
migrations and fails on any index that does not. Partition pruning works, and a
cross-owner scan is not merely discouraged but slow enough to notice.

## Two things measuring caught

**A portable constraint instead of a shimmed simulator.** `length(quote) > 0`
is unimplemented in pg-mem. Rather than widen the test shim, the constraint is
`quote <> ''` — identical semantics, and it runs everywhere. *A constraint that
only exists in production is a constraint nobody tests.*

**A redundant clause, found by measuring bite.** Weakening
`state <> 'superseded' AND superseded_by IS NULL` alone changed nothing: a
superseded row already fails the first branch. Removing the whole constraint
**does** fail a test. The redundancy is now documented in the migration rather
than left as false precision — the third time in this project a bite
measurement has revealed something about the code rather than the test.

## Bite, measured

Every mutation verified as **applied** before believing its number.

| mutation | failures |
|---|---|
| allow any number of objects | 2 |
| accept any polarity string | 1 |
| allow evidence with no quote | 1 |
| allow two self entities per owner | 1 |
| remove the superseded constraint | 1 |
| *(reverted)* | **0 — 24/24** |

## Results

```
npm test    2193 / 187 suites / 0 fail    (from 2169 / 178)
eval:gate   exit 0 · default boot unchanged · nothing reads the new tables
```

## Next

**PR-2** — the predicate registry: a controlled but open vocabulary, modelled
on `reasoning/typeRegistry.js`, which already solved this exact problem for
edge types. Then the claim repository, then extraction writes into it.

---

## PR-2 — the predicate registry

The vocabulary of claims. 31 predicates, controlled but open.

### Why a registry and not a free-text column

Free text is effectively what the current lane has, and it is why the
extraction baseline reports **predicate accuracy 0%** — there is nothing to be
right or wrong about.

A closed enum is the opposite failure, and this project has fixed that exact
pathology **four times**: classifier task verbs, goal outcome verbs,
self-declaration verbs, `TECH_TERMS`. A fifth is not interesting.

So the design is `reasoning/typeRegistry.js`, **reused rather than
reinvented** — seeded, auto-register-with-log, classed, strict-mode pin. A
second vocabulary system with different rules is how "two of everything"
starts, and a test asserts the properties are shared.

### The seed is the eval dataset's vocabulary

Not an invented set: the 24 predicates `extraction-core.v1` already uses, plus
seven inverses. A test asserts full coverage — if these diverged, the registry
and the extraction baseline would measure different vocabularies and
`predicate_accuracy` would be meaningless the moment PR-3 writes a claim.

`decided`, `rejected`, `plans_to`, `task_owner` and `has_status` are all
present. Decisions and tasks are named in the vision and absent from the
engine; now they have somewhere to go.

### Two things predicates carry that edge types do not

**`inverse`** — `manages` ⇄ `reports_to`. Retrieval traverses one row in either
direction rather than storing the relation twice, because two rows for one fact
is how a graph starts disagreeing with itself. A test walks every declared
inverse and asserts it **round-trips**: a one-way inverse is worse than none,
since the traversal works one way and silently returns nothing the other, which
reads as missing data rather than a broken vocabulary.

**`objectKind`** — entity, literal, quantity or time. The claims table enforces
exactly-one-object; this says *which* one, so a mis-shaped claim fails at write
time rather than as a constraint violation nobody can interpret.

### Open, but loud

An unseen predicate is admitted **and logged once**. Silent admission would let
`works_at`, `work_at` and `worksat` accumulate with nobody noticing, and the
vocabulary would stop meaning anything. `autoRegistered()` is the drift list.

A **malformed** predicate always throws, strict mode or not — that is not a
vocabulary question, it is corruption, and admitting it puts unqueryable rows
in the table.

`AQUA_CLAIM_STRICT_PREDICATES=1` turns admission into a throw, for the eval
harness and CI: a run that silently invented vocabulary would report a
predicate accuracy that means nothing.

### 🔴 Dead code found by measuring bite

The module shipped with an `autoLogged` Set, copied from `typeRegistry`. The
"logged once" mutation reported **0 failures** — and this time the mutation
*had* applied.

`ensurePredicate` returns early once a predicate is registered, so the log line
is already unreachable on a second call. The Set guarded nothing. It is needed
in `typeRegistry` because that module's `ensure()` does not return early;
copying the pattern without checking whether its precondition held brought
along a guard with no job.

Removed, and the test now pins the mechanism that actually produces the
behaviour — bite went 0 → 2.

**Also: the fifth self-match.** My residue check for `autoLogged` matched the
comment *explaining why `autoLogged` was removed*. Now verified against code
lines only.

### Bite, measured

Every mutation verified as applied first — one was rejected by that guard for a
wrong anchor, which is the guard working.

| mutation | failures |
|---|---|
| break one inverse pair | 1 |
| remove the early return (log every use) | 2 |
| silently admit malformed predicates | 1 |
| ignore strict mode | 2 |
| drop `decided` from the seed | 2 |
| *(reverted)* | **0 — 23/23** |

### Results

```
npm test    2216 / 193 suites / 0 fail    (from 2193 / 187)
eval:gate   exit 0 · nothing imports the registry yet
```

### Next

**PR-3** — the claim repository: the one writer, using this vocabulary and
those tables. That is the PR where the inertness tests from PR-1 and PR-2 both
get updated on purpose.

---

## PR-3 — the claim repository

**The one writer.** Every claim that ever exists is created here.

Not because a facade is tidy. Because the alternative is what the audit found:
three semantic stores with three write paths, and the reason nobody could say
what AQUA believed is that it depended which one you asked. A test walks `src/`
and fails on any second `INSERT INTO aqua_claims`.

### Four refusals, each load-bearing

| refusal | why it is not merely strict |
|---|---|
| **no claim without evidence** | The table demands it; refusing *here* gives a readable error rather than a constraint violation. A claim with no span is a hallucination with a database row. |
| **no claim without an actor** | L9. *"Who said this?"* must be answerable for every row, including rows the extractor writes at 3am. |
| **no object coercion** | The predicate declares its `objectKind`; a mismatch is **refused, never coerced**. Coercion is how `works_at` ends up with a literal in half its rows and an entity in the other half, and the join stops working. |
| **no cross-owner write** | L19 says isolation is structural. A repository that trusted its caller would make it conventional again. |

The object refusal fired on my own first probe — I passed a literal to
`works_at`, which takes an entity. The guard doing its job before a single test
existed.

### The same thing said twice is ONE claim

The second time someone says a thing, the right outcome is a **stronger
claim**, not a second one. `recordClaim` returns `{ created: false }` so the
caller can *see* corroboration rather than silently believing it wrote
something new. Case and whitespace are not new beliefs.

**Corroboration counts distinct SOURCES, not evidence rows.** Six quotes from
one document is one source agreeing with itself; counting rows would let a
single chatty file manufacture confidence. Tested directly: three quotes from
one source score **0**.

It also never reaches certainty — 30 sources cap at 0.9. Agreement alone is not
proof, and `contradicting` evidence is excluded from the count entirely.

### Supersession is a write, not a delete

L5. One transaction, both halves or neither: a half-applied supersession leaves
a claim that is neither current nor superseded — and the retrieval baseline
already measures what ambiguous currency costs, **20% on the superseded
category**, the old employer winning.

`claimsAbout()` excludes superseded claims by default. That is the query the
current engine cannot express, and its absence is the whole finding.

### 🔴 A fixture failure that read as nine broken tests

Nine tests failed with `hookFailed`. Not one of them was wrong: my `beforeEach`
deleted claims that reference each other through `superseded_by`, so the
cleanup hit the FK and every test in the file after it reported as failing.

A failing fixture reports as a failing **test**, and the failure text points at
the assertion rather than the cause. Worth remembering: `hookFailed` in the
output means *look at the harness first*.

### Three guards fired at once

`claim schema — nothing uses it yet`, `predicate registry — nothing uses it
yet`, and `db pool — inert by default` all went red. Every change is legitimate
for this PR, and all three were updated **deliberately** via `ALLOWED` lists
rather than relaxed.

The claim-schema list has exactly **one** entry, and that is the design.

### Bite, measured

Every mutation verified as applied first.

| mutation | failures |
|---|---|
| accept a claim with no evidence | 1 |
| coerce a wrong-kind object | 1 |
| count evidence rows, not distinct sources | 1 |
| let corroboration reach certainty | 1 |
| allow a cross-owner evidence link | 1 |
| let the live view include superseded claims | 1 |
| *(reverted)* | **0 — 25/25** |

### Results

```
npm test    2241 / 199 suites / 0 fail    (from 2216 / 193)
eval:gate   exit 0 · nothing CALLS the repository yet
```

### Next

**PR-4** — the extractor that fills it, and the first time
`predicate_accuracy` can be non-zero. It runs against `extraction-core.v1`, so
the number it produces is directly comparable to the 0% baseline.

---

## PR-4 — the backfill, and the question it answers

### Why this and not "the extractor"

The obvious PR-4 was the extractor that fills the repository. It is the wrong
one to write next:

1. An **LLM extractor is E6**, not E5, and skipping ahead is the one thing the
   standing process forbids without a critical-flaw finding.
2. There are **no provider keys in the sandbox**, so it could not be executed
   here at all — it would ship on argument, which is the failure E2 exists to
   prevent.
3. The schema owes an answer first: **can it represent what AQUA already
   believes?** 65 facts across 6 owners. If those cannot become claims, the
   schema is wrong and every PR built on it inherits the error.

So this PR answers that with a number.

### The answer

**The shape projects cleanly. The understanding does not exist to project.**

A legacy fact is `{ statement, entities, confidence, sourceType }` — a verbatim
sentence plus an entity list, with no predicate, polarity, modality or
validity, because the lane that wrote it had nowhere to put them. That is the
same structural gap the extraction baseline reports as predicate 0% / fidelity
0%.

| | outcome |
|---|---|
| statement, entities, confidence, provenance, trust tier | **preserved** |
| predicate, polarity, modality, valid_from, valid_to | **deferred, and reported** |

The backfill **does not guess**. Inferring a predicate from a sentence *is*
extraction, and doing it inside a migration would bury a low-quality extractor
where nobody evaluates it — a silent, unmeasured version of exactly what E6 is
supposed to do properly.

Every backfilled claim gets the `unresolved` predicate, so
`SELECT count(*) WHERE predicate='unresolved'` is **the number of things AQUA
has stored and not understood**. E6 upgrades them in place.

### 🔴 The simulator defect this uncovered

The backfill appeared to lose entities and re-project on every run. It was not
the backfill.

**pg-mem ignores the `WHERE` on a partial unique index and then silently drops
the conflicting row rather than raising.** Two entities for one owner — one
`self`, one `concept` — and only the first persisted, with *both inserts
reporting success*.

Diagnosis took five isolating probes; the first four hypotheses were wrong
(constraint set, the tolerance shim, `RETURNING`, the index itself in a
simpler table). Only reproducing it with and without the index found it.

Two consequences worth stating:

- **E5/PR-1's self-entity test was passing for the wrong reason.** pg-mem
  treated the partial index as a full unique index on `owner_id`, so the
  duplicate was rejected — the right outcome by accident. It is now **skipped
  with a reason**, with a companion test asserting the harness records which
  constraints it declined to enforce, so the skip can never go invisible.
- The harness now **skips partial unique indexes** rather than losing rows.
  Silent data loss in a test harness is worse than a missing feature.

The strip regex also had to learn to stop at the semicolon: the first version
used `[\s\S]*?` and skipped an entire migration file.

### The second and last writer

`backfill.js` writes claims directly rather than through the repository,
because the repository refuses claims without a predicate and legacy facts have
none. That exception is **declared** in the one-writer test, and it writes
`unresolved` claims and nothing else — asserted. Any *third* writer still fails.

### Bite, measured

| mutation | failures |
|---|---|
| guess `works_at` instead of deferring | 3 |
| flatten the trust tiers | 1 |
| skip the idempotency check | 2 |
| drop unprojectable facts silently | 1 |
| reuse one entity across owners | 1 |
| *(reverted)* | **0 — 19/19** |

### Results

```
npm test    2261 / 205 suites / 0 fail / 1 skipped-with-a-reason
eval:gate   exit 0 · nothing runs the backfill automatically
```

### Next

E5's remaining work is the **read path** — a projection that answers "what do
we know about X" from claims, with `state <> 'superseded'` doing the work the
retrieval baseline says is missing. The extractor that produces real predicates
is **E6**, and it needs provider keys to be evaluated honestly.

---

## PR-5 — the read path

"What do we know about X?" answered from claims. **Nothing here writes.**

A persisted "current beliefs" store would be the audit's three-stores mistake
with a newer schema: the moment a derived view is stored it can disagree with
what it came from, and something has to reconcile them. A test bans `INSERT`,
`UPDATE` and `DELETE` from the module outright.

### The failure it fixes, in one query

The retrieval baseline scores the superseded category at **20%** — asked *"where
do I work"*, the engine returns the **old** employer, because it has no way to
say one fact replaced another.

```
whatWeKnow(me)                        → Nummo      (current)
whatWeKnow(me, { asOf: '2023-06' })   → Intercom   (correct for 2023)
historyOf(me, 'works_at')             → Nummo (current) | Intercom (past)
```

`asOf` makes the temporal question explicit rather than implicit. An engine
that can only answer "now" cannot tell you it ever changed.

### 🔴 A real bug in my first cut

The live filter also required `state <> 'superseded'`, which made **every
historical query return nothing** — a superseded claim is exactly the one that
was true in the past.

Supersession and validity are **different questions**: `superseded` says a
claim was replaced, `valid_to` says when it stopped being true. `asOf: 2023`
was answering *"I know nothing about 2023"* instead of *"Intercom"*.

### 🔴 A second pg-mem silent-wrong-answer

`count(*) FILTER (WHERE ...)` is **silently ignored** by pg-mem, which returns
the *unfiltered* count. Coverage reported `unresolved: 2` of `total: 2` for two
claims that were both fully resolved.

`SUM(CASE ...)` is identical in Postgres and correct in both. Same call as
PR-1's `quote <> ''`: **choose the portable form rather than shim the
simulator**, because a query that only works in production is a query nobody
tests. That is now two silent-wrong-answer classes found in pg-mem in two PRs —
partial unique indexes, and `FILTER`.

### 🔴 A third untested branch, found by measuring bite

Removing the supersession clause failed **zero** tests. Every superseded claim
in the suite carried a `valid_to`, so the window alone excluded it — the
headline test was passing for the wrong reason.

The real case is supersession **without** an end date: a correction where
nobody knows when the old fact stopped being true. Only the state check catches
it. Added; bite went 0 → 1.

### Confidence is a vector, with a derived summary

`overall` stays out of the table (L7). The components are **multiplied, not
averaged** — a claim extracted badly from a trusted source is still badly
extracted, and averaging lets one strong component mask a fatal weak one.

Corroboration is a **bonus on top**, not a factor: one well-extracted statement
from the user is not one-third as good as three. Nothing reaches certainty.

### Contradictions are surfaced, never resolved

Both sides are returned. The existing reasoning graph already refuses to pick a
winner and that is one of the better decisions in the codebase — this preserves
it rather than quietly regressing.

### Coverage is the honest headline

`understoodFraction` is reported as a fraction with its denominator, not a
score, because a score invites being quoted without one. `unresolved` is
counted separately so a caller cannot read a thin answer as a complete one.

### Bite, measured

| mutation | failures |
|---|---|
| ignore supersession | 1 |
| ignore the validity window | 3 |
| average confidence instead of multiplying | 1 |
| let confidence reach certainty | 1 |
| resolve contradictions to one side | 1 |
| revert coverage to `FILTER` | 2 |
| *(reverted)* | **0 — 21/21** |

### Results

```
npm test    2282 / 211 suites / 0 fail / 1 skipped-with-a-reason
eval:gate   exit 0 · nothing calls the projection yet
```

One unrelated flake seen once in the full battery — a reasoning perf budget
that passes in isolation. Same class as the two already recorded.

### Where E5 stands

The schema, the vocabulary, the writer, the migration and the read path all
exist and are exercised. **What is missing is the extractor**, and it is
missing for a reason I cannot engineer around: E6 needs provider keys to be
evaluated honestly, and an LLM extractor shipped without a measurement is
exactly what E2 was built to prevent.
