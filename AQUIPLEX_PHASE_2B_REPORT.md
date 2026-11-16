# AQUIPLEX — Phase 2b Report: Per-Owner Persistence Integrated

**Date:** 2026-11-13 · **Branch:** `main` working tree, **uncommitted** · **Builds on:** [AQUIPLEX_PER_OWNER_STORAGE_PLAN.md](AQUIPLEX_PER_OWNER_STORAGE_PLAN.md) (Phase 2a), [AQUIPLEX_SCALABILITY_AUDIT.md](AQUIPLEX_SCALABILITY_AUDIT.md)

Status labels are as defined in the audit: **Implemented** · **Tested locally** · **Tested against a real database** · **Tested under concurrent load** · **Not yet implemented**.

Nothing in this report touched production. Render settings, DNS, production databases and Cloud SQL were not touched. Nothing was committed or deployed. Every database test ran against the disposable PostgreSQL 16 container `aqua-test-db` (localhost:55432). Every flag added here defaults to **off**, and with it off the application behaves exactly as before. That is verified by the existing suites and by a test per store that the default writes no rows and changes no file format.

This report covers **storage behaviour only**. It makes no claim about application scalability. API scaling is Phase 3 onwards, and capacity numbers belong to Phase 6.

---

## 1. Summary

| | |
|---|---|
| Stores integrated (behind a flag) | **6**: reflection, Mind, recall redactions, conversations (message-level), reasoning graph, identity map |
| Stores remaining | **13** (§4.2), each with its writer ownership and merge strategy documented |
| New tests | **125** (Phase 2a + 2b storage suites), all passing against a real Postgres. Up to 3 real OS processes per case. |
| Mutation (bite) checks | Phase 2a 12/12, Phase 2b 12/12 caught |
| Regression | 4,516 tests in the affected directories (existing + new): 4,498 pass, 6 skipped. 5 failures: 2 mine, fixed and re-verified (§8); 3 pre-existing and unrelated (§8). |
| Defects found and fixed along the way | `saveReflectionState` erased the "already raised" watermark (§3.1). Server and worker overwrote each other's graph and identity entries (audit S6) when partitions are on. A stale process could resurrect deleted Mind items, which is also possible on the current JSON path (§3.2). |

---

## 2. How a store is integrated

The existing adapter seam (`core/storage/index.js`) is keyed by file path. It cannot express per-owner writes (the E3/PR-4 finding). The per-owner layer therefore sits **beside** it in `core/storage/` and plugs into the same lifecycle:

| Lifecycle point | Existing | Added |
|---|---|---|
| Boot | `configureStorageFromEnv()` + boot line | `configurePartitionBindings()` + `[STORE] partitions: …` line (server: `aqua/router.js`; worker: `aqua/scripts/worker.mjs`) |
| SIGTERM | `flushStorage()` (≤5 s, alongside the mirror and job drains) | also flushes every binding |
| Unit of work | none (every owner always in memory) | `ensureOwnerLoaded(owner)`: aqua router per request (`user:<id>`); `runOneJob` per job (`job.ownerId`). Two queries: versions, then only changed rows. |

**Store code is unchanged in shape.** Each store keeps its synchronous `Map` and accessors. A mutation marks the owner dirty. A short debounce later, only dirty owners are written through `partitionRepository.update()`, which is version-checked; on conflict the store's merge runs on the newer value. Deletions are tombstone rows. In `on` mode an owner that has not been loaded is **not ready**, and the stores refuse to act on "nothing here" for it (§3).

New modules:
- `core/storage/ownerBinding.js`: one entry per owner, generic.
- `memory/conversationPartitions.js`: message rows.
- `core/storage/instanceAggregate.js`: global aggregates.

### Feature flags

| Variable | Kind | Default | Meaning |
|---|---|---|---|
| `AQUA_STORE_PARTITIONS` | gate (registered, requires DB) | unset = off | Per store: `reflection:on,mind:shadow,history:on,…` Modes below. |
| `AQUA_PARTITION_STORE_OWNERS` | setting | 2000 | `on`/`only`: owners kept in memory per process per store (least-recently-used clean owners evicted) |
| `AQUA_PARTITION_CACHE_ENTRIES` / `_BYTES` | setting | 5000 / 64 MB | repository row cache bounds |

| Mode | Reads from | Writes to | Rollback |
|---|---|---|---|
| `off` | JSON (+ Mongo mirror) | JSON | — (today) |
| `shadow` | JSON | JSON + partitions (best effort, retried, never surfaced) | remove the flag |
| `on` | partitions, per owner | partitions + a JSON rollback copy (on-disk file with merged owners replaced) | remove the flag |
| `only` | partitions | partitions | `partition-migrate --mode export` → JSON, then remove the flag |

**Safety rules, each tested:**
- `on`/`only` without `DATABASE_URL` falls back to `off`, and the boot line says why.
- `on`/`only` for a store that has **no rows** while its JSON file has data is refused. The store stays `off` and keeps serving the JSON, because serving an empty store would look like total data loss.
- If the database is unreachable at boot in `on` mode, the store stays `on` with owners not ready. It does **not** fall back to a JSON file that may be stale.

---

## 3. Stores integrated

Each store has a test file whose multi-process cases run real child processes (`core/tests/helpers/storeProcess.mjs`). Each child has its own data directory, pool and memory, playing server or worker.

### 3.1 Reflection (`brain/reflectionV2/reflectionStore.js`): step 1

| | |
|---|---|
| Writers | `reflectWorldModel` → `saveReflectionState` (snapshot + `lastReflectionAt`); `revisionDirectiveFor` → `markSurfaced` (`lastSurfacedAt`). Two processes. |
| Merge | `lastSurfacedAt` = max (a watermark never goes back). Snapshot + `lastReflectionAt` move **together** from the more recent reflection. Deterministic tie-break. Commutative, idempotent, associative (tested). |
| Deletion | `forgetReflectionState` → tombstone. A copy survives only if it changed after the deletion. |
| Not ready | `reflectWorldModel` returns `skipped: 'owner-not-loaded'` instead of diffing against nothing ("everything changed"). `revisionDirectiveFor` raises nothing. |
| **Fix** | `saveReflectionState` replaced the record and dropped `lastSurfacedAt`. Every reflection reset the watermark, so a revision could be raised again. The watermark is now kept, on the JSON path too. This is a behaviour change on the default path, and a test pins it. |
| Tests | `brain/tests/reflectionPartitions.test.js` (16): both writers' changes survive; **baseline: the same race on the JSON path loses one side**; idempotent retry and older watermark (no new version); deletion vs stale copy, and genuine re-creation; owner isolation; not ready; never-migrated refusal; no-DB fallback; default writes nothing; rollback copy; shadow parity. |

### 3.2 Mind and recall redactions: step 2

| | Mind (`mind/mindStore.js`) | Recall redactions (`memory/recallRedactions.js`) |
|---|---|---|
| Writers | memory engine, Mind post-turn, Memory UI (server); reflection V3 belief projection (worker) | Memory UI forget/correct, propagation (server) |
| Merge | the file's existing two-process merge, unchanged (`mergeConcurrent`): per-item tombstones as data, newer item wins per key, unions, `turnCount` max. Applied to copies, installed in place. | grow-only: phrases **unioned**, `forgetAllAt` = later |
| Deletion | `deleteMind` → tombstone. **New rule:** an owner re-created after deletion keeps only items learned at or after it (`pruneMindBefore`). A deletion pending when the person keeps chatting is not cancelled by the new write. | `purgeOwner` → tombstone; only later redactions survive |
| Not ready | owner loaded per request/job; LRU eviction of clean owners | **fails closed**: an unloaded owner's matcher redacts everything, so recall quotes nothing rather than something the person asked to forget |
| Found | A process holding a pre-deletion copy that *touches* it after the deletion (`touchMind` stamps `updatedAt = now`) brought the deleted facts back. The current JSON path has the same weakness (`mergeForFlush` compares owner timestamps). Fixed for partitions by the item-level prune. **The JSON path is unchanged.** | — |
| Tests | `mind/tests/mindPartitions.test.js` (12): concurrent facts from two processes both kept; newer correction wins everywhere; deleted fact not resurrected; account deleted then talking again; stale process cannot resurrect a deleted mind; only the requested owner loaded; bounded memory (cap 3 → evicted owners reload intact); rollback copy. Redactions: concurrent forgets both hold; fail-closed; purge vs stale copy. | |

### 3.3 Conversations: revision-based message model (step 3)

`memory/conversationPartitions.js`, wired into `memory/conversationStore.js`. **One changed message never rewrites the conversation.**

| Requirement | Implementation | Test |
|---|---|---|
| Stable message IDs | New messages carry `mid` = `1-<ts36>-<seq>-<rand>`. Migrated ones are keyed by position, `0-000042`, and keep their migration ordinal. Off mode adds no field. | default test checks the message keys are unchanged |
| Independent insertion | one INSERT per message row; two instances never contend | 2 processes × 15 concurrent appends + 1: **31/31 kept, no duplicates, per-writer order kept, every message row at version 1 (never rewritten)** |
| Versioned edits | `editMessage(conv, key, patch)` writes one row, checked against the held version; `rev` + `editedAt` | exactly one message row changes |
| Explicit conflict detection | concurrent edit → `{ ok: false, conflict: true, current }` | two concurrent edits: one lands, the other is told and shown the winner |
| Deletion tombstones | `deleteMessage` → tombstone; `clearConversation`/`purgeConversation` → header tombstone + **every** message row of the conversation in the database, including rows this instance never saw | stale edit of a deleted message refused; rows written by another instance are retired too |
| Safe concurrent insertion | retry after a lost acknowledgement recognises its own row (idempotent); a different row under the key → re-key, never overwrite | idempotent-retry test |
| Ordering | ordinal (migrated), then key (time, then per-process sequence) | migrated history + new messages in order; export equals what the app shows |
| Metadata | header re-applies only the meta **fields** this process changed (title from one tab, pin from another: both kept); a header deleted elsewhere wins | concurrent title + pin |
| Isolation | header and messages owned by `user:<meta.userId>`; another user's conversation is neither loaded nor accessible | isolation test |

The partition layout for `.aqua-history.json` is now message-level (header + rows). The Phase 2a migration, reconcile and export tooling therefore works per message.

Tests: `memory/tests/conversationPartitions.test.js` (12).

### 3.4 Reasoning graph and identity map (step 4)

These are the two stores the audit found **both processes write with no merge** (S6). The same race on the JSON path keeps one side.

| | Reasoning graph | Identity map |
|---|---|---|
| Writers | file enrichment, ingest, reflection apply (server); `ensureSelfEntity` (worker) | resolution (server); `ensureSelfEntity` (worker) |
| Merge | nodes/edges unioned by id; edge in both → confidence/peak/observations/`lastConfirmedAt` max, evidence + sourceFiles unioned, history merged by time (capped) | per entry: norms + refs unioned (capped), fuller canonical, newer kind, min/max timestamps |
| Deletion | `removeFile` → file tombstone (`removedFiles`) travelling with the graph. A link survives only if made after the removal (`byFile.at`, recorded only with the flag on). Purge → row tombstone; only later items survive. | purge → row tombstone; only later entries survive |
| Tests | `reasoning/tests/graphIdsPartitions.test.js` (6): **S6 race, nothing lost**; removed file stays removed though the other process held it; purge vs stale process; pure merges | |

---

## 4. Writer ownership and merge strategy: every store

### 4.1 Integrated

§3, for these stores: reflection, Mind, recall redactions, conversations (`history`), reasoning graph, identity map (`ids`).

### 4.2 Remaining (designed, **not yet implemented**)

| Store | Writers | Proposed merge / ownership | Blocker or note |
|---|---|---|---|
| `evidence` | file pipeline, propagation, reflection apply (server) | per evidence item newest-wins; item tombstones for retire/forget | needs item-level timestamps audited |
| `uko` (owners section) | upload / file pipeline (server) | per owner map of ukoId: union + removal tombstones (like graph files) | — |
| `uko` (content cache) | same | one row per content hash, **first writer wins** (insert expected-version 0; a conflict means the same derived payload exists). Global cap by a periodic prune. **Not** instance-partitioned: a contention point only for identical uploads. | §5 |
| `fileindex` | file pipeline (server) | derived from uko: per-owner last-writer-wins + rebuild on conflict | rebuildable, low risk |
| `attachments` | upload, chat (server) | rows under the **conversation's** owner (`user:<id>`), union by attachment id | owner must be resolved from the conversation at write time; the migration needs that join |
| `pic` | post-turn consolidate (server) | lifecycle per subject by latest transition; versions append-only union; signals per fact newest-wins | — |
| `brain` annotations | reflection apply (server) | per entity annotation, latest wins | — |
| `vectors` | embedding, recall (server) | one row per namespace (`<owner>`, `files:<owner>`, `recall:<owner>`): several partitions per owner, so the multi-row binding (like conversations); union by item hash, cap 500 | — |
| `projects`, `index` | project routes (server) | per workspace, owned through Mongo `Bundle.userId`; load at request entry by workspace id after the access check | owner not in the value |
| `artifacts` index + manifests + binaries | artifact engine (server) | index rows per artifact (owner = `ownerId`); manifest version CAS replaces the in-process `withVersionLock`; binaries → object storage | Phase 4 (GCS). Binaries are not mirrored today (audit S3). |
| `history-trash` | conversation deletion (server) | per item (`t:`) rows owned by the user, append-only; purge per user | in `on` mode it is still a local JSON file |
| `identity-overrides` | admin | single global row, CAS, rare | — |
| `cognition`, `ledger` | every turn (server) | instance-partitioned aggregates (§5): **module implemented and tested, not wired** | wiring needs the stores' reads to use the aggregated view |

---

## 5. Global rows: instance partitioning (step 5)

**Investigation.** Measured in Phase 2a: with 30% of writes on one row, optimistic CAS lost nothing, but p99 reached 1.7 s and the worst case 15.8 s. Of the three hot rows:
- `cognition` and `ledger` hold counters + EWMAs per task type. These are adaptive strategy priors, **not user data**.
- The uko cache is keyed by content hash. Rows are already per hash, so contention exists only between identical uploads. Instance partitioning is unnecessary there; first-writer-wins per hash is correct (§4.2).

**Design (`core/storage/instanceAggregate.js`, implemented):**
- Each instance writes **only its own row**, `~inst:<id>`: its deltas, applied with a sequence number, plus a heartbeat.
- `read()` = base `~agg` + Σ live instance rows.
- `fold()` adds an expired instance row (heartbeat older than the TTL) to the base and tombstones it **in one transaction**, both version-checked.

| Required | How | Test (real Postgres) |
|---|---|---|
| No contention | single writer per row | 16 instances × 10 publishes at once: exact totals; publish p50 20 ms, p99 259 ms (in-process, one pool) |
| Deduplication | per-row sequence: a delta already applied is skipped; a publish with an unknown outcome is re-sent with the **same** sequence | lost acknowledgement: not applied twice |
| Instance expiry | heartbeat + TTL; an idle live instance keeps its row with heartbeats | idle instance not folded |
| Exactly-once fold | base update + instance tombstone commit together, CAS | two folders at once: each row folded once |
| Recovery | a restarted process is a new instance; a slow instance whose row was folded continues in a new generation row | late publish after fold: no double count |
| Deterministic merge | `addAggregates`: counters sum, `*At` take the later, EWMAs combine as sample-weighted means: commutative and associative | pure tests |

**Not for authoritative state.** The EWMA combination is deterministic, but it *approximates* a single process's recency-weighted EWMA. It is used for heuristics only. A crash loses at most the deltas since the last publish.

---

## 6. Migration and reconciliation (step 6)

**Tooling (implemented):** `aqua/scripts/partition-migrate.mjs --db <url> --store <name> --from <file|pg-blob> --mode dry-run|apply|reconcile|export`.
- The database comes **only** from `--db`. Non-local hosts are refused without `--allow-remote`. It never reads `.env` and never imports `dataDir.js`.
- `apply` never overwrites.
- `export` refuses to overwrite a file without `--force`.
- Every run is recorded in `aqua_store_partition_runs`.

**Matrix** (`core/tests/storeMigrationMatrix.test.js`, real Postgres). For each integrated store, using 120 owners (40 conversations × 6 messages for history):

| Check | reflection | mind | redactions | history | graph | ids |
|---|---|---|---|---|---|---|
| dry-run writes nothing | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| apply inserts every partition; per-owner row counts = source | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| reconcile clean: counts **and** canonical SHA-256 = source | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| export deep-equals source | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| re-run idempotent (0 inserted, 0 duplicates) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| rollback: exported file served by a real process with the flag off | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| concurrent writes | §3.1 | §3.2 | §3.2 | §3.3 | §3.4 | §3.4 |
| deletions | §3.1 | §3.2 | §3.2 | §3.3 | §3.4 | §3.4 |

**Interrupted migration:** the CLI was SIGKILLed during `apply` on about 12,400 history rows.
- It stopped part-way, at a multiple of 200 rows: no half-written batch.
- The re-run inserted exactly the rest: `inserted + identical = expected`, 0 conflicts.
- Final row count = expected. Reconcile clean.

**No data loss or duplication found** in any run: per-owner counts, canonical hashes, and the id-level checks in the contention runs.

---

## 7. Performance (this machine; storage path only)

Windows 11 laptop, PostgreSQL 16.15 in Docker (local socket), Node v24.19. One run each. Raw JSON is in `aqua/eval/out/scalability/` (gitignored).

**Request path** (`aqua/scripts/phase2b-bench.mjs`). One heavy owner (50 conversations × 40 messages = 2,000 messages, 200 Mind facts, reflection state) among 2,000 other owners. Reflection, Mind and history `on`:

| Measure | Result |
|---|---|
| First load of the owner (cold) | 130 ms, 2,052 rows |
| Re-check per request, nothing changed | p50 19.6 ms, p95 30.5 ms (version query only, no data) |
| Re-check after one message from "another instance" | 23.9 ms, **1 row fetched** |
| `addMessage` + flush | p50 6.5 ms, p95 11.3 ms |
| Bytes written per appended message | **401 B** (whole-file path today: **788,154 B**) |
| Process RSS | 126 MB |

**Storage layer under contention** (Phase 2a, unchanged): 32 OS processes, 6,400 updates, 0 lost, 0 duplicates. Details are in the plan document §6.

---

## 8. Test evidence

New suites, all against the disposable Postgres, all passing in one parallel run (**278/278**, including the affected existing suites):

| Suite | Tests |
|---|---:|
| `core/tests/partitionLayout.test.js` | 39 |
| `core/tests/partitionRepository.test.js` | 15 |
| `core/tests/partitionMigration.test.js` | 10 |
| `brain/tests/reflectionPartitions.test.js` | 16 |
| `mind/tests/mindPartitions.test.js` | 12 |
| `memory/tests/conversationPartitions.test.js` | 12 |
| `reasoning/tests/graphIdsPartitions.test.js` | 6 |
| `core/tests/instanceAggregate.test.js` | 7 |
| `core/tests/storeMigrationMatrix.test.js` | 8 |
| **Total new** | **125** |

The suites that write real store keys serialize on a Postgres advisory lock (`acquireStoreKeyLock`). Without it the parallel runner let one suite's cleanup delete another's rows (observed once, fixed).

**Bite (Phase 2b), each mutation applied, verified, reverted byte-identically:**

| Mutation | Failing tests |
|---|---:|
| binding ignores the other side (last writer wins) | 6 |
| binding keeps stale items after a deletion | 1 |
| unloaded owners treated as ready | 1 |
| `markDirty` cancels a pending deletion | 1 |
| reflection watermark merge takes the smaller | 4 |
| redactions fail open when not loaded | 1 |
| message edit without a version check | 1 |
| insert retry re-keys instead of recognising its own row | 1 |
| conversation delete skips rows it never saw | 1 (0 at first: a test was added) |
| graph keeps links older than a removal | 2 |
| aggregate publish without sequence dedupe | 1 |
| aggregate fold without the instance tombstone | 2 |
| *(reverted)* | **0** |

**Regression** (`src/core src/reasoning src/brain src/identity src/memory src/mind src/files src/routes src/cognition src/intelligence src/pic src/upload src/understanding src/account`): 4,516 tests, 4,498 pass, 6 skipped. 5 failures:
- `flushStorage` returned a non-zero value without an adapter flush: **mine, fixed**.
- No read-site probe existed for the new gate: **mine, fixed** (`flagReadSiteParity` 71/71 after both).
- `temporalState.live.test.js` (2 tests): **pre-existing, date-dependent.** Its script says "from next month" and pins 2026-11-01, which is now in the past.
- `repoHygiene` flags two Nov-2 files `aqua/eval/out/contexts.before-profile.*.json`: **pre-existing**, left untouched.

---

## 9. Known limitations

1. **Not enabled anywhere.** No store has run `on` with real traffic. The dev launcher has not run with the flag on.
2. **Write-behind window.** Partition writes are debounced (250 ms, history 50 ms) and drained on SIGTERM (≤5 s). A crash loses at most that window, the same order as today's 500 ms JSON debounce. `flushMind` (propagation, off by default) and redactions start the write immediately but cannot await it synchronously.
3. **Clocks.** Tombstone decisions compare application timestamps with the database's `now()`. Clock skew between hosts shifts the "after the deletion" boundary by the skew.
4. **Orphan message rows.** A message appended by an instance *after* another instance finished deleting the conversation is written as a live row under a tombstoned header. It is invisible to the app and to exports, and removed by an account purge. A cleanup job is **not implemented**.
5. **Per-request cost grows with the owner's row count** (versions query: 19.6 ms p50 at 2,052 rows). An owner-level change counter would make it constant: **not implemented**.
6. **Whole-store enumeration in `on` mode sees loaded owners only:** `listOwners`, `mindStats`, `getAllConversations`, the propagation sweeper.
7. **Pre-login Mind adoption** (`conv:` → `user:`) needs the `conv:` owner loaded; the router loads only `user:<id>`.
8. **Shadow mode does not fix S6:** the JSON file stays authoritative. Only `on`/`only` do.
9. **The rollback copy** in `on` mode is merged into the on-disk file per process (the same read→rename window `mindStore` has today). The lossless rollback is `export`.
10. **Not tested:** Cloud SQL, network latency, failover, connection poolers, Linux. Everything here ran on one Windows machine.

---

## 10. Rollback instructions (per store, nothing to undo by default)

| From | Step | Data |
|---|---|---|
| `shadow` | Remove the store from `AQUA_STORE_PARTITIONS`; restart. | JSON was authoritative throughout. Partition rows can stay (inert) or be deleted by `store_key`. |
| `on` | Remove the store from the flag; restart. | The JSON rollback copy is current within the debounce. **Before** restarting, run `partition-migrate --mode export --out <file>` and `--mode reconcile --from <that file>` as the record of what the partitions held. Any rows newer than the copy can be re-applied from that file. |
| `only` | `partition-migrate --mode export --out <data dir>/.aqua-<store>.json` (with `--force` over the stale file), check it with `--mode reconcile`, then remove the flag and restart. | export = partitions, deletions included (tested). |
| Schema | Migrations 0026 are additive; nothing reads the tables with the flag off. | `DROP TABLE` is optional. |

On Render, the JSON files are restored from the Mongo mirror at boot. In `on` mode the binding writes the rollback copy through the same debounced writer, so it reaches the mirror as today.

---

## 11. Phase 3 preparation

Design only, not activated: [AQUIPLEX_PHASE_3_API_WORKER_DESIGN.md](AQUIPLEX_PHASE_3_API_WORKER_DESIGN.md).
