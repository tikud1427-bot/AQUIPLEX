# AQUIPLEX Production Intelligence Loop Closure

This build closes the durable production path:

USER TURN
→ durable `understanding.turn.v1`
→ E6 understanding
→ canonical Postgres World Model
→ transactional outbox
→ embedding/reflection/contradiction jobs
→ canonical retrieval
→ E8 context
→ reasoning/answer
→ future turns use the revised model.

## Changes

1. `aqua/src/routes/turnPostProcess.js`
   - E6 is now scheduled as a durable `understanding.turn.v1` job.
   - Uses owner + conversation + turn idempotency.
   - The expensive provider call no longer lives only in process-memory post-turn work.
   - Queue scheduling remains fail-open for the user response.

2. `aqua/scripts/worker.mjs`
   - Existing production worker already consumes `understanding.turn.v1`, canonical embedding, reflection and contradiction jobs.
   - No duplicate worker implementation was introduced.

3. `aqua/src/brain/index.js`
   - When E6 is enabled, canonical commit is now ON by default.
   - `AQUA_E6_COMMIT=off` is the explicit rollback.
   - Canonical commit remains transactional and fail-open to the user turn.

4. `aqua/src/core/observability.js`
   - Durable E6 scheduling is explicitly observable as `scheduled=on/off`.
   - A queued job is no longer reported as a misleading extraction skip.

5. `scripts/start-production.mjs`
   - Production launcher starts both the HTTP server and durable cognition worker.
   - This prevents a single-service deployment from running chat while silently leaving the learning queue undrained.

6. `aqua/scripts/production-loop-doctor.mjs`
   - Static closure gate verifies the complete code-level chain.

## Production startup

Use:

`npm run start:production`

This starts:
- HTTP server
- durable cognition worker

## Verification

Run:

`node aqua/scripts/production-loop-doctor.mjs`

The static gate currently checks:
- production launcher
- durable E6 scheduling
- worker consumption
- canonical commit promotion
- embedding outbox
- reflection/embedding dispatch
- reflection execution
- canonical Postgres retrieval

## Live deployment gate

Before declaring the loop fully live, run against the real deployment:

1. `npm run db:status`
2. `npm run db:drift`
3. `npm run db:migrate` if migrations are pending
4. `npm run doctor:production-loop`
5. start with `npm run start:production`
6. run the longitudinal World Model E2E evaluation
7. verify queued → running → done jobs
8. verify a newly learned fact can be retrieved on a later turn
9. verify correction/supersession changes the later answer
10. verify owner isolation

The code-level loop is closed in this build; live database/provider validation remains a deployment operation rather than something that can be truthfully simulated without the production substrate.
