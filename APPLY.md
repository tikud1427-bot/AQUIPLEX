# Apply — Blueprint batch (E1/PR-7, E4/PR-7, E12 slice, durable turn path)

1. From your repo root:  `tar -xzf aquiplex-blueprint-batch.tar.gz`   (overlays 17 files, same relative paths)
2. Delete the two snapshot files (an archive cannot delete):  `bash apply-deletions.sh`
3. `cd aqua && npm ci && npm test`   → expect 0 fail (sandbox: 3368 tests / 3366 pass / 2 skipped)
4. `node scripts/production-loop-doctor.mjs`  → expect 8/8
5. Against a real DB:  `npm run db:migrate && npm run doctor:dlq`, and run `DATABASE_URL=... node --test src/core/tests/dlqPolicy.test.js src/core/tests/jobQueue.test.js`

Behaviour changes (both invisible while AQUA_E6=off, today's prod state):
- With AQUA_E6=on AND Postgres configured, turn understanding is queued (`understanding.turn.v1`) instead of run in-process; falls back to in-process if the queue is down. Run the worker (`npm run start:production`).
- With AQUA_E6=on, `AQUA_E6_COMMIT` now defaults on. Rollback: `AQUA_E6_COMMIT=off`.
New endpoint: GET /api/aqua/health/metrics (Prometheus text).
