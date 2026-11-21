/**
 * AQUA — worker runtime (E4)
 *
 * The handler table and the claim → run → ack step of the durable worker,
 * importable. `scripts/worker.mjs` is the long-running process around this;
 * anything that needs to drain the queue the way production does (the live
 * World-Model Lift experiment, live tests) imports THIS rather than writing a
 * second copy of the handlers. A test-only re-implementation of the worker is
 * exactly the seam L12 says must not be trusted.
 *
 * Production handlers are intentionally small adapters: the queue owns retry,
 * ordering and acknowledgement; domain modules own the actual work. Unknown
 * kinds DEAD-LETTER rather than retry forever.
 */
import { claim, complete, fail, enqueue, heartbeat, release, HEARTBEAT_STALE_MS, canarySleep } from './jobQueue.js';
import { ensureOwnerLoaded, anyAuthoritative as anyPartitionStoreAuthoritative, flushOwnerBindingsStrict } from '../storage/ownerBinding.js';
import { isOwnerDeleted } from '../storage/deletedOwners.js';
import { LEARNING_HANDLERS, readTurnText } from '../../learning/turnLearning.js';
import { logJobEvent } from './jobLog.js';
import { RECONCILE_KIND, runReconcile, scheduleChargeReconcile, RECONCILE_INTERVAL_MS } from '../../credits/reconcileJob.js';
import { dispatchPendingClaimReflections } from '../../brain/reflectionV3/reflectionOutbox.js';
import { runClaimReflectionJob } from '../../brain/reflectionV3/reflectionWorker.js';
import { runClaimContradictionJob } from '../../brain/reflectionV3/contradictionWorker.js';
import { runClaimConsolidationJob, CONSOLIDATION_KIND } from '../../brain/reflectionV3/consolidationWorker.js';
import { ownersWithStructuralDuplicates } from '../worldModel/worldModelRepository.js';
import { recordJ3 } from '../observability.js';
import * as Brain from '../../brain/index.js';
import { logE6Turn } from '../observability.js';
import { embedOne } from '../../embeddings/embeddingProvider.js';
import { upsertClaimEmbedding } from '../worldModel/embeddingRepository.js';
import { modelSignature } from '../../embeddings/embeddingModel.js';
import { startSpan, reportError } from '../telemetry.js';
import { PROACTIVE_JOB_KIND, proactiveEnabled, runProactiveJob, scheduleProactive } from '../../brain/proactive/index.js';
import { ACTION_JOB_KIND, runActionJob } from '../../brain/actions/executor.js';
import { hashOwner } from '../spanAttributes.js';
import { DOCUMENT_JOB_KIND } from '../../files/documentUnderstanding.js';

export const HANDLERS = Object.freeze({
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
    // Phase 3: a durable turn's job carries a REFERENCE to the message, not
    // its text; read it now (redacted as the request path would have). A
    // deleted conversation or message means there is nothing to understand.
    // Older jobs (and the in-process fallback's enqueue) carry the text itself.
    let userMessage = payload.userMessage ?? '';
    if (payload.userMessageKey) {
      const text = readTurnText({ conversationId: payload.conversationId, userMessageKey: payload.userMessageKey },
        { rememberSensitive: payload.rememberSensitive === true });
      if (!text) return { skipped: 'source-missing' };
      userMessage = text.userMessage;
    }
    const result = await Brain.understandTurn({
      ownerId: job.ownerId,
      conversationId: payload.conversationId ?? null,
      turn: Number.isInteger(payload.turn) ? payload.turn : null,
      userMessage,
      // When the user SAID it (enqueue time), the anchor for relative dates.
      // Older payloads lack it: the job's own creation time is the closest truth.
      assertedAt: payload.assertedAt ?? job.createdAt ?? null,
    });
    logE6Turn({
      ownerId: job.ownerId,
      conversationId: payload.conversationId ?? null,
      result,
      ms: Date.now() - started,
    });
    // understandTurn fails OPEN (L11): a provider error yields an empty result
    // rather than a throw, which is right on the request path. Here it was
    // wrong. A 429 (Groq's TPM limit is per organisation, shared by every key)
    // completed the job with zero claims and the turn was never understood —
    // measured on live Postgres 2026-10-04: "X is blocking the launch" lost.
    // The durable queue exists to retry exactly this, so throw: backoff and
    // max_attempts → DLQ apply. Re-running is safe — the commit ledger is
    // idempotent on (source, segment, extractor_version) and successful
    // segments are served from the extraction cache.
    assertUnderstood(result);
  },
  // 2026-10-11: an uploaded document's chunk through the SAME understanding
  // pipeline as a turn, with document provenance (files/documentUnderstanding.js).
  // Same retry semantics: an extraction or commit failure throws → backoff → DLQ.
  [DOCUMENT_JOB_KIND]: async job => {
    const started = Date.now();
    const p = job.payload ?? {};
    const text = String(p.text ?? '').trim();
    if (!text) return;
    // G1-1: an EXTERNAL resource (source-derived ukoId) gets its own canonical
    // source identity — never shared with an upload of the same bytes — so its
    // knowledge can be deleted with the source. A resource already deleted is
    // not understood (no resurrection from a queued job). Uploads: unchanged.
    const external = typeof p.ukoId === 'string' && p.ukoId.startsWith('ext_');
    if (external) {
      const { getUKO } = await import('../../files/ukoStore.js');
      if (!getUKO(job.ownerId, p.ukoId)) return;
    }
    const conversationId = external
      ? `extuko:${p.ukoId}`
      : `file:${String(p.hash ?? p.ukoId ?? 'unknown').slice(0, 32)}`;
    const result = await Brain.understandTurn({
      ownerId: job.ownerId, conversationId,
      turn: Number.isInteger(p.chunk) ? p.chunk + 1 : 1,
      userMessage: text,
      // `enqueuedAt`: the commit refuses an external resource deleted at or
      // after this job was enqueued — re-checked under the source lock at
      // commit time, not only here (externalDeletionGuard.js).
      source: { kind: 'document', name: String(p.name ?? 'document'), hash: p.hash ?? null, chunk: Number.isInteger(p.chunk) ? p.chunk : 0, ...(external ? { ukoId: p.ukoId, enqueuedAt: job.createdAt ?? null } : {}) },
    });
    logE6Turn({ ownerId: job.ownerId, conversationId, result, ms: Date.now() - started });
    assertUnderstood(result);
  },
  'claim.reflection.v1': async job => {
    await runClaimReflectionJob(job);
  },
  'claim.contradiction.v1': async job => {
    await runClaimContradictionJob(job);
  },
  // E9 J3 (2026-10-04): structural duplicate consolidation, one owner per job.
  [CONSOLIDATION_KIND]: async job => {
    await runClaimConsolidationJob(job);
  },
  // Phase 4 (2026-10-06): proactive trigger evaluation for one owner. A job
  // enqueued while the gate was on and run after it was turned off is a no-op.
  [PROACTIVE_JOB_KIND]: async job => {
    if (!proactiveEnabled()) return;
    await runProactiveJob(job);
  },
  // Phase 5 (2026-10-06): execute ONE approved bounded action run.
  [ACTION_JOB_KIND]: async job => {
    await runActionJob(job);
  },
  // Phase 3: durable post-turn learning (learning/turnLearning.js).
  ...LEARNING_HANDLERS,
  // Phase 3: an operational canary — holds a database connection busy for
  // payload.ms (≤ 30 s) and writes nothing. Used to test shutdown and recovery
  // while a job is inside a database call.
  // Phase 4B: pending-charge recovery (credits/pendingCharges.js). Idempotent:
  // every wallet refund is conditional on the charge id.
  [RECONCILE_KIND]: async () => runReconcile(),
  'ops.canary.v1': async job => {
    await canarySleep(Math.min(30_000, Math.max(0, Number(job.payload?.ms) || 0)));
    return { slept: true };
  },
});

/** Phase 4 periodic scan interval (default 1 h; 0 = never). Registered setting AQUA_PROACTIVE_INTERVAL_MS. */
export const PROACTIVE_INTERVAL_MS = (() => {
  const v = Number(process.env.AQUA_PROACTIVE_INTERVAL_MS);
  return Number.isFinite(v) && v >= 0 ? v : 60 * 60_000;
})();
export const scheduleChargeReconcileTick = (opts = {}) => scheduleChargeReconcile({ enqueue, ...opts });
export { RECONCILE_INTERVAL_MS as CHARGE_RECONCILE_INTERVAL_MS };
export const scheduleProactiveScan = (opts = {}) => scheduleProactive({ enqueue, intervalMs: PROACTIVE_INTERVAL_MS, ...opts });

/** Throw when any segment's extraction failed (transport/parse), so the job retries. */
export function assertUnderstood(result) {
  // The canonical commit fails OPEN inside understandTurn (L11, request path).
  // In the durable job a failed commit is a lost turn: the claims were
  // extracted and then never written — measured 2026-10-04 when a unique-index
  // collision swallowed "I live in Berlin" on a return to an old value. Throw
  // so the queue retries and, if it keeps failing, dead-letters VISIBLY.
  const commit = result?.canonicalCommit;
  if (commit?.enabled && commit.committed === false) {
    throw Object.assign(new Error(`understanding commit failed: ${commit.error ?? 'unknown'}`),
      { code: 'UNDERSTANDING_COMMIT_FAILED' });
  }
  const n = Number(result?.stats?.errors ?? 0);
  if (n > 0) {
    const why = (result.stats.errorReasons ?? []).join(' | ') || 'unknown';
    throw Object.assign(new Error(`understanding incomplete: ${n} segment(s) failed extraction — ${why}`),
      { code: 'UNDERSTANDING_INCOMPLETE' });
  }
}

/**
 * E9 J3 scheduler: one durable consolidation job per owner that HAS duplicate
 * groups, keyed per interval bucket so any number of workers enqueue it once
 * (enqueue's ON CONFLICT on the idempotency key). Low priority: it never
 * delays understanding/reflection work. Fail-open: a scheduling error is
 * logged and retried on the next tick.
 */
export const CONSOLIDATION_INTERVAL_MS = (() => {
  const v = Number(process.env.AQUA_CONSOLIDATION_INTERVAL_MS);
  return Number.isFinite(v) && v >= 0 ? v : 10 * 60_000;
})();

export async function scheduleConsolidation({ intervalMs = CONSOLIDATION_INTERVAL_MS, now = Date.now(), limit = 100 } = {}) {
  if (!intervalMs) return { owners: 0, created: 0, disabled: true };
  try {
    const owners = await ownersWithStructuralDuplicates({ limit });
    const bucket = Math.floor(now / intervalMs);
    let created = 0;
    for (const ownerId of owners) {
      const r = await enqueue({ ownerId, kind: CONSOLIDATION_KIND, payload: { bucket },
        idempotencyKey: `j3:consolidation:${bucket}`, priority: 200, maxAttempts: 5 });
      if (r.created) created++;
    }
    recordJ3('scheduled', created);
    if (created) console.log(`[WORKER] scheduled ${created} consolidation job(s)`);
    return { owners: owners.length, created };
  } catch (err) {
    console.error(`[WORKER] consolidation scheduling failed: ${err?.message ?? err}`);
    return { owners: 0, created: 0, error: String(err?.message ?? err) };
  }
}

/** Outbox → jobs. Fail-open per call: a dispatch error is logged, never thrown. */
export async function dispatchReflections({ limit = 25 } = {}) {
  try {
    const batch = await dispatchPendingClaimReflections({ limit, jobEnqueue: enqueue });
    const results = Array.isArray(batch) ? batch : (batch.results ?? []);
    const dispatched = results.filter(r => r.dispatched).length;
    const reaped = Number(batch?.reaped ?? 0);
    if (reaped) console.warn(`[WORKER] reclaimed ${reaped} stale claim outbox row(s)`);
    if (dispatched) console.log(`[WORKER] dispatched ${dispatched} claim-reflection/embedding outbox event(s)`);
    return { dispatched, reaped };
  } catch (err) {
    console.error(`[WORKER] outbox dispatch failed: ${err?.message ?? err}`);
    return { dispatched: 0, reaped: 0, error: String(err?.message ?? err) };
  }
}

/**
 * A database that cannot be reached (refused, reset, shut down, timed out) —
 * not a fault of the job. Phase 3: such a job is RELEASED (attempt not
 * counted) instead of failed, so an outage cannot dead-letter a user's turn.
 */
export function isDatabaseUnavailable(err) {
  const code = String(err?.code ?? '');
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', '57P01', '57P02', '57P03', '53300'].includes(code)) return true;
  if (/^08/.test(code)) return true;
  return /Connection terminated|connect ECONNREFUSED|timeout exceeded when trying to connect|Client has encountered a connection error|the database system is (starting up|shutting down)/i
    .test(String(err?.message ?? ''));
}

/** jobId → { job, timer, lost } — what this process is running right now. */
const inFlight = new Map();
export const HEARTBEAT_EVERY_MS = Math.max(250, Math.floor(HEARTBEAT_STALE_MS / 4));

/**
 * Shutdown past its deadline: stop renewing and hand every in-flight job back
 * (attempt not counted) so another worker takes it at once instead of after
 * the heartbeat goes stale. The process must exit right after: a handler still
 * running here could otherwise keep writing. Re-running is idempotent.
 */
export async function releaseInFlight(reason = 'shutdown') {
  let n = 0;
  for (const [jobId, e] of inFlight) {
    clearInterval(e.timer);
    e.lost = true;
    try { if (await release(jobId, e.job.fence, { reason })) n++; } catch { /* db gone: the heartbeat goes stale and recovery reclaims it */ }
    logJobEvent('released', e.job, { reason });
  }
  return n;
}
export const inFlightCount = () => inFlight.size;

/**
 * Claim one job and run it. Returns null when the queue has nothing runnable,
 * otherwise `{ jobId, kind, ownerId, ok, state?, error? }`.
 *
 * Phase 3 — the lifecycle of one attempt:
 *   claim (fenced: this worker, this attempt) → heartbeat every
 *   HEARTBEAT_EVERY_MS while the handler runs → owner deleted? complete as a
 *   no-op → load the owner (database unreachable → RELEASE, attempt not
 *   counted) → handler → flush every partition write (incomplete → the job
 *   fails and retries; nothing is acknowledged while its result is only in
 *   memory) → complete, fenced. A worker whose claim was taken away (it looked
 *   dead) can neither complete nor fail the job: its result is discarded.
 */
export async function runOneJob(workerId, { kinds = null, handlers = HANDLERS } = {}) {
  const job = await claim(workerId, { kinds });
  if (!job) return null;
  const fence = job.fence ?? null;
  const t0 = Date.now();
  const queueWaitMs = job.createdAt ? Math.max(0, new Date(job.claimedAt ?? t0).getTime() - new Date(job.createdAt).getTime()) : null;
  logJobEvent('claimed', job, { workerId, queueWaitMs });

  const handler = handlers[job.kind];
  if (!handler) {
    await fail(job.jobId, `no handler registered for kind "${job.kind}"`, fence);
    console.warn(`[WORKER] job ${job.jobId} kind=${job.kind} has no handler`);
    logJobEvent('failed', job, { error: 'no-handler' });
    return { jobId: job.jobId, kind: job.kind, ownerId: job.ownerId, ok: false, error: 'no-handler' };
  }

  const entry = { job, timer: null, lost: false };
  if (fence) {
    entry.timer = setInterval(() => {
      heartbeat(job.jobId, fence)
        .then(held => { if (!held && !entry.lost) { entry.lost = true; logJobEvent('lost', job, { reason: 'claim taken over' }); } })
        .catch(() => { /* a missed beat; the next one retries */ });
    }, HEARTBEAT_EVERY_MS);
    entry.timer.unref?.();
    inFlight.set(job.jobId, entry);
  }
  const done = () => { clearInterval(entry.timer); inFlight.delete(job.jobId); };

  const span = startSpan('job.run', {
    'aqua.job_kind': job.kind, 'aqua.attempts': Number(job.attempts ?? 0), 'aqua.owner_hash': hashOwner(job.ownerId),
  });
  const base = { jobId: job.jobId, kind: job.kind, ownerId: job.ownerId };
  try {
    // Phase 3: an account deleted while this job waited — nothing to learn, nothing to write.
    if (await isOwnerDeleted(job.ownerId)) {
      done();
      await complete(job.jobId, fence);
      logJobEvent('skipped', job, { reason: 'owner-deleted', runMs: Date.now() - t0 });
      return { ...base, ok: true, skipped: 'owner-deleted' };
    }
    // Phase 2b — the job is the unit of work: load its owner into every store
    // that is authoritative on partitions. A database that cannot answer is not
    // the job's fault: give it back without counting the attempt.
    if (anyPartitionStoreAuthoritative()) {
      try { await ensureOwnerLoaded(job.ownerId); }
      catch (err) {
        if (!isDatabaseUnavailable(err)) throw err;
        done();
        try { await release(job.jobId, fence, { delayMs: 5_000, reason: `owner load: ${String(err?.message ?? err).slice(0, 200)}` }); } catch { /* db down: recovery reclaims it */ }
        logJobEvent('released', job, { reason: 'database-unavailable', error: String(err?.message ?? err) });
        return { ...base, ok: false, state: 'released', error: String(err?.message ?? err) };
      }
    }
    const outcome = await handler(job);
    // Nothing is acknowledged while what it wrote is only in this process's memory.
    if (anyPartitionStoreAuthoritative()) await flushOwnerBindingsStrict();
    done();
    if (entry.lost) {
      logJobEvent('lost', job, { reason: 'claim taken over before completion; result discarded', runMs: Date.now() - t0 });
      return { ...base, ok: false, state: 'lost' };
    }
    const acked = await complete(job.jobId, fence);
    span.setAttribute('aqua.outcome', acked ? 'done' : 'lost');
    if (!acked) {
      logJobEvent('lost', job, { reason: 'fence mismatch at completion', runMs: Date.now() - t0 });
      return { ...base, ok: false, state: 'lost' };
    }
    console.log(`[WORKER] job ${job.jobId} kind=${job.kind} owner=${job.ownerId} done`);
    logJobEvent('done', job, { runMs: Date.now() - t0, queueWaitMs, outcome: outcome?.skipped ? `skipped:${outcome.skipped}` : 'applied' });
    return { ...base, ok: true, ...(outcome?.skipped ? { skipped: outcome.skipped } : {}) };
  } catch (err) {
    done();
    span.setStatus('error');
    reportError(err, { where: `job.${String(job.kind).replace(/[^a-z0-9._-]/gi, '_')}`, ownerId: job.ownerId });
    let r;
    try { r = await fail(job.jobId, err, fence); }
    catch (e2) {
      // Could not even record the failure (database gone): the heartbeat
      // stopped, and recovery reclaims the job once it is stale.
      logJobEvent('unrecorded', job, { error: String(err?.message ?? err), recordError: String(e2?.message ?? e2) });
      return { ...base, ok: false, state: 'unrecorded', error: String(err?.message ?? err) };
    }
    span.setAttribute('aqua.outcome', r.state === 'dead' ? 'dead' : r.state === 'lost' ? 'lost' : 'retry');
    const detail = r.state === 'dead'
      ? `DEAD after ${job.attempts} attempt(s)`
      : r.state === 'lost' ? 'claim lost; not recorded' : `retry in ${Math.round(r.retryInMs / 1000)}s`;
    console.error(`[WORKER] job ${job.jobId} kind=${job.kind} failed — ${detail}: ${err?.message ?? err}`);
    logJobEvent(r.state === 'dead' ? 'dead' : r.state === 'lost' ? 'lost' : 'retry', job,
      { runMs: Date.now() - t0, retryInMs: r.retryInMs, error: String(err?.message ?? err).slice(0, 300) });
    return { ...base, ok: false, state: r.state, error: String(err?.message ?? err) };
  } finally {
    span.end();
  }
}

/**
 * Run the production dispatch + claim loop until nothing is runnable. Bounded
 * by `maxJobs` (G6). Jobs that failed and were rescheduled into the future are
 * not waited for — the summary reports them so a caller can tell "drained"
 * from "drained except for N retries".
 */
export async function drainUntilIdle({ workerId = `drain-${process.pid}`, kinds = null, maxJobs = 2000 } = {}) {
  const summary = { ran: 0, ok: 0, failed: 0, byKind: {}, errors: [] };
  for (let i = 0; i < maxJobs; i++) {
    await dispatchReflections();
    const r = await runOneJob(workerId, { kinds });
    if (!r) break;
    summary.ran++;
    summary.byKind[r.kind] ??= { ok: 0, failed: 0 };
    if (r.ok) { summary.ok++; summary.byKind[r.kind].ok++; } else {
      summary.failed++; summary.byKind[r.kind].failed++;
      if (summary.errors.length < 20) summary.errors.push({ kind: r.kind, error: r.error });
    }
  }
  return summary;
}
