# Storage and Durability Audit

Evidence levels as defined in SYSTEM_ARCHITECTURE_MAP.md.

## 1. Inventory

| Store | Substrate(s) | Authority for reads during a request |
|---|---|---|
| Conversation history | Map → `.aqua-history.json` (debounced 500 ms) → Mongo `aqua_kv` mirror; optional Postgres partitions (`AQUA_STORE_PARTITIONS=history:*`, off by default) | **In-process Map** |
| Conversation trash | `.aqua-history-trash.json` (last 40), or partition rows | file |
| Legacy facts / Mind / PIC / evidence / vectors / reasoning graph / reflection / ids / cognition / ledger / attachments / file index / UKO / projects / identity overrides / recall redactions | 20 JSON files in `DATA_DIR` (each with a Map), mirrored to Mongo | In-process Maps |
| Canonical World Model (claims, evidence, retired statements, current world) | PostgreSQL | Postgres (live queries) |
| Jobs, pending charges, store partitions | PostgreSQL | Postgres |
| Users, sessions, credits | MongoDB (platform) | MongoDB |

22 modules use `createDebouncedWriter` (SOURCE-CONFIRMED, grep count).

## 2. Read/write precedence (SOURCE-CONFIRMED)

- **Boot:** `dataDir.js` → `hydrateFromMongo(DATA_DIR)` (newer-wins per file) → each store's `loadFromDisk()` → Maps.
- **Request:** all reads from Maps. Writes mutate the Map synchronously, then schedule a whole-file rewrite (500 ms debounce), then `mirrorWrite()` to Mongo (fire-and-forget, re-queued with backoff on failure).
- **Running instances never re-read** files or Mongo. A Map miss is final for that process.
- **Canonical World Model:** read live from Postgres, gated by `resolveReadMode()`. `isReachable()` is cached 10 s when up and 3 s when down, with a 1.5 s probe (`core/db/pool.js:172-185`). When down, `authoritative` is served as `legacy` (degraded), the legacy veto falls back to deletions only, and Context V2 runs with `canonicalOnly:false`.

## 3. Findings

### S-1 (D-07, S1). A Map miss silently becomes a new empty conversation

`getOrCreateConversation(id)` (`memory/conversationStore.js:150-162`) treats "not in this process's Map" as "new": it creates `{ messages: [] }` *at the client's id*, logs `[STORE] CREATED`, and returns `isNew: true`. `canAccessConversation` also passes, because `conversationExists` is false. The user keeps seeing the old conversation in the UI while the model gets no history. No error is raised or shown.

Conditions that produce a miss:

| Condition | Mechanism | Status |
|---|---|---|
| >1 instance (scale-out, deploy overlap) | Per-process Map; mirror is whole-file last-writer-wins; the mirror module itself documents it as "only safe single-instance" and adds a heartbeat alarm | SOURCE-CONFIRMED design limit |
| Restart before a debounced flush or mirror upsert lands | 500 ms local window; mirror fire-and-forget; Render rebuilds the filesystem on deploy (`mongoMirror.js` header) | SOURCE-CONFIRMED |
| Mirror **unverified** at boot (reported in production) | `enterUnverified()` → "local stores are not mirrored; the Mongo backup is left untouched" (`mongoMirror.js:272-277`). Everything written in this state survives only on the local disk. On Render that disk does not survive a deploy | SOURCE-CONFIRMED; production state reported |
| History partitions `on`/`only` with Postgres down | `ensureOwnerLoaded` throws → logged → request continues "owner NOT READY"; history Map lacks the conversation | SOURCE-CONFIRMED; whether prod enables history partitions is unknown (`.env` does not set `AQUA_STORE_PARTITIONS`) |

The overwrite risk: when the recreated empty conversation is flushed, the whole-file writer writes this process's Map. If this process lacks other conversations (a non-hydrated instance), its flush can overwrite a richer file or mirror generation. The mirror's lineage and heartbeat logic exists to detect this. Whether it prevents all cases is NOT AUDITED.

### S-2 (D-09, S1). Configured but absent PostgreSQL degrades every turn

`.env` (CONFIG-INDICATED) sets `DATABASE_URL=…@localhost:5432/aqua`, matching production's `ECONNREFUSED localhost:5432`. Effects, SOURCE-CONFIRMED per call site:

| Effect | Where | User-visible consequence |
|---|---|---|
| Read mode authoritative → legacy (degraded) | `brain/index.js:142-149`, `chat.js:597-601` | Corrections and supersessions held only in the canonical model are not applied |
| Legacy veto → deletions-only fallback | `chat.js:609`, `brain/index.js:232` | Facts the canonical model retired may reappear |
| World Core read throws → `world core unavailable` | `brain/index.js:1211-1243` | The "current world" section is missing |
| Canonical claim hydration per id fails → `claim hydration skipped` (up to 64 ids per turn) | `brain/index.js:1258-1267` | Latency and log noise; E7 dense lane empty |
| `retiredStatements` read fails (swallowed) | `brain/index.js:1170-1172` | Retired sentences may be quoted |
| Canonical writes (post-turn ingest, E6) fail | post-turn path (fail-open) | New understanding is not recorded canonically; legacy stores keep diverging from canonical |
| Durable turn commit / jobs / pending charges unavailable | `conversationPartitions.js:608` and Phase 3/4 paths (only when enabled) | — |

This is fail-open by design, but fail-open here means **silently answering from a different source of truth** without telling the user or the model. "Missing information" and "failed retrieval" look identical downstream: the Context Engine renders "EVIDENCE STATUS: UNKNOWN" whether the store is empty or the database is down (D-01).

### S-3 (S2). Two sources of truth for the user's world, with no reconciliation on the read path

Legacy JSON facts and Mind on one side, the canonical Postgres World Model on the other. Precedence is decided per turn by DB reachability. When the DB returns, nothing reconciles what was learned meanwhile: canonical writes that failed are not replayed. That is SOURCE-CONFIRMED for the turn path (fail-open `guard`). Whether a job or backfill replays them is NOT AUDITED.

### S-4 (S2). Durability window for a completed turn

Non-durable path: the user sees `done` after `addMessage` (Map) but before the 500 ms flush and the asynchronous mirror. The Phase 4A response gate holds the response until writes are durable **only for partition-backed stores** ("A no-op while no store is on partitions", `aqua/router.js:238-241`). So with defaults, a crash within roughly 0.5 s plus mirror latency loses an acknowledged turn. SOURCE-CONFIRMED.

### S-5 (S3). Whole-file rewrite cost scales with all users

Every message rewrites the entire `.aqua-history.json` (all users' conversations) and re-mirrors it, chunked over 16 MB. The partitions work (Phase 2b) exists to remove this but is off by default.

### S-6 (S3). Auto-created conversations become inaccessible to their owner

`addMessage` on a missing id auto-creates `meta: { autoCreated: true }` **without `userId`** (`conversationStore.js:205-208`). For a signed-in user, `canAccessConversation(userId, id)` then compares `undefined === userId` → false → 404 for every later request on that id. Trigger: a turn that finishes after its conversation was deleted mid-stream. Low frequency. SOURCE-CONFIRMED.

## 4. Production vs development configuration

| Aspect | Code default | Repository `.env` | Production (from logs) |
|---|---|---|---|
| Postgres | none | `localhost:5432` | configured, unreachable |
| Mongo mirror | on when `MONGO_URI` is set | set | **unverified** |
| Context V2 | off | on | on (log-proven) |
| History partitions | off | unset | unknown |
| `NODE_ENV` | — | production | — |

Whether production uses this `.env` or platform-managed variables could not be established from the repository. **Runtime evidence needed:** the production environment's flag set (names and values of `AQUA_*`, the host part of `DATABASE_URL`), the instance count, and the `/provider-health` mirror status block (`durable`, `verdict`, `consecutiveFailures`, `queuedFiles`, `conflict`).

## 5. Multi-instance consistency verdict

The JSON + Map + whole-file mirror architecture is **single-writer only**. This is SOURCE-CONFIRMED and stated in the module's own header. Any horizontal scaling, including deploy overlap, can lose or hide conversation history and personal memory without an error. The partition-backed design is the intended fix and is off by default. Its correctness under Postgres outage is a separate concern: it degrades to "owner not ready", which for history means S-1.
