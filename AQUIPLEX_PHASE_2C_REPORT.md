# AQUIPLEX — Phase 2c Report: Storage Integration Completed, Horizontal Scaling Prepared

**Date:** 2026-11-14 · **State:** uncommitted working tree on `main` · **Builds on:** [AQUIPLEX_PHASE_2B_REPORT.md](AQUIPLEX_PHASE_2B_REPORT.md)

Nothing in this phase touched Render, DNS, production databases, production environment variables or Cloud SQL. Nothing was committed or deployed. All database work used the disposable PostgreSQL 16 container (`aqua_test`, localhost:55432) and the disposable Mongo container (`aqua_phase2c`, localhost:57017). Every new behaviour is behind a flag that defaults to off. With the flag off, the application behaves as before (the full regression is in §7). The exception is two Phase 2b changes that were already reported there.

Companion documents:
- [AQUIPLEX_STORE_OWNERSHIP_MATRIX.md](AQUIPLEX_STORE_OWNERSHIP_MATRIX.md): every store's readers, writers, concurrency and deletion.
- [AQUIPLEX_APPLICATION_INTEGRATION_TEST_REPORT.md](AQUIPLEX_APPLICATION_INTEGRATION_TEST_REPORT.md): real application workflows.
- [AQUIPLEX_PHASE_3_READINESS_REPORT.md](AQUIPLEX_PHASE_3_READINESS_REPORT.md): independent API and worker entrypoints.

Status labels: **Implemented** · **Tested locally** · **Tested against a real database** · **Tested under concurrent load** · **Unverified** · **Remaining**.

---

## 1. Summary

| | |
|---|---|
| Stores with documented ownership and concurrency semantics | **all** (matrix §1–§3) |
| Stores on owner partitions behind `AQUA_STORE_PARTITIONS` | 2b: 6 · **2c: +13** (brain annotations, evidence, fileindex, uko owners, attachments, pic, vectors, projects, project index, artifacts incl. binaries, conversation trash, cognition, ledger) |
| Deliberately **not** partitioned | uko content cache (process-local, per owner), identity overrides (no runtime writer) |
| Phase 2b limitations | 4 of 5 **fixed** and pinned by tests (§3). The fifth, global aggregation, is now wired to cognition and ledger. |
| Application journey (2 APIs + 2 workers, separate disks, every store `on`, real providers) | see §5 |
| Independent API / worker entrypoints | implemented and tested, **not activated** (readiness report) |

## 2. What changed (implementation)

| Area | Files | Status |
|---|---|---|
| Three-way merge engine: collections, links, logs, log maps, root lists, counters, whole values | `core/storage/entryMerge.js` | Implemented · tested locally (13) |
| Keyed bindings: entries keyed by conversation, workspace, namespace or artifact, owner resolved from the data, last-synced base kept per entry, immediate version-checked `commit()` | `core/storage/keyedBinding.js` | Implemented · tested against a real database |
| 13 stores bound | the store modules in the matrix | Implemented · tested against a real database (§4) |
| Immutable object store (pg backend; GCS refused until Phase 4) | `core/storage/objectStore.js`, migration `0028_objects.sql` | Implemented · tested against a real database |
| Per-owner change counter (database trigger) | migration `0027_owner_versions.sql` | Implemented · tested against a real database |
| Guarded message insert, transactional conversation delete, orphan sweep, prefix tombstones, measured clock offset | `core/storage/partitionRepository.js` | Implemented · tested against a real database |
| Deletion by database order, clock-offset conversion, owner fast path | `core/storage/ownerBinding.js` | Implemented · tested against a real database |
| Cognition and ledger on instance aggregates (migration seed from the existing JSON, exactly once) | `core/storage/instanceAggregate.js`, `cognition/cognitiveStore.js`, `intelligence/learningLedger.js` | Implemented · tested against a real database |
| Owner resolution in migration (`--history`, `--projects`), unresolved owners counted | `partitionMigration.js`, `scripts/partition-migrate.mjs` | Implemented · tested locally |
| Phase 3 entrypoints, scheduler lease, `/ready`, role-gated SIGTERM drain | see readiness report | Implemented · tested (SIGTERM unverified) |

## 3. Phase 2b limitations: fixed

| # | Limitation | Fix | Test (real Postgres, real processes) |
|---|---|---|---|
| 1 | A message could be inserted after its conversation was deleted | `insertChild`: one statement inserts only while the header is **live**, under a share lock. `tombstoneGroup` locks the header first, waits for in-flight inserts, then retires every message row in the **same transaction** | an instance appending 25 messages while another deletes: header tombstoned, **0 live message rows** |
| 2 | Invisible orphan message rows | `sweepOrphans`: per tombstoned header, lock it, re-check it is **still** deleted, retire its live children; exact-prefix matching | legacy orphan retired; a deleted-then-**re-created** conversation untouched; an id that is a prefix of another (`gone` vs `gone2`) untouched |
| 3 | Deletion decisions depended on synchronized clocks | (a) a pending local delete is decided by **database order**: everything committed before the tombstone is retired; (b) a deletion made elsewhere is converted into this process's clock with a **measured** application-to-database offset; (c) the three-way stores need no clock at all (attribution against the base) | a host **10 min slow** keeps a genuinely new change made after a deletion; a host **10 min fast** cannot pass an old copy off as new |
| 4 | The per-request check grew with the owner's data | trigger-maintained `aqua_owner_versions` counter: an unchanged owner costs one primary-key lookup. Every writer bumps it (any instance, any tool, a migration); global rows never do | own writes force a full load; unchanged → fast path; a direct SQL write by "another instance" moves it; no counter row for `''` |
| 5 | Global heuristic aggregation not wired | cognition and ledger on instance aggregates; the local view = shared total + unpublished changes; the existing JSON seeds the shared base **once** (insert-if-absent) | two instances: totals exact (8 plans, 6 outcomes), latency EWMA correct, no owner rows created |

**Global aggregation never becomes user data:** the aggregate rows have owner `''`, are never loaded per user, are sanitized on read (non-finite or negative numbers dropped), and hold task-type statistics only.

## 4. Test evidence

New suites, all against the disposable Postgres:

| Suite | Tests | What it proves |
|---|---:|---|
| `core/tests/entryMerge.test.js` | 13 | three-way semantics: attribution, deletions without tombstones, edit beats delete, counters add, order independence |
| `core/tests/phase2cLimits.test.js` | 6 | §3 rows 1–4 (two clock cases: never-saw-the-deletion uses the measured offset; reloaded-after needs no clock) |
| `core/tests/phase2cStores.test.js` | 11 | each 2c store with two real processes: concurrent writes kept, deletions honoured, isolation, cross-instance artifact files, distinct artifact versions, trash rows, aggregates |
| `core/tests/phase3Roles.test.js` | 3 | multi-worker exactly-once, per-owner order, no HTTP in workers, single scheduler owner + takeover, stale-job recovery, DLQ |
| **Consolidated:** every storage, role and guard suite (2a, 2b, 2c, queue, flags, pool, dual-write, write shape), run in parallel | **331** | **331/331 pass** after all 2c changes |

**Bite (mutation) check:** each mutation was applied, verified, run against its suites, and reverted byte-identically.

| Mutation | Failing tests |
|---|---:|
| three-way merge ignores the base (always ours) | 5 |
| counters do not add both sides' increments | 2 |
| message insert ignores a deleted header | 1 |
| deletion compared with the raw database time (no measured offset) | 1 (0 at first, see below) |
| owner fast path never taken | 1 |
| orphan sweep never runs | 1 |
| every worker believes it owns the schedulers | 1 |
| artifact version taken from the local copy instead of the newest row | 1 |
| attachments owned by the conversation id instead of its user | 1 |
| aggregate change not recorded into the instance delta | 1 |
| keyed flush skips the database for real changes | 6 |
| *(reverted)* | **0** |

The offset mutation first bit **0** tests. The slow-clock test reloaded after the deletion, which takes the clock-free path (the process holds the tombstone), so it never reached the offset conversion. A second test now covers a slow host that never saw the deletion. Both properties are tested separately.

## 5. Application-level validation

The real application was run as **2 API instances + 2 workers with separate empty disks**, every store `on`, real providers, real HTTP and sessions. Result: **29/29 checks** on persisted data. Details are in [AQUIPLEX_APPLICATION_INTEGRATION_TEST_REPORT.md](AQUIPLEX_APPLICATION_INTEGRATION_TEST_REPORT.md).

Scenarios covered:
- **Signup and session:** signup on A; the session used on B.
- **Concurrent conversation writes:** concurrent insertion from both instances.
- **Cross-instance memory:** extraction in workers, recall on the other instance; Mind fact forgotten through one instance and gone everywhere.
- **Upload:** attachments owned by the user.
- **Restarts:** worker restart; a job **genuinely interrupted mid-run**, reclaimed and completed; API restart on an **empty disk** serving everything from partitions.
- **Deletion:** a conversation deleted with every message row tombstoned; account deletion leaving **no live row in any store**.

The testing found one real defect, now fixed: **scheduler ownership flapped** during long jobs because the lease was renewed only between jobs. Renewal now runs on an independent timer, and the final run confirms single, stable ownership.

## 6. Feature-flag rollout design (per store; **no production flag activated**)

**Order.** Lowest blast radius first; each store moves only when the previous one has held:

1. `brain`, `fileindex`, `pic`, `reflection`
2. `ids`, `reasoning-graph` (fixes S6), `evidence`, `uko`, `vectors`
3. `mind`, `recall-redactions`
4. `history` (+ trash), `attachments` (needs `--history` owner join)
5. `projects`, `index` (needs `--projects`; legacy ownerless workspaces backfilled first), `artifacts` (object store; Phase 4 GCS before production)
6. `cognition`, `ledger` (aggregates; safe at any point)

**Per store, the gates:**

| Gate | Action | Pass criterion | Rollback |
|---|---|---|---|
| G0 | `partition-migrate --mode dry-run` from the mirror's current file | 0 conflicts; unresolved owners = 0 (or listed and accepted) | nothing written |
| G1 | `--mode apply`, then `--mode reconcile` | `clean: true` (counts + canonical SHA-256) | delete the store's rows (nothing reads them) |
| G2 | `shadow` | daily reconcile clean for 7 days; `partitions` boot line clean | remove the flag |
| G3 | `on` (single production instance still) | the application journey against staging; error rate unchanged | remove the flag: the JSON rollback copy is current |
| G4 | rollback drill | `export` → JSON → restart `off` → served identically (tested per store in the matrix suite) | — |
| G5 | `only` | after every owner store is at G4 | `export` first, then the flag |

**Preventing dual-write divergence:**
- **There is one authority per mode.** In `off`/`shadow`, JSON is authoritative. In `on`/`only`, partitions are, and JSON is only a derived rollback copy that is never read while the flag is on.
- **`shadow` never feeds reads**, so a divergent shadow cannot reach a user. Divergence is measured by `reconcile`, not trusted.
- **Moving a store to `on` with no rows is refused** while its JSON file has data (the never-migrated guard), and a store never falls back to stale JSON when the database is unreachable at boot.
- **Rolling back from `on` to `off`** uses the rollback copy, which lags the partitions by at most the debounce. For an exact rollback: `export` → reconcile → flag off.
- **Multiple instances are allowed only when every owner store is `on`.** Until then the Mongo mirror's single-writer lease stays the guard.

## 7. Regression (flags off)

Full `aqua/src` battery against the test database, default flags:
- **First run: 4,912 tests, 4,679 passed, 6 skipped, 42 failed.** Every failure was investigated:
  - **Mine, fixed:** migration 0027's plpgsql trigger cannot run on pg-mem. The pg-mem harness now skips it like the pgvector migrations 0012/0013, recording it as applied; the counter is tested on real Postgres.
  - **Transient, mine:** route suites that ran while I briefly had a quoting error in `flags.js`.
  - **Rerun of all 48 previously failing files: 550 tests, 538 pass, 2 skipped, 3 fail.** All three are pre-existing and unrelated: the two date-dependent temporal tests (frozen "next month" = 2026-11-01) and the hygiene check flagging two Nov-2 eval output files.

## 8. Known limitations and remaining work

| # | Item | Status |
|---|---|---|
| 1 | Graceful SIGTERM of the split roles | **Unverified** on this machine (Windows kill = TerminateProcess) |
| 2 | Post-turn learning still runs inside the API process | **Remaining** (Phase 3 step 2). Cloud Run must keep CPU allocated meanwhile |
| 3 | GCS backend for artifact binaries | **Remaining** (Phase 4). pg backend used today; `gcs` refuses rather than falling back |
| 4 | Existing local-disk artifacts are not migrated to the object store | **Remaining**: a one-off export tool. Until then they stay readable on the instance that holds them |
| 5 | Legacy workspaces without `ownerId`, attachments of conversations without `userId` | not loadable per user. Migration **reports** them (`unresolvedOwners`); backfill required before `on` |
| 6 | `flushMind`, redaction persistence and `purgeTrashForUser` count are asynchronous in `on` mode | stated; propagation is off by default |
| 7 | "Newer wins" on a double edit of the *same* item uses item timestamps from different hosts | deletions do not depend on clocks; this tie-break does, within NTP skew |
| 8 | EWMA aggregation is an approximation | heuristics only |
| 9 | Platform uploads (`public/uploads`) | **Remaining** (Phase 4) |
| 10 | Nothing measured on Cloud SQL, Linux, under network latency or failover | **Unverified**. No capacity claim is made from these tests |
