# AQUIPLEX — Job Ownership and Recovery (Phase 3)

Who may run a job, how that is proven, and what happens when a process, the
database or an account disappears. Code: `core/jobs/jobQueue.js`,
`core/jobs/workerRuntime.js`, `scripts/worker.mjs`,
`core/storage/deletedOwners.js`, `core/jobs/schedulerLease.js`.

## 1. Job ownership: claim, fence, heartbeat

| Mechanism | Rule |
|-----------|------|
| Claim | `UPDATE … WHERE job_id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`. Two workers never claim the same row; the loser takes another job instead of waiting. |
| Per-owner order | A job is claimable only while its owner has nothing `running`. One user's jobs run one at a time; other users are unaffected. **Enforced in one claim transaction:** candidates `FOR UPDATE SKIP LOCKED`, then `pg_try_advisory_xact_lock(84125320, hashtext(owner_id))` (never waits; a locked owner is skipped), then a re-check that nothing of the owner is running, then the claim. The lock is released at COMMIT, together with the claim becoming visible. |
| Why the lock (defect found in Phase 3) | The original single-statement claim (E4) was **not** exclusive per owner. Two workers claiming at the same instant each skipped the other's locked row, picked a different job of the same owner, and neither saw the other's uncommitted `running` row. The multi-worker journey caught two Mind jobs of one owner running 1 ms apart, which lost a turn-count increment. Regression test: 8 concurrent claimers × 15 rounds. It passes with the new claim and fails with the old one. |
| Dependencies | A job with `depends_on` is not claimable while any listed job (same owner, by idempotency key) is `queued` or `running`. A **dead** dependency does not block: the in-process stages were fail-open per stage, and that is kept. |
| Fence | The claim returns `{workerId, attempts}`. `heartbeat`, `complete`, `fail` and `release` apply only while the row still has `state='running' AND claimed_by=$w AND attempts=$n`. |
| Heartbeat (lease renewal) | Every `AQUA_JOB_HEARTBEAT_STALE_MS/4` (default 120 s / 4 = 30 s) on an independent timer while the handler runs. A failed beat is retried at the next tick. A beat that finds the fence gone marks the attempt **lost**. |
| No double execution | A job is handed to a second worker only after its heartbeat has been stale for `AQUA_JOB_HEARTBEAT_STALE_MS`. The fence guarantees that a worker which was only slow (GC pause, network partition) cannot complete or fail the job after that. Its result is discarded. Its partition writes, if any landed, were made by idempotent stages (§4 of the architecture doc). |

Tested on real Postgres:

- the fenced worker's heartbeat, complete and fail are refused;
- a 3 s job with a 1 s stale threshold is never reaped while it beats;
- depends_on ordering holds.

## 2. Recovery

| Situation | Outcome | Test |
|-----------|---------|------|
| Worker killed mid-job (SIGKILL, OOM, lost VM) | Heartbeat goes stale. The scheduler-owning worker's `reapStale` (every 60 s) re-queues the job, and it re-runs idempotently. | journey L6; Linux T6 |
| Same, on the job's **last** attempt | Dead-lettered (`dead: worker vanished mid-job on its last attempt`), not re-run forever. A poison input cannot kill workers in a loop. | phase3Learning |
| Handler throws | `fail`: retry with backoff (2^n s; capacity errors 1/2/4/8 min), dead after `max_attempts`. Dead rows are kept (DLQ) and can be requeued with `requeueDead`. | existing jobQueue suite |
| Database unreachable between jobs | The claim fails; the worker backs off (4× poll) and resumes when the database is back. No restart. | journey L8 (Postgres container restarted; workers kept running and learned every committed turn once) |
| Database unreachable while loading the owner | `release`: back to `queued` in 5 s, **attempt not counted**. An outage cannot dead-letter learning. | Error classification unit-tested and `release` tested; the combination was **not** hit end-to-end (in L8 the restart landed while workers were idle) |
| Database unreachable when recording the outcome | Logged `unrecorded`. The heartbeat stops and recovery re-queues the job once stale. | **Not exercised** end-to-end |
| Partition flush incomplete after the handler | The job fails and retries. It is never marked done with its result only in memory. | code path; covered indirectly |
| Worker SIGTERM, job shorter than the deadline | The job finishes and completes. Then flush, lease release, exit 0. | Linux T2 |
| Worker SIGTERM, job past `AQUA_WORKER_SHUTDOWN_MS` (8 s) | Stop the heartbeat, **release** (attempt not counted), flush, release the lease, exit 0. Another worker takes the job at once. | Linux T4 + T5 |
| API killed mid-request | The turn is either fully committed (messages and jobs) or not at all. The invariant "every persisted user message has its learning job" held after the crash. | journey L7 |
| API SIGTERM with requests in progress | Stop accepting connections (`/ready` unavailable), wait up to `AQUA_API_SHUTDOWN_MS` (8 s) for in-flight requests to complete, then run the existing flush/drain and exit. | Linux T7 |

## 3. Account and conversation deletion

1. **Account deletion writes `aqua_deleted_owners` first**
   (`accountPurge.purgeOwnerData`, step `deletionMarker`), before any store is
   purged.
2. **Every per-owner write path checks the marker.** These are
   `ownerBinding.flushOwner`, `keyedBinding` flushes, and conversation-partition
   inserts, headers and trash. Tombstones still pass: they are the purge.
3. **The worker checks it before running a job.** A job of a deleted account
   completes as a no-op (`skipped: owner-deleted`).
4. **A job already running when the account is deleted** may finish computing,
   but its writes are refused by step 2. Tested: deletion during a held job left
   **no live row**.
5. **Queue rows are purged.** Existing G4 `purgeOwner` in the account purge.
   Journey L11 deleted an account with 5 learning jobs pending, then started a
   worker: no live row of the user in any store, and the marker was present.
6. **A deleted conversation** means the job's source is missing, so the job
   completes as `skipped: source-missing` and nothing is learned. A turn
   committing into a conversation another instance deleted is refused
   (`CONVERSATION_DELETED`). The deletion wins, and the local copy and its
   queued writes are dropped.

## 4. Scheduler ownership (single owner, kept)

- One lease row (`aqua_scheduler_leases`, name `worker-schedulers`).
  - Renewed on a timer every TTL/3, independent of the job loop.
  - Released on graceful shutdown.
  - Fails **closed** on a database error: no proof means the schedulers don't
    run.
- **Extraction and learning jobs never touch it.** Every worker claims jobs; only
  the lease holder runs reap, consolidation scan and proactive scan.
- Journey L10:
  - of w1/w2, exactly one owned the lease, with no flapping;
  - after both were killed, exactly one replacement ever owned it;
  - its only loss was during the deliberate database restart, followed by
    re-acquisition.
- Linux:
  - T3: SIGTERM during a renewal blocked on a row lock still released the lease
    and exited 0;
  - T5: a replacement took the released lease at once.

## 5. Settings

| Setting | Default | Meaning |
|---------|---------|---------|
| `AQUA_POST_TURN_DURABLE` (gate) | off | Durable learning; needs history partitions on |
| `AQUA_JOB_HEARTBEAT_STALE_MS` | 120000 | Reclaim threshold; heartbeat every quarter of it |
| `AQUA_WORKER_SHUTDOWN_MS` | 8000 | Worker SIGTERM wait for the job in hand (scripts/worker.mjs; not in the src flag registry, which scans `aqua/src` only) |
| `AQUA_API_SHUTDOWN_MS` | 8000 | API SIGTERM wait for in-flight requests (root index.js; same note) |
| `AQUA_JOB_LOG` | on | Structured `[JOB]` lines |
| `AQUA_SCHEDULER_LEASE_MS` | 60000 | Scheduler lease TTL (Phase 3 prep) |
