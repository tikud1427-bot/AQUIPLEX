#!/usr/bin/env node
/**
 * AQUIPLEX — cognition-worker-only entrypoint (scalability Phase 3; NOT used by
 * any deployment yet).
 *
 * Starts ONLY the durable job worker (aqua/scripts/worker.mjs) with
 * AQUA_ROLE=worker. It never opens an HTTP port. Run any number of them:
 * claims are `FOR UPDATE SKIP LOCKED` with per-owner ordering in SQL; exactly
 * one of them at a time runs the periodic schedulers (lease, migration 0029).
 *
 * Unlike aqua/scripts/worker.mjs run bare, this loads the platform .env the way
 * the combined launcher does (variables set by the host still win), so the
 * worker has the same provider keys as the API.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

process.env.AQUA_ROLE = process.env.AQUA_ROLE || 'worker';
if (process.env.AQUA_ROLE !== 'worker') {
  console.error(`✗ start-worker: AQUA_ROLE=${process.env.AQUA_ROLE} — this entrypoint only runs the worker role`);
  process.exit(2);
}
if (process.env.START_WORKER_SKIP_DOTENV !== '1') {
  dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'), quiet: true });
}
console.log('[ROLE] worker — durable job queue only; no HTTP server');
await import('../aqua/scripts/worker.mjs');
