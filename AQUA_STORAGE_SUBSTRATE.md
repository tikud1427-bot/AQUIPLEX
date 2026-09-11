# AQUA Storage Substrate — E3

**Blueprint:** Epic E3 · the critical path, and the larger of the two
existential problems

---

## Why E3 exists

24 JSON stores, every one a module-level singleton holding **all owners in one
file**, `JSON.parse`d at boot and rewritten whole on every flush. Measured
consequences: memory scales with total users rather than active ones, boot time
scales with total data, and a second app instance means last-writer-wins data
loss. The `MULTIPLE LIVE WRITERS DETECTED` alarm is the architecture reporting
its own ceiling.

The exit criterion for the whole epic is one sentence: **two app instances
running concurrently with zero data loss** — a property the current
architecture cannot have at all.

## PR-1 — a connection primitive, and nothing else

**This PR changes no behaviour.** Nothing reads or writes through the pool, and
a test walks `src/` asserting that **no production module imports it**. When a
store starts using it, that test has to be updated on purpose.

That is the point of shipping it alone. The blueprint's ordering rule for E3 is
that two risky things never move at once: migrate the storage engine *before*
changing what is stored, and prove each step inert before the next.

### Inert means inert

- **No connection at import.** The `pg.Pool` is constructed lazily on the first
  `getPool()`. If this module connected at load, every route in the engine
  would depend on a reachable database at boot — laziness here is a safety
  property, not a performance one.
- **No `DATABASE_URL` → `isConfigured()` is false**, `getPool()` returns
  `null`, and `dbHealth()` reports `not-configured` rather than erroring.
- **A malformed URL fails at config time** with a readable message, not as a
  confusing timeout on whichever request first touches the database.

### Credentials never reach a log

`describe()` returns host, port and database and **never** the password or the
raw URL. The boot line uses it:

```
[DB] postgres=not-configured (JSON stores remain authoritative)
[DB] postgres=configured host=db.internal port=5432 db=aquadb ssl=true max=10
```

A connection string in a log file is a credential in a log file, and log files
get pasted into issues. Two tests assert the secret is absent from both
`describe()` and the boot line.

### The boot line is not optional

Printed on **every** boot, configured or not, and pinned by a test that checks
`router.js` still calls it. L13 — no dark stages: a configured database must
never be a surprise, and this module could otherwise sit unreported forever.

### One failure mode worth naming

`pool.on('error')` is registered because an **idle-client** error is emitted on
the pool, not on a query. Without a listener Node treats it as an unhandled
`error` event and kills the process — the most common way a `pg` pool takes
down a server.

## Dev database

```bash
docker compose -f docker-compose.dev.yml up -d
export DATABASE_URL=postgresql://aqua:aqua@localhost:5432/aqua
```

The image is `pgvector/pgvector:pg16`, not plain `postgres`: the blueprint puts
claim embeddings in the same database as the claims (Part 3), and installing
the extension later on a database that was never built for it is a migration
nobody enjoys.

**No test requires a running database.** A suite that only runs where Postgres
happens to exist is a suite that stops running; unreachability is tested
against loopback port 1, which refuses instantly.

## Bite, measured

| mutation | failures |
|---|---|
| leak the connection string in `describe()` | 1 |
| accept any URL scheme | 1 |
| construct a pool with no configuration | 1 |
| ignore `sslmode=require` | 1 |
| stop reporting the boot line | 1 |
| *(reverted)* | **0 — 21/21** |

## Results

```
npm test      2018 / 139 suites / 1 fail *
eval:gate     exit 0
flagproof     30/30
router        boots, prints the DB line
```

\* the one failure is **pre-existing**: `artifacts: owner quota evicts oldest`
fails identically on the unmodified tree when `src/artifacts` runs in
isolation. Order- or timing-dependent, same class as the known
`fileIntelligence2.e2e` perf flake. Not from this PR.

## Next

**PR-2** — a forward-only, versioned, idempotent migration runner. **PR-3** —
the `atomicStore` adapter interface, a **refactor with zero behaviour change**,
JSON remaining the sole implementation. Only after that does anything dual-write.

---

## PR-2 — the migration runner

Forward-only, versioned, idempotent. Still nothing in the engine touches it: a
test asserts **no production module imports the runner**, so nothing migrates
on boot. Migrating automatically at startup is a decision, not a default — it
belongs with the PR that first depends on a table existing.

### The pure part is separated from the SQL part

Applying a migration needs a database. Deciding **which** to apply, in what
order, and whether the set on disk is coherent does not — and that is where
every interesting mistake lives. `discover()`, `validate()` and `plan()` are
pure and fully tested; `migrate()` is a thin loop over a plan they produced.

Same split E1/PR-6 used when the platform could not be booted in a test
process: put the judgement somewhere testable, and keep the untestable part too
small to hide anything. **Every test here runs without a database.**

### Three properties that matter more than the feature set

**Idempotent.** A fully migrated database plans nothing. Asserted, including
the case where the driver hands back `version` as a **string** — `"1" !== 1`
would re-apply every migration.

**Locked.** `pg_advisory_lock` guards the apply path. Two app instances
starting together must not both migrate; E3 exists to make multi-instance
possible, and racing on DDL at the first deploy would be an ugly way to learn
that.

**Checksummed.** A migration edited after it was applied is **refused**, by
name, with what to do instead. Silently re-reading an edited file is how two
environments diverge while both report "up to date".

### Per-migration transactions, not one big one

A failure leaves the schema at a **known** version and the next run resumes.
One transaction around everything sounds safer and is worse: it makes a partial
failure unresumable.

### No down migrations, deliberately

A rollback is a second, less-tested write path executed against production data
at the worst possible moment. The honest recovery for a bad migration is a new
migration that corrects it, plus the backup — the same reasoning L5 already
applies to knowledge: nothing is deleted, things are superseded. A test asserts
no `down` path and no `*_down.sql` exists.

### An incoherent set is refused before the database is touched

Duplicate versions (two people numbering the same, one silently skipped),
gaps (usually a file deleted after being applied somewhere), and empty files.
The CLI validates the files **first**, so a mistake is reported even on a
machine with no database attached.

### The CLI

```bash
npm run db:status              # read-only
npm run db:migrate             # apply
npm run db:migrate -- --dry-run
```

Exit **2** is reserved for "DATABASE_URL is not set" — distinct from failure,
because a deploy script that treats an unconfigured database as success will
happily start an app whose schema was never created.

### 0001 creates no product table

Only `aqua_schema_info`, so the runner has something real to apply and a fresh
database can say where its schema came from. The blob store is PR-4; the claim
tables are E5.

It deliberately does **not** `CREATE EXTENSION vector`. The dev image has it,
but creating it needs privileges a managed provider may not grant to the app
role — it belongs in the migration that first needs a vector column, where a
failure explains itself.

### Bite, measured

| mutation | failures |
|---|---|
| stop detecting drift | 1 |
| drop the advisory lock | 1 |
| allow duplicate versions | 1 |
| allow gaps in the sequence | 1 |
| compare ledger versions as strings | 1 |
| *(reverted)* | **0 — 27/27** |

### One defect in my own test

The "no `CREATE EXTENSION`" check matched the phrase inside the SQL comment
**explaining why there is no `CREATE EXTENSION`** — the third time in this
project a detector has flagged its own documentation. Comments are now stripped
before any content check.

### Results

```
npm test    2045 / 146 suites / 0 fail    (from 2018 / 139)
eval:gate   exit 0 · flagproof 30/30 · router boots
```

---

## PR-3 — the adapter seam

`atomicStore.js` has carried this line in its header since Phase 3b:

> *"all six stores now persist through ONE interface, so a Postgres/Mongo
> adapter is a change here, not in six places."*

The claim was true and unexercised. This PR makes it real: **every byte that
leaves or enters a store now passes through an adapter**, and there is exactly
one implementation — the same filesystem code that was inline, moved.

### The test is the battery passing unchanged

**2045 existing tests, none of them edited, all still green.** That is the
proof, and it is why this PR ships alone rather than alongside a second
implementation. The public API of `atomicStore` is byte-identical — a test
asserts the exported names, because a refactor that quietly adds or removes an
export is not a refactor.

### Why the seam is keyed by PATH

Every caller passes an absolute file path today, so keying the interface by
path means **all 19 consumers change not at all**. A Postgres adapter will map
that path to `(owner, store)` with `path.basename` — the store filenames are
already stable and unique.

Introducing a store-name key would mean editing 19 call sites **and** swapping
the backend in one change, which is the second risky thing E3's ordering
forbids.

### 🔴 The detail this refactor nearly lost

The first version of the adapter generated temp paths with
`` `${key}.tmp-${Date.now()}` ``. The original used a **monotonic counter** in
the target's own directory:

```
.${basename}.tmp.${pid}.${counter++}
```

Two properties were load-bearing and both were nearly dropped:

- the temp file must sit in the **same directory** as the target — `rename(2)`
  is atomic only within one filesystem; across filesystems it is a copy, which
  is exactly the corruption this module exists to prevent
- a **counter, not a timestamp** — two writes to one file inside the same
  millisecond would share a `Date.now()` temp path and race

The original scheme is restored byte for byte, and two tests pin it. This is
precisely the kind of "harmless equivalent rewrite" that a zero-behaviour-change
PR exists to catch.

### A contract, not just an implementation

`runAdapterContract()` is exported and will be run against E3/PR-4's Postgres
adapter unchanged, so *"it works"* means the same thing for both rather than
each being judged by whatever its author remembered to check. Nine assertions:
round-trip, replace-not-append, unicode, missing-key-returns-null,
copy-without-disturbing-source, concurrent writes.

`setAdapter` validates **before** swapping, so a broken adapter never takes
effect — and it is deliberately **not** an env switch. Changing the substrate
of every store on a string in a `.env` is exactly the kind of change that
should be a deliberate code path with its own flag and its own drift job.

### 🔴 Two defects in my own tests

**A vacuous test, caught by measuring bite rather than reading it.** The
"failed write leaves no temp file" test wrote into a *non-existent directory* —
so the temp was never created, the cleanup it claimed to guard was never
reached, and it passed while proving nothing. Reverting the `unlink` produced
**0 failures**. The target is now an existing non-empty directory: the temp
write succeeds, the rename fails, and the unlink is what keeps things clean.
Bite is now 2.

**Fourth self-match.** A content assertion matched `Date.now()` inside the
comment explaining why `Date.now()` is not used. Comment stripping is now a
shared helper used by every source-content assertion in the file.

### Results

```
npm test    2067 / 149 suites / 0 fail    (2045 pre-existing, unedited)
eval:gate   exit 0 · flagproof 30/30 · router boots
```

### Next

**PR-4** — a Postgres blob adapter, unused, graded against the same contract.
Nothing dual-writes until PR-5.

---

## PR-4 — the Postgres blob adapter, unused

Nothing installs it. `getAdapter()` still returns the JSON adapter, and a test
asserts no production module imports the new one. It exists to be graded
against the same contract — and to surface, cheaply and early, the thing that
makes this substrate swap harder than it looks.

### ⚠ The finding: Postgres has no synchronous client

The seam requires `readSync`, `writeSync`, `existsSync` and `copySync`, because
that is what `atomicStore` has always offered and what the SIGTERM drain
depends on. There is no synchronous Postgres driver for Node and there cannot
sensibly be one.

So this adapter is **hydrate-once, serve-from-cache, write-behind**:

```
hydrate()   async, once at boot — every store blob into memory
readSync    serves the cache
writeSync   updates the cache and ENQUEUES a database write
flush()     awaits every queued write — must run on SIGTERM
```

That matches how the engine already behaves — every store is fully in memory
and flushed on a debounce — so it is not a new risk. But it **is** a different
durability guarantee, and pretending otherwise would be exactly the quiet
equivalence PR-3 nearly shipped with temp paths.

It is therefore **declared, not buried**. `syncDurable` is now a required part
of the adapter contract:

| adapter | `syncDurable` | meaning on return from `writeSync` |
|---|---|---|
| `json-file` | `true` | the bytes are on disk |
| `pg-blob` | `false` | the bytes are in memory; durability is deferred |

An adapter that omits the flag is refused. A durability guarantee cannot be
implicit — E3/PR-5's dual-write will have to call `flush()` in the SIGTERM
drain, and this is how it knows it must.

### One row per store FILE, not per owner

The blueprint's PR-4 line says *"one row per owner/store"*. It cannot be that
yet, and the reason is recorded in the migration rather than quietly diverged
from: PR-3 keyed the seam by **path** so all 19 consumers stayed untouched, and
a store path carries no owner — every owner already lives in one file.

Splitting by owner changes what the stores themselves hold, which is E5's claim
schema, not a substrate swap. This table reproduces today's shape faithfully,
and that is deliberately **not** an improvement.

### 🔴 A defect in my own adapter: an unhandled rejection

`writeSync` enqueues a promise that, by definition, **nobody awaits**. My first
version re-threw the failure from inside it — which is an unhandled rejection,
and Node kills the process on those. The same failure mode `pool.on('error')`
guards in PR-1, reached by a different road.

Failures are now recorded and logged, then **re-reported by `flush()`** — loud,
surfaced where someone is waiting for an answer, and unable to take the process
down in between. Two tests pin it, including that `flush()` is not sticky.

### 🔴 A guard fired, and I updated it rather than relaxing it

PR-1 asserted **no production module imports the pool**. The adapter must — so
the battery went red, which is exactly what that test was for: the change
became a deliberate edit instead of a drift nobody noticed. The guard now
carries an explicit `ALLOWED` list and still fails on anything else.

The engine remains a no-op with respect to Postgres: `getAdapter()` is
unchanged, and a separate test asserts nothing imports the adapter itself.

### Tests that cannot run say so

The round-trip contract needs a live Postgres. Those tests are **skipped with a
reason** when `DATABASE_URL` is unset — never quietly passed:

```
ok 5 - pg blob adapter — round trip against a real database # SKIP DATABASE_URL is not set …
```

Same rule the eval harness applies to its own cases: a thing that could not run
is reported as not run, never estimated. A green suite that silently skipped
its only integration test is worse than a red one.

```bash
docker compose -f docker-compose.dev.yml up -d
export DATABASE_URL=postgresql://aqua:aqua@localhost:5432/aqua
npm run db:migrate && node --test src/core/tests/pgBlobAdapter.test.js
```

### Bite, measured

| mutation | failures |
|---|---|
| claim `writeSync` is durable when it is not | 1 |
| swallow write-behind failures | 1 |
| copy a missing key silently | 1 |
| let an adapter omit the durability flag | 2 |
| *(reverted)* | **0 — 17/17** |

### Results

```
npm test    2084 / 154 suites / 0 fail    (from 2067 / 149)
eval:gate   exit 0 · adapter still json-file · Postgres still unused
```

### Next

**PR-5** — dual-write behind `AQUA_STORE_PG=shadow`, JSON authoritative,
`flush()` wired into the SIGTERM drain. **PR-6** — the drift job.

---

## PR-5 — dual write, shadow mode

`AQUA_STORE_PG=shadow` turns on dual-write. **Off by default.**

```
[STORE] backend=json-file shadow=off
[STORE] backend=json-file shadow=postgres (JSON remains authoritative; no read comes from Postgres)
```

### The asymmetry is the whole design

| | primary — JSON | shadow — Postgres |
|---|---|---|
| reads | **every one** | **never, not once** |
| writes | must succeed | best effort |
| failures | propagate | counted and logged, never propagate |

**Nothing reads from Postgres in this mode.** That is what makes shadow mode
safe to switch on in production: the worst case for a completely broken
database is a log line per write and a non-zero drift counter. The data users
depend on is untouched, because the path that serves them never consults the
new store.

A test asserts `readSync` and `existsSync` delegate to the primary
*syntactically*, not merely behaviourally — reading from the shadow fails two
assertions.

### Why a failing shadow must not throw

If it propagated, enabling shadow mode would make the engine **less reliable
than leaving it off**. A migration step that raises risk before delivering any
benefit is a step nobody turns on, and the substrate never moves. The counter
and the log are how the failure stays visible instead of silent.

The inverse is asserted too: a **primary** failure still propagates. Swallowing
a lost authoritative write would be far worse than any shadow problem.

### Durability comes from the primary

A dual write is exactly as durable on return as its authoritative half.
Reporting the shadow's `false` would tell the shutdown drain it still has work
when it does not; reporting `true` for a Postgres-only adapter would be a lie.

### The SIGTERM drain now awaits deferred writes

PR-4's adapter reports `syncDurable: false`, so the synchronous shutdown flush
does **not** mean the bytes are safe. `flushStorage()` joins the Mongo drain:

```js
Promise.allSettled([drainMirror(5_000), flushStorage(5_000)])
  .finally(() => process.exit(code));
```

`allSettled`, not sequential — a deploy will not wait twice. Without this the
first deploy in shadow mode would drop whatever was still write-behind.

### Fails open, loudly

`AQUA_STORE_PG=shadow` with no `DATABASE_URL` falls back to JSON and prints
why. Only the exact word `shadow` enables it — `on`, `true`, `1` and `yes` all
mean off, because a substrate swap should not be one plausible-looking string
away from happening by accident.

### Two more guards fired

E3/PR-4's *"nothing imports the Postgres adapter"* and E3/PR-1's *"nothing
imports the pool"* both went red. Both changes are legitimate for this PR, and
both were updated **deliberately** rather than relaxed — each entry in an
`ALLOWED` list cost a red battery first, which is the entire point.

The second guard's meaning changed with it: the adapter is no longer *unused*,
it is *reachable only through shadow mode*, and the test now says so.

### Bite, measured

| mutation | failures |
|---|---|
| read from the shadow | 2 |
| let a shadow failure propagate | 1 |
| report the shadow's durability | 1 |
| enable shadow on any truthy value | 1 |
| drop `flushStorage` from the SIGTERM drain | 1 |
| *(reverted)* | **0 — 18/18** |

### Also fixed

A stray whitespace line in `router.js`, left by a bite test during PR-1 and
shipped in that tarball.

### Results

```
npm test    2102 / 159 suites / 0 fail    (from 2084 / 154)
eval:gate   exit 0 · default boot still json-file, shadow off
```

### Next

**PR-6** — the drift comparison job: read both sides, compare checksums, report
at boot. Read paths do not flip until drift has been zero for a week.

---

## PR-6 — the drift job

Reads both sides, reports where they disagree. Read paths do not flip until
this has reported clean for a week, and PR-7 will point at `aqua_drift_runs`
for the evidence rather than at somebody's recollection.

```bash
npm run db:drift
```

```
[DRIFT] clean — 12/12 stores match (7ms)
[DRIFT] ⚠ 1 mismatched, 2 missing in postgres of 12 stores — read paths must NOT flip
```

### It never writes to a store

A drift job that *repairs* what it finds is a second write path, with no
review, running unattended, against the exact data whose correctness is in
question. This one reports; a human decides.

The only thing it writes is its own history row — and a test asserts it:
no `writeSync`, no `atomicWrite`, no adapter access, no `UPDATE`, no `DELETE`,
and no `INSERT` into anything but `aqua_drift_runs`.

### It compares checksums, not blobs

`aqua_store_blobs.checksum` exists for this. The shadow side is one query
returning `(store_key, checksum)`; selecting `data` would drag every store
across the wire on a timer. A test fails if the query ever grows a `data`
column.

### Four outcomes, and two of them are different problems

| | meaning |
|---|---|
| matched | same checksum both sides |
| mismatched | present both sides, contents differ — **both values reported**, so nobody has to diff two files by hand |
| missing in postgres | a write never landed |
| stale row | a row outlived its store file |

Collapsing the last two into "different" would lose *which side to go and look
at*. They are counted and reported separately.

### An empty shadow is drift, not cleanliness

The state immediately after shadow mode is switched on: nothing written yet. If
that read as clean, the week-of-zero criterion could be satisfied by a database
nobody ever wrote to. Asserted directly, and reverting it fails two tests.

### Only `.aqua-*.json` is compared

The data directory also holds `.bak` files, temp files and migration stubs.
Hashing those would report drift for files the shadow was never asked to hold.

### The boot report is not awaited

In shadow mode only, and fire-and-forget:

```js
if (storeResult.mode === 'shadow') {
  import('./src/core/db/drift.js')
    .then(async ({ checkDrift, driftLine }) => console.log(driftLine(await checkDrift())))
    .catch(err => console.log(`[DRIFT] check unavailable: ${err.message}`));
}
```

A comparison that delayed startup would be the first thing switched off. It is
diagnostic, not load-bearing, and a test fails if it ever becomes `await`ed.

### The pure part is separated, again

`diffManifests()` holds all the judgement and needs neither a database nor a
filesystem — so the logic that decides whether the substrate is safe to switch
to is fully tested without a server. Same split as the migration runner.

### Bite, measured

| mutation | failures |
|---|---|
| call an empty shadow "clean" | 2 |
| conflate the two missing categories | 2 |
| pull every blob instead of checksums | 1 |
| hash backups and temp files too | 1 |
| await the drift check at boot | 1 |
| *(reverted)* | **0 — 19/19** |

### The inertness guard fired a fifth time

`drift.js` imports the `TABLE` constant from the adapter — a far weaker
coupling than using it, but still added to the `ALLOWED` list deliberately
rather than waved through. Every entry on those lists cost a red battery first.

### Results

```
npm test    2121 / 166 suites / 0 fail    (from 2102 / 159)
eval:gate   exit 0 · default boot: json-file, shadow off, no drift check
```

### Next

**PR-7** — flip the first read path, artifacts, behind its own flag. Only after
drift has been clean for a week, with `aqua_drift_runs` as the evidence.

---

## PR-7 — flipping the first read path

The first PR in this epic where a user's read can actually come from Postgres.

```bash
AQUA_STORE_PG=shadow AQUA_STORE_PG_READ=artifacts
```

```
[STORE] backend=json-file shadow=postgres reads=[.aqua-artifacts.json] (all writes still go to both)
[STORE] backend=json-file shadow=postgres (JSON remains authoritative; no read comes from Postgres)
        — .aqua-artifacts.json still drifts — reads stay on JSON
```

### A list, not a boolean

The epic flips **one store per PR**. One store being trustworthy says nothing
about another, and a single global switch would make that careful ordering
meaningless. `AQUA_STORE_PG_READ` takes bare names and normalises them.

### Three properties carry the safety

**1 — Hydrate first.** The Postgres adapter serves reads from a cache. An
unhydrated cache answers `null` for everything, so *every* read would take the
fallback below: working, with the new substrate contributing nothing and nobody
noticing. A test asserts `hydrate()` runs before the drift comparison.

**2 — Drift gates the flip, per store, at the moment of the decision.** A store
whose two sides disagree does not flip, however loudly the environment asked —
and the refusal is printed. `missingShadow` counts as dirty, not just a
checksum mismatch: a store the shadow has never received is precisely the case
where reading from it would serve an empty store.

The evidence is checked *now*, not remembered from a report last week.

**3 — A null from the shadow is never trusted.** It falls back to JSON, counts
it, and logs. An empty store is indistinguishable from total data loss to the
person reading it — serving `null` would be the worst outcome available in this
epic: silent, total, and looking exactly like success.

A throwing shadow read falls back too. A genuinely absent store still reads
`null` — the fallback invents nothing, so a first boot does not look like a
failure.

### What does not change

Writes still go to **both**, flipped or not. `existsSync` answers yes if either
side has it. An unflipped store reads from JSON even when the shadow holds it —
tested, because a flip that leaked would silently move eight stores instead of
one.

### Bite, measured

| mutation | failures |
|---|---|
| trust a null from the shadow | 2 |
| let the flip leak to every store | 1 |
| flip without hydrating first | 1 |
| flip regardless of drift | 2 |
| treat missing-in-shadow as clean | 1 |
| *(reverted)* | **0 — 18/18** |

### 🔴 A vacuous BITE MEASUREMENT, not a vacuous test

The scoping mutation first reported **0 failures**, which looked like a useless
test. It was not — my mutation targeted a line that did not exist, so nothing
was mutated and the suite passed because the code was unchanged.

The distinction matters: measuring bite only proves something if the mutation
actually applied. The corrected mutation fails 1. Every earlier bite table in
this project stands, but the lesson is to verify that a mutation landed before
believing what it reports.

### A PR-5 assertion superseded, deliberately

PR-5 asserted *syntactically* that nothing reads from Postgres. PR-7 exists to
change that, so the assertion was **rewritten rather than deleted**: what
survives is that the default path is the primary and the shadow is reached only
through an explicit opt-in list.

Also reverted: a gratuitous rewording of the boot line ("JSON authoritative"
for "JSON remains authoritative") that broke a PR-5 test for no benefit.

### Results

```
npm test    2139 / 171 suites / 0 fail    (from 2121 / 166)
eval:gate   exit 0 · default boot: json-file, shadow off, nothing flipped
```

### Before merging this one

Unlike every previous PR in this epic, this one is gated on something other
than my tests: **`npm run db:drift` reporting clean for a week**, with
`aqua_drift_runs` as the evidence. The code refuses the flip if drift is dirty
at boot, but that is a backstop, not a substitute for the week.

### Next

**PR-8** — attachments, the second most isolated store. Same shape, one store
at a time, each gated on its own drift.

---

## PR-8 — executing the chain

**Six E3 PRs shipped with every live-database test skipped.**

The skips were honest — reported with a reason, never quietly passed. But the
effect was that the migration runner, the blob adapter, the drift job and the
read flip had **never been executed against anything**. Six PRs of unexercised
code, each verified only by the tests that carefully avoided the part which
talks to Postgres.

So before flipping a second store, the chain gets run.

### What running it found

Everything worked, and three things were confirmed that no previous PR could
check:

**A write really reaches the table.** A *second* adapter, hydrating from
scratch, is the only way to distinguish a real write from a cache agreeing with
itself. It does.

**The adapter and the drift job hash identically.** They are separate
functions in separate files. If they had diverged, drift would have reported
false positives forever and no read path could ever have flipped. Now asserted
against a row the adapter actually wrote.

**The drift gate refuses a dirty store for real.** Against a database holding
one clean store and one dirty one, `configureStorageFromEnv` flips exactly one
and reports the refusal.

The migration idempotency claim — asserted in PR-2 against a hand-built plan —
is now asserted against a database that recorded the first run.

### ⚠ What this does NOT prove

`pg-mem` is a simulator, and treating it as a substitute for the live check
would be exactly the "green means safe" this project keeps catching.

**Not proven here:**

| | |
|---|---|
| `pg_advisory_lock` | **stubbed — always succeeds.** The two-instances-can't-both-migrate property is *not* tested. That needs two processes and a real server. |
| `CREATE TABLE IF NOT EXISTS` | unimplemented for an existing table |
| `ON CONFLICT DO NOTHING` | unimplemented for an existing row |
| everything operational | concurrency, connection loss, isolation, SSL, performance |

The last two SQL forms *are* the idempotency mechanism, so the harness
tolerates exactly those two errors — a deliberate, narrow allowance, and the
reason the live tests remain, still skipped-with-a-reason, as the real evidence.

### An injection seam instead of patching node_modules

The diagnostic that found all this had to overwrite `node_modules/pg` to
redirect the driver, because ESM exports are read-only. That is not something
to ship. `pool._setPoolForTests()` is the seam; the harness uses it and puts
the pool back.

### Bite, measured

| mutation | failures |
|---|---|
| cache the write but never send it | **7** |
| drift hashes differently from the adapter | 5 |
| re-apply every migration each run | 2 |
| flip a store that still drifts | 1 |
| *(reverted)* | **0 — 14/14** |

The first one is the point: silently caching a write and never sending it is
precisely the failure none of the previous six PRs could detect.

### Results

```
npm test    2153 / 175 suites / 0 fail    (from 2139 / 171)
eval:gate   exit 0 · default boot unchanged · pg-mem is a devDependency
```

`npm audit` still reports the pre-existing `image-size` advisories via
`pptxgenjs` — unchanged by this PR, and unrelated to `pg-mem`.

### Next

**PR-9** — flip attachments, the second store. The chain is now exercised on
every run, so that flip lands on evidence rather than on argument. The live
week-of-drift on a real server is still the gate for turning any of it on.

---

## PR-9 — two instances, zero data loss

E3's exit criterion. Before this PR it was **false on the new substrate**, and
PR-8's harness is what made that checkable.

### The measurement

Two adapters, each with its own cache — exactly the production shape:

```
instance A writes {"owner":"alice"}
instance B writes {"owner":"bob"}

final row      : {"owner2":"bob"}     ← alice is gone
A still thinks : {"owner1":"alice"}
B still thinks : {"owner2":"bob"}
```

That is the identical last-writer-wins loss the Mongo mirror already warns
about, faithfully reproduced on Postgres. **Moving to Postgres without fixing
it would have moved the bug, not fixed it** — and the epic would have
"completed" with its headline promise untrue.

### Optimistic versioning, not a lock

`aqua_store_blobs` gains a `version` column. A write states the version it
**read**; the `UPDATE` applies only if the row still carries it. A stale write
affects zero rows and the caller is told.

A per-store advisory lock would serialise every write to a store across all
instances, turning a 500 ms debounce into a queue. Optimistic versioning costs
nothing when there is no conflict, which is the normal case.

```
✓ B refused: StoreConflictError
✓ alice survives
✓ B recovers via refresh()
✓ B writes successfully afterwards
```

### The loser is told

`StoreConflictError` is its own type because it is **not** a database failure —
it is the concurrency control working, and the correct response (re-read,
merge, retry) differs from a connection error's.

An **awaited** `write` throws: the caller is right there, and a caller who is
not told their write lost believes it won — which is how two instances end up
confidently holding different data. A **write-behind** `writeSync` has nobody
to tell in the moment, so the conflict is recorded and re-reported by
`flush()`, and `conflicts()` survives the flush so an operator asking *"did any
write lose a race?"* still gets an answer.

`refresh()` is deliberately **manual**. Silently adopting the other instance's
value would discard this instance's write with nobody told — the same bug
wearing a politer face.

### 🔴 Two guards, and only one was tested

Measuring bite found that dropping the `AND version = $5` clause failed **zero**
tests. Not a vacuous test this time — a genuinely untested code path: every
case was caught by the *first-write* branch, so the `UPDATE` guard was never
reached.

Two independent guards; my suite exercised one. The added case has both
instances hydrate **after** the row exists, so both hold version 1 and the
`UPDATE` clause is the only thing between them. Both mutations now bite.

### 🔴 A pg-mem quirk that would have been invisible in production

`ON CONFLICT DO NOTHING ... RETURNING` returns a row in pg-mem where real
Postgres returns none. A first-write guard built on that row count would have
been **correct in production and silently wrong in every test** — the worst
combination available.

The guard reads back the stored checksum instead, which is true on both. A test
asserts the code does not depend on `RETURNING` after a `DO NOTHING`.

### Two of my own mistakes, both caught by measuring rather than reading

- A `conflicts.push` edit whose anchor did not match — it never applied, and I
  printed success without asserting. Same class as PR-4's partial replace.
- A timing-based test that waited one `setImmediate` when the guard performs
  **two** awaited queries. Now synchronised on `flush()`, which is the real
  synchronisation point, and run three consecutive times.

### Also fixed

PR-8's chain test asserted `applied.length === 3`. Adding a migration turned it
red for no useful reason — "expected 3" says nothing about whether the runner
is wrong or the set simply grew. It now derives the count from disk.

### Bite, measured

| mutation | failures |
|---|---|
| drop the version guard (last-writer-wins) | 1 |
| swallow the conflict instead of raising | 1 |
| hydrate without loading versions | 1 |
| stop recording write-behind conflicts | 1 |
| *(reverted)* | **0 — 11/11** |

### What remains unproven

`pg_advisory_lock` is still stubbed in the harness, so **migration** mutual
exclusion between two instances is untested. Store writes are now safe under
concurrency; the migration path's safety still rests on a real server and two
real processes.

### Results

```
npm test    2164 / 177 suites / 0 fail    (from 2153 / 175)
eval:gate   exit 0 · default boot unchanged
```

### Next

**PR-10** — flip the remaining stores. Each is now a config change rather than
code, because PR-7 generalised the flip: `AQUA_STORE_PG_READ` takes a list and
drift gates each store independently.

---

## PR-10 — the finding that replaced a config change

PR-10 was going to be "flip the remaining stores". It is not a PR: PR-7
generalised the flip, so all eight stores already work from one `.env` line.
Writing that as a pull request would be theatre.

So the same question PR-9 asked: **what does the epic actually still lack?**

### The measurement

```
store size: 2.9 MB
one whole-store write         :  91 ms
ONE FACT changed, same store  :  69 ms   ← the entire 2.9 MB is rewritten
```

| owners | bytes per write | time |
|---:|---:|---:|
| 100 | 0.1 MB | 16 ms |
| 1,000 | 1.2 MB | 52 ms |
| 5,000 | 6.0 MB | **858 ms** |

Superlinear, and every turn writes.

**E3 moved where the blob lives. It did not change the shape.** The audit said
the JSON substrate fails between 1k and 10k users; on this evidence the
Postgres blob substrate fails in the same range for the same reason. More
durable, more concurrent — **not more scalable**.

Per-owner rows, measured rather than assumed: **28 ms at 5,000 owners versus
858 ms**, and flat.

### Why this is not a bug to fix here

PR-4 recorded the reason and it holds: PR-3 keyed the seam by **path**, and a
path carries no owner. Splitting by owner changes what the stores *hold* — that
is E5's claim schema, where the blueprint already puts it (Part 3, `claims`
partitioned by `owner_id`). Doing it inside E3 would be the "two risky things
at once" the epic's ordering forbids, and it would be done twice.

### Recorded as inverting tests

`writeShape.test.js` asserts what is true **today** — one row per store, a
one-owner change rewriting everything, a boot loading every owner. Those
assertions are expected to **invert** when per-owner storage lands, the same
mechanism E1/PR-1 used for the ratio ceiling that E1/PR-3 closed.

One test in that file asserts E3's real win alongside the open problems, so the
suite does not read as "the epic achieved nothing": the same write is safe
under two instances, which was false before PR-9.

Bite: write only a fragment → 3 · hydrate loads nothing → 1. Both mutations
verified as *applied* before believing the number — the PR-7 lesson.

### Where E3 stands

**Complete against its stated exit criterion.** Two instances no longer lose
each other's writes, and that was false six PRs ago. Durable, concurrent,
observable, with a per-store rollout switch.

**The scaling problem moves to E5**, labelled rather than assumed solved.

### Still ungated by anything I can run

`npm run db:drift` clean for a week on a real server, with `aqua_drift_runs` as
the evidence, before any read flip is switched on. `pg_advisory_lock` is
stubbed in the harness, so migration mutual exclusion has never actually run.
