# AQUIPLEX — Job Architecture (Phase 3: API / worker learning separation)

Status: **implemented, tested on the disposable Postgres, not activated anywhere.**
Gate: `AQUA_POST_TURN_DURABLE` (default `off`). Uncommitted on `main`.

## 1. The chat-turn lifecycle (audit, Step 1)

What a turn does, in order, and where each step runs now.

| # | Step | Code | Where it runs with the gate ON | Why |
|---|------|------|-----------------------------|-----|
| 1 | Auth, credit deduction (usageGuard) | routes/chat.js | API, synchronous | Gating the request |
| 2 | `prepareTurn`: owner resolution, sensitivity policy, memory extraction into the turn transaction (`beginTurnMemory`), retrieval, context assembly | routes/chat.js | API, synchronous | The answer depends on it. The turn's memory is rolled back if the turn is not persisted. |
| 3 | Provider call(s), verification, identity guard | routes/chat.js | API, synchronous | This is the answer |
| 4 | **Persist the turn**: user + assistant messages, plus **every learning job**, in **one Postgres transaction** | turnPostProcess.commitTurnWithLearning → conversationStore.commitTurnDurably → conversationPartitions.commitTurn → partitionRepository.insertChildrenTx | API, synchronous, before `res.json` / SSE `done` | A turn is acknowledged only when it and everything it must teach are durable |
| 5 | `commitTurnMemory` (the turn-memory commit boundary) | memory/turnCommit.js | API, after step 4 succeeds | If step 4 fails, the request fails (503, refund) and the memory rolls back |
| 6 | Mind post-turn (`memoryAfterTurn`: turn counter, predictions, Mind reflection when due) | job `learning.mind.v1` | **worker** | Was synchronous in the API |
| 7 | World-model ingest + claim shadow projection + Digital Twin | job `learning.observe.v1` | **worker** | Was deferred in-process; lost on crash |
| 8 | E6 understanding (provider calls) | job `understanding.turn.v1` (when `AQUA_E6`) | **worker** | Already durable; payload is now a reference (§3) |
| 9 | Reflection V2 (every `REFLECT_EVERY_TURNS` turns) | job `learning.reflect.v1`, `depends_on` = the turn's observe job | **worker** | Was a later in-process tick |
| 10 | PIC consolidation (every `AQUA_CONSOLIDATE_EVERY` owner turns) | job `learning.consolidate.v1`, enqueued by the mind job once per interval bucket | **worker** | Was an in-memory watermark, reset on restart |
| 11 | `recordOutcome`, `recordTurnCost` (learning ledger, cost accounting) | routes/chat.js | API, after the response (unchanged) | Process-wide heuristics (instanceAggregate, Phase 2c), not per-user learning. Cheap. **Not moved**, see §6. |

Stays synchronous on purpose: steps 1–5 (the answer and the turn's own memory
transaction). Moved: steps 6–10, all the post-turn learning. With the gate on,
the API runs none of it. The journey checks that no API process ran a learning
job.

Turns that never had post-turn learning still have none, unchanged: a stream the
user stopped (CLIENT_ABORTED), edit turns and artifact turns. Their messages
persist through the existing background flush.

## 2. Job kinds

| Kind | Idempotency key | Priority | Payload (no user text) | Depends on |
|------|-----------------|----------|------------------------|-----------|
| `learning.mind.v1` | `learning.mind.v1:<conv>:<userMsgKey>` | 50 | taskType, workspaceId | — |
| `learning.observe.v1` | `learning.observe.v1:<conv>:<userMsgKey>` | 60 | rememberSensitive (bool) | — |
| `learning.reflect.v1` | `learning.reflect.v1:<conv>:<userMsgKey>` | 70 | — | observe key |
| `understanding.turn.v1` | `understanding.turn.v1:<conv>:<turn>` (unchanged) | 100 | conversationId, turn, assertedAt, userMessageKey, rememberSensitive | — |
| `learning.consolidate.v1` | `learning.consolidate.v1:<bucket>` | 150 | bucket, turns | — |
| `ops.canary.v1` | caller's | caller's | ms (pg_sleep ≤ 30 s, writes nothing) | — |

Every row also records `owner_id`, `conversation_id`, `source_ref`
(`{conversationId, userMessageKey, assistantMessageKey, turn}`), `state`,
`attempts`/`max_attempts`, `created_at`, `started_at` (first claim),
`claimed_at`, `heartbeat_at`, `finished_at` and `last_error` (migration
`0030_learning_jobs.sql`, additive only).

**No copy of sensitive content.** Jobs carry references. The worker reads the
message from the conversation store and recomputes the sensitivity filter:
health and mood sentences are removed unless the user opted in, the same rule
as `memoryWriteTurn`. The opt-in is the one recorded at enqueue time. So:

- a conversation deleted, or a message edited, before the job runs is honoured;
- account deletion leaves no transcript in `aqua_jobs`;
- the journey checks that no job row contains the user's words (L2, L9).

Older `understanding.turn.v1` jobs carrying `userMessage` still work.

## 3. Durable job creation (Step 2)

```
POST /chat or /chat/stream (API)
  … answer ready …
  addMessage(user), addMessage(assistant)          (in memory, with stable message keys)
  commitTurn(conv, [user, assistant], jobsWithin):
      take this turn's insert ops out of the background flush queue
      flush pending header/meta ops
      BEGIN
        SELECT header … FOR SHARE                  (conversation must be live; blocks a concurrent delete)
        INSERT message rows                        (ON CONFLICT: own earlier attempt = idempotent; collision = re-key)
        INSERT aqua_jobs rows                      (ON CONFLICT (owner_id, idempotency_key) DO NOTHING)
      COMMIT
      on any failure: ROLLBACK, remove the messages locally, throw
  commitTurnMemory()                               (only after COMMIT)
  res.json / SSE done                              (only after COMMIT)
```

- **Not acknowledged unless durable.** A failed commit becomes a retryable
  error: HTTP 503 with `Retry-After` on `/chat`, an `error` event on the stream.
  The usage guard refunds the credit, and the turn's memory rolls back
  (`rollbackTurnMemory` in the route's `finally`).
- **No duplicates.** There are stable keys per turn. A retried enqueue returns
  `created:false` (tested).
- **Survives restarts and machine replacement.** Jobs are rows in Postgres. The
  journey recovered all queued learning after both workers were killed (L6),
  after the API was killed mid-request (L7), and after a database restart (L8).
- **Owner edge case.** If the memory owner differs from the conversation owner,
  the turn is still committed durably, but its learning runs in-process as
  before. This is counted (`ownerMismatch`) and logged. It never happened in the
  journeys.
- **Prerequisites.** Durable mode needs `DATABASE_URL` and history partitions
  `on`. Messages must be rows to share a transaction with the jobs. Otherwise the
  gate is refused with the reason in the boot line:
  `[TURN] durable post-turn learning: off — …`.

## 4. Worker execution (Step 3)

`core/jobs/workerRuntime.js` `runOneJob` is the same code the worker process,
the tests and the drains use:

1. **claim**: one transaction; `FOR UPDATE SKIP LOCKED` candidates, then a
   per-owner advisory try-lock and a re-check (see the ownership doc for the
   race this closes).
   - One running job per owner.
   - Not claimable while a `depends_on` job is queued or running.
   - Returns a **fence** `{workerId, attempts}`.
2. **heartbeat**: renewed every `AQUA_JOB_HEARTBEAT_STALE_MS / 4` while the
   handler runs.
3. **owner deleted?** (`aqua_deleted_owners`): complete as a no-op and write
   nothing.
4. **load the owner** (`ensureOwnerLoaded`). If the database is unreachable,
   **release** the job without counting the attempt.
5. **handler**: the same stage functions `runPostTurn` calls, with the same
   inputs.
6. **flush every partition write** (`flushOwnerBindingsStrict`). If anything is
   still pending, the job fails and retries. Nothing is acknowledged while its
   result is only in memory.
7. **complete, fenced.** A worker that lost its claim cannot complete or fail
   the job, and its result is discarded.

**Idempotency per stage:**

| Stage | Why a re-run is safe |
|-------|----------------------|
| Mind (turn counter, predictions) | `appliedTurns` marker in the owner's Mind, written in the same row and flush as the change |
| World-model ingest | Idempotent by `turnSourceId(conversationId, turn)` (existing) |
| Twin | `appliedTurns` marker |
| Reflection V2 | `appliedTurns` marker (in the Mind; the reflection writes go to the brain stores — see the risk in the implementation report) |
| E6 | Commit ledger idempotent on (source, segment, extractor_version) (existing) |
| Consolidation | Measured idempotent (a second pass merges nothing); once per bucket |

Tested by duplicate delivery: the in-process test, plus L5, where 16 learning
jobs were redelivered and the turn count did not change.

## 5. Observability (Step 8)

**Lifecycle log.** One `[JOB] {json}` line per event (`core/jobs/jobLog.js`):

- Events: `claimed`, `done`, `skipped`, `retry`, `dead`, `failed`, `released`,
  `lost`, `unrecorded`, `reclaimed`.
- Fields: jobId, kind, owner hash (HMAC, never the account id), attempt,
  queueWaitMs, runMs, retryInMs, error (truncated).
- Never payloads or text. `AQUA_JOB_LOG=off` silences it.

**Turn commits.** `[TURN] {"evt":"turn","phase":"committed","jobs":…,"ms":…}`
per durable commit. `durableTurnStats()` gives commit p50/p95/max, failures and
owner mismatches.

**Queue-derived metrics.** These are the same in every process:

- `jobTimings()`: per kind — jobs, dead, retries, queue wait and processing time
  p50/p95/max, from the row timestamps;
- `retryStats()` and `deadLetters()` (existing).

## 6. Not moved, and why

- **`recordOutcome` / `recordTurnCost`.** Process-level heuristics and cost
  accounting, stored as per-instance aggregate rows (Phase 2c). They stay in the
  API's post-response defer. A crash loses at most that turn's contribution to a
  global average, never user knowledge. Moving them would cost two jobs per turn
  for no correctness gain.
- **Mind reflection (`scheduleReflection`).** Still a `setImmediate` inside
  `memoryAfterTurn`, but that now runs in the worker. The job waits one tick so
  the reflection lands in the job's own flush.
- **Edit, artifact and aborted-stream turns** never ran post-turn learning.
  Unchanged.
