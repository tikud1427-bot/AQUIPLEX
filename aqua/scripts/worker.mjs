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
import { claim, complete, fail, reapStale, queueStats, enqueue } from '../src/core/jobs/jobQueue.js';
import { isConfigured } from '../src/core/db/pool.js';
import { dispatchPendingClaimReflections } from '../src/brain/reflectionV3/reflectionOutbox.js';
import { runClaimReflectionJob } from '../src/brain/reflectionV3/reflectionWorker.js';
import { runClaimContradictionJob } from '../src/brain/reflectionV3/contradictionWorker.js';
import * as Brain from '../src/brain/index.js';
import { logE6Turn } from '../src/core/observability.js';
import { embedOne } from '../src/embeddings/embeddingProvider.js';
import { upsertClaimEmbedding } from '../src/core/worldModel/embeddingRepository.js';
import { modelSignature } from '../src/embeddings/embeddingModel.js';

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
 * Production handlers are intentionally small adapters: the queue owns retry,
 * ordering and acknowledgement; domain modules own the actual work.
 * Understanding is the first canonical consumer because it is the most
 * important off-request-path stage in the blueprint. Claim reflection is fed by
 * the transactional outbox and therefore also runs here, never on /chat.
 *
 * Unknown kinds DEAD-LETTER rather than retry forever.
 */
const HANDLERS = Object.freeze({
  'claim.embedding.v1': async job => {
    const payload = job.payload ?? {};
    const statementText = String(payload.statementText ?? '').trim();
    if (!statementText) throw new Error('claim embedding job requires statementText');
    const vector = await embedOne(statementText);
    if (!vector) throw new Error('claim embedding unavailable; retrying durable job');
    await upsertClaimEmbedding({
      ownerId: job.ownerId,
      claimId: payload.claimId,
      vector,
      contentHash: payload.contentHash ?? 'unknown',
      signature: modelSignature(),
    });
  },
  'understanding.turn.v1': async job => {
    const started = Date.now();
    const payload = job.payload ?? {};
    const result = await Brain.understandTurn({
      ownerId: job.ownerId,
      conversationId: payload.conversationId ?? null,
      turn: Number.isInteger(payload.turn) ? payload.turn : null,
      userMessage: payload.userMessage ?? '',
    });
    logE6Turn({
      ownerId: job.ownerId,
      conversationId: payload.conversationId ?? null,
      result,
      ms: Date.now() - started,
    });
  },
  'claim.reflection.v1': async job => {
    await runClaimReflectionJob(job);
  },
  'claim.contradiction.v1': async job => {
    await runClaimContradictionJob(job);
  },
});

let running = true;
let inFlight = null;

async function dispatchReflections() {
  try {
    const results = await dispatchPendingClaimReflections({ limit: 25, jobEnqueue: enqueue });
    const dispatched = results.filter(r => r.dispatched).length;
    if (dispatched) console.log(`[WORKER] dispatched ${dispatched} claim-reflection outbox event(s)`);
  } catch (err) {
    console.error(`[WORKER] outbox dispatch failed: ${err?.message ?? err}`);
  }
}

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
await loop();
