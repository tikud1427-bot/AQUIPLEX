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
import { claim, complete, fail, enqueue } from './jobQueue.js';
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
    const result = await Brain.understandTurn({
      ownerId: job.ownerId,
      conversationId: payload.conversationId ?? null,
      turn: Number.isInteger(payload.turn) ? payload.turn : null,
      userMessage: payload.userMessage ?? '',
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
    const conversationId = `file:${String(p.hash ?? p.ukoId ?? 'unknown').slice(0, 32)}`;
    const result = await Brain.understandTurn({
      ownerId: job.ownerId, conversationId,
      turn: Number.isInteger(p.chunk) ? p.chunk + 1 : 1,
      userMessage: text,
      source: { kind: 'document', name: String(p.name ?? 'document'), hash: p.hash ?? null, chunk: Number.isInteger(p.chunk) ? p.chunk : 0 },
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
});

/** Phase 4 periodic scan interval (default 1 h; 0 = never). Registered setting AQUA_PROACTIVE_INTERVAL_MS. */
export const PROACTIVE_INTERVAL_MS = (() => {
  const v = Number(process.env.AQUA_PROACTIVE_INTERVAL_MS);
  return Number.isFinite(v) && v >= 0 ? v : 60 * 60_000;
})();
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
 * Claim one job and run it. Returns null when the queue has nothing runnable,
 * otherwise `{ jobId, kind, ownerId, ok, state?, error? }`.
 */
export async function runOneJob(workerId, { kinds = null, handlers = HANDLERS } = {}) {
  const job = await claim(workerId, { kinds });
  if (!job) return null;

  const handler = handlers[job.kind];
  if (!handler) {
    await fail(job.jobId, `no handler registered for kind "${job.kind}"`);
    console.warn(`[WORKER] job ${job.jobId} kind=${job.kind} has no handler`);
    return { jobId: job.jobId, kind: job.kind, ownerId: job.ownerId, ok: false, error: 'no-handler' };
  }

  const span = startSpan('job.run', {
    'aqua.job_kind': job.kind, 'aqua.attempts': Number(job.attempts ?? 0), 'aqua.owner_hash': hashOwner(job.ownerId),
  });
  try {
    await handler(job);
    await complete(job.jobId);
    span.setAttribute('aqua.outcome', 'done');
    console.log(`[WORKER] job ${job.jobId} kind=${job.kind} owner=${job.ownerId} done`);
    return { jobId: job.jobId, kind: job.kind, ownerId: job.ownerId, ok: true };
  } catch (err) {
    span.setStatus('error');
    reportError(err, { where: `job.${String(job.kind).replace(/[^a-z0-9._-]/gi, '_')}`, ownerId: job.ownerId });
    const r = await fail(job.jobId, err);
    span.setAttribute('aqua.outcome', r.state === 'dead' ? 'dead' : 'retry');
    const detail = r.state === 'dead'
      ? `DEAD after ${job.attempts} attempt(s)`
      : `retry in ${Math.round(r.retryInMs / 1000)}s`;
    console.error(`[WORKER] job ${job.jobId} kind=${job.kind} failed — ${detail}: ${err?.message ?? err}`);
    return { jobId: job.jobId, kind: job.kind, ownerId: job.ownerId, ok: false, state: r.state,
      error: String(err?.message ?? err) };
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
