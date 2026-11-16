# AQUIPLEX — Scalability Architecture Audit

**Date:** 2026-11-13 · **Scope:** Phase 1 of the production scalability project · **Code state:** `main` @ `839ea0d1` plus the uncommitted working tree.

This audit is read from the code. It is not read from Render. Nobody has read the Render service settings, environment, or logs during this work. Every statement about production is marked:

- **V**: verified in code or by a test run in this repository.
- **I**: inferred from code and earlier audits, not observed in production.
- **U**: unknown until someone reads the Render dashboard.

Status vocabulary (used in every document of this project):

| Label | Meaning |
|---|---|
| **Implemented** | Code exists on the branch. |
| **Tested locally** | Unit or integration tests pass on a developer machine (pg-mem, fakes, or files). |
| **Tested against a real database** | Tests pass against a real PostgreSQL 16 server (the disposable `aqua-test-db`), not pg-mem. |
| **Tested under concurrent load** | Several processes or connections ran against a real database at the same time, with measured results. |
| **Not yet implemented** | Nothing exists yet. |

---

## 1. Summary

1. **Production is one process on one disk (I).** Without `DATABASE_URL`, `aqua/scripts/worker.mjs` exits with code 1, and `start-production.mjs` then stops the server too. Production therefore runs `node index.js` as a single process ([AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md) §inferred topology; [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md): "production currently serves the legacy read"). The start command is **U**.
2. **User memory, conversations and files live in 18 whole-file JSON stores (V).** Each store holds every owner in one in-memory `Map`, loaded completely at boot and rewritten completely on every flush. On Render, durability comes from the Mongo `aqua_kv` mirror, which copies the whole file and is restored at boot (V, code; I, production).
3. **A second API instance today means divergence, not just slowness (V).** Each instance keeps its own copy of every store in memory. The mirror lets exactly one host write (lease plus generation compare-and-swap). The second instance's writes stay queued and are never mirrored. Its users' changes exist only on its own disk and disappear at the next deploy. **AQUIPLEX cannot scale horizontally until those 18 stores move to per-owner rows.** That is Phase 2.
4. **The Postgres blob adapter is not per-owner storage (V).** `aqua_store_blobs` holds one row per store *file*. One fact changed still rewrites the whole file: measured at 858 ms and 6 MB per write at 5,000 owners ([E3_SCALING_FINDING.md](E3_SCALING_FINDING.md)). It added durability and conflict detection. It did not add scale. It is shadow-only (`AQUA_STORE_PG=shadow`) and is believed to be off in production (I).
5. **The canonical World Model and the job queue are already per-owner and multi-instance safe (V).** Claims, entities, the outbox, the commit ledger and `aqua_jobs` are owner-keyed Postgres tables. The job claim enforces per-owner ordering with `FOR UPDATE SKIP LOCKED` (`jobQueue.js:claim`). This part is Cloud Run-ready in shape. It is **not** what production serves today (I).
6. **Process-local state that blocks scaling** (details in §4): the 18 in-memory stores, artifact binaries and manifests on local disk (**not mirrored at all**), `public/uploads` on local disk, provider key cooldowns, the in-process post-turn job registry, and per-instance rate limits unless Redis is configured.
7. **Cloud Run specific (V, code; Cloud Run behaviour is documented platform behaviour):** post-turn understanding work runs *after* the response (`setImmediate` through `jobRegistry.defer`), and stores flush on a 500 ms debounce. With request-based billing, Cloud Run throttles CPU outside requests, so both would stall. The API must use instance-based billing ("CPU always allocated") until post-turn work moves fully to the worker.

---

## 2. Production data paths (as the code runs with production's inferred env)

Inferred env: `NODE_ENV=production`, `MONGO_URI` set, `RENDER=true`, no `DATABASE_URL`, no `AQUA_STORE_PG`, no `AQUA_RATE_LIMIT_REDIS_URL` (I; the last is **U**).

```
browser / Android WebView
   │  HTTPS (Render edge)
   ▼
index.js  (one Node process, CJS)            trust proxy=1, helmet, express-rate-limit (memory)
   ├── express-session ── connect-mongo ────────────────► Mongo: sessions          (shared, TTL)
   ├── passport / auth / billing / wallet ──────────────► Mongo: users, payments, transactions, …
   ├── multer diskStorage ──────────────────────────────► ./public/uploads        (LOCAL, ephemeral)
   └── /api/aqua + /v1 ──► aqua/router.js (ESM, dynamic import, same process)
          ├── chat turn  → 18 in-memory store Maps ──debounced 500 ms──► DATA_DIR/*.json (LOCAL)
          │                                                     └─mirrorWrite─► Mongo aqua_kv (whole file, chunked)
          ├── post-turn  → jobRegistry.defer (in-process, setImmediate); no durable queue without DATABASE_URL
          ├── artifacts  → DATA_DIR/.aqua-artifacts/<id>/{manifest.json,v*/files}   (LOCAL, NOT mirrored)
          └── boot       → dataDir.js top-level await hydrateFromMongo(DATA_DIR) before any store loads
```

When `DATABASE_URL` is set (dev, test, and the launcher used by the evals), the following are added: canonical World Model reads and writes, the durable `aqua_jobs` queue, the outbox, and the separate worker process that shares `DATA_DIR` with the server.

---

## 3. Dependency map — every persistent store

Column key:
- **Owner model**: what the top-level key is.
- **Write path**: how bytes leave the process.
- **Read path**: how they come back.
- **Concurrency assumption**: what must hold for it to be correct.
- **Migration status**: where it stands today.

### 3.1 JSON stores (`aqua/src/**`, through `core/atomicStore.js`)

Every store below follows the same pattern unless a row says otherwise:
- **Write:** module `Map` → `createDebouncedWriter` (500 ms, temp file then rename) → `DATA_DIR/<file>` → `mirrorWrite` → Mongo `aqua_kv`.
- **Read:** `loadJsonFile` once at import, served from memory afterwards.
- **Boot:** `hydrateFromMongo` restores the file first.
- **Concurrency assumption:** exactly one writer process per file. The mirror's host lease enforces one *host*. Within one host, only `mindStore` merges with a second process.

| Store file | Module | Owner model (top-level key) | Notes | Migration status |
|---|---|---|---|---|
| `.aqua-history.json` | `memory/conversationStore.js` | `conversationId` → `{messages, meta.userId}` | **Largest hot store.** Every chat turn writes it. Listing a user's conversations scans every conversation (`listConversationIdsForUser`). Up to 5,000 messages per conversation. | blob shadow only |
| `.aqua-history-trash.json` | `memory/conversationStore.js` | list of deleted conversations | Written with `atomicWriteFileSync` (blocks the event loop). | blob shadow only |
| `.aqua-mind.json` | `mind/mindStore.js` | `ownerId` (`user:<id>` / `conv:<id>`) | **Only store with a cross-process merge** (dirty owners, per-item tombstones, `deletedOwners` in the envelope). | blob shadow only |
| `.aqua-evidence.json` | `files/evidenceStore.js` | `ownerId \|\| 'anon'` | The 2.9 MB store in the E3 measurement. | blob shadow only |
| `.aqua-uko.json` | `files/ukoStore.js` | `{owners: ownerKey → ukoId → uko, cache: contentHash → payload}` | Two sections. The `cache` section is **global** (deduplication by content hash, shared across owners). | blob shadow only |
| `.aqua-fileindex.json` | `files/fileSearchIndex.js` | `ownerId` | | blob shadow only |
| `.aqua-attachments.json` | `upload/attachmentStore.js` | `conversationId` → extracted text | The owner is reachable only through the conversation. | blob shadow only |
| `.aqua-vectors.json` | `embeddings/vectorStore.js` | `namespace` (`<ownerId>`, `files:<ownerId>`, or a workspace) | Raw float arrays. Capped at 500 items per namespace. | blob shadow only |
| `.aqua-pic.json` | `pic/picStore.js` | `ownerId \|\| 'anon'` | | blob shadow only |
| `.aqua-reasoning-graph.json` | `reasoning/reasoningGraph.js` | `ownerId \|\| 'anon'` | **The worker writes it too** (`ensureSelfEntity` → `graph.upsertNode`) and there is **no cross-process merge**. | blob shadow only |
| `.aqua-ids.json` | `brain/identity/idStore.js` | `ownerId \|\| 'anon'` | **The worker writes it too** (`idStore.putEntry`) and there is no merge. | blob shadow only |
| `.aqua-brain.json` | `brain/worldModel/annotationStore.js` | `ownerId \|\| 'anon'` | | blob shadow only |
| `.aqua-reflection.json` | `brain/reflectionV2/reflectionStore.js` | `ownerId` | | blob shadow only |
| `.aqua-recall-redactions.json` | `memory/recallRedactions.js` | `ownerId` | A privacy record: user-requested recall removals. Losing a write re-exposes content. | blob shadow only |
| `.aqua-projects.json` | `project/projectMemory.js` | `workspaceId` | The owner is in Mongo (`Bundle.userId`), not in the value. | blob shadow only |
| `.aqua-index.json` | `project/projectIndex.js` | `workspaceId` → source files | Multi-MB ("largest store", per its own header). | blob shadow only |
| `.aqua-cognition.json` | `cognition/cognitiveStore.js` | **global** `{byTask}` running averages | Not owner data. | blob shadow only |
| `.aqua-ledger.json` | `intelligence/learningLedger.js` | **global** `{byTask}` running averages | Not owner data. | blob shadow only |
| `.aqua-artifacts/.index.json` | `artifacts/artifactStore.js` | `artifactId` | The index is mirrored. **Manifests and binaries are not** (see §3.2). | blob shadow only |
| `.aqua-identity-overrides.json` | `identity/identityLoader.js` | global config | `atomicWriteFileSync`. | — |
| `.mirror-sync.json` | `core/mongoMirror.js` | mirror lineage marker | Local only, by design. | n/a |

### 3.2 Files and binary objects

| Data | Location | Durable on Render? | Notes |
|---|---|---|---|
| Artifact binaries + `manifest.json` | `DATA_DIR/.aqua-artifacts/<id>/` (or `AQUA_ARTIFACTS_DIR`) | **No (I).** They are written with `fs.promises.writeFile` and `atomicWriteFile`, neither of which mirrors. Only `.index.json` goes through the debounced writer. | After a redeploy, the index lists artifacts whose files are gone, unless Render has a persistent disk (**U**). This is a probable live defect, independent of scaling. |
| Platform uploads (`multer.diskStorage`) | `./public/uploads` | No (I) | Tool logos and the APK download path. |
| Chat file uploads (parsed text) | `.aqua-attachments.json`, `.aqua-uko.json` | Yes, through the mirror | Raw bytes are parsed in memory and not kept. |

### 3.3 MongoDB (`models/`, Mongoose)

| Collection | Owner model | Write path | Concurrency | Status |
|---|---|---|---|---|
| `users` (wallet, auth version, settings) | user `_id` | Mongoose; wallet debits are atomic `findOneAndUpdate` (V, earlier monetization work) | multi-instance safe | production |
| `payments`, `transactions`, `billinglogs`, `webhooklogs`, `entitlementaudits` | user | Mongoose, idempotent on the provider id | multi-instance safe | production |
| `sessions` | session id | `connect-mongo`, `touchAfter` 24 h | shared, multi-instance safe | production |
| `pendingsignups`, `nativeoauthcodes`, `productevents`, `bundles`, `tools` | user / global | Mongoose | safe | production |
| `aqua_kv` | **file**, not owner | `mongoMirror.js`: whole-file upsert, chunked at 10 MB, generation CAS, host lease | one writing host | production durability path (I) |

### 3.4 PostgreSQL (`aqua/src/core/db/migrations/0001–0025`)

| Table(s) | Owner model | Writers | Concurrency | Status |
|---|---|---|---|---|
| `aqua_store_blobs` (0002, 0004) | **per store file** | `pgBlobAdapter` via `dualWriteAdapter` (shadow) | optimistic `version` CAS; write-behind | Implemented, tested against a real DB (E3/PR-8); off in production (I) |
| `aqua_drift_runs` (0003) | — | `db/drift.js` | — | Implemented |
| entities, claims, belief/inferred claims, world model, embeddings (0005–0017, 0021–0022, 0025) | `owner_id`, with owner foreign keys (0011) and per-owner HNSW (0013) | `worldModelRepository`, `claimRepository`, `embeddingRepository` | transactional, owner-scoped | Implemented; not in production (I) |
| `aqua_jobs` (0007) | `owner_id` | `jobQueue.enqueue` (idempotent on owner + key), `claim` (`SKIP LOCKED` + per-owner `NOT EXISTS`) | N workers | Implemented, tested against a real DB |
| outbox, commit ledger, migration runs, process metrics, proactive interventions, action runs (0009, 0010, 0018–0020, 0023, 0024) | `owner_id` | worker, server | transactional | Implemented |

### 3.5 Other shared or process-local state

| State | Where | Shared across instances? |
|---|---|---|
| Rate-limit windows (auth 10/15 min, engine 30/min, reads 300/min) | `utils/rateLimitStore.js` | Only with `AQUA_RATE_LIMIT_REDIS_URL`. Otherwise per process. Degrades to memory if Redis is unreachable. Tested against real Redis (2026-10). |
| Provider key cooldowns and rejections | `aqua/src/providers/keyPool.cjs` | No. Process memory, behind a synchronous `{get,set,…}` seam. |
| Post-turn deferred work | `core/jobs/jobRegistry.js` | No. Drained on SIGTERM (5 s cap). Lost on crash. |
| Durable jobs | `aqua_jobs` | Yes. |
| Mongo mirror writer lease | `aqua_kv` lock doc | Yes, by host. |
| Process metrics | `aqua_process_metrics` (worker → server `/metrics`) | Yes, with Postgres. |
| SSE chat stream | `routes/chat.js` (`text/event-stream`, heartbeat interval) | One request on one instance. No cross-instance fan-out is needed (V). No WebSockets in the product path (V). |
| Request id | generated per turn in `routes/chat.js`; logs carry `req=` | Per request. No inbound `X-Request-Id` / `traceparent` propagation at the platform layer. |
| Build id memo, trending tools | `index.js` | Per process, harmless. |

---

## 4. Process-local state that prevents horizontal scaling

Ranked by consequence.

| # | Finding | Evidence | Consequence with 2+ API instances | Fix phase |
|---|---|---|---|---|
| **S1** | 18 whole-file stores, every owner in memory, whole-file rewrite on each flush | §3.1; `writeShape.test.js` pins it | Each instance diverges. The non-leaseholder's writes are never mirrored and are lost at deploy. Memory grows with total users, not active users. | **2** |
| **S2** | The mirror is file-granular with a single writing host | `mongoMirror.js` lease + CAS | It prevents silent overwrite. It also prevents a second writer by design. | 2 (retire after cutover) |
| **S3** | Artifact files and manifests are on local disk and not mirrored | `artifactStore.js:149,181,307` | Lost on redeploy today. Invisible to other instances. | **4** (object storage) |
| **S4** | `public/uploads` on local disk | `index.js:520` | Lost on redeploy. Instance-local. | 4 |
| **S5** | Post-turn learning runs in-process after the response | `turnPostProcess.js` `d.defer`; `jobRegistry` | Lost on crash. Starved by Cloud Run CPU throttling. | 3 |
| **S6** | Server and worker both write `reasoning-graph` and `ids`, with no merge | `selfEntity.js:80,98` | Present-day last-writer-wins between two processes on one host whenever `AQUA_SELF_ENTITY` is on. | 2 (fixed by per-owner CAS) |
| **S7** | The worker's stores are loaded once at boot | `mindStore` merges at flush time only | The worker reads stale owner data written by the API. | 2 (per-owner version refresh) |
| **S8** | Provider cooldowns are per process | `keyPool.cjs` STATE STORE | N instances each pay the first 429. Free-tier quotas are shared per organisation, so N instances burn quota N times faster. | 4 |
| **S9** | Rate limits are per process without Redis | `index.js:163` | The effective limit multiplies by N. | 4 (configuration) |
| **S10** | Periodic schedulers: propagation sweeper (API, off by default); consolidation and proactive scans (every worker, deduplicated by idempotency bucket key) | `router.js:80`, `worker.mjs` loop | API: N instances sweep the same owners. Worker: safe, with redundant queries. | 3 |
| **S11** | No HTTP drain on SIGTERM | `atomicStore.hookShutdownOnce` calls `process.exit` after store/mirror/job drains. `index.js` never calls `server.close()`. | In-flight requests and SSE streams are cut at every instance stop. Cloud Run stops instances far more often than Render. | 4 |
| **S12** | `/health` is liveness only | `index.js:783` | No readiness signal: the store hydrate, Mongo and Postgres can all be down while it returns 200. | 4 |
| **S13** | Postgres pool `max=10` per process, with no budget | `pool.js:86` | 100 Cloud Run instances × 10 = 1,000 connections, beyond any small Cloud SQL tier. | 4/5 |

---

## 5. Reconciling the five engineering findings

| Document | Claim | Still true? |
|---|---|---|
| [E3_SCALING_FINDING.md](E3_SCALING_FINDING.md) | The blob substrate fails in the same 1k–10k user range as JSON. Per-owner rows measured 28 ms vs 858 ms at 5,000 owners. | **Yes.** The code is unchanged in shape. The 28 ms figure was a simulator floor; Phase 2 re-measures it on a real server. |
| [AQUA_STORAGE_SUBSTRATE.md](AQUA_STORAGE_SUBSTRATE.md) | E3 is complete against "two instances, zero data loss" **for the blob table** (version CAS). Migration advisory-lock exclusion has never run on a real server. | **Partly superseded.** CAS protects the shadow blob. It does not make the *authoritative* JSON path multi-instance safe, and production reads JSON. "Zero data loss with two instances" is **not** a production property. |
| [AQUA_JOBS.md](AQUA_JOBS.md) | PR-1: in-memory registry. Durable queue, retry and outbox are "next". | **Superseded by the code.** `jobQueue.js` (durable, idempotent, per-owner ordering, `SKIP LOCKED`, backoff, DLQ, `reapStale`), `dlqPolicy.js` and `workerRuntime.js` exist. The in-memory registry still carries the no-Postgres path. |
| [AQUA_SCALING_CORRECTION.md](AQUA_SCALING_CORRECTION.md) | `detectContradictions` is O(N²) pairs per owner (2.3 s at 1,200 facts). | **Open, and orthogonal to infrastructure.** It is per-owner CPU, so it scales out with workers but caps the size of a single owner. Tracked here as a worker-sizing input, not changed (rule 3: no intelligence changes). |
| [AQUA_RENDER_SHADOW_READINESS.md](AQUA_RENDER_SHADOW_READINESS.md) | A feature-flag rollout procedure on Render. Production config not verified. | Still applicable as the *pattern* for every Render change in this project: gates, abort criteria, rollback. |

---

## 6. Owner-isolation inventory (preserved by every later phase)

- Owner ids: `user:<mongoUserId>` for signed-in users, `conv:<conversationId>` before login, with adoption (`ownerResolver.resolveOwner` → `adoptMind`). The `'anon'` bucket exists in six stores.
- `req.aquaUserId` is set only after `requireLogin` (`index.js` `aquaAccess`). Every engine read is keyed by it.
- Conversations carry `meta.userId`. Attachments are keyed by conversation, so their owner is derived. Workspaces are owned through Mongo `Bundle.userId`.
- Account deletion: `jobQueue.purgeOwner`, `conversationStore.purgeTrashForUser`, and the per-store purge functions. A per-owner store must make purge a single owner-scoped operation (Phase 2 requirement).

---

## 7. What this audit could not establish (needs Render access)

1. The start command (`node index.js` vs `start:production`).
2. Whether a persistent disk is attached, and `AQUA_DATA_DIR`.
3. The instance count and plan (RAM governs the whole-store in-memory ceiling).
4. Production `aqua_kv` size per file (the real size of the 1k–10k ceiling).
5. Whether `AQUA_RATE_LIMIT_REDIS_URL`, `AQUA_STORE_PG` or `DATABASE_URL` are set.
6. The real user count.

Until these are read, capacity statements about production remain **U**. The procedure to read them without changing anything is in [AQUIPLEX_RENDER_MIGRATION_RUNBOOK.md](AQUIPLEX_RENDER_MIGRATION_RUNBOOK.md) §0 (to be written in Phase 7).

---

## 8. Implementation plan (phase order and exit criteria)

| Phase | Deliverable | Exit criterion (measured, not asserted) |
|---|---|---|
| **2a** | Owner-partitioned Postgres table + partitioned store (CAS, tombstones, bounded cache, owner-scoped load and purge) + lossless split/reassemble + migration and reconcile tooling. **No consumer wired.** | Against a real Postgres: two instances with no lost update; write bytes independent of owner count; deleted data not resurrected; owner A never reads owner B; blob → partitions → blob deep-equal for every store shape. |
| 2b | Unit-of-work hydration: `await ensureOwner(ownerId)` at request and job entry, sync access inside, per-owner version refresh, LRU eviction of clean owners. One store cut over behind a per-store flag, starting with the lowest-risk owner-keyed store. | Battery green with the flag on for that store. Shadow parity (drift = 0) on a dev launcher run. |
| 2c | Remaining stores cut over one at a time, each with drift evidence. | Same, per store. |
| 3 | API-only entrypoint (no worker, no schedulers); worker-only entrypoint; a single designated scheduler owner; post-turn work durable. | Multi-worker test: no duplicates, per-owner order kept, stale-job recovery, SIGTERM finishes the job in hand. |
| 4 | Object storage adapter (GCS) for artifacts/uploads; Redis-shared cooldowns; HTTP drain; readiness endpoint; pool budget; request-id propagation. | Tests per item. |
| 5 | Cloud Build / Artifact Registry / Cloud Run (API, worker) / Secret Manager / monitoring configs and docs. | `gcloud` dry-run validation only; nothing deployed without approval. |
| 6 | Load and failure tests at 100 / 500 / 1k / 5k. | Real numbers, or an explicit "not run". |
| 7 | The remaining documents. | — |

Phase 2a is implemented alongside this audit. Its design, migration plan and test evidence are in [AQUIPLEX_PER_OWNER_STORAGE_PLAN.md](AQUIPLEX_PER_OWNER_STORAGE_PLAN.md).
