# AQUIPLEX — Phase 5 Readiness Report (after Phase 4B)

Date 2026-11-15.

**Phase 5 (a controlled cloud staging environment) has not been started.**

- Nothing was deployed, and no cloud resource exists.
- Production, Render and DNS are untouched.
- Nothing is committed (HEAD `839ea0d1`).

## 1. Where things stand

| Area | State | Evidence |
|------|-------|----------|
| Stateless API instances + independent workers | implemented, tested multi-process | Phase 3 journeys; Phase 4B journey 37/37 |
| Durable-before-response for every accepted interaction | implemented, tested | Phase 4A |
| No credit lost on a dead turn | **implemented, tested** | pending charges: 16/16 crash-boundary tests; Linux 28/28; journey L12 |
| Learning cannot be starved by other work | **implemented, tested** (aging) | `phase4bWorker` 4/4 + bite |
| Worker observability (lifecycle, queue lag) | implemented, tested | startup test; Linux runs |
| Shared artifact storage on GCS | **implemented, tested on an emulator** | object store 8/8; artifacts across instances; migration 2/2 |
| Migration tooling (conversations, artifacts) with export and rollback | implemented, tested on synthetic data | 7/7 + 2/2 + 3/3 |
| Cloud Run templates | written, linted, **not deployed** | `cloudRunTemplates` 8/8 |
| Cost estimate | written, **rates to verify** | cost estimate §0 |
| Graceful shutdown on Linux (API and worker) | tested | 22/22 (worker), 28/28 (API with charges) |

## 2. Decisions and authorisations needed before Phase 5

1. **A GCP project for staging:** a billing account and a budget alert. The
   estimate puts staging at ≈ $40–65 / month at the assumed rates.
2. **Region.** Prices and latency differ: a US Tier 1 region was assumed.
3. **Worker runtime.** Cloud Run worker pools (verify the launch stage in the
   region) or a Compute Engine MIG fallback.
4. **Cloud SQL tier for staging:** a shared core is cheapest but has **no SLA**.
   This is acceptable for staging only.
5. **Credential rotation.** Exposed credentials noted in earlier audits must be
   rotated before anything is put in Secret Manager.
6. **Staging data.** Synthetic accounts only, **or** a production export under
   the procedure in `AQUIPLEX_ARTIFACT_MIGRATION_READINESS.md` §2. That export
   needs its own explicit authorisation.

## 3. Phase 5 plan (proposed, not started)

1. **Build** the image (one image, two entrypoints) and push it to Artifact
   Registry.
2. **Create** the staging resources:
   - Cloud SQL PostgreSQL 16;
   - a private bucket with soft delete;
   - secrets;
   - service accounts with the roles in the configuration plan §4.
3. **Migrate** the schema (0001–0031) to staging Cloud SQL.
4. **Deploy** the API service and the worker from the templates. Mongo stays
   external, using a staging database.
5. **Run in staging:**
   - the application journeys (real login, chat, artifacts, deletion);
   - the Linux shutdown harnesses adapted to Cloud Run: a revision rollout as
     SIGTERM, and a forced instance replacement;
   - the charge reconciler.
6. **Measure:**
   - API latency per route;
   - commit and flush times on Cloud SQL (not local Docker);
   - queue lag;
   - instance memory and CPU;
   - Cloud SQL connections;
   - logging volume.
7. **Experiment:** request-based CPU for the API under load. Compare statistics
   lag and cost.
8. **Load test (Phase 6)** before any production decision, with capacity numbers
   only from it.

## 4. Known gaps and risks carried into Phase 5

| # | Gap | Impact | Plan |
|---|-----|--------|------|
| 1 | Nothing has run on real GCP: IAM, metadata-server tokens, real GCS `412`s, Cloud SQL latency, the Cloud Run 10 s grace | unknown failure modes | Phase 5 step 5 |
| 2 | The GCS emulator does not enforce `ifGenerationMatch` | the concurrent-first-write path is proven only by the in-process fake | verify on a real bucket |
| 3 | Worker-pool launch stage and billing are unverified | may need the MIG fallback | decision 3 |
| 4 | Production data volumes unknown (history size, artifact count, ownerless artifacts) | migration plan sizing | an authorised inventory run |
| 5 | Mongo replica-set failover during a charge refund is untested (standalone test Mongo) | low; refunds are idempotent and retried | staging with a replica set |
| 6 | API and worker feature-flag skew changes what is learned | silent behaviour difference | one environment definition for both (configuration plan §3) |
| 7 | One worker processes one job at a time; aging bounds waiting, not throughput | queue lag under a backlog | alert on queue lag; add instances |
| 8 | Platform uploads (`public/uploads`) still on local disk | lost on instance replacement | move to a bucket in Phase 5 |
| 9 | AI provider costs and rate limits are outside the infrastructure estimate | likely the dominant cost | a separate decision |
| 10 | Pre-existing test failures (eval CLIs refusing with `DATABASE_URL`, date-dependent tests, hygiene, a signup-page test at HEAD) | noise in the battery | listed in the implementation report §5 |

## 5. Not started

Phase 5 itself:
- any cloud resource;
- any deployment;
- any production export;
- any flag change outside the disposable test environment.
