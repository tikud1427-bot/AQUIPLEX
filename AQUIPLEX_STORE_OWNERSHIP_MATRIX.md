# AQUIPLEX — Store Ownership Matrix

**Date:** 2026-11-14 · **Scope:** every persistent store of the AQUA engine (Phase 2c, step 1) · **State:** uncommitted working tree on `main`. Production is untouched.

How to read the columns:
- **Readers / Writers:** the modules that read or write the store. "Server" means the API process. "Worker" means the durable job worker (`aqua/scripts/worker.mjs`).
- **Today:** the whole-file JSON store, plus the Mongo `aqua_kv` mirror on Render.
- **Partitioned:** behaviour with `AQUA_STORE_PARTITIONS=<store>:on`.
- **Concurrency:** what happens when two processes change the same owner's data at once, with partitions on.
- **Deletion:** how a deletion survives a process that still holds the old data.

Status labels follow [AQUIPLEX_SCALABILITY_AUDIT.md](AQUIPLEX_SCALABILITY_AUDIT.md) §0. Every store below is **Implemented** and **Tested against a real database** with real processes. The tests are listed in [AQUIPLEX_PHASE_2C_REPORT.md](AQUIPLEX_PHASE_2C_REPORT.md) §4. None is enabled anywhere outside the test database.

---

## 1. Owner data

| Store (flag name) | Implementation (partitioned) | Readers | Writers — server | Writers — worker | Concurrent writes | Deletion | Partitioning needed? | Migration · rollback |
|---|---|---|---|---|---|---|---|---|
| **reflection** `.aqua-reflection.json` | `ownerBinding`, row `o:<owner>` | Brain revision voice, reflection V2 | `markSurfaced` (request), `saveReflectionState` (post-turn) | — (post-turn runs on the server) | field merge: watermark = max; snapshot + its time travel together from the newer reflection | `forgetReflectionState` → tombstone, ordered by the database | yes: two writers | migrate CLI; rollback = drop flag (JSON copy kept current) |
| **mind** `.aqua-mind.json` | `ownerBinding`, `o:<owner>`; LRU of clean owners | memory engine, context engine, chat, Memory UI, reflection V3 | memory engine, Mind post-turn, Memory UI, propagation | reflection V3 belief projection (`touchMind`) | existing per-item merge (`mergeConcurrent`): newer item wins per key, unions, item tombstones | `deleteMind` → tombstone; a re-created mind keeps only items learned after the deletion | yes: server **and** worker | same |
| **recall-redactions** | `ownerBinding`, `o:<owner>` | episodic recall | Memory UI forget/correct, propagation | — | grow-only union; `forgetAllAt` = later | account purge → tombstone; **fails closed** when not loaded (quotes nothing) | yes: privacy record | same |
| **history** `.aqua-history.json` | `conversationPartitions`: header `c:<conv>` + one row per message `m:<conv>:<key>` | chat, conversations routes, episodic recall, understanding routes, upload | chat, conversation routes, upload | — | message insert = independent row, guarded by a share lock on a live header; edits version-checked (explicit conflict); meta merged per field | conversation delete = one transaction: header + **every** message row, waiting for in-flight inserts | yes: hottest store | migrate CLI (message-level layout); rollback = drop flag |
| **history-trash** | rows `t:<time>:<conv>` per user (cap 40) | account purge only | conversation delete | — | append-only, unique keys | account purge → tombstones by prefix | yes, when history is partitioned (was one file for all users) | rows created going forward; old file stays as the archive |
| **reasoning-graph** | `ownerBinding`, `o:<owner>` | context engine, reasoning, Brain | file enrichment, ingest, reflection apply | `ensureSelfEntity` (`upsertNode`) | union of nodes/edges; edges merge confidence/evidence/history | file removal travels as a file tombstone; links newer than the removal survive; purge → tombstone | yes: server **and** worker (audit S6) | same |
| **ids** `.aqua-ids.json` | `ownerBinding`, `o:<owner>` | entity resolution, understanding | resolution | `ensureSelfEntity` (`putEntry`) | grow-only per entry: norms/refs union, fuller name, newer kind | purge → tombstone; only later entries survive | yes: server **and** worker (S6) | same |
| **brain** (annotations) `.aqua-brain.json` | `keyedBinding`, three-way, `o:<owner>` | world-model projection, Brain routes | reflection apply, Memory UI | — | three-way per annotation; double edit → newer `updatedAt` | `removeAnnotation` attributed against the base; purge → tombstone | yes: several API instances | migrate CLI; rollback = drop flag |
| **evidence** | `keyedBinding`, three-way, `o:<owner>` | Brain, memory engine, PIC, context | file pipeline, memory engine, propagation, PIC consolidation, reflection archive | — | three-way per fact/evidence; link sets merged then dangling ids dropped; `byChecksum` rebuilt | `removeFile` and eviction attributed against the base; purge → tombstone | yes | same |
| **uko** (owners section) | `keyedBinding`, `owners:<owner>` | file engine, PIC, observe ingest | upload / file pipeline | — | three-way per uko | `removeUKO` against the base; purge → tombstone | yes | same |
| **uko** (content cache) | **process-local, per owner, not persisted** | file engine | file engine | — | none (not shared) | purged with the owner, evicted with the owner | **no.** A parse cache: sharing it would create a global hot row and keep a deleted user's parsed content in other instances' memory | nothing to migrate; a cold cache only re-parses |
| **fileindex** | `keyedBinding`, `o:<owner>` | file search | enrichment pipeline | — | three-way per file; lanes as id sets filtered to live files | three-way; purge → tombstone | yes (derived, but per owner) | same |
| **attachments** | `keyedBinding`, `c:<conv>`, **owned by the conversation's user** | chat, episodic recall, conversations | upload, chat, file engine, conversation delete | — | three-way list by attachment id | `removeAttachment` against the base; `clearAttachments` → tombstone | yes | migrate with `--history` (owner join); unresolved counted |
| **pic** | `keyedBinding`, `o:<owner>` | PIC, Brain routes, reflection V2 | consolidation, lifecycle, feedback, versions, ledger | — | lifecycle per subject by latest transition; version histories unioned; **ok/bad counters add both sides' increments**; logs unioned and capped | purge → tombstone | yes | same |
| **vectors** | `keyedBinding`, `ns:<namespace>`, owner from the namespace (`<o>`, `files:<o>`, `recall:<o>`, `canonical-claims:<o>`, `ws:<id>` → workspace owner) | semantic memory, recall, file memory, project semantics, canonical semantic lane | the same modules | — | three-way per vector id; cap 500 newest | `remove` against the base; `clearNamespace` → tombstone | yes | migrate with `--projects` for `ws:` namespaces |
| **projects** | `keyedBinding`, `ws:<id>`, owner = `workspace.ownerId` | project routes, unified upload | same | — | three-way per top-level field (a double change keeps ours, counted) | `deleteWorkspaceData` → tombstone | yes | migrate with `--projects`; ownerless legacy workspaces are reported (backfill first) |
| **index** (project sources) | `keyedBinding`, `ws:<id>`, owner via the workspace | project retrieval, edits, chat | ingestion, summary sync | — | whole value (a re-ingest replaces it) | `clearIndex` → tombstone; derived index rebuilt, never stored | yes | same |
| **artifacts** | `keyedBinding`, `a:<id>` (index entry + manifest), owner = `ownerId`; **binaries in the object store** (`aqua_objects`, GCS in Phase 4) under a unique per-version directory | artifact routes, edit engine, chat | engine, edit engine, routes, account purge | — | every mutation is a version-checked **commit**: concurrent edits get distinct version numbers | delete = tombstone + all objects removed; prune removes the pruned versions' objects | yes: binaries were instance-local and not mirrored (audit S3) | rows created going forward; existing artifacts keep the local path until exported (see report §8) |

## 2. Global (not owner) data

| Store | Implementation | Writers | Why not per owner | Concurrency | Partitioning needed? |
|---|---|---|---|---|---|
| **cognition** `.aqua-cognition.json` | `instanceAggregate`: each instance writes only `~inst:<id>`; total = base + live instances | every turn (server) | strategy priors, not user data | none: one writer per row; counters exact, EWMAs sample-weighted (approximate) | instance-partitioned, **not** owner-partitioned |
| **ledger** `.aqua-ledger.json` | same | every turn (server) | routing statistics | same | same |
| **identity-overrides** | unchanged (JSON) | **none at runtime.** `updateIdentityProfile(persist)` has no caller | static configuration | n/a | **no** |
| Mongo mirror marker `.mirror-sync.json` | unchanged | mirror | local lineage by design | n/a | no; the mirror is retired per store when partitions are `only` |

## 3. Data outside the JSON stores (unchanged, already multi-instance safe)

| Data | Store | Owner model | Concurrency |
|---|---|---|---|
| users, wallet, payments, billing, sessions | Mongo | user | atomic updates / connect-mongo |
| canonical World Model (claims, entities, revisions, embeddings) | Postgres (0005–0025) | `owner_id` | transactional |
| durable jobs, outbox, commit ledger | Postgres | `owner_id` | `SKIP LOCKED`, per-owner ordering, idempotency keys |
| scheduler leases | Postgres (0029) | scheduler name | conditional upsert on database time |
| platform uploads (`public/uploads`) | local disk | — | **not addressed** (tool logos, APK): Phase 4 object storage |

## 4. Unresolved writer conflicts

None among the stores above, **with partitions on**:
- Every store that more than one process writes has a defined merge or a single-writer row design.
- Every deletion is either ordered by the database or attributed against a base.

Three accepted approximations are stated rather than hidden:
1. **EWMA combination** in cognition and ledger is a sample-weighted mean, not the exact single-process recency-weighted value. These stores are heuristics only.
2. **Double edits on the whole-value stores** (projects, index): a concurrent change to the *same* field on two instances keeps ours, and the conflict is counted. This is not a silent loss of different fields, which are merged.
3. **Same-item edits** resolved by "newer wins" compare item timestamps written by different hosts. Deletions do **not** depend on clocks, but this tie-break does, within normal NTP skew.

**With partitions off or in shadow**, the original whole-file behaviour applies, including the audit's S6 race. That is why multi-instance deployment requires every owner store to be `on` (see [AQUIPLEX_PHASE_3_READINESS_REPORT.md](AQUIPLEX_PHASE_3_READINESS_REPORT.md)).
