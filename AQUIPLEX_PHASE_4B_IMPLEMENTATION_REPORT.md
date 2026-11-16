# AQUIPLEX — Phase 4B Implementation Report: Infrastructure Readiness

Date 2026-11-15.

**Uncommitted on `main` (HEAD `839ea0d1`).** None of the following was touched:
production, Render, DNS. None of the following was created: Cloud SQL, a GCS
bucket, any deployment. No production data was read or exported, no production
credential was used, and `~/.aquiplex` was not modified.

Every new behaviour is behind a flag that is off by default:
- `AQUA_PENDING_CHARGES`;
- `AQUA_OBJECT_STORE=gcs`, which applies only with artifacts on partitions.

The exceptions apply to every configuration:
- **job aging** (`AQUA_JOB_AGING_SECONDS`, default 5 s; 0 restores the old
  behaviour);
- the artifact read paths;
- the worker diagnostics.

Companion reports:
- `AQUIPLEX_PENDING_CHARGE_RECOVERY_REPORT.md`
- `AQUIPLEX_WORKER_FAILURE_INVESTIGATION.md`
- `AQUIPLEX_GCS_STORAGE_IMPLEMENTATION_REPORT.md`
- `AQUIPLEX_ARTIFACT_MIGRATION_READINESS.md`
- `AQUIPLEX_CLOUD_RUN_CONFIGURATION_PLAN.md`
- `AQUIPLEX_INITIAL_INFRASTRUCTURE_COST_ESTIMATE.md`
- `AQUIPLEX_PHASE_5_READINESS_REPORT.md`

## 1. Status at a glance

| Category | Items |
|----------|-------|
| **Implemented** | pending-charge state machine + idempotent wallet operations + reconciler job/CLI + account purge + ledger reconciliation; job aging + queue lag + worker diagnostics; GCS object-store backend; artifact streaming reads with no local copy; classic-layout fetch; artifact migration CLI; Cloud Run templates; cost estimate; operator export procedure |
| **Tested with real PostgreSQL (+ real Mongo where relevant)** | charges 16/16 (crash at every boundary); worker 4/4; object stores 8/8; artifact migration 2/2; conversation migration 7/7; artifact audit 3/3; templates 8/8 |
| **Tested on Linux** | API shutdown with pending charges, **28/28**: dead-turn charge refunded, ledger clean. Worker starvation reproduction 24/24. |
| **Tested with multiple processes** | multi-instance journey (2 APIs, workers, real providers, DB restart, API crash, charges) **37/37**; artifacts created / streamed / edited / deleted across two processes on the GCS emulator; charge crash tests in separate processes |
| **Not tested** | real GCP (IAM, real GCS, Cloud SQL, Cloud Run grace, worker pools); production data; load; Mongo replica-set failover |
| **Not activated** | everything: the flags above are off; templates not applied; no resource exists |

## 2. What changed

| Area | Files | What |
|------|-------|------|
| Pending charges | `aqua/src/core/db/migrations/0031_pending_charges.sql`, `aqua/src/credits/pendingCharges.js`, `aqua/src/credits/reconcileJob.js`, `services/credits/pendingChargeWallet.js`, `services/credits/wallet.service.js` (`deductCredits({chargeId})`, `refundCharge`), `models/User.js` (`wallet.appliedCharges` / `refundedCharges`), `middleware/usage/checkUsage.js` (7a), `aqua/src/routes/turnPostProcess.js` + `routes/chat.js` (commit in the turn's transaction), `aqua/src/core/storage/responseGate.js` (settle), `aqua/src/account/accountPurge.js`, `aqua/scripts/charges-reconcile.mjs`, worker scheduler | PENDING → COMMITTED / REFUND_PENDING → REFUNDED / VOID, every move conditional and recorded; wallet debit and refund at most once per charge |
| Worker failure | `aqua/scripts/worker.mjs` (diagnostics), `aqua/src/core/jobs/jobQueue.js` (aging, `queueLag`), harness isolation | root cause: priority starvation (investigation report) |
| GCS | `aqua/src/core/storage/objectStore.js` (`createGcsObjectStore`, `getStream` on both backends), `aqua/src/artifacts/artifactStore.js` (`openArtifactFileStream`, `readArtifactFile`, classic fetch, `ARTIFACT_OBJECT_MISSING`, no eager local copy), `routes/artifacts.js`, `artifacts/editEngine.js` | shared, owner-isolated, write-once storage; readable on any instance |
| Migration | `aqua/scripts/artifact-migration.mjs`, procedure in the readiness report | plan / upload / rows / verify / export |
| Cloud Run | `deploy/cloudrun/api.service.yaml`, `deploy/cloudrun/worker.workerpool.yaml` | templates only |
| Flags | `AQUA_PENDING_CHARGES` (gate), `AQUA_CHARGE_ABANDON_MS`, `AQUA_CHARGE_RECONCILE_INTERVAL_MS`, `AQUA_CHARGE_CRASH_AT` (test seam), `AQUA_JOB_AGING_SECONDS`, `AQUA_GCS_BUCKET`, `AQUA_GCS_ENDPOINT` | census 49 gates / 66 settings / 115 read |
| Tests | `aqua/src/credits/tests/pendingCharges.live.test.js`, `aqua/src/core/tests/phase4bWorker.test.js`, `objectStoreGcs.test.js`, `cloudRunTemplates.test.js`, `aqua/src/artifacts/tests/artifactMigration.live.test.js`, harness extensions | — |

## 3. Defects found and fixed in this phase

1. **A credit was lost when a turn's process died.** This was the Phase 4A gap.
   It is fixed by pending charges, and verified end to end on Linux and in the
   multi-instance journey.
2. **Strict job priority allowed unbounded starvation.** A stream of
   higher-priority retries kept user learning waiting. This was the root cause
   of the unexplained worker failure. Fixed by aging, with a regression test and
   a bite check.
3. **Existing (classic-layout) artifacts were unreadable on any other
   instance.** `ensureArtifactFiles` skipped them.
4. **The artifact edit engine read files synchronously from local disk.** An
   edit on another instance would fail.
5. **`getArtifact` copied the current version to local disk on every call.** On
   Cloud Run that disk is memory.
6. **The first duplicate-refund test was too weak** to prove the wallet's
   once-only condition (bite check missed). A same-instant race test was added,
   and the mutation is now caught.
7. **Windows process abort at CLI exit** (libuv, open keep-alive sockets). The
   migration CLI no longer calls `process.exit`.

## 4. Testing and measurement

**Results:**

| Suite / run | Result |
|-------------|--------|
| Pending charges, crash at every boundary (real Postgres + Mongo) | 16/16; bite 6/6 after the race test |
| Worker starvation + startup + fail-closed | 4/4; bite: strict priority never claims the low job in 10 s |
| Object stores (Postgres, GCS emulator, enforcing fake) + across instances | 8/8 |
| Artifact migration (classic → GCS + rows, read by an empty-disk instance) | 2/2 |
| Conversation migration + artifact audit (re-run) | 10/10 |
| Cloud Run template lint | 8/8 |
| Linux API shutdown with charges | 28/28 |
| Multi-instance journey with charges (real providers; DB restart; API crash) | 37/37 |

**Measurements** (local Docker Postgres/Mongo and real providers; **no capacity
claims**):

| Measure | Result |
|---------|--------|
| Request-entry cost of a pending charge (50 runs, measured while the test battery ran) | plain debit p50 7.3 ms → `beginCharge` p50 15.2 ms (+≈ 8 ms); with a separate commit (non-chat success) p50 18.4 ms; a failed request's full refund path p50 45.9 ms. **A durable chat turn adds no commit round trip:** the charge commits inside the turn's transaction. |
| Turn commit (journey, n = 10) | p50 33 ms, p95 46 ms, max 46 ms |
| Chat end to end (journey, n = 10) | p50 2.4 s. The p95 of 99 s is a provider retry during the database restart; not representative. |
| Memory | API 166–170 MB, workers 83–108 MB (working set, Windows) |
| Jobs | 0 dead in the journey. `attempts > 1` rows are the journey's deliberate redelivery and reclaim. 6 `memory.index.v1` embedding jobs ran durably. |
| Charges in the journey | 10 COMMITTED inside their turns' transactions; 1 dead-turn charge refunded by one reconcile pass; wallet exactly 5000 − 5 × 10 |

## 5. Full batteries

**AQUA (`npm test`, test databases mapped):**
- 5842 tests: 5804 pass, 14 fail, 17 skipped, 7 todo.
- 2 failures were the flag census, which did not yet list `AQUA_GCS_BUCKET` and
  `AQUA_GCS_ENDPOINT`. They are now registered; the flag and template suites
  then passed 16/16.
- The other 12 are known and not caused by this phase:
  - 9 eval-CLI tests refuse whenever `DATABASE_URL` is set. They passed 47/47
    without a database in Phase 3.
  - 2 `temporalState.live` tests are date-dependent.
  - 1 is `repoHygiene` (eval/out before-profile files).

**Platform:** 387 tests, 384 pass. The 3 failures are known:
- 2 signup-page tests fail at HEAD (`FREE_DAILY_CREDITS` is missing in the
  test's own minimal app);
- 1 hygiene test (root `.patch` files).

## 6. Remaining risks

These are also listed in the Phase 5 readiness report §4.

- **Nothing has run on real GCP.**
- **The GCS emulator does not enforce preconditions.** The concurrent-first-write
  path is proven only by the in-process fake.
- **The worker-pool launch stage is unverified.**
- **Production data volumes are unknown.**
- **The charge abandon window** (15 min) must stay above any request lifetime.
- **Wallet id lists are bounded to 500.**
- **Aging bounds waiting, not throughput:** add workers when queue lag grows.
- **AI provider cost** is outside the infrastructure estimate.
