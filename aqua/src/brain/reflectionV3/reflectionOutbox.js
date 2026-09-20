/**
 * AQUA Brain — E9 / PR-5 claim reflection outbox bridge.
 *
 * Durable boundary: canonical claim lifecycle events are converted into one
 * idempotent durable job. The outbox is the source of truth; this module never
 * mutates Mind while publishing. A worker owns the actual reflection.
 */
import { getPool, isConfigured } from '../../core/db/pool.js';
import { enqueue } from '../../core/jobs/jobQueue.js';

const CLAIM_EVENTS = new Set([
  'claim.created',
  'claim.corroborated',
  'claim.contradicted',
  'claim.superseded',
  'claim.stale',
]);

const CONTRADICTION_EVENT = 'claim.contradiction.detected';
const EMBEDDING_EVENT = 'claim.embedding.requested';

function requireOwner(ownerId) {
  if (!ownerId) throw new Error('reflection outbox: ownerId is required');
}

export function contradictionJobKey(outboxRow) {
  if (!outboxRow?.outboxId) throw new Error('reflection outbox: outboxId is required');
  return `e9:claim-contradiction:outbox:${outboxRow.outboxId}`;
}

export function isClaimContradictionEvent(eventType) {
  return eventType === CONTRADICTION_EVENT;
}

export function toContradictionJob(outboxRow) {
  if (!isClaimContradictionEvent(outboxRow?.eventType)) return null;
  requireOwner(outboxRow.ownerId);
  const payload = outboxRow.payload ?? {};
  const incomingClaimId = payload.incomingClaimId ?? null;
  const existingClaimId = payload.existingClaimId ?? null;
  if (!incomingClaimId || !existingClaimId) throw new Error('contradiction outbox: both claim ids are required');
  return {
    ownerId: outboxRow.ownerId,
    kind: 'claim.contradiction.v1',
    payload: {
      ownerId: outboxRow.ownerId,
      incomingClaimId,
      existingClaimId,
      outboxId: Number(outboxRow.outboxId),
      kind: payload.kind ?? null,
      reason: payload.reason ?? null,
      subject: payload.subject ?? null,
      predicate: payload.predicate ?? null,
    },
    idempotencyKey: contradictionJobKey(outboxRow),
    priority: 25,
  };
}


export function embeddingJobKey(outboxRow) {
  if (!outboxRow?.outboxId) throw new Error('reflection outbox: outboxId is required');
  return `e7:claim-embedding:outbox:${outboxRow.outboxId}`;
}

export function isClaimEmbeddingEvent(eventType) {
  return eventType === EMBEDDING_EVENT;
}

export function toEmbeddingJob(outboxRow) {
  if (!isClaimEmbeddingEvent(outboxRow?.eventType)) return null;
  requireOwner(outboxRow.ownerId);
  const claimId = outboxRow.payload?.claimId ?? outboxRow.aggregateId;
  const statementText = outboxRow.payload?.statementText;
  if (!claimId || !statementText) throw new Error('embedding outbox: claimId and statementText are required');
  return {
    ownerId: outboxRow.ownerId,
    kind: 'claim.embedding.v1',
    payload: {
      ownerId: outboxRow.ownerId,
      claimId,
      statementText: String(statementText),
      contentHash: outboxRow.payload?.contentHash ?? null,
      outboxId: Number(outboxRow.outboxId),
    },
    idempotencyKey: embeddingJobKey(outboxRow),
    priority: 40,
  };
}

export function reflectionJobKey(outboxRow) {
  if (!outboxRow?.outboxId) throw new Error('reflection outbox: outboxId is required');
  return `e9:claim-reflection:outbox:${outboxRow.outboxId}`;
}

export function isClaimReflectionEvent(eventType) {
  return CLAIM_EVENTS.has(eventType);
}

export function toReflectionJob(outboxRow) {
  if (!isClaimReflectionEvent(outboxRow?.eventType)) return null;
  requireOwner(outboxRow.ownerId);
  const claimId = outboxRow.payload?.claimId ?? outboxRow.aggregateId;
  if (!claimId) throw new Error('reflection outbox: claimId is required');
  return {
    ownerId: outboxRow.ownerId,
    kind: 'claim.reflection.v1',
    payload: {
      ownerId: outboxRow.ownerId,
      claimId,
      eventType: outboxRow.eventType,
      outboxId: Number(outboxRow.outboxId),
      ...(outboxRow.payload?.previousState ? { previousState: outboxRow.payload.previousState } : {}),
      ...(outboxRow.payload?.nextState ? { nextState: outboxRow.payload.nextState } : {}),
      ...(outboxRow.payload?.conversationId ? { conversationId: outboxRow.payload.conversationId } : {}),
    },
    idempotencyKey: reflectionJobKey(outboxRow),
    priority: 30,
  };
}

/** Publish one pending claim event into the durable queue. */
export async function dispatchOutboxRow(outboxId, { jobEnqueue = enqueue } = {}) {
  if (!isConfigured()) throw new Error('DATABASE_URL is not set — reflection outbox cannot dispatch');
  const p = await getPool();
  const { rows } = await p.query(
    `SELECT outbox_id, owner_id, event_type, aggregate_id, payload
       FROM aqua_outbox
      WHERE outbox_id = $1 AND state = 'pending'`, [outboxId]);
  if (!rows.length) return { dispatched: false, reason: 'not-pending' };

  const row = {
    outboxId: Number(rows[0].outbox_id), ownerId: rows[0].owner_id,
    eventType: rows[0].event_type, aggregateId: rows[0].aggregate_id,
    payload: rows[0].payload,
  };
  const job = toEmbeddingJob(row) ?? toReflectionJob(row) ?? toContradictionJob(row);
  if (!job) return { dispatched: false, reason: 'not-supported-claim-event' };

  const result = await jobEnqueue(job);
  await p.query(
    `UPDATE aqua_outbox
        SET state = 'published', published_at = now(), claimed_by = NULL, claimed_at = NULL
      WHERE outbox_id = $1 AND state = 'pending'`, [outboxId]);
  return { dispatched: true, outboxId: Number(outboxId), jobId: result.jobId, jobCreated: result.created };
}

/** Claim a small pending batch without stealing another worker's rows. */
export async function dispatchPendingClaimReflections({ limit = 25, jobEnqueue = enqueue } = {}) {
  if (!isConfigured()) throw new Error('DATABASE_URL is not set — reflection outbox cannot dispatch');
  const p = await getPool();
  const { rows } = await p.query(
    `SELECT outbox_id, owner_id, event_type, aggregate_id, payload
       FROM aqua_outbox
      WHERE state = 'pending'
        AND event_type = ANY($1::text[])
        AND available_at <= now()
      ORDER BY outbox_id ASC
      LIMIT $2`, [[...CLAIM_EVENTS, CONTRADICTION_EVENT, EMBEDDING_EVENT], limit]);
  const results = [];
  for (const r of rows) {
    try {
      results.push(await dispatchOutboxRow(Number(r.outbox_id), { jobEnqueue }));
    } catch (error) {
      results.push({ dispatched: false, outboxId: Number(r.outbox_id), error: String(error?.message ?? error) });
    }
  }
  return results;
}
