# AQUIPLEX — Per-Owner Storage Plan

**Date:** 2026-11-13 · **Phase:** 2 of the scalability project · **Prerequisite:** [AQUIPLEX_SCALABILITY_AUDIT.md](AQUIPLEX_SCALABILITY_AUDIT.md)

> **Update 2026-11-13:** Phase 2b integrated six stores behind `AQUA_STORE_PARTITIONS`. The "Not yet implemented" rows in §1 for consumer wiring, owner hydration and the cutover flag are superseded by [AQUIPLEX_PHASE_2B_REPORT.md](AQUIPLEX_PHASE_2B_REPORT.md). The history layout is now message-level (§3.2 there).

Status labels are defined in the audit §0. Nothing in this document has been run against production. Nothing has been migrated. Render has not been touched.

---

## 1. Status at a glance

| Item | Status |
|---|---|
| Migration `0026_store_partitions.sql` (partition table + run ledger) | **Implemented** · **Tested against a real database** (applied to the disposable `aqua_test`, PG 16) |
| `storage/partitionLayout.js`: lossless split/reassemble for all 20 registered store shapes | **Implemented** · **Tested locally** (39 tests) |
| `storage/partitionRepository.js`: CAS, tombstones, ownership, bounded LRU, owner load/refresh/purge, transactions | **Implemented** · **Tested against a real database** (15 tests) · **Tested under concurrent load** (§6; up to 32 OS processes) |
| `storage/partitionMigration.js`: migrate (dry-run/apply), reconcile, export (rollback) from JSON files or `aqua_store_blobs` | **Implemented** · **Tested against a real database** (10 tests) |
| `aqua/scripts/partition-load.mjs`: multi-process contention and write-shape harness | **Implemented** · run 4 times (§6) |
| Mutation (bite) check of the three modules | 12 of 12 mutations caught (§7) |
| Any consumer store reading or writing partitions | **Not yet implemented** (Phase 2b) |
| Unit-of-work owner hydration, per-store cutover flag, eviction from store Maps | **Not yet implemented** (Phase 2b) |
| Production migration of any store | **Not yet implemented** and **not authorised** |

The existing adapters (`jsonFileAdapter`, `pgBlobAdapter`, `dualWriteAdapter`) and every consumer are unchanged. `getAdapter()` still returns the JSON adapter.

---

## 2. Why the blob adapter is not per-owner storage

`aqua_store_blobs` stores one row per *store file*. Measured on the same server (§6.1), one owner's change rewrites 3.7 MB at 5,000 owners. The partition row write is 738 bytes at every owner count. The blob adapter also hydrates every store at boot and serves reads from a whole-world cache, so memory grows with total users. It gave durability and conflict detection. It does not give scale. That is what [E3_SCALING_FINDING.md](E3_SCALING_FINDING.md) recorded, and this plan acts on it.

---

## 3. Design

### 3.1 Data model (`aqua_store_partitions`)

One row per `(store_key, partition_key)`:

- `store_key`: the file basename (`.aqua-mind.json`), the same key the blob table and drift job use.
- `partition_key`: `<section>:<key>` (`o:user:42`, `c:<conversationId>`, `owners:user:42`, `cache:<hash>`), or `~rest` for everything in the file that is not a partitioned map: the envelope, global aggregates, unknown fields.
- `owner_id`: whose data this is (`''` = not owner data). Indexed together with `store_key`.
- `data` (text, byte-exact; `NULL` = tombstone).
- `version` (CAS).
- `ordinal`: source key order, so a rollback export reproduces the file.

Text, not `jsonb`: `jsonb` reorders keys, and the rollback path must reproduce the source.

### 3.2 Partition layout (owner derivation)

Defined once in `partitionLayout.js`. Each layout is also checked by a test that the split is lossless and that no `user:` partition mentions another user.

| Store | Partition | Owner |
|---|---|---|
| mind, evidence, pic, reasoning-graph, ids, brain, reflection, recall-redactions, fileindex | `o:<ownerId>` | the key |
| history | `c:<conversationId>` | `user:<meta.userId>`, or `conv:<id>` before login |
| history-trash | `t:<seq>:<id>` (duplicates kept) | as history |
| attachments | `c:<conversationId>` | `conv:<id>`. **Weaker:** the user is reached through the conversation (a join), not a column. |
| uko | `owners:<owner>`, `cache:<hash>` | the owner; the content cache is **global** |
| vectors | `ns:<namespace>` | the owner (the `files:` prefix is stripped) |
| projects, index | `ws:<workspaceId>` | `ws:<id>`. **Weaker:** the user is in Mongo `Bundle.userId`. |
| artifacts index | `a:<artifactId>` | the entry's `ownerId` |
| cognition, ledger, identity-overrides | `~rest` only | global |

### 3.3 Repository guarantees (each one has a test, and each test bites)

| Guarantee | Mechanism | Test |
|---|---|---|
| One owner's update writes that owner's bytes only | row per partition | `write shape` (100 vs 5,000 owners: identical bytes, 1 row touched) |
| Transactional writes | `transact([...])` in one `BEGIN…COMMIT`; all-or-nothing | `transact is all or nothing` |
| Optimistic concurrency | `UPDATE … WHERE version = $expected`; insert `ON CONFLICT DO NOTHING`; `PartitionConflictError` | `stale write is refused`; `exactly one insert wins` |
| No lost update under read-modify-write | `update(mutate)` re-applies `mutate` to the newest value on conflict | `every increment lands` (2 instances × 40) + §6 (6,400 ops, 32 processes) |
| No blind write | a write must state a version this instance read (`UnreadWriteError`) | `a blind write is refused` |
| Deletion tombstones are preserved | `delete` keeps the row (data `NULL`, version+1); re-creation needs the tombstone's version | three tombstone tests |
| Ownership isolation | `owner_id` in the `UPDATE` predicate; reads that name an owner refuse foreign rows, from cache as well as from the database | four isolation tests |
| Account purge | one statement tombstones every live partition of one owner; refuses the global owner `''` | `purgeOwner …` |
| No whole-world load | `loadOwner(owner)` is one index range scan; there is no hydrate-all | by construction; `loadOwner returns only that owner's partitions` |
| Bounded cache | LRU by entries and bytes (`AQUA_PARTITION_CACHE_ENTRIES` / `_BYTES`); write-through, so eviction can never lose a write | `the cache stays within its bound …` |
| Cross-instance freshness | `refreshOwner` compares cached versions to the database in one scan; correctness never depends on it (a stale cache causes a conflict, never a lost write) | `refreshOwner drops what another instance changed` |
| Honest async | no `readSync`/`writeSync`: every operation returns a promise | by construction |

### 3.4 What the design does *not* solve, measured

**Hot global rows.** With 32 processes and 30% of all writes on one partition, nothing was lost. But p99 rose to 1.7 s and the worst single update took 15.8 s (7,675 conflicts, §6.2). Optimistic concurrency is correct for ordinary per-owner traffic and wrong for a row every request writes. Three such rows exist: `cognition` and `ledger` (global running averages updated per turn) and the uko `cache:` section. They need a different write shape (decision **D-2**, §9).

---

## 4. Phase 2b: cutting a store over (designed, not implemented)

The 19 consumers access their stores synchronously (`getMind(owner)` and similar). Making those calls async everywhere is a rewrite this project's rules forbid. The bridge is **asynchronous load at the unit of work, synchronous access inside it**:

1. **Entry.** The aqua router (after `requireLogin`, when `req.aquaUserId` is known) and `workerRuntime.runOneJob` (before the handler; `job.ownerId` is known) call `await ensureOwner(ownerId)`. The first time, it runs `repo.loadOwner(owner, cutoverStores)` and installs each partition into its store's `Map`. On later calls it runs `refreshOwner` and reloads only what moved. Cost: one index range scan for the first load, one version scan after that.
2. **Inside the unit of work.** Store code is unchanged: sync `Map` reads and in-place mutation.
3. **Persist.** `scheduleSave(ownerId)` marks the owner dirty (`mindStore` already tracks dirty owners). The debounced flush writes only the dirty owner's partitions through `repo.update`, with a **per-store merge policy** applied on conflict:
   - `merge`: a store-specific function. `mindStore.mergeConcurrent` already exists and already honours per-item tombstones.
   - `append`: conversations; union of messages by id/timestamp, never dropping either side.
   - `preserve`: the write lands, and the overwritten version is kept for recovery, the same rule the Mongo mirror's generation CAS uses today.
4. **Eviction.** Owners not touched for N minutes and not dirty are dropped from the store `Map`s (a new `evictOwner` per store). This removes the "memory grows with total users" property.
5. **Cross-owner code paths** must become queries, not `Map` scans: `listConversationIdsForUser`, `purgeTrashForUser`, artifact owner quotas, the propagation sweeper's `for owner of store`. Each is listed in the 2b ticket with its replacement query.

**Per-store flag:** `AQUA_STORE_PARTITIONS=<store>:<mode>,…` with three modes, one store at a time:

| Mode | Reads from | Writes to | Rollback |
|---|---|---|---|
| `shadow` | JSON (+ mirror) | JSON + partitions (best effort) | drop the flag |
| `read` | partitions (owner hydration) | partitions, then a JSON export of the touched owner | drop the flag; JSON is current |
| `only` | partitions | partitions | `exportStore` → JSON file → mirror, then drop the flag |

A store moves `shadow → read` only after `reconcileStore` is clean for 7 consecutive days (the `aqua_store_partition_runs` rows are the evidence). It moves `read → only` only after a successful rollback drill.

**Cutover order** (lowest blast radius first; the reason in brackets):

1. reflection, brain annotations, fileindex, pic [owner-keyed, small, rebuildable]
2. ids + reasoning-graph [owner-keyed; **fixes audit S6**, the server/worker lost writes]
3. evidence, uko owners, vectors [owner-keyed, larger]
4. mind [already has a merge and tombstones]
5. recall-redactions [privacy record: last of the small stores, so its rollback drill is proven elsewhere first]
6. history + history-trash + attachments [largest and hottest; needs the listing queries in step 5 of the bridge]
7. projects + index; artifacts index together with object storage (Phase 4)
8. cognition, ledger, uko cache: decided by D-2

**Horizontal scaling is allowed only after** every owner store is in `read` or `only` and the Mongo mirror is retired for those files. Until then, the single-writer rule stands (absolute rule 7).

### 4.1 Tests to write *before* each cutover (acceptance criteria)

- The full battery passes with the store in `read` mode (the same suites, unedited), against the test database.
- Two server processes plus one worker on the dev launcher: a scripted journey (chat, memory change, delete, file upload) leaves reconcile clean and loses no update. Run with `partition-load`-style verification of ids.
- Kill -9 of one instance mid-turn: the owner's data equals what was acknowledged.
- Deletion: an item deleted on instance A is not resurrected by instance B's later flush. This extends today's `mindStore` cross-process test to two *hosts*.
- Memory: RSS stays flat while 10,000 distinct owners are touched in sequence (eviction works).

---

## 5. Migration plan (for production; every step needs explicit authorisation)

None of this has been run. It requires `DATABASE_URL` in production, which production does not have today (audit §1).

| Step | Action | Evidence required to continue | Rollback |
|---|---|---|---|
| M0 | Read Render config (audit §7). Snapshot `aqua_kv` (Mongo export) and the data dir. | Snapshot checksums recorded | — |
| M1 | Provision Postgres; `npm run db:migrate` (0001–0026) | `db:status` clean | drop the database |
| M2 | `migrate --dry-run` per store from the **mirror's** current files | report: owners, partitions, 0 conflicts | nothing was written |
| M3 | `migrate --apply` per store | inserted = partitions; reconcile clean | `DELETE FROM aqua_store_partitions WHERE store_key = …` (nothing reads it yet) |
| M4 | Store in `shadow` | reconcile clean daily for 7 days | drop the flag |
| M5 | Store in `read` | battery and journey; error rate unchanged | drop the flag |
| M6 | Rollback drill: `export` → JSON → restart in JSON mode → reconcile | export reconciles clean against the partitions | — |

**Sources:** JSON file (`readJsonFileSource`) or the E3 blob (`readBlobSource`). Migration never overwrites. A partition that differs from the source is reported as conflicting and left alone, because after cutover the partition is the newer copy. Re-running is idempotent.

**Reconciliation** reports missing / extra / mismatched / tombstoned partitions and compares canonical checksums of the reassembled store with the source. `clean` requires all four counts at zero and equal checksums. Reports name partition keys only, never content.

**Rollback** is `exportStore` → the existing JSON loader. The export is deep-equal to the source (byte-identical when the source was compact) and carries deletions made after cutover.

---

## 6. Measured evidence

Setup: Windows 11 laptop. PostgreSQL 16 in Docker (`aqua-test-db`, pgvector/pg16), local socket, default `max_connections`. Node v22. One run each. These numbers describe **this storage layer on this machine**. They are not a capacity statement for AQUIPLEX (see [AQUIPLEX_LOAD_TEST_REPORT.md](AQUIPLEX_LOAD_TEST_REPORT.md), Phase 6). Raw JSON is in `aqua/eval/out/scalability/` (gitignored, local).

### 6.1 Write shape: one owner's update (20 samples per row, ~1 KB per owner)

Reproduce: `node aqua/scripts/partition-load.mjs --db <test-url> --shape`

| Owners | Blob bytes/write | Blob p50 / p95 | Partition bytes/write | Partition p50 / p95 |
|---:|---:|---:|---:|---:|
| 100 | 73,761 | 47.1 / 55.1 ms | 734 | 4.2 / 21.1 ms |
| 1,000 | 739,770 | 14.8 / 81.0 ms | 736 | 3.8 / 6.2 ms |
| 5,000 | 3,715,750 | 52.0 / 115.1 ms | 738 | 3.9 / 8.5 ms |

Partition writes are flat in bytes and latency. Blob bytes grow linearly. The 100-owner blob p50 includes warm-up: 20 samples are too few to rank small differences, but enough to show the shape.

### 6.2 Contention: N OS processes, each with its own pool and cache

Reproduce: `node aqua/scripts/partition-load.mjs --db <test-url> --procs N --ops K --owners O --hot H`

| Processes × ops | Owners | Hot share | Acknowledged | **Lost** | **Duplicates** | Conflicts (all retried) | Throughput | p50 / p95 / p99 / max | Peak connections | RSS per process |
|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|
| 8 × 250 | 1,000 | 10% | 2,000 | **0** | **0** | 376 | 849 ops/s | 3.5 / 20.2 / 102 / 292 ms | 10 | 52 MB |
| 32 × 200 | 5,000 | 0% | 6,400 | **0** | **0** | 50 | 1,146 ops/s | 14.4 / 31.2 / 57.8 / 225 ms | 34 | 52 MB |
| 32 × 200 | 5,000 | 30% | 6,400 | **0** | **0** | 7,675 | 273 ops/s | 3.6 / 202 / 1,707 / 15,788 ms | 34 | 54 MB |

"Lost" is acknowledged updates minus distinct op ids found in the rows. "Duplicates" is op ids found more than once. Each counter equalled its id count in every run.

---

## 7. Bite (mutation) check

Each mutation was applied, verified as applied, run against the three suites on the real database, and reverted with a byte-identical restore (session script `bite.mjs`).

| Mutation | Failing tests |
|---|---:|
| drop the version guard (last writer wins) | 4 |
| drop the owner guard on update | 1 |
| allow blind writes | 1 |
| cache read ignores the owner | 1 |
| no cache eviction | 1 |
| `update` does not retry on conflict | 1 |
| `refreshOwner` never drops | 1 |
| purge every owner | 2 |
| migration overwrites conflicts | 3 |
| no implied tombstones from the envelope | 3 |
| reassembly ignores `ordinal` | 5 |
| `__proto__` key by assignment | 1 |
| *(reverted)* | **0** |

---

## 8. Known limits of this phase

- **pg-mem is not used for these tests.** `ON CONFLICT DO NOTHING RETURNING` behaves differently there (E3/PR-9), and that clause is the insert guard. The suites skip loudly without a real database.
- **Tombstones are never compacted.** That is safe and costs about one small row per deleted partition. Compaction (dropping tombstones older than a retention window) would let a writer that never read the row re-insert after the window, so it is deferred until a retention decision exists.
- **Attachments and workspaces derive their owner indirectly** (§3.2). Isolation for them rests on the conversation or workspace check that already guards every route. 2b must not loosen it.
- **Multi-process here means one machine.** No network latency, no managed-database connection limits, no failover. Phase 6 repeats these runs against the target database.

---

## 9. Decisions needed before Phase 2b

| # | Decision | Options | Recommendation |
|---|---|---|---|
| **D-1** | Postgres for production (Cloud SQL, or another managed Postgres) | Phase 2b cannot start in production without one. | Cloud SQL for PostgreSQL 16 in the Cloud Run region, private IP, PgBouncer or the Cloud SQL connector (pool budget in the Cloud Run doc). |
| **D-2** | Write shape of the three global hot rows (cognition, ledger, uko cache) | (a) per-instance sub-partitions (`~rest@<instance>`), merged on read; (b) keep them instance-local (they are adaptive heuristics, not user data); (c) CAS as measured (§6.2, poor) | **(a)** for cognition/ledger. Content-hash rows for the uko cache: each hash is its own partition, already the case, so contention exists only on identical uploads. |
| **D-3** | Merge policy per store (§4 step 3) | `merge` / `append` / `preserve` | as listed in §4; review the conversation `append` rule with product (message edits) |
| **D-4** | First store to cut over | §4 order | reflection |
