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
import { reapStale, queueStats } from '../src/core/jobs/jobQueue.js';
import { isConfigured } from '../src/core/db/pool.js';
// The handler table ('understanding.turn.v1' → Brain.understandTurn, claim
// embedding/reflection/contradiction) and the claim → run → ack step live in
// workerRuntime.js so live evals and tests drain the queue through the SAME
// code this process runs (L12), not a copy of it.
import { HANDLERS, dispatchReflections, runOneJob, scheduleConsolidation, CONSOLIDATION_INTERVAL_MS,
  scheduleProactiveScan, PROACTIVE_INTERVAL_MS } from '../src/core/jobs/workerRuntime.js';
// E12: this process's counters (spans, extraction tokens, errors) reach the
// server's /metrics through aqua_process_metrics — see processMetrics.js.
import { startMetricsPublisher } from '../src/core/processMetrics.js';
import { configureTelemetryFromEnv } from '../src/core/telemetryExport.js';
let stopMetrics = null;
let telemetry = null;

const flag = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const WORKER_ID = `${process.pid}@${process.env.HOSTNAME ?? 'local'}`;
const POLL_MS = Number(flag('--poll', '750'));
const REAP_EVERY_MS = Number(flag('--reap', String(60_000)));
const KINDS = flag('--kinds', null)?.split(',').map(s => s.trim()).filter(Boolean) ?? null;

let running = true;
let inFlight = null;

async function runOne() {
  return (await runOneJob(WORKER_ID, { kinds: KINDS })) !== null;
}

async function loop() {
  let lastReap = 0;
  let lastConsolidation = 0;
  let lastProactive = 0;
  while (running) {
    // Phase 4: time passing makes a deadline urgent without any new claim —
    // one durable evaluation per owner with a deadline/dispute per interval
    // (deduplicated across workers by the bucket key). No-op when the gate is off.
    if (PROACTIVE_INTERVAL_MS && Date.now() - lastProactive > PROACTIVE_INTERVAL_MS) {
      lastProactive = Date.now();
      await scheduleProactiveScan();
    }
    // E9 J3: enqueue durable per-owner consolidation jobs (deduplicated across workers).
    if (CONSOLIDATION_INTERVAL_MS && Date.now() - lastConsolidation > CONSOLIDATION_INTERVAL_MS) {
      lastConsolidation = Date.now();
      await scheduleConsolidation();
    }
    if (Date.now() - lastReap > REAP_EVERY_MS) {
      lastReap = Date.now();
      try {
        const n = await reapStale();
        if (n) console.warn(`[WORKER] reclaimed ${n} job(s) from a worker that vanished`);
      } catch (err) { console.error(`[WORKER] reap failed: ${err?.message ?? err}`); }
    }

    let did = false;
    try {
      await dispatchReflections();
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
  try { await stopMetrics?.(); } catch { /* final snapshot is best-effort */ }
  try { await telemetry?.shutdown(); } catch { /* flushing spans is best-effort */ }
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
  + ` · handlers: ${Object.keys(HANDLERS).join(',')}`);
console.log(`[WORKER] queue: ${JSON.stringify(await queueStats())}`);
stopMetrics = startMetricsPublisher({ role: 'worker' });
telemetry = configureTelemetryFromEnv({ role: 'worker' });
console.log(`[WORKER] telemetry spans=${telemetry.spans} errors=${telemetry.errors}`);
await loop();
