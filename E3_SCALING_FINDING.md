# E3 — the scaling problem is not solved yet

**Blueprint:** Epic E3 · written instead of PR-10
**Status:** a measurement, not a code change

---

## Why this is not PR-10

PR-10 was going to be "flip the remaining stores". It isn't a PR: E3/PR-7
generalised the flip, so every store already works today —

```
AQUA_STORE_PG_READ=artifacts,attachments,cognition,pic,evidence,reasoning-graph,mind,conversations
→ normalises 8 stores, drift gates each independently
```

That is a `.env` line. Writing it as a pull request would be theatre.

So — the same question PR-9 asked — **what does the epic actually still
lack?** The answer is uncomfortable and worth having in writing before anyone
believes the storage problem is finished.

## The measurement

The audit's second existential finding was: *whole-file JSON stores, all owners
in one file, rewritten whole on every flush.* Six PRs later the blob lives in
Postgres. **The shape did not change.**

```
store size: 2.9 MB
one whole-store write         :  91 ms
ONE FACT changed, same store  :  69 ms   ← the entire 2.9 MB is rewritten
```

And it gets worse, not linearly:

| owners | bytes per write | time per write |
|---:|---:|---:|
| 100 | 0.1 MB | 16 ms |
| 1,000 | 1.2 MB | 52 ms |
| 5,000 | 6.0 MB | **858 ms** |

Every turn writes. At 5,000 owners a single user learning a single fact costs
almost a second of database work and 6 MB of traffic — for everyone's data,
because it is all one row.

## What E3 did and did not buy

**Did:**

- a real database, migrations, drift detection
- **two instances no longer lose each other's writes** (PR-9) — the exit
  criterion, and it was false before that PR
- a seam where the substrate can change without touching 19 consumers

**Did not:**

- change the write shape. `.aqua-evidence.json` is still one blob containing
  every owner, rewritten in full whenever any part of it changes
- remove the boot-time full load
- make anything scale

The audit said the JSON substrate "fails between 1k and 10k users". On this
evidence, **the Postgres blob substrate fails in the same range, for the same
reason.** It is more durable and more concurrent. It is not more scalable.

## The alternative, measured rather than assumed

One row per `(owner, store)` instead of one row per store:

```
per-owner write at 5,000 owners:  28 ms   (vs 858 ms whole-store)
```

**30× faster, and flat instead of superlinear** — because the write touches one
owner's data rather than everyone's.

## Why PR-4 could not do this

E3/PR-4 recorded the reason and it still holds: E3/PR-3 keyed the storage seam
by **path**, and a store path carries no owner. Splitting by owner is not a
substrate change — it is a change to what the stores *hold*, which means
touching every consumer that assumes `loadJsonFile()` returns the whole world.

That is E5's claim schema, and the blueprint puts it there deliberately. The
error would be to do it as a surprise inside E3, which is exactly the
"two risky things at once" the epic's ordering forbids.

## What this means for the plan

Three honest options, and the recommendation is the second:

**A — declare E3 done and move to E4/E5.** Defensible: E3's stated exit
criterion is met, and per-owner storage genuinely belongs to E5. Risk: the
scaling problem is quietly believed to be solved when it is not.

**B — declare E3 done, and record that the scaling problem moves to E5.**
Same work, honest label. E5 stops being "the claim schema" and becomes "the
claim schema, which is also how storage stops rewriting everything" — which is
what the blueprint's Part 3 actually describes, with `claims` partitioned by
`owner_id`.

**C — add per-owner sharding to E3 now.** Rejected: it means changing what the
stores hold before the claim schema exists, so it would be done twice.

## The recommendation

**Option B.** E3 is complete against its own criterion, and the next PR should
be the one that closes it out honestly:

- the substrate is durable, concurrent and observable — real gains
- it is **not yet scalable**, and the blueprint already knows where that gets
  fixed
- `AQUA_STORE_PG_READ` gives a per-store rollout when the live week of drift is
  clean

Before any of that is switched on in production, the gate is still the one PR-7
named: **`npm run db:drift` clean for a week on a real server**, with
`aqua_drift_runs` as the evidence. Nothing in the sandbox substitutes for it.

## What is still unproven anywhere

- `pg_advisory_lock` is stubbed in the test harness, so **migration** mutual
  exclusion between two instances has never run
- no measurement above involved a real Postgres, real network latency, real
  connection loss, or real concurrent load
- the per-owner figure is a floor, not a promise: it was measured on a
  simulator with an ideal index
