#!/usr/bin/env node
/**
 * AQUA — job worker (E4/PR-2)
 *
 *   npm run worker
 *   npm run worker -- --kinds post-turn,reflect --poll 500
 *
 * Drains `aqua_jobs`. One process, one job at a time; run several for
 * throughput — the claim query's per-owner predicate and `SKIP LOCKED` mean
 * they cooperate without talking to each other.
 *
 * GRACEFUL SHUTDOWN IS THE POINT, NOT A COURTESY.
 *
 * A worker killed mid-job leaves a row in `running`, and the per-owner
 * predicate that guarantees ordering then blocks that ONE owner until
 * `reapStale` releases it — every other user is unaffected, which is the
 * design working, but the affected user is stuck for the reap interval. So
 * SIGTERM stops taking new work and finishes the job in hand before exiting.
 * `reapStale` is the floor for the cases where that is not possible: SIGKILL,
 * OOM, a lost node.
 *
 * FAIL-CLOSED (L11). Enrichment fails open; a queue does not. If the database
 * is unreachable the worker exits non-zero rather than idling quietly, because
 * a worker that looks alive and processes nothing is worse than one that is
 * plainly down.
 */
import { claim, complete, fail, reapStale, queueStats } from '../src/core/jobs/jobQueue.js';
import { isConfigured } from '../src/core/db/pool.js';

const flag = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const WORKER_ID = `${process.pid}@${process.env.HOSTNAME ?? 'local'}`;
const POLL_MS = Number(flag('--poll', '750'));
const REAP_EVERY_MS = Number(flag('--reap', String(60_000)));
const KINDS = flag('--kinds', null)?.split(',').map(s => s.trim()).filter(Boolean) ?? null;

/**
 * The handler table.
 *
 * ⚠️ DELIBERATELY EMPTY OF PRODUCTION WORK. E4/PR-2 is the runner; PR-5 and
 * PR-6 move world-model ingest, reflection and consolidation onto it, each
 * behind its own flag and its own measured change. Wiring a handler here now
 * would move production work onto an unproven runner in the same commit that
 * introduced the runner, and the first failure would have two candidate causes.
 *
 * An unknown kind DEAD-LETTERS rather than being retried: retrying a job no
 * handler exists for burns the attempt budget to arrive at the same place, more
 * slowly and with less information.
 */
const HANDLERS = Object.create(null);

let running = true;
let inFlight = null;

async function runOne() {
  const job = await claim(WORKER_ID, { kinds: KINDS });
  if (!job) return false;

  const handler = HANDLERS[job.kind];
  if (!handler) {
    await fail(job.jobId, `no handler registered for kind "${job.kind}"`);
    console.warn(`[WORKER] job ${job.jobId} kind=${job.kind} has no handler`);
    return true;
  }

  try {
    await handler(job);
    await complete(job.jobId);
    console.log(`[WORKER] job ${job.jobId} kind=${job.kind} owner=${job.ownerId} done`);
  } catch (err) {
    const r = await fail(job.jobId, err);
    const detail = r.state === 'dead'
      ? `DEAD after ${job.attempts} attempt(s)`
      : `retry in ${Math.round(r.retryInMs / 1000)}s`;
    console.error(`[WORKER] job ${job.jobId} kind=${job.kind} failed — ${detail}: ${err?.message ?? err}`);
  }
  return true;
}

async function loop() {
  let lastReap = 0;
  while (running) {
    if (Date.now() - lastReap > REAP_EVERY_MS) {
      lastReap = Date.now();
      try {
        const n = await reapStale();
        if (n) console.warn(`[WORKER] reclaimed ${n} job(s) from a worker that vanished`);
      } catch (err) { console.error(`[WORKER] reap failed: ${err?.message ?? err}`); }
    }

    let did = false;
    try {
      inFlight = runOne();
      did = await inFlight;
    } catch (err) {
      // The claim itself failed — a database blip, not a job failure. Back off
      // rather than spinning against a database that is having a bad time.
      console.error(`[WORKER] claim failed: ${err?.message ?? err}`);
      await sleep(POLL_MS * 4);
    } finally { inFlight = null; }

    if (!did && running) await sleep(POLL_MS);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function shutdown(signal) {
  if (!running) return;
  running = false;
  console.log(`\n[WORKER] ${signal} — finishing the job in hand, taking no more`);
  try { await inFlight; } catch { /* runOne handles its own failures */ }
  try { console.log(`[WORKER] queue at exit: ${JSON.stringify(await queueStats())}`); } catch { /* db may be gone */ }
  console.log('[WORKER] stopped');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (!isConfigured()) {
  console.error('\n✗ DATABASE_URL is not set — the job queue has nowhere to read from.');
  console.error('  A worker that idles quietly against a missing database looks alive and');
  console.error('  processes nothing, so this exits instead.\n');
  process.exit(1);
}

console.log(`[WORKER] ${WORKER_ID} polling every ${POLL_MS}ms`
  + `${KINDS ? ` kinds=${KINDS.join(',')}` : ''}`
  + ` · handlers: ${Object.keys(HANDLERS).length ? Object.keys(HANDLERS).join(',') : 'none registered (E4/PR-5,6)'}`);
console.log(`[WORKER] queue: ${JSON.stringify(await queueStats())}`);
await loop();
