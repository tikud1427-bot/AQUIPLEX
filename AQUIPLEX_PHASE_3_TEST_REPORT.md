# AQUIPLEX — Phase 3 Test Report

All tests ran on 2026-11-14/15 against **disposable services only**:

- `aqua-test-db`: pgvector pg16, `localhost:55432`;
- `aqua-test-mongo`: `localhost:57017`;
- every process with its own empty temporary `AQUA_DATA_DIR`.

The real `~/.aquiplex`, the `.env` databases and production were not used.
Provider calls in the journeys are real: free-tier keys from `.env`, read by the
child processes.

## 1. Summary

| Suite | Where | Processes | Result |
|-------|-------|-----------|--------|
| `src/core/tests/phase3Learning.test.js` | Windows, real Postgres | 1 host (in-process) | **17/17** |
| Phase 3 + job + storage + post-turn regression set (19 files) | Windows, real Postgres | 1–4 | **277/277** |
| Bite check (14 mutations of the guarantees) | Windows, real Postgres | 1 | **14/14 caught** |
| Bite check, claim race (old single-statement claim) | Windows, real Postgres | 1 | **caught** |
| `scripts/phase3-learning-journey.mjs --durable on` (final, with DB restart) | Windows | **2 APIs + 5 workers over time**, real HTTP/login/providers | **34/34** |
| `scripts/phase3-linux-shutdown.mjs` | **Linux** (Docker, node 24) | up to 3 workers + 1 API, real signals | **22/22** (runs 3 and 4) |
| Full `npm test` battery | Windows | — | 5747/5784 pass; 13 failures, none caused by Phase 3 after a deliberate pin update (see §6) |

## 2. Real-Postgres suite (`phase3Learning.test.js`, 17 tests)

| Area | Test |
|------|------|
| Durable creation | A committed turn is its 2 message rows plus its learning jobs. The jobs reference the message keys. No job row contains the user's text. |
| No duplicates | A retried enqueue of the same turn creates nothing (`created:false`). |
| Atomicity | If the job insert fails inside the transaction, neither message is written, nothing lingers in the background queue, and the in-memory copy is removed. |
| Not acknowledged | A commit into a conversation deleted by "another instance" fails as `retryable / turn_not_durable`, and the turn memory is not committed. |
| Dependencies | `depends_on`: the dependent job (better priority) waits for its dependency. |
| Fencing | A reclaimed worker's heartbeat, complete and fail are all refused; the new holder completes. |
| Per-owner exclusivity | 8 concurrent claimers × 15 rounds: never two jobs of one owner. **Fails on the old claim.** |
| Release | Back to `queued`, attempts not counted. |
| Lease renewal | A 3 s job with a 1 s stale threshold is never reclaimed while it heartbeats. |
| Poison job | Reclaimed on its last attempt, it is dead-lettered, not re-run forever. |
| Idempotent learning | Jobs delivered twice: turn count +1 once, one Twin marker. |
| Source deleted | A conversation deleted before the job ran: `skipped: source-missing`, nothing learned. |
| Account deleted (pending) | The job does nothing and writes nothing (no Mind row). |
| Account deleted (running) | Deleted while the handler was held mid-run: **no live row** of the user afterwards. |
| DB-unavailable classification | Connection errors → release; job faults → fail. |
| Missing reference | Reads as nothing. |
| Redaction | The worker sees the health sentence removed unless the user opted in; the opt-in flag is in the job, the text is not. |

**Bite check** (`scratchpad/bite3.cjs`). Each mutation was applied, the suite run,
and the file restored byte for byte. All 14 were caught:

- marker ignored;
- complete not fenced;
- depends_on ignored;
- heartbeat ignored by recovery;
- release counts the attempt;
- exhausted job requeued forever;
- jobs outside the message transaction;
- binding deleted-owner check removed;
- worker deleted-owner check removed;
- worker redaction removed;
- user text copied into the payload;
- failed commit acknowledged;
- source deletion ignored;
- DB-unavailable classification broken.

## 3. Application journey (`aqua/scripts/phase3-learning-journey.mjs`)

**Setup.**

- Two APIs: `scripts/start-api.mjs`, ports 5081 and 5082.
- Workers: `scripts/start-worker.mjs`, w1/w2, later w3/w4/w5.
- Each process has its own empty data directory. All 18 stores are on
  partitions, with `AQUA_POST_TURN_DURABLE=on`.
- One browser-like session (a cookie jar) is used on both APIs: real signup,
  e-mail verification from the log (`MAIL_TRANSPORT=log`), and real chat
  through providers.

**Final run (34/34).**

| Scenario | What was checked | Result |
|----------|------------------|--------|
| boot | both APIs ready; both state durable learning ACTIVE; no API started a worker | 3/3 |
| L1 real login | signup → verify → session used on both APIs | 1/1 |
| L2 durable creation | when the API answered, mind/observe/understanding jobs already existed; no job row holds the user's words; streaming turn on the other API ends with `done` | 3/3 |
| L3 learning across instances | Mind turn count exactly 2; learning jobs run by workers; **no API ran a learning job**; recall on B of facts said on A | 4/4 |
| L4 concurrent messages | 4 turns at once across both APIs → turn count +4 exactly; every persisted user message has its job | 3/3 |
| L5 duplicate delivery | 15 learning jobs re-delivered → turn count unchanged; 8 Mind stages recognised their markers | 2/2 |
| L6 worker crash | job running when both workers were killed; a turn taken with no worker is queued; a fresh worker reclaimed and drained everything; that turn was learned once | 4/4 |
| L7 API crash | API killed mid-request; afterwards no persisted user message lacks its job; replacement API with an empty disk ready | 2/2 |
| L8 DB interruption | `docker restart aqua-test-db` during a chat; that turn is refused or fully committed; APIs ready again; workers recovered **without restarting** and learned every committed turn once | 4/4 |
| L9 redaction | a health sentence: not in any job row, not in any store outside the conversation, not in canonical claims | 3/3 |
| L10 scheduler ownership | one owner among w1/w2, no flapping; one owner among w3/w4 (its single loss was during the DB restart, then it re-acquired) | 2/2 |
| L11 account deletion with jobs pending | deletion accepted with 5 learning jobs queued; marker written; after a worker ran, **no live row of the user in any store** | 3/3 |

**Earlier runs. The failures found were real and are fixed:**

| Run | Result | Finding |
|-----|--------|---------|
| durable, with restart (run 1) | 33/34 | L10 check too strict: a fail-closed lease loss during the DB restart is correct. Check corrected. |
| durable, no restart (run 2) | 29/30 | **L4: two workers ran two jobs of the same owner concurrently, 1 ms apart; a turn-count increment was lost.** This was a pre-existing E4 claim race. Fixed with the per-owner advisory lock; regression test added. |
| durable, no restart (run 3) | 29/30 | L4 now correct (3→7). **L9: a health sentence persisted in the user's PIC store.** The request path's verification feedback (`recordReasoningOutcome`, pre-existing) stored the raw message as `query`. Fixed: redacted; guard test added. |
| durable off (baseline) | 16/17 | L11 "jobs pending" cannot hold in off mode: there are no learning jobs. Expected. |

## 4. Linux graceful shutdown

See `AQUIPLEX_LINUX_SHUTDOWN_TEST_REPORT.md`: 22/22, covering the user's seven
cases (T1–T7).

Run 1 found that the worker **exited 143 on SIGTERM without finishing its job
or releasing its lease**: the store layer's SIGTERM handler pre-empted it. This
was a pre-existing defect, invisible on Windows. It is fixed.

## 5. Measurements (local Docker Postgres, Windows host; no capacity claims)

**API latency added by the durable commit.** This is the time from adding the
messages to COMMIT of messages and jobs, on the request path.

| Run | n | p50 | p95 | max |
|-----|---|-----|-----|-----|
| final | 11 | 32 ms | 68 ms | 68 ms |
| run 3 (no restart) | 9 | 27 ms | 44 ms | 44 ms |
| run 1 | 11 | 23 ms | 31 ms | 31 ms |

In exchange, the API no longer runs `memoryAfterTurn` (synchronous before), or
ingest, Twin, reflection and consolidation (deferred, in-process).

**End-to-end chat latency** (client-measured):

- durable: p50 1.9–2.8 s over four runs;
- off: p50 3.8 s.

This is dominated by provider latency and fallbacks: one off-mode turn took
108 s on a provider failover. **It is not a valid comparison of the two modes**
and is not claimed as one.

**Job timings** (final run, from the workers' `[JOB]` lines; first attempts
only for queue wait):

| Kind | Jobs | Processing p50 / p95 / max | Queue wait p50 / p95 / max |
|------|------|-----------------------------|-----------------------------|
| learning.mind.v1 | 18 runs | 10 / 48 / 48 ms | 317 / 3667 / 3667 ms |
| learning.observe.v1 | 18 runs | 91 / 386 / 386 ms | 508 / 3684 / 3684 ms |
| learning.reflect.v1 | 3 | 20 / 44 / 44 ms | 2877 ms |
| understanding.turn.v1 (provider calls) | 9 | 2085 / 4142 / 4142 ms | 966 / 17940 / 17940 ms |

- Queue wait is dominated by **per-owner serialization**: a user's learning jobs
  wait behind that user's `understanding.turn.v1` provider call. In L4 it also
  includes four concurrent turns.
- During the L6 outage (no worker running), queued turns waited up to ~155 s
  (run 1). That wait was the outage itself.

**Retries and failures** (final run, the journey's owner):

- 0 genuine retries (no `retry` lifecycle event);
- 0 dead letters.
- The `attempts > 1` rows (mind 7, observe 7, reflect 1, canary 1) are the
  journey's deliberate re-delivery (L5) and the reclaim (L6).

**Worker memory** (working set, Windows):

- workers: 81–93 MB;
- APIs: 165–175 MB.

The workers' figure is unchanged from the off baseline (72–86 MB).

**DB load** (`pg_stat_database` deltas over a whole journey, without the
restart, which resets the counters):

| Mode | Commits | Rows inserted | Rows updated |
|------|---------|---------------|--------------|
| durable (run 3) | 5847 | 790 | 970 |
| off (baseline) | 7969 | 675 | 943 |

The two runs differ in provider behaviour and in background schedulers: the off
run's proactive scheduler enqueued 183 jobs. So this is a rough indication that
durable mode does not multiply database work, not a precise cost.

## 6. Full battery

Recorded in `AQUIPLEX_PHASE_3_IMPLEMENTATION_REPORT.md` §5, which also lists the
pre-existing failures that are not caused by Phase 3.

## 7. Not tested

- Cloud Run, Cloud SQL, GCS, Render, or any multi-machine network (all processes
  were on one host).
- **Sustained load and capacity.** No load test was run; Phase 6.
- The worker releasing a job because the database failed **while loading the
  owner**, and the `unrecorded` path. Only the classification and the release
  primitive are tested.
- A **graceful** API drain during a real chat turn mid-commit (Linux T7 used an
  unauthenticated request; the journey's L7 was a hard kill).
- More than one worker on Linux processing user learning jobs (the Linux suite
  uses canary jobs).
- `rememberSensitive=true` end-to-end (the opt-in path is unit-tested only).
