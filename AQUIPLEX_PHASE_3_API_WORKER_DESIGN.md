# AQUIPLEX — Phase 3 Design: Independent API and Cognition Worker Entrypoints

**Date:** 2026-11-13 · **Status:** design only. **Not yet implemented, not activated.** Production keeps running exactly as it does today (audit §1: one `node index.js` process on Render).

Inputs: [AQUIPLEX_SCALABILITY_AUDIT.md](AQUIPLEX_SCALABILITY_AUDIT.md) (S5, S10, S11, S12, S13), [AQUIPLEX_PHASE_2B_REPORT.md](AQUIPLEX_PHASE_2B_REPORT.md).

---

## 1. Today

| Process | Entrypoint | Does | Schedulers inside |
|---|---|---|---|
| server | `index.js` (+ `aqua/router.js`) | HTTP, SSE chat, sessions, billing; **post-turn learning in-process** (`turnPostProcess.js`: four `defer` blocks — ingest/observe, E6 enqueue, Mind/world reflection, PIC consolidation) | propagation sweeper (60 s, off by default), metrics publisher (15 s), Mongo mirror heartbeat (30 s) |
| worker | `aqua/scripts/worker.mjs` | claims `aqua_jobs` (`SKIP LOCKED`, per-owner ordering), retries, DLQ, outbox dispatch | stale reap (60 s), consolidation scan (10 min), proactive scan (1 h) — run by **every** worker, deduplicated only by idempotency key |
| launcher | `aqua/scripts/start-production.mjs` | spawns both; one dies → both stop | — |

## 2. Target

### 2.1 Entrypoints

| Script | Starts | Never starts |
|---|---|---|
| `scripts/start-api.mjs` (new) | `index.js` with `AQUA_ROLE=api` | the job loop, any periodic scheduler other than its own metrics publisher |
| `scripts/start-worker.mjs` (new; today's `worker.mjs` body) | the durable job loop with `AQUA_ROLE=worker` | HTTP |
| `scripts/start-scheduler.mjs` (new, optional) | the periodic schedulers only, under a lease (§2.3) | HTTP, job execution |
| `scripts/start-production.mjs` | **unchanged** — the single-host combined mode stays valid for Render | — |

`AQUA_ROLE` is a registered setting read once at boot and printed in the boot line. Unset = today's behaviour (`combined`).

### 2.2 Post-turn work becomes durable (the precondition for a stateless API)

Each of the four `defer` blocks becomes a job kind enqueued idempotently with key `<conversationId>:<turn>:<kind>` (the queue already absorbs duplicates on `(owner_id, idempotency_key)`). Per-owner ordering is the existing claim predicate. Order of migration, gated per block by `AQUA_POST_TURN_DURABLE=<list>`:

1. E6 enqueue — already durable (`understanding.turn.v1`); nothing to do.
2. Reflection (`reflectTurn`) — reads/writes reflection + graph + evidence; requires those stores `on` (reflection, graph done in Phase 2b; evidence remaining).
3. Observe/ingest — Mind, ids, graph, conversations: requires Mind/ids/graph/history `on` (done in Phase 2b).
4. PIC consolidation — requires `pic` (remaining).

A block may move to the worker **only when every store it writes is partition-authoritative**; otherwise the worker would write a JSON copy the API never reads. The design keeps the in-process path as the rollback for each block.

Why it matters on Cloud Run: with request-based billing the CPU is throttled after the response, so in-process post-turn work would stall. Until all four blocks are durable, the API must run with **CPU always allocated** (instance-based billing).

### 2.3 One designated owner per periodic scheduler

A lease table (`aqua_scheduler_leases(name PK, holder, expires_at)`), acquired with a conditional `UPDATE … WHERE expires_at < now() OR holder = $me` and renewed at a third of the TTL. Chosen over `pg_advisory_lock` because session-level advisory locks do not survive a transaction-pooling connection pooler (PgBouncer / Cloud SQL connector in transaction mode).

| Scheduler | Today | Target owner |
|---|---|---|
| stale-job reap | every worker | lease `reap` |
| consolidation scan | every worker (idempotent) | lease `consolidation` |
| proactive scan | every worker (idempotent) | lease `proactive` |
| outbox dispatch | every worker, each loop | stays per worker (row-claimed, safe) |
| propagation sweeper | API process | lease `propagation`, moved to scheduler role |
| instance-aggregate fold (Phase 2b §5) | — | lease `aggregate-fold` |
| DLQ policy evaluation | — | lease `dlq` |
| Mongo mirror heartbeat | every process | unchanged while the mirror exists; retired when all stores are `only` |

### 2.4 Worker guarantees (existing, to be kept and re-tested in the split runtime)

Multiple workers (`SKIP LOCKED`), per-owner ordering (claim predicate), idempotency (`(owner_id, idempotency_key)` + commit ledger), retry with capacity-aware backoff, dead-letter with reasons (`dlqPolicy.js`), stale-job recovery (`reapStale`, 10 min), graceful shutdown (finish the job in hand). Phase 2b adds: the job's owner is loaded into every partition-authoritative store before the handler runs, and a database failure there fails the job (retried) rather than running on unknown state.

### 2.5 API shutdown and readiness

| Need | Design |
|---|---|
| SIGTERM | stop accepting (`server.close()`), end SSE streams with a final `event: retry` after ≤ 8 s (Cloud Run gives 10 s), then the existing storage/mirror/job drains. Today `process.exit` runs after the drains without closing the server (audit S11). |
| Liveness | `/health` unchanged |
| Readiness | new `/ready`: Mongo connected, Postgres reachable (`pool.isReachable`), router mounted, partition bindings configured. 503 until all hold. |
| Pool budget | `PGPOOL_MAX` per role (API small, worker small), total ≤ Cloud SQL connection limit / max instances; documented in the Cloud Run architecture (Phase 5). |

## 3. Acceptance tests (to write before implementation)

1. API role: no job is claimed, no scheduler timer exists (assert on process handles + log lines).
2. Worker role: no port is opened.
3. Two workers + one API on the test database: a scripted chat journey; every post-turn job runs exactly once, per-owner order kept, no store diverges (reconcile clean).
4. Kill -9 one worker mid-job: the job is reclaimed after the reap interval and completes once.
5. Two scheduler processes: each lease held by exactly one at a time; holder killed → taken over within TTL.
6. API SIGTERM during an SSE stream: the stream ends cleanly, the turn's post-turn job is in the queue.
7. `/ready` is 503 with Postgres down, 200 when it returns.

## 4. Explicitly out of scope until authorised

Activating any role in production; Cloud Run deployment; enabling `AQUA_STORE_PARTITIONS` anywhere but the test database; running more than one production writer.
