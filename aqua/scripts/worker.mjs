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
  scheduleProactiveScan, PROACTIVE_INTERVAL_MS, releaseInFlight, inFlightCount,
  scheduleChargeReconcileTick, CHARGE_RECONCILE_INTERVAL_MS } from '../src/core/jobs/workerRuntime.js';
// E12: this process's counters (spans, extraction tokens, errors) reach the
// server's /metrics through aqua_process_metrics — see processMetrics.js.
import { startMetricsPublisher } from '../src/core/processMetrics.js';
import { configureTelemetryFromEnv } from '../src/core/telemetryExport.js';
import { createSchedulerLease, DEFAULT_LEASE_MS } from '../src/core/jobs/schedulerLease.js';
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
// Phase 3: how long SIGTERM waits for the job in hand (AQUA_WORKER_SHUTDOWN_MS,
// default 8 s — inside Cloud Run's 10 s). Past it the job is RELEASED (attempt
// not counted) and the process exits; the job re-runs elsewhere, idempotently.
const SHUTDOWN_MS = Number(process.env.AQUA_WORKER_SHUTDOWN_MS) > 0 ? Number(process.env.AQUA_WORKER_SHUTDOWN_MS) : 8_000;

let running = true;
let inFlight = null;

// Phase 4B — worker diagnostics (AQUIPLEX_WORKER_FAILURE_INVESTIGATION.md).
// One JSON line per lifecycle event, and a summary every DIAG_MS (--diag ms,
// default 10000; 0 = off): a worker that "processes nothing" must say WHY —
// not polling, polling but claiming nothing, claims failing, or stuck in one
// step. No user data: counts, timings, error messages.
const DIAG_MS = Number(flag('--diag', '10000'));
const diag = { polls: 0, claimed: 0, empty: 0, claimErrors: 0, lastClaimError: null, lastClaimAt: null,
  lastPollAt: null, step: 'boot', stepSince: Date.now(), leaseErrors: 0, reaped: 0 };
const wlog = (phase, fields = {}) => {
  try { console.log(`[WORKER] ${JSON.stringify({ evt: 'worker', phase, t: new Date().toISOString(), worker: WORKER_ID, ...fields })}`); } catch { /* never fail on logging */ }
};
const step = name => { diag.step = name; diag.stepSince = Date.now(); };

// Phase 3 prep — ONE worker at a time runs the periodic schedulers (reap,
// consolidation scan, proactive scan); every worker claims jobs. The lease is
// renewed every third of its TTL by a TIMER, independent of the job loop (a
// job longer than the TTL — an extraction call can take a minute — must not let
// ownership lapse; measured: it flapped between workers when renewal lived in
// the loop), and released on shutdown.
const lease = createSchedulerLease({ name: 'worker-schedulers', holder: WORKER_ID });
let schedulerOwner = false;
let justAcquired = false;
async function renewLease() {
  const was = schedulerOwner;
  const t0 = Date.now();
  schedulerOwner = await lease.isLeader();
  const st = lease.status();
  if (st.lastError && st.errors > diag.leaseErrors) { diag.leaseErrors = st.errors; wlog('lease-error', { error: st.lastError, ms: Date.now() - t0 }); }
  if (schedulerOwner && !was) justAcquired = true;
  if (schedulerOwner !== was) {
    console.log(`[WORKER] ${WORKER_ID} ${schedulerOwner ? 'now OWNS' : 'no longer owns'} the periodic schedulers`);
    wlog(schedulerOwner ? 'lease-acquired' : 'lease-lost', { ms: Date.now() - t0 });
  }
}
let leaseTimer = null;

async function runOne() {
  return (await runOneJob(WORKER_ID, { kinds: KINDS })) !== null;
}

async function loop() {
  let lastReap = 0;
  let lastConsolidation = 0;
  let lastProactive = 0;
  let lastChargeReconcile = 0;
  if (!leaseTimer) {
    const t0 = Date.now();
    await renewLease();
    wlog('first-lease-done', { schedulerOwner, ms: Date.now() - t0 });
    step('loop');
    leaseTimer = setInterval(() => { renewLease().catch(err => wlog('lease-error', { error: String(err?.message ?? err) })); }, Math.max(500, Math.floor(DEFAULT_LEASE_MS / 3)));
  }
  while (running) {
    // A new owner (first start, or taking over from a worker that died) runs every scheduler now.
    if (justAcquired) { justAcquired = false; lastProactive = 0; lastConsolidation = 0; lastReap = 0; lastChargeReconcile = 0; }
    if (!schedulerOwner) { lastProactive = lastConsolidation = lastReap = lastChargeReconcile = Date.now(); }
    // Phase 4: time passing makes a deadline urgent without any new claim —
    // one durable evaluation per owner with a deadline/dispute per interval
    // (deduplicated across workers by the bucket key). No-op when the gate is off.
    if (schedulerOwner && PROACTIVE_INTERVAL_MS && Date.now() - lastProactive > PROACTIVE_INTERVAL_MS) {
      lastProactive = Date.now();
      await scheduleProactiveScan();
    }
    // E9 J3: enqueue durable per-owner consolidation jobs (deduplicated across workers).
    if (schedulerOwner && CONSOLIDATION_INTERVAL_MS && Date.now() - lastConsolidation > CONSOLIDATION_INTERVAL_MS) {
      lastConsolidation = Date.now();
      await scheduleConsolidation();
    }
    // Phase 4B: pending-charge recovery, one job per interval (no-op when off).
    if (schedulerOwner && Date.now() - lastChargeReconcile > CHARGE_RECONCILE_INTERVAL_MS) {
      lastChargeReconcile = Date.now();
      try { await scheduleChargeReconcileTick(); } catch (err) { wlog('charge-reconcile-schedule-error', { error: String(err?.message ?? err) }); }
    }
    if (schedulerOwner && Date.now() - lastReap > REAP_EVERY_MS) {
      lastReap = Date.now();
      try {
        const n = await reapStale();
        diag.reaped += n;
        if (n) wlog('reaped', { count: n });
        if (n) {
          console.warn(`[WORKER] reclaimed ${n} job(s) from a worker that vanished`);
          console.log(`[JOB] ${JSON.stringify({ evt: 'job', phase: 'reclaimed', t: new Date().toISOString(), count: n, pid: process.pid })}`);
        }
      } catch (err) { console.error(`[WORKER] reap failed: ${err?.message ?? err}`); }
    }

    let did = false;
    diag.polls++; diag.lastPollAt = Date.now();
    try {
      step('dispatch');
      await dispatchReflections();
      step('claim+run');
      inFlight = runOne();
      did = await inFlight;
      if (did) { diag.claimed++; diag.lastClaimAt = Date.now(); } else diag.empty++;
    } catch (err) {
      // The claim itself failed — a database blip, not a job failure. Back off
      // rather than spinning against a database that is having a bad time.
      diag.claimErrors++; diag.lastClaimError = String(err?.message ?? err).slice(0, 300);
      console.error(`[WORKER] claim failed: ${err?.message ?? err}`);
      wlog('claim-error', { error: diag.lastClaimError, code: err?.code ?? null });
      step('backoff');
      await sleep(POLL_MS * 4);
    } finally { inFlight = null; step('idle'); }

    if (!did && running) await sleep(POLL_MS);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function shutdown(signal) {
  if (!running) return;
  running = false;
  console.log(`\n[WORKER] ${signal} — finishing the job in hand (up to ${SHUTDOWN_MS}ms), taking no more`);
  wlog('shutdown-begin', { signal, inFlight: inFlightCount(), step: diag.step });
  const t0 = Date.now();
  if (leaseTimer) clearInterval(leaseTimer);
  const finished = await Promise.race([
    Promise.resolve(inFlight).then(() => true, () => true),
    new Promise(r => setTimeout(() => r(false), SHUTDOWN_MS).unref()),
  ]);
  if (!finished && inFlightCount()) {
    const n = await releaseInFlight('shutdown deadline');
    console.warn(`[WORKER] shutdown deadline: released ${n} in-flight job(s) for another worker`);
  }
  // Partition writes of finished jobs are already flushed (runOneJob); this is the floor.
  try { await (await import('../src/core/storage/index.js')).flushStorage(3_000); } catch { /* best-effort */ }
  try { await lease.release(); } catch { /* db may be gone: the lease simply expires */ }
  console.log(`[WORKER] shutdown ${finished ? 'clean' : 'past deadline'} in ${Date.now() - t0}ms`);
  wlog('shutdown-end', { clean: finished, ms: Date.now() - t0, ...diag });
  try { await stopMetrics?.(); } catch { /* final snapshot is best-effort */ }
  try { await telemetry?.shutdown(); } catch { /* flushing spans is best-effort */ }
  try { console.log(`[WORKER] queue at exit: ${JSON.stringify(await queueStats())}`); } catch { /* db may be gone */ }
  console.log('[WORKER] stopped');
  process.exit(0);
}

// Phase 3 (found by the Linux SIGTERM test): the store layer's own SIGTERM
// handler (core/atomicStore.js: flush, drain, process.exit(143)) is installed in
// this process too, and with nothing to drain it exited within milliseconds —
// before the job in hand finished and before the lease was released. Register
// this shutdown as a blocker of that handler: it now waits for the worker's
// graceful shutdown (which exits 0 itself), bounded so it can never hang.
let shutdownDone = null;
process.on('SIGTERM', () => { shutdownDone ??= shutdown('SIGTERM'); });
process.on('SIGINT', () => { shutdownDone ??= shutdown('SIGINT'); });
{
  const { registerShutdownBlocker } = await import('../src/core/atomicStore.js');
  registerShutdownBlocker(() => Promise.race([
    Promise.resolve(shutdownDone),
    new Promise(r => setTimeout(r, SHUTDOWN_MS + 8_000).unref()),
  ]));
}

if (!isConfigured()) {
  console.error('\n✗ DATABASE_URL is not set — the job queue has nowhere to read from.');
  console.error('  A worker that idles quietly against a missing database looks alive and');
  console.error('  processes nothing, so this exits instead.\n');
  process.exit(1);
}

wlog('boot', { pid: process.pid, node: process.version, pollMs: POLL_MS, reapMs: REAP_EVERY_MS, kinds: KINDS,
  leaseMs: DEFAULT_LEASE_MS, shutdownMs: SHUTDOWN_MS, heartbeatStaleMs: Number(process.env.AQUA_JOB_HEARTBEAT_STALE_MS) || 120_000 });
console.log(`[WORKER] ${WORKER_ID} polling every ${POLL_MS}ms`
  + `${KINDS ? ` kinds=${KINDS.join(',')}` : ''}`
  + ` · handlers: ${Object.keys(HANDLERS).join(',')}`);
{
  step('db-probe');
  const t0 = Date.now();
  try {
    const qs = await queueStats();
    wlog('db-connected', { ms: Date.now() - t0, queue: qs });
    console.log(`[WORKER] queue: ${JSON.stringify(qs)}`);
  } catch (err) {
    wlog('db-error', { ms: Date.now() - t0, error: String(err?.message ?? err).slice(0, 300), code: err?.code ?? null });
    throw err;
  }
}
if (DIAG_MS > 0) {
  const { queueLag } = await import('../src/core/jobs/jobQueue.js');
  const t = setInterval(async () => {
    // Queue lag per priority band: a band whose oldest runnable job keeps
    // growing while this worker claims steadily is being starved.
    let lag = null;
    try { lag = await queueLag(); } catch (err) { lag = { error: String(err?.message ?? err).slice(0, 200) }; }
    wlog('summary', { ...diag, stepMs: Date.now() - diag.stepSince, schedulerOwner, inFlight: inFlightCount(),
      sinceLastPollMs: diag.lastPollAt ? Date.now() - diag.lastPollAt : null, sinceLastClaimMs: diag.lastClaimAt ? Date.now() - diag.lastClaimAt : null, lag });
  }, DIAG_MS);
  t.unref();
}
// Phase 2b — the same per-owner partition safety rules the server applies at boot.
step('configure-partitions');
{
  const t0 = Date.now();
  console.log(await (await import('../src/core/storage/index.js')).configurePartitionBindings());
  wlog('partitions-configured', { ms: Date.now() - t0 });
}
stopMetrics = startMetricsPublisher({ role: 'worker' });
telemetry = configureTelemetryFromEnv({ role: 'worker' });
console.log(`[WORKER] telemetry spans=${telemetry.spans} errors=${telemetry.errors}`);
step('first-lease');
wlog('ready', { msSinceStart: Math.round(process.uptime() * 1000) });
await loop();
