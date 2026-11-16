# AQUIPLEX — Cloud Run Configuration Plan (Phase 4B)

Date 2026-11-15.

**Templates only. Nothing was deployed, created or activated.** No project,
service, worker pool, Cloud SQL instance, bucket or secret exists because of this
work.

Templates: `deploy/cloudrun/api.service.yaml` and
`deploy/cloudrun/worker.workerpool.yaml`. Their consistency with the code is
checked by `aqua/src/core/tests/cloudRunTemplates.test.js` (8/8):
- every variable they set is one the code reads;
- no secret is inline;
- the same durability flags and partition list in both;
- the probes, entrypoints and CPU setting below.

## 1. Services

| | API | Worker |
|-|-----|--------|
| Resource | Cloud Run **service** `aquiplex-api` | Cloud Run **worker pool** `aquiplex-worker` (no HTTP) |
| Entrypoint | `node scripts/start-api.mjs` (`AQUA_ROLE=api`: HTTP only, no job processing, no periodic schedulers) | `node scripts/start-worker.mjs --poll 750 --diag 30000` (`AQUA_ROLE=worker`: jobs only; never listens) |
| Size | 1 vCPU, 1 GiB | 1 vCPU, 1 GiB |
| Scaling | min 1, max 4 instances (to be revised by the Phase 6 load test) | fixed instance count; start with 1, add instances when queue lag grows (§6) |
| Concurrency | `containerConcurrency: 40` requests per instance | **one job at a time per process**; scale by instances |
| Request timeout | 300 s (SSE chat streams); Cloud Run's maximum is 3600 s | — |
| CPU | **always allocated** (`run.googleapis.com/cpu-throttling: "false"`), §5 | always running by nature |
| Execution environment | gen2 | gen2 (worker pools are gen2 only, per the docs) |

**Worker pools: verify before use.** Google's documentation shows both
`gcloud beta run worker-pools` and `gcloud run worker-pools`, with a BETA
launch-stage annotation in YAML examples. Their GA status in the chosen region
could not be confirmed.

If worker pools are not available, the fallback is a **Compute Engine managed
instance group**: a container-optimised OS running the same image and command,
1 instance, with autohealing on process exit. The application needs no change:
the worker does not listen on any port by design.

## 2. Database connections

- **Cloud SQL for PostgreSQL 16**, via the Cloud SQL connector:
  - the annotation `run.googleapis.com/cloudsql-instances:
    PROJECT:REGION:INSTANCE`;
  - the Unix socket `/cloudsql/PROJECT:REGION:INSTANCE`;
  - `DATABASE_URL=postgresql://USER:PASS@/aqua?host=/cloudsql/PROJECT:REGION:INSTANCE`,
    held in Secret Manager.
- **Pool per process:** `PGPOOL_MAX` 10 (API), 5 (worker); `PGPOOL_CONNECT_MS`
  5000.
- **Connection budget**, which must hold:
  `maxAPI × PGPOOL_MAX + workers × PGPOOL_MAX + operators/migrations ≤ max_connections − reserve`.
  With the template values: 4 × 10 + 2 × 5 + 10 = 60 connections. That fits a
  small dedicated-core instance. Check `max_connections` of the chosen tier: the
  shared-core tiers allow fewer.
- **Migrations** (0001–0031) run once, by an operator, before the first deploy:
  `npm run db:migrate` against the target. The API and worker check the schema
  at boot but do not migrate.
- **Mongo** (users, sessions, wallet, billing) stays where it is (`MONGO_URI`, a
  secret). Moving it is outside Phase 4B.

## 3. Environment and feature flags

| Group | API | Worker |
|-------|-----|--------|
| Storage | `AQUA_STORE_PARTITIONS` = every store `on`; `AQUA_DISABLE_MONGO_MIRROR=1`; `AQUA_DATA_DIR=/tmp/aqua-data`, `AQUA_ARTIFACTS_DIR=/tmp/aqua-artifacts` (local caches only, in memory) | same |
| Objects | `AQUA_OBJECT_STORE=gcs`, `AQUA_GCS_BUCKET` | same |
| Durability | `AQUA_POST_TURN_DURABLE=on`, `AQUA_PENDING_CHARGES=on` | same |
| Jobs | — | `AQUA_JOB_HEARTBEAT_STALE_MS=30000`, `AQUA_JOB_AGING_SECONDS=5`, `AQUA_SCHEDULER_LEASE_MS=60000`, `AQUA_CHARGE_ABANDON_MS=900000`, `AQUA_CHARGE_RECONCILE_INTERVAL_MS=60000` |
| Shutdown | `AQUA_API_SHUTDOWN_MS=7000`, `AQUA_SHUTDOWN_BUDGET_MS=9500` | `AQUA_WORKER_SHUTDOWN_MS=7000`, `AQUA_SHUTDOWN_BUDGET_MS=9500` |
| Mail | `MAIL_TRANSPORT=resend`, `MAIL_FROM` | — |

**Intelligence feature flags** (`AQUA_E6`, `AQUA_BRAIN*`, `AQUA_TWIN_V2`,
`AQUA_REFLECT_V2`, `AQUA_CONSOLIDATE`, …) are **not** set in the templates. They
keep their code defaults until a product decision.

**The API and worker must carry identical values for them.** The worker decides
stage gates when a job runs (Phase 3 risk). Deploy both from one environment
definition.

## 4. Secrets (Secret Manager; never in YAML or images)

| Secret | API | Worker |
|--------|-----|--------|
| `aquiplex-database-url` | ✔ | ✔ |
| `aquiplex-mongo-uri` | ✔ | ✔ (the charge reconciler refunds wallets) |
| `aquiplex-session-secret` | ✔ | |
| `aquiplex-google-client-id` / `aquiplex-google-client-secret` | ✔ | |
| `aquiplex-razorpay-key-id` / `aquiplex-razorpay-key-secret` / `aquiplex-razorpay-webhook-secret` | ✔ | |
| `aquiplex-resend-api-key` | ✔ | |
| `aquiplex-groq-api-key-1`, `aquiplex-gemini-key-1`, `aquiplex-nvidia-api-key-1`, … (one per key in the pool) | ✔ | ✔ |
| `aquiplex-serper-api-key` | ✔ | |

**Service accounts:**
- **API:** `roles/cloudsql.client`, `roles/secretmanager.secretAccessor` on its
  secrets only, object read/create/delete on the bucket only.
- **Worker:** the same, minus the web secrets.

Exposed credentials listed in earlier audits must be **rotated before** they are
placed in Secret Manager.

## 5. Health, readiness, graceful shutdown

**Probes:**
- **Startup probe: `GET /ready`.** It answers 200 only when Mongo is connected,
  the engine is mounted and Postgres is reachable, and the instance is not
  draining.
- **Liveness probe: `GET /health`.** It never touches a database, so a database
  outage does not restart healthy instances.

**Shutdown.** Cloud Run sends SIGTERM and kills the instance 10 s later.

- **API (tested on Linux):**
  - stops accepting connections;
  - waits up to 7 s for in-flight requests: a turn completes durably or not at
    all;
  - drains the stores within what is left of 9.5 s, then exits.
  - Measured exit times: 1.6–2.8 s with requests in flight; 9.5 s with a stuck
    transaction (Phase 4A).
- **Worker (tested on Linux):**
  - finishes the job in hand, or releases it at 7 s (attempt not counted);
  - flushes;
  - releases the scheduler lease;
  - exits 0.
  - A SIGKILLed worker's job is reclaimed when its heartbeat is 30 s stale.

## 6. CPU allocation: what can be request-based

**Request-based CPU allocation** means the CPU is throttled outside requests.

| API work | After the response? | Request-based safe? |
|----------|---------------------|---------------------|
| Chat turn: preparation writes, messages, learning jobs, charge, effects (Phases 3–4A) | no: all durable **before** the response | ✔ |
| Mutating requests' writes (the response gate) | no | ✔ |
| Credit refunds and ledger rows | no (awaited) | ✔ |
| Post-turn learning | no: worker jobs | ✔ |
| Fact embeddings | no: worker job `memory.index.v1` | ✔ |
| `recordOutcome` / `recordTurnCost` → per-instance statistics rows (cognition, ledger), synced on a timer | **yes** | ✔ for correctness (global heuristics, lag only); the stats sync is delayed while throttled |
| PIC background consolidation (3 s debounce) | **yes** | ✔ for correctness (idempotent maintenance; also a worker job); delayed |
| Process metrics publisher, telemetry export | **yes** | metrics and spans arrive late or are lost at scale-in |
| Effects slower than their 3 s wait (rare, counted) | **yes** | they finish late |
| SIGTERM drain | Cloud Run allocates CPU during the 10 s grace | ✔ |

**Conclusion.** No required user state depends on CPU after a response. The API
**can** use request-based allocation for correctness. What it would degrade:
- the freshness of routing statistics;
- PIC maintenance timing;
- observability.

**Recommendation.** Start with CPU **always allocated**, as in the template. Plan
an experiment in staging (Phase 5/6): request-based allocation, under load,
comparing latency, statistics lag and cost. Switch only on that evidence.

**Workers must always have CPU.** They poll and have no requests.

**Worker scaling signal.** The worker's `summary` line carries the queue lag per
priority band. Add a worker instance when the oldest runnable learning job
(priority 50–70) waits longer than an agreed bound (for example 60 s) for
several minutes. This is a Phase 5 alerting item.

## 7. Not done (requires authorisation)

- Building or pushing the container image.
- Creating the project, service accounts, secrets, Cloud SQL, the bucket.
- Deploying either template; configuring a domain, TLS, DNS.
- Choosing the region: the cost estimate assumes a Tier 1 US region; an Indian
  region changes prices.
