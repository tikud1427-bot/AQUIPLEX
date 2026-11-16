# AQUIPLEX — Phase 3 Implementation Report: API / Worker Learning Separation

Date 2026-11-15. **Everything below is uncommitted on `main` and not activated
anywhere.** The gate `AQUA_POST_TURN_DURABLE` is off by default; with it off,
the product behaves as before, except for the defect fixes in §3, which apply
regardless.

Companion documents:

- `AQUIPLEX_JOB_ARCHITECTURE.md`: the turn lifecycle audit, job kinds, the
  commit, worker execution;
- `AQUIPLEX_JOB_OWNERSHIP_AND_RECOVERY.md`: claims, fencing, recovery, deletion,
  scheduler ownership;
- `AQUIPLEX_PHASE_3_TEST_REPORT.md`, `AQUIPLEX_LINUX_SHUTDOWN_TEST_REPORT.md`;
- `AQUIPLEX_PHASE_4_READINESS_REPORT.md`, which includes the Cloud Run CPU
  answer.

## 1. Status at a glance

| Category | Items |
|----------|-------|
| **Implemented** | durable turn commit (messages + jobs, one transaction); 4 learning job kinds + canary; worker handlers with idempotency markers; fenced claim/heartbeat/complete/fail; release; heartbeat-based recovery; dead-lettering of exhausted reclaimed jobs; `depends_on`; per-owner claim exclusivity (advisory lock); deleted-owner marker checked by every write path and the worker; strict flush before acknowledgement; worker SIGTERM deadline + release; API in-flight request drain; structured `[JOB]`/`[TURN]` logs; `jobTimings()`; boot line for the durable state; flags registered (48 gates / 59 settings) |
| **Tested with real PostgreSQL** | all of the above (phase3Learning 17/17, regression set 277/277, journey 34/34), bite 14/14 + claim race |
| **Tested on Linux** | worker SIGTERM idle / job in hand / during lease renewal / inside a DB call past the deadline; replacement; SIGKILL recovery; API drain with a request in progress (22/22) |
| **Tested with multiple processes** | 2 APIs + 2–5 workers (journey), up to 3 workers + 1 API (Linux), concurrent claimers (in-process, 8 connections) |
| **Not tested** | Cloud Run / Cloud SQL / GCS / Render; multi-host networks; load and capacity; worker release when the DB fails during owner load, and the `unrecorded` path (primitives only); a graceful API drain during a real chat commit; `rememberSensitive=true` end-to-end |
| **Not activated** | `AQUA_POST_TURN_DURABLE` (off everywhere); `AQUA_STORE_PARTITIONS` (off everywhere); `start:api` / `start:worker` (no deployment uses them); migration 0030 (applied to the test DB only) |
| **Remaining risks** | §6 |

## 2. What was built (files)

**New:**

| File | Purpose |
|------|---------|
| `aqua/src/core/db/migrations/0030_learning_jobs.sql` | Additive: `aqua_jobs.conversation_id`, `source_ref`, `depends_on`, `heartbeat_at`, `started_at`, `finished_at`; the running-heartbeat index; `aqua_deleted_owners` |
| `aqua/src/learning/turnLearning.js` | Job specs (API side), handlers (worker side), reading the message by reference with redaction, applied-turn markers |
| `aqua/src/core/storage/deletedOwners.js` | `markOwnerDeleted` / `isOwnerDeleted` (positive answers cached for good, negative for 2 s) |
| `aqua/src/core/jobs/jobLog.js` | Structured lifecycle lines |
| `aqua/src/core/tests/phase3Learning.test.js`, `aqua/src/routes/tests/picQueryRedaction.test.js` | Tests |
| `aqua/scripts/phase3-learning-journey.mjs`, `aqua/scripts/phase3-linux-shutdown.mjs` | Journey and Linux harness |

**Changed:**

| File | Change |
|------|--------|
| `core/jobs/jobQueue.js` | `enqueue` on a transaction client with references/dependencies; **claim in a transaction with a per-owner advisory lock**; fenced `heartbeat`/`complete`/`fail`; `release`; heartbeat-aware `reapStale` that dead-letters exhausted jobs; `canarySleep`; `jobTimings` |
| `core/jobs/workerRuntime.js` | Learning + canary handlers; `understanding.turn.v1` accepts references; `runOneJob` lifecycle (heartbeat timer, deleted-owner skip, release on DB-unavailable, strict flush, fenced ack, lost detection, logs); `releaseInFlight`; `isDatabaseUnavailable` |
| `memory/conversationPartitions.js` | `commitTurn` (the durable commit); ownership-refused writes dropped instead of blocking the queue; deleted-owner checks |
| `core/storage/partitionRepository.js` | `insertChildrenTx` |
| `core/storage/ownerBinding.js`, `keyedBinding.js` | Deleted-owner check; `flushOwnerBindingsStrict`; `storeAuthoritative` |
| `memory/conversationStore.js` | `commitTurnDurably`, `durableTurnCommitAvailable` |
| `routes/turnPostProcess.js` | `durableTurnLearningState`, `commitTurnWithLearning`, `durableTurnStats` (`runPostTurn` unchanged) |
| `routes/chat.js` | `/chat` and `/chat/stream` commit boundary uses the durable path when active (before `res.json` / `done`); **PIC query redacted** |
| `mind/mindStore.js` | `appliedTurns` markers + merge |
| `account/accountPurge.js` | Deletion marker written first |
| `core/atomicStore.js` | `registerShutdownBlocker` |
| `scripts/worker.mjs` | Shutdown deadline + release, flush before exit, **shutdown blocker (Linux fix)**, reclaim log |
| `index.js` | API in-flight request drain (`AQUA_API_SHUTDOWN_MS`), role-gated |
| `router.js` | Durable-state boot line |
| `scripts/start-api.mjs` | Header comment |
| `core/flags.js` | Registry: `AQUA_POST_TURN_DURABLE`, `AQUA_JOB_HEARTBEAT_STALE_MS`, `AQUA_JOB_LOG` |
| Test fixtures | dbPool allowlist, flag census, parity probe |

Nothing was deleted. No existing migration was edited. `runPostTurn`, the
in-process path, is unchanged and remains the default and the rollback.

## 3. Defects found and fixed during Phase 3

Each was found by a test written for this phase. All four predate Phase 3; it
made them reachable or visible.

1. **Worker SIGTERM never graceful on Linux.**
   - Symptom: the store layer's SIGTERM handler exited 143 within milliseconds,
     before the job in hand finished or the lease was released.
   - Found by: Linux run 1, 7/22.
   - Fix: the worker registers its shutdown as a blocker of that handler.
2. **Per-owner claim exclusivity was racy.**
   - Symptom: two workers could run two jobs of the same owner concurrently.
     Measured: a lost Mind increment.
   - Found by: journey run 2.
   - Fix: claim transaction + per-owner advisory try-lock + re-check. A
     regression test fails on the old claim.
3. **The raw user message was persisted in the PIC store**, as the verification
   feedback `query`, bypassing the health/mood sensitivity policy.
   - Found by: journey run 3, L9.
   - Fix: redacted, plus a guard test.
4. **One ownership-refused history write blocked every later history write** of
   the process: ops apply in order and the failed op retried forever.
   - Found by: phase3Learning.
   - Fix: the write is dropped with an error log. A turn committing into a
     conversation deleted elsewhere also drops its local copy.

## 4. Requirements traceability

| Step | Requirement | Where / evidence |
|------|-------------|------------------|
| 1 | Audit: what can be async, what must stay sync | Architecture §1 |
| 2 | Durable job per accepted turn, transactional with messages | `commitTurn` / `insertChildrenTx`; test "one transaction"; journey L2 |
| 2 | Don't acknowledge without the job | retryable error → 503 / stream `error` + refund + memory rollback; tests "neither are the messages", "retryable" |
| 2 | Survive restarts and machine replacement | Rows in Postgres; journey L6/L7/L8 (replacement API with an empty disk) |
| 2 | Stable IDs, idempotency keys, recorded fields | Architecture §2; migration 0030 |
| 2 | No copies of sensitive content | References only; tests; journey L2/L9 |
| 2 | No duplicate jobs | `ON CONFLICT (owner_id, idempotency_key)`; test |
| 3 | Move learning into workers | 4 learning kinds + E6; journey L3 "no API ran a learning job" |
| 3 | Behaviour, provenance, isolation, deletion/redaction | Same stage functions and inputs; owner check on the source; deleted-owner marker; redaction recomputed |
| 3 | No duplicate facts/graph updates; dependencies | Markers + idempotent ingest/E6; `depends_on`; test + L5 |
| 3 | Failure isolation, responsive chat, no lost learning on API exit | Per-owner ordering; commit ≈ 20–70 ms; L7 |
| 3 | Do not remove intelligence features | All stages still run (in workers); off = unchanged |
| 4 | Atomic claim, safe concurrency, lease renewal, recovery, bounded retry, terminal state, idempotent execution, DB disconnection, no double execution, safe shutdown, single scheduler | Ownership doc; tests; Linux |
| 5 | Linux SIGTERM (7 cases) | Linux report, 22/22 |
| 6 | Responsibility boundaries | Below |
| 7 | Tests on disposable Postgres | Test report |
| 8 | Performance + observability, no invented capacity | Test report §5; architecture §5 |

**Step 6, responsibility boundaries:**

- `start:api` sets `AQUA_ROLE=api`: no worker, no periodic jobs. The propagation
  sweeper is skipped for the api role (Phase 2c). Journey boot: "no API process
  started a worker".
- `start:worker` sets `AQUA_ROLE=worker`: no HTTP listener (`phase3Roles`). There
  is one scheduler owner (lease), and any number of ordinary workers are safe.
- `/ready` reflects Mongo, the engine, Postgres reachability and draining.
  `/health` is unchanged (liveness).
- SIGTERM is tested on Linux; startup is deterministic (boot lines state roles,
  partitions and durable state).
- The Cloud Run request-based CPU answer is in the Phase 4 readiness report:
  **not yet**. Request-path memory writes still flush on timers after the
  response.

## 5. Full test battery

Command: `npm test` in `aqua/`, with `AQUA_TEST_DATABASE_URL`=disposable DB and a
temporary `AQUA_DATA_DIR`.

**Result: 5784 tests — 5747 pass, 13 fail, 17 skipped, 7 todo.**

| Failures | Cause | Phase 3? |
|----------|-------|----------|
| 1 — `storageAdapter`: "the public API is exactly what it was" | The pin lists atomicStore's exports; `registerShutdownBlocker` is new | **Yes.** Pin updated deliberately; 22/22 after |
| 9 — `eval/tests/answerRunner`, `evalProviderIntegration` | The eval CLIs refuse whenever `DATABASE_URL` is set ("evaluation never reaches a real database"), and the runner maps the test DB into it for the whole battery | No. Environmental: **47/47** when run without a database |
| 2 — `temporalState.live` | Date-dependent | No. Known before Phase 2 |
| 1 — `repoHygiene` "nothing is named *backup*" | `eval/out/contexts.before-profile.*.json` files in the tree | No. Known before Phase 2 |

The 7 "todo" entries are documented known limitations, for example "no
synonym/related-concept matching". They are expected to fail and are not
counted as failures.

After the pin update, no failure is attributable to Phase 3.

## 6. Remaining risks

1. **Request-path store writes flush after the response.** This affects Cloud
   Run CPU allocation and cross-instance freshness (Phase 4 item 1).
2. **Flag skew between API and workers.** The worker decides stage gates when a
   job runs, so differing environments change what is learned. They must be
   deployed together.
3. **Reflection idempotency spans two stores.** The marker is in the Mind; the
   reflection writes go to the brain stores. A crash between those two flushes
   re-runs reflection. It recomputes a delta against the already-applied state.
   This was not separately tested.
4. **Recovery window with default settings is up to ~3 minutes** (heartbeat 120 s
   + reap 60 s). During it, one user's later learning waits behind the stranded
   job.
5. **The turn counter merges by max.** It is now safe because one owner's jobs
   are exclusive. A writer outside the queue that incremented it concurrently
   would still lose counts.
6. **`ownerMismatch` turns** (memory owner ≠ conversation owner) learn in-process,
   as before. They never occurred in the tests.
7. **Durable mode requires history partitions**, so production history must be
   migrated first. Not done; Phase 4.
8. **No load test.** Connection-pool needs per API and worker against Cloud SQL
   limits are unmeasured.

## 7. Rollback

- Unset or set `AQUA_POST_TURN_DURABLE=off` and restart. Turns use
  `runPostTurn` in-process again.
- Jobs already queued are still processed by the workers. They stay valid and
  idempotent.
- Migration 0030 is additive and needs no rollback.
- The defect fixes in §3 are independent of the gate.
