# AQUIPLEX — Phase 3 Readiness Report: Independent API and Cognition Workers

**Date:** 2026-11-14 · **Status:** entrypoints **implemented and tested locally against the disposable Postgres**; **not activated** anywhere. Render, DNS, Cloud SQL and production environment variables were not touched. Nothing was committed or deployed.

Status labels as in [AQUIPLEX_SCALABILITY_AUDIT.md](AQUIPLEX_SCALABILITY_AUDIT.md) §0. Design: [AQUIPLEX_PHASE_3_API_WORKER_DESIGN.md](AQUIPLEX_PHASE_3_API_WORKER_DESIGN.md).

---

## 1. What is ready for review

| Item | Where | Status |
|---|---|---|
| API-only entrypoint: `npm run start:api` → `scripts/start-api.mjs` (`AQUA_ROLE=api`, starts `index.js` only) | new file | Implemented · tested (journey: two API instances, no worker in either) |
| Worker-only entrypoint: `npm run start:worker` → `scripts/start-worker.mjs` (`AQUA_ROLE=worker`, runs `aqua/scripts/worker.mjs`, no HTTP) | new file | Implemented · tested (a preload makes any `listen()` fatal; never triggered) |
| API runs no periodic scheduler | `aqua/router.js` (propagation sweeper skipped when `AQUA_ROLE=api`) | Implemented · boot line asserted |
| Single scheduler owner among workers | `core/jobs/schedulerLease.js`, migration `0029_scheduler_leases.sql`, `worker.mjs` | Implemented · tested: one holder; a killed owner replaced within the TTL; a new owner runs every scheduler at once. **The lease is renewed by an independent timer.** The application journey found ownership flapping when renewal ran only between jobs, because a 7 s extraction outlived the TTL. Fixed, and the final journey run showed stable ownership |
| Readiness endpoint `/ready` (Mongo, engine mounted, Postgres reachable, not draining) | `index.js` (new route; `/health` unchanged) | Implemented · tested (journey waits on it) |
| SIGTERM drain for the API (stop accepting, report not-ready, then the existing drains) | `index.js`, **only when `AQUA_ROLE` is set** | Implemented · **not tested** (see §4) |
| Unit-of-work owner load in the worker (fails the job, so it retries, when the DB cannot answer) | `workerRuntime.runOneJob` (Phase 2b) | Implemented · tested |
| `start:production` (combined launcher) | unchanged | today's Render contract preserved |

## 2. Preserved guarantees, with evidence

| Guarantee | Mechanism (existing unless noted) | Evidence |
|---|---|---|
| Durable job queue | `aqua_jobs` (E4) | unchanged |
| Idempotency | `(owner_id, idempotency_key)` unique; commit ledger | existing `jobQueue.test.js` |
| Per-owner ordering | claim predicate `NOT EXISTS running for owner` + `SKIP LOCKED` | `phase3Roles.test.js`: 3 workers, 60 jobs over 6 owners: each job **once** (attempts = 1), **no overlap** within an owner, work shared across workers |
| Retry | capacity-aware backoff | existing tests |
| Dead-letter | `fail()` past `max_attempts`, reason kept | `phase3Roles.test.js`: an unknown kind dead-letters with "no handler registered" |
| Recovery after worker termination | `reapStale` (10 min) by the scheduler owner | `phase3Roles.test.js`: a job left `running` by a vanished worker is reclaimed and completed. Journey S9/S11: workers killed, a fresh worker drains everything |
| Single scheduler ownership | lease (new) | `phase3Roles.test.js` |
| SIGTERM (worker) | finishes the job in hand, releases the lease (new), exits | **not tested on this machine** (§4) |

## 3. Storage precondition for multi-instance

Multi-instance deployment is safe only when **every owner store is `on` (or `only`)**. In `off` or `shadow` the whole-file behaviour applies, including the server/worker overwrite (audit S6). The matrix [AQUIPLEX_STORE_OWNERSHIP_MATRIX.md](AQUIPLEX_STORE_OWNERSHIP_MATRIX.md) shows no unresolved conflicting-writer behaviour with partitions on. The application journey ran the split runtime this way: two APIs, two workers, separate empty disks, all stores `on`. See [AQUIPLEX_APPLICATION_INTEGRATION_TEST_REPORT.md](AQUIPLEX_APPLICATION_INTEGRATION_TEST_REPORT.md).

**Do not activate multi-instance** until the rollout in [AQUIPLEX_PHASE_2C_REPORT.md](AQUIPLEX_PHASE_2C_REPORT.md) §6 has taken every owner store to `on` in production, with reconcile clean.

## 4. Unverified, and why

| Item | Why not verified | How to verify (Linux CI or a staging VM) |
|---|---|---|
| Graceful SIGTERM of API and worker | On Windows, `child.kill()` is TerminateProcess: no handler runs. The repository's existing SIGTERM tests skip on Windows for the same reason. | send SIGTERM during an SSE chat and during a long job; assert `/ready` → 503, the stream ends, the job completes once and the lease is released |
| In-process post-turn work in the API | Still runs in the API after the response (design §2.2) | needs the four post-turn blocks moved to durable jobs. Until then Cloud Run must run the API with **CPU always allocated** |
| Connection budget under N instances | not measured | Phase 5/6 |
| Cloud Run behaviour (cold starts, CPU throttling, 10 s SIGTERM grace) | no Cloud Run deployment exists | Phase 5 staging |

## 5. Proposed Phase 3 implementation steps (for review, not done)

1. Linux CI job running the role tests plus a SIGTERM test of both roles.
2. Move post-turn blocks to durable jobs in the design's order, each behind `AQUA_POST_TURN_DURABLE`, with the in-process path as rollback.
3. Staging: two API instances and two workers against a non-production Cloud SQL, all stores `on`, the application journey run against it.
4. Only then: Cloud Run configuration (Phase 5).
