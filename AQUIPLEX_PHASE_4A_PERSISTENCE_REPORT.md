# AQUIPLEX — Phase 4A Persistence Report

Date 2026-11-15. **Uncommitted on `main`; nothing activated outside the
disposable test services.**

Objective: every accepted user interaction has durable, consistent state
**before** the API responds, and the remaining data can be migrated without
loss.

**Configuration in scope.** The target is the multi-instance configuration:
every store on partitions (`AQUA_STORE_PARTITIONS=…:on`) and
`AQUA_POST_TURN_DURABLE=on`.

The current single-process configuration (whole-file JSON stores, Mongo mirror)
is **unchanged** and assessed separately in §2.4.

Companion reports:
- `AQUIPLEX_CONVERSATION_MIGRATION_REPORT.md`
- `AQUIPLEX_ARTIFACT_STORAGE_AUDIT.md`
- `AQUIPLEX_API_SHUTDOWN_TEST_REPORT.md`
- `AQUIPLEX_PHASE_4B_READINESS_REPORT.md`

## 1. Summary

| Category | |
|----------|-|
| **Implemented** | per-request write scope + response gate (no required state waits on a post-response timer); chat turn boundary (preparation writes durable before commit, effects awaited and written before the response, fact embeddings as a durable job); refunds awaited before error responses; credit ledger writes awaited; bounded total shutdown time; conversation-history migration tooling; artifact audit + object plan; duplicate-message-key migration fix |
| **Tested with real PostgreSQL** | `phase4aPersistence` 9/9 (bite 9/9); `historyMigration` 7/7 (fresh database); `artifactAudit` 3/3; Phase 3 regression; wallet/refund 41/41 on test Mongo |
| **Tested on Linux** | API shutdown with real chat turns, streaming, a transaction in progress, credit refund and job draining: 24/24 (run 4). Phase 3 worker shutdown: 22/22 after this phase's changes. |
| **Tested with multiple processes** | Phase 3 multi-instance journey (2 APIs + up to 5 workers, real providers) **34/34** with all Phase 4A changes |
| **Not tested** | production data (history, artifacts); Cloud Run, Cloud SQL, GCS; load |
| **Not activated** | everything |
| **Remaining risks** | §6 |

## 2. Audit: every operation that can run after an API response

Method:
- every `setTimeout`, `setImmediate`, `setInterval`, deferral (`defer`,
  `later`), debounced writer and unawaited write in `aqua/src`, `aqua/router.js`,
  the root `index.js`, `routes`, `services` and `middleware`;
- each read in context.

Columns:
- **Required?** — is it required for consistency?
- **Before** / **After 4A** — is it durable before the response, without and
  with this phase?
- **Visible elsewhere?** — can another API instance see the latest committed
  state?
- **If the process exits right after the response** — what is lost.

### 2.1 User state (required)

| Operation | Writes | Required? | Before | After 4A | Visible elsewhere? | If the process exits right after the response |
|-----------|--------|-----------|--------|----------|--------------------|---------------------------------|
| Owner-partition flush (`ownerBinding`: mind, reflection, recall-redactions, reasoning-graph, ids) | the owner's row | **yes** | no: ~50 ms debounce timer after the response | **yes**: the response gate writes the request's own owners before `res.end` | after the flush, yes (per-request owner load) | before: the change was lost. After: nothing (it was written) |
| Keyed-partition flush (`keyedBinding`: evidence, brain annotations, uko, fileindex, attachments, pic, vectors, projects, index, artifacts) | the entry rows | **yes** | no (timer) | **yes** (the request's own keys) | yes | same |
| History ops (header/meta, message insert/delete, conversation delete, trash) | `c:`/`m:`/`t:` rows | **yes** | no (50 ms timer) | **yes**. Chat (durable): the turn's messages are in **one transaction with their jobs**; other conversation ops are written by the gate. | yes | same |
| Chat turn preparation (memory observation, facts, identity, retrieval bookkeeping) | Mind and other owner stores | **yes** | no (timers) | **yes**, written **before** the messages+jobs transaction. A failure means nothing committed, then a retryable 503, refund and rollback. | yes | — |
| Turn commit effects (`retireSupersededInBackground`, `propagateToEvidenceInBackground`) | evidence lane | yes (what is recalled as current) | no: fire-and-forget at commit | **awaited** (≤ 3 s) and written before the response | yes | before: lost. After: written. If the effects run past 3 s, they finish in the background (counted: `effectsTimedOut`). |
| Fact embedding refresh (`indexOwnerFacts`, provider call) | vectors | derived (rebuildable from facts) | no: fire-and-forget | **durable job `memory.index.v1`**, committed with the turn. A provider call is never on the request path. | after the job | before: lost until the next fact change. After: the job runs. |
| Post-turn learning (Mind, ingest, Twin, E6, reflection, consolidation) | many | yes | in-process deferral (Phase 3 off) | **durable jobs**, in the turn's transaction (Phase 3) | after the job | none lost (Phase 3 tests) |
| Aborted stream (user pressed stop) | user message + partial answer | yes | timer | **flushed** right after, best effort (nobody waits for a response) | yes | a window of one flush |
| Reads that write (e.g. reflection marked "surfaced") | owner rows | bookkeeping | timer | flushed before the response; a failure is **logged, not an error** | yes | before: lost. After: written. |

### 2.2 Credits (required)

| Operation | Required? | Before | After 4A |
|-----------|-----------|--------|----------|
| Deduction on entry (`usageGuard` → `deductCredits`) | **yes** | awaited, atomic (`findOneAndUpdate`) | unchanged |
| Refund of a failed request | **yes** | `/chat` and the stream: `refund().catch()`, not awaited; the usage guard's `finish` net ran **after** the response | **awaited before the error response**: the response gate for JSON errors, `awaitRefund` before the stream's error event, bounded at 5 s. `onceOnly`: a second call now settles only after the first refund, so an await really waits. Linux A5: refunded before the API exited. |
| Ledger rows (`Transaction` DEBIT / REFUND / ADMIN_ADJUST) | yes (billing audit) | fire-and-forget | **awaited** (still fail-open: a ledger failure does not fail the user's action) |
| Credit deducted for a turn whose process **dies** before it completes | **yes** | lost | **still lost**: a gap, see §6 and the 4B readiness report |

### 2.3 Not user state (left as they are, on purpose)

| Operation | Writes | Why it can stay after the response |
|-----------|--------|-------------------------------------|
| `recordOutcome` / `recordTurnCost` → cognition and ledger (`instanceAggregate`, per-instance rows synced on a timer) | routing and cost statistics | Global heuristics, not one user's state. At most one sync interval of one instance's statistics is lost on a hard exit. The SIGTERM drain syncs. |
| PIC background consolidation (3 s debounce per owner) | evidence/PIC maintenance | Idempotent and recomputable; also run by `learning.consolidate.v1` |
| Mind reflection (`scheduleReflection`, `setImmediate`) | the Mind | Runs inside the worker's `learning.mind.v1` job (durable mode); the job waits a tick so it is part of the job's flush |
| JSON rollback copies of partitioned stores (`backupFlush`) | local JSON file | A rollback aid only; the database is authoritative |
| Mongo mirror (`mirrorWrite`) | `aqua_kv` | Durability of the **JSON** stores (single-process mode); not used for partitioned stores |
| Tool click analytics (`Tool.findByIdAndUpdate(...).catch`) | click counter | Analytics |
| Telemetry, process metrics, durability self-check, propagation sweeper (worker role only), provider timeouts | — | Not stored user state |
| Sessions (connect-mongo) | session | `express-session` saves before ending the response |

### 2.4 The current single-process mode (JSON stores) — unchanged

With partitions off (today's Render process):
- stores write their whole JSON file **≤ 500 ms after** a change (debounced),
  then mirror to Mongo;
- SIGTERM flushes them synchronously;
- a **hard** exit (SIGKILL, OOM) can lose up to one debounce window of changes.

This phase does not change that mode: making whole-file writes synchronous per
request would rewrite every user's data on every request. The fix for that mode
*is* the partitioned configuration.

## 3. What was built

| Piece | File | Behaviour |
|-------|------|-----------|
| Write scope | `aqua/src/core/storage/requestWrites.js` | AsyncLocalStorage per request. Every binding records the exact keys a request dirties (owner, entry key, conversation id). `flushScopeStrict` writes **only those keys** and throws `FLUSH_INCOMPLETE` if any is still pending. |
| Per-key flush | `ownerBinding.flushOnly/pendingAmong`, `keyedBinding.…`, `conversationPartitions.…` (ops tagged by conversation via `enqueueOp`) | Serialized with the background flush. A failure keeps the key dirty (background retry) and reports it. **Other users' pending writes are neither written nor waited for**, which is tested. |
| Response gate | `aqua/src/core/storage/responseGate.js`, installed first in `aqua/router.js` | Holds `res.end` until the request's writes are durable. Mutating request + failure → **retryable 503** instead of the success. GET → logged. SSE / chat → best effort (chat has its own boundary). Error status + `creditContext` → refund awaited first. A no-op while nothing is on partitions and no refund is owed. |
| Chat boundary | `routes/turnPostProcess.js` `commitTurnWithLearning`, `memory/turnCommit.js` | ① flush the preparation writes (before adding the messages, so their inserts stay in the transaction) ② messages + learning jobs + `memory.index.v1` in one transaction ③ commit the turn memory, run and **await** its effects (embedding skipped: it is a job) ④ flush what ③ wrote. `[TURN]` logs `preFlushMs, txMs, effectsMs, postFlushMs, preKeys, postKeys`. |
| Embedding job | `learning/turnLearning.js` `memory.index.v1` | `indexOwnerFacts(owner, getFacts(owner))`. Owner-level, idempotent, no payload. |
| Refunds | `middleware/usage/checkUsage.js` `onceOnly`; `routes/chat.js` `awaitRefund` | see §2.2 |
| Ledger | `services/credits/wallet.service.js` | `await Transaction.create(...)` (fail-open) |
| Shutdown budget | `core/atomicStore.js` `AQUA_SHUTDOWN_BUDGET_MS` (9.5 s); API in-flight wait 7 s (`index.js`) | SIGTERM → exit ≤ ~9.5 s even when a drain is stuck (was 13 s, measured) |

## 4. Failure semantics of one chat turn (durable mode)

| Failure at | Client sees | State |
|------------|-------------|-------|
| ① preparation flush | retryable 503 / stream error; credit refunded before the error | nothing committed. The turn memory rolls back in process; the rolled-back state is written by the background retry (the database was unreachable) |
| ② the transaction | same | no message, no job (Phase 3; Linux A4) |
| ③ effects slower than 3 s | success | accepted; the effects finish in the background (counted) |
| ④ the post-commit flush | success | the turn and its jobs are committed; the effects' writes stay queued and retried (counted: `postCommitNotDurable`). Window: one database round trip right after a successful commit. |
| the process dies during ② | socket error, never success | transaction rolled back (Linux A4); **credit not refunded** (gap) |

## 5. Latency (measured; local Docker Postgres; no capacity claims)

| Run | Commit total | Breakdown (p50 / p95) |
|-----|--------------|-----------------------|
| Windows multi-instance journey (real providers), n = 12 | p50 38 ms, p95 69 ms | pre-flush 0 / 2 ms · transaction 36 / 68 ms · effects 0 / 1 ms · post-flush 0 / 1 ms |
| Linux, fast fake model, n = 4 (run 4) | 29–31 ms, unblocked | pre-flush 0–7 ms (1–2 keys) · post-flush 0–1 ms (1 key) |

- With a real model, the bindings' 50 ms debounce usually writes the
  preparation state **during** the model call, so the pre-commit flush mostly
  confirms.
- With a fast model, it does the writing (1–2 keys, ≤ 7 ms).
- Phase 3's measured commit was p50 23–32 ms. The added boundary costs single
  milliseconds in these runs.
- **Under load** (pool contention, Cloud SQL latency) these numbers are not
  known.

## 6. Remaining risks

1. **A credit deducted for a turn that dies with its process is not refunded.**
   A hard exit after deduction-on-entry. Linux A4 shows the turn vanishes
   correctly but the credit does not come back. Needs a request-scoped pending
   charge plus a reconciler (4B).
2. **The post-commit window.** A database failure in the round trip right after
   a successful commit leaves the turn's *effect* writes (evidence lane) queued
   in memory. If the process then also dies, they are lost. The turn, its
   messages and its learning jobs are durable.
3. **Partial pre-flush across stores.** If one store's write succeeds and
   another's fails, the turn is refused and rolled back in memory. The
   rolled-back state reaches the database only by the background retry, when
   the database is reachable again. Until then, the store that succeeded holds
   the turn's observation.
4. **Effects slower than 3 s** finish after the response (counted, logged).
5. **Single-process JSON mode** keeps its ≤ 500 ms hard-crash window (§2.4).
6. **Routes outside the AQUA router** are not gated: platform routes, auth,
   billing. They use Mongo with awaited writes. The audit found only the ledger
   rows and click analytics unawaited; the ledger is fixed.
7. **Load.** The gate adds one or more database round trips per mutating
   request. Pool sizing under concurrency is unmeasured.

## 7. Tests run

| Suite | Result |
|-------|--------|
| `src/core/tests/phase4aPersistence.test.js` (real Postgres) | 9/9; bite check 9/9 mutations caught (gate removed, binding not recording writes, flush not scoped, pre-commit flush removed, effects not awaited, post-commit flush removed, embedding still inline, refund not awaited, index job missing) |
| `src/core/tests/historyMigration.test.js` (fresh disposable database) | 7/7 |
| `src/artifacts/tests/artifactAudit.test.js` | 3/3 |
| Phase 3 + 4A regression (Phase 3 learning, roles, jobs, partitions, turn commit, memory/forget, all route tests, flags, storage) | 535/536 on the first run. The one failure was cross-suite test interference (fixed); then 26/26 for the two suites together. |
| Storage layout + migration suites after the duplicate-key fix | 119/119 |
| `tests/platform/creditRefund` + `walletAndPayments.live` (test Mongo) | 41/41 |
| Linux API shutdown (`phase4a-linux-api-shutdown.mjs`) | 24/24 (run 4) |
| Linux worker shutdown (Phase 3 suite) after the budget change | 22/22 |
| Multi-instance journey (Windows, real providers) | 34/34 |
| Full batteries | see `AQUIPLEX_PHASE_4B_READINESS_REPORT.md` §4 |
