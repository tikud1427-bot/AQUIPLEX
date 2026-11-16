#!/usr/bin/env node
/**
 * AQUIPLEX — API-only entrypoint (scalability Phase 3; NOT used by any
 * deployment yet).
 *
 * Starts ONLY the HTTP server (index.js) with AQUA_ROLE=api:
 *   · no cognition worker is spawned (unlike scripts/start-production.mjs);
 *   · no periodic scheduler runs in this process (aqua/router.js);
 *   · SIGTERM stops accepting connections and reports not-ready (/ready) before
 *     the existing store/mirror/job drains run (index.js).
 * Post-turn learning: with AQUA_POST_TURN_DURABLE=on (Phase 3; needs history
 * partitions on) every learning stage is a job committed with the turn and run
 * by scripts/start-worker.mjs processes — this process runs none of it. With
 * it off, the in-process post-turn blocks still run here after the response,
 * which is why Cloud Run must then keep CPU allocated for this service
 * (AQUIPLEX_PHASE_4_READINESS_REPORT.md).
 *
 * Like index.js, it reads the platform .env (dotenv does not override variables
 * already set by the host).
 */
process.env.AQUA_ROLE = process.env.AQUA_ROLE || 'api';
if (process.env.AQUA_ROLE !== 'api') {
  console.error(`✗ start-api: AQUA_ROLE=${process.env.AQUA_ROLE} — this entrypoint only runs the API role`);
  process.exit(2);
}
console.log('[ROLE] api — HTTP only; no cognition worker, no periodic schedulers in this process');
await import('../index.js');
