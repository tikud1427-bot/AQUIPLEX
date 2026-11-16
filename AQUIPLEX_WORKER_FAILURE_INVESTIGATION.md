# AQUIPLEX — Worker Failure Investigation (Phase 4B)

**The failure.** In the first complete Linux API shutdown run of Phase 4A (20/23,
ended 2026-11-15 06:00:28 UTC; raw output in
`scratchpad/linux4a-out-run2/`), check A6 failed.

- A freshly started worker left **every** learning job of the test user
  `queued` for the whole 120 s window: mind 4, observe 4, reflect 1. None was
  ever `running`.
- The harness then captured no worker output.
- The next two runs passed.

Phase 4A listed the cause as undetermined.

**Conclusion: root cause identified, with evidence from the database itself. It
was not a hang, a crash or lost work. It was priority starvation.**

## 1. Instrumentation added (`aqua/scripts/worker.mjs`)

One `[WORKER] {json}` line per lifecycle event, and a summary every `--diag` ms
(default 10 s; the Cloud Run template uses 30 s):

| Event | Content |
|-------|---------|
| `boot` | pid, node version, poll / reap / lease / heartbeat / shutdown settings, kinds filter |
| `db-connected` / `db-error` | first query latency + queue counts / the error and its code. A worker that cannot reach the database **exits** (fail-closed), it does not idle. |
| `partitions-configured`, `ready` | startup steps with timings |
| `first-lease-done`, `lease-acquired`, `lease-lost`, `lease-error` | scheduler ownership and renewal errors |
| `claim-error` | every failed claim (error + code) |
| `reaped` | jobs recovered from dead workers |
| `summary` | polls, claimed, empty polls, claim errors, last claim error, ms since the last poll and the last claim, current step and how long it has lasted, scheduler owner, in-flight jobs, and **queue lag per priority band** (`queueLag()`: runnable jobs and the age of the oldest) |
| `shutdown-begin`, `shutdown-end` | signal, the job in hand, clean or past the deadline, duration |

A worker that "processes nothing" now says which of these it is:
- not polling;
- polling but claiming nothing;
- claims failing;
- stuck in one step;
- busy, with a band whose queue lag keeps growing.

## 2. Hypotheses and how each was tested

| # | Hypothesis | Test | Result |
|---|-----------|------|--------|
| H1 | Orphaned Postgres sessions: a SIGKILLed container process leaves its backend alive (Docker Desktop's network proxy keeps the TCP connection), holding locks | `scratchpad/orphan-probe.sh`: a process in the container takes an advisory lock and a row lock in an open transaction, then SIGKILLs itself; `pg_stat_activity` / `pg_locks` checked | **Rejected.** The backend was gone within 1 s. |
| H2 | Same, for a client whose query was **blocked on a lock** when it died (the A4 situation) | `scratchpad/orphan-probe2.sh`: victim blocked on a `FOR SHARE` behind a holder, SIGKILLed; holder releases after 6 s; checked at +0/5/15 s | **Rejected.** No orphan, no lock. |
| H3 | The worker never started, or crashed at boot | A fresh, instrumented reproduction with the same harness | Not reproduced: the worker booted, connected, claimed. |
| H4 | **Starvation**: the worker was busy with other owners' higher-priority jobs in the **shared** test queue | **Database history of the failing window** (below), plus a deliberate reproduction with a backlog | **Confirmed** |

## 3. The evidence

The queue keeps every job row with its timestamps. Jobs finished or updated
during the failing A6 window (05:58:28–06:00:28 UTC):

| Kind (priority) | What happened | When |
|-----------------|---------------|------|
| `claim.contradiction.v1` (25) | 72 done | 05:58:29–05:58:31 |
| `claim.reflection.v1` (30) | **1,228 done** | 05:58:31–05:59:28 |
| `claim.embedding.v1` (40) | 989 jobs repeatedly failing and re-queued (no embedding key inside the container; backoff 2, 4, 8, 16 s; 5 attempts each). Their earlier attempts were overwritten; they were dead-lettered at 06:02:59–06:03:19 by the **next** run's worker. | 05:59:28 → past the window |
| `learning.*` (50–70), the test user's | **never reached** | — |

The worker was therefore alive and busy for the whole window.

- It worked through 1,300 jobs of priority 25–30.
- It then spent the rest of the window on ~989 × 5 embedding attempts of priority
  40. Each failed in milliseconds and came back runnable a few seconds later, so
  some priority-40 job was always available ahead of every priority-50 job.
- The next run passed because its worker dead-lettered the remaining embedding
  jobs (06:03:19) and reached the learning jobs within seconds (06:03:19).

The backlog came from the full test battery run the night before. Its live
suites enqueue claim reflections, contradictions and embeddings for test users
and leave them queued. The Linux harness shares that disposable database, and
its A6 check counted only its own user's jobs.

## 4. Why it matters beyond the test

The claim order was **strict priority**, then age. In production the same
mechanism means this: a sustained stream of higher-priority work keeps
lower-priority work waiting **without bound**. An example is embedding jobs
retrying every few seconds during an embedding-provider outage. That would delay
every user's post-turn learning (priority 50–70) for as long as the stream lasts.

## 5. Fix: aging

`core/jobs/jobQueue.js` `claim()` now orders by an **aged priority**:

```
effective = priority − min(100, floor(seconds runnable / AQUA_JOB_AGING_SECONDS))
```

- `AQUA_JOB_AGING_SECONDS` defaults to 5; 0 restores strict priority.
- A job waiting 50 s outranks a freshly retried job 10 points better.
- Among fresh jobs, strict priority is unchanged.
- Both claim paths (transactional and fallback) use it.

**Regression tests** (`aqua/src/core/tests/phase4bWorker.test.js`, real Postgres;
**4/4**):

1. **Aging:** a priority-50 job runnable for 40 aging points is claimed before
   ten fresh priority-40 jobs. Fresh jobs keep strict order.
2. **Starvation:** 8 priority-40 jobs re-queued immediately after every claim (a
   permanent stream). The priority-50 job must be claimed within a bound: it was
   claimed in about 0.5 s. **With aging disabled (bite check) it was never
   claimed in 10 s.** That reproduces the original failure deterministically.
3. **Startup:** a real worker process emits, in order: `boot` → `db-connected` →
   `partitions-configured` → `ready` → `first-lease-done` → `summary`, with
   polls > 0 and queue lag.
4. **Fail-closed:** a worker whose database is unreachable logs `db-error` and
   exits non-zero.

**Harness fix.** The Linux harness now records the claimable backlog when A6
starts and parks other owners' runnable jobs for the duration of A6 (restored
afterwards). It also saves the worker's log every run.

**Verification:**
- A reproduction run with a 150-job backlog: 24/24. The worker drained the
  backlog and the user's jobs.
- The Phase 4B Linux run with charges: 28/28.

## 6. What remains

- Aging bounds **waiting**, not **throughput**. A backlog larger than the workers
  can process still delays everyone: one worker, one job at a time. The worker
  summary's queue lag is the signal to add workers; alerting on it is a Phase 5
  item.
- The investigation used the database history of a single failing run. The
  mechanism is proven by the deterministic starvation test and the bite check,
  but the exact claim interleaving of that run was not recorded.
