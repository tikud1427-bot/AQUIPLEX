# AQUIPLEX — Phase 4 Readiness Report (after Phase 3)

Phase 4 (distributed infrastructure: GCS object store, Cloud SQL, Cloud Run
services) has **not** been started. Nothing has been deployed, provisioned or
enabled. This report says what Phase 3 makes possible, what still blocks a
rollout, and answers the Cloud Run CPU question. It does not change any Cloud
Run configuration.

## 1. What Phase 3 delivers toward Phase 4

| Capability | State |
|------------|-------|
| API runs no post-turn learning (gate on) | Implemented, tested (journey L3: no API ran a learning job) |
| Learning survives API exit, worker crash, DB restart | Tested (journeys L6/L7/L8, Linux T6) |
| Graceful SIGTERM for workers and API, on Linux | Tested 22/22 (after fixing a real defect) |
| Multiple workers safe; one scheduler owner | Tested (journeys L10, Linux T3/T5, phase3Roles) |
| Per-request owner load (stateless API instances) | Phase 2c, unchanged |
| Structured job lifecycle logs; queue-derived timings | Implemented |

## 2. Can Cloud Run use request-based CPU allocation for the API?

**Not yet. With the gate on it is close, but three things still run after the
response and would be throttled.** From the code:

1. **The request's own store writes are flushed by debounce timers *after* the
   response.**
   - The turn's memory extraction (prepareTurn → Mind/evidence/etc.) marks owner
     partitions dirty.
   - `ownerBinding`/`keyedBinding` write them ~50 ms later on a timer.
   - The durable commit covers only the **messages and jobs**.
   - With CPU throttled between requests, those writes would wait for the next
     request on the instance. Other instances would read the owner's
     pre-turn state meanwhile.
   - The SIGTERM drain would still flush them at scale-in, but staleness across
     instances is a correctness problem.

   **Required:** the turn path awaits `flushOwnerBindings` for that owner before
   acknowledging, as the worker already does (`flushOwnerBindingsStrict`).
   About one round trip; not measured yet.
2. **`recordOutcome` / `recordTurnCost`** run in a post-response defer, and
   `instanceAggregate` syncs on a timer. These are global heuristics: delay is
   harmless, but at scale-in they are flushed only by the drain.
3. **Background timers in the API process:**
   - Mongo mirror heartbeat (mirror disabled in the split runtime tests);
   - process-metrics publisher;
   - telemetry export.

   All would stall. None is user data.

**Recommendation.**

- Keep **CPU always allocated** for the API until (1) is done and measured.
- After (1), request-based CPU is plausible. It must be validated by a load test
  on Cloud Run itself (Phase 6). It cannot be inferred from these local tests.
- Workers must **always** have CPU allocated: they are long-running pollers and
  have no requests.

## 3. Blockers and prerequisites for Phase 4

| # | Item | Why |
|---|------|-----|
| 1 | Turn path awaits its own owner flush | Cloud Run CPU (§2), and cross-instance freshness |
| 2 | `AQUA_POST_TURN_DURABLE` requires history partitions **on**, so the production history must be migrated to partitions first (Phase 2 tooling exists: `partition-migrate.mjs`) | The commit needs message rows |
| 3 | Same flags on API and workers (`AQUA_E6`, `AQUA_BRAIN*`, `AQUA_TWIN_V2`, `AQUA_REFLECT_V2`, `AQUA_CONSOLIDATE`) | The worker decides stage gates when the job runs; the API decides only E6 and the reflect cadence |
| 4 | Object store for artifacts (`AQUA_OBJECT_STORE=gcs`) is not implemented; it refuses | Phase 4 scope |
| 5 | Exit code 143 after a clean API drain | The platform's health semantics must accept it (or map it to 0) |
| 6 | Worker recovery window with defaults: heartbeat 120 s + reap 60 s | May want a lower heartbeat on Cloud Run; the 10 s grace period means long jobs are released at SIGTERM, not finished |
| 7 | Pool sizing: each API process holds one connection per in-flight turn commit; each worker one per job plus heartbeats | Must be sized against Cloud SQL connection limits (not measured) |

## 4. What has NOT been established (no capacity claims)

- No throughput or concurrency limit was measured.
  - The journeys ran 2 APIs + 2 workers with a handful of concurrent turns.
  - Commit overhead: p50 23 ms over 11 turns, on a local Docker Postgres.
  - Neither number predicts Cloud SQL latency or load behaviour.
- No test ran on Cloud Run, Cloud SQL, GCS or Render.
- Provider rate limits, not the job system, dominated end-to-end chat latency
  in every run.

## 5. Suggested Phase 4 order (for approval, not started)

1. Turn path awaits its owner flush (item 1). Measure it.
2. Staging migration of history to partitions on a copy of production data
   (never production), with the durable gate on.
3. GCS object-store backend.
4. Cloud Run service definitions (API: CPU always allocated; workers: min
   instances ≥ 1), then Phase 6 load tests there.
