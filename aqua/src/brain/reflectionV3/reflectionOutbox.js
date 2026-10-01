/**
 * AQUA Brain — E9 / PR-5 claim reflection outbox bridge.
 *
 * Durable boundary: canonical claim lifecycle events are converted into one
 * idempotent durable job. The outbox is the source of truth; this module never
 * mutates Mind while publishing. A worker owns the actual reflection.
 */
import crypto from 'node:crypto';
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

const OUTBOX_EVENT_TYPES = Object.freeze([...CLAIM_EVENTS, CONTRADICTION_EVENT, EMBEDDING_EVENT]);
const OUTBOX_CLAIM_TTL_MS = Math.max(60_000, Number(process.env.AQUA_OUTBOX_CLAIM_TTL_MS ?? 10 * 60_000));

function workerIdentity() {
  return `${process.pid}:${crypto.randomUUID()}`;
}

/**
 * Recover rows stranded in `processing` by a crashed dispatcher. This is
 * deliberately bounded and owner-agnostic: the row remains structurally
 * owner-scoped and is simply made claimable again.
 */
export async function reapStaleClaimOutbox({ ttlMs = OUTBOX_CLAIM_TTL_MS } = {}) {
  if (!isConfigured()) return 0;
  const p = await getPool();
  const ttl = Math.max(60_000, Number(ttlMs) || OUTBOX_CLAIM_TTL_MS);
  const { rowCount = 0 } = await p.query(
    `UPDATE aqua_outbox
        SET state='pending', claimed_at=NULL, claimed_by=NULL,
            available_at=now(), last_error=COALESCE(last_error, 'dispatcher claim expired')
      WHERE state='processing'
        AND claimed_at IS NOT NULL
        AND claimed_at < now() - ($1::bigint * interval '1 millisecond')`, [ttl]);
  return rowCount;
}

async function claimPendingRow(outboxId, claimer) {
  const p = await getPool();
  // One round-trip, one winner. FOR UPDATE SKIP LOCKED makes the dispatcher
  // safe across multiple worker processes; only the winner leaves `pending`.
  const { rows } = await p.query(
    `WITH candidate AS (
       SELECT outbox_id
         FROM aqua_outbox
        WHERE state='pending'
          AND outbox_id=$1
          AND available_at <= now()
          AND event_type = ANY($2::text[])
        FOR UPDATE SKIP LOCKED
     )
     UPDATE aqua_outbox o
        SET state='processing', claimed_at=now(), claimed_by=$3,
            attempts=attempts+1, last_error=NULL
       FROM candidate c
      WHERE o.outbox_id=c.outbox_id
      RETURNING o.outbox_id,o.owner_id,o.event_type,o.aggregate_id,o.payload`,
    [outboxId, OUTBOX_EVENT_TYPES, claimer]);
  return rows[0] ?? null;
}

async function publishClaimedRow(p, row, { jobEnqueue = enqueue } = {}) {
  const normalized = {
    outboxId: Number(row.outbox_id), ownerId: row.owner_id,
    eventType: row.event_type, aggregateId: row.aggregate_id, payload: row.payload,
  };
  const job = toEmbeddingJob(normalized) ?? toReflectionJob(normalized) ?? toContradictionJob(normalized);
  if (!job) {
    await p.query(
      `UPDATE aqua_outbox SET state='published', published_at=now(), claimed_by=NULL, claimed_at=NULL
        WHERE outbox_id=$1 AND state='processing' AND claimed_by=$2`,
      [row.outbox_id, row.claimed_by]);
    return { dispatched: false, outboxId: Number(row.outbox_id), reason: 'not-supported-claim-event' };
  }

  try {
    const result = await jobEnqueue(job);
    await p.query(
      `UPDATE aqua_outbox
          SET state='published', published_at=now(), claimed_by=NULL, claimed_at=NULL, last_error=NULL
        WHERE outbox_id=$1 AND state='processing' AND claimed_by=$2`,
      [row.outbox_id, row.claimed_by]);
    return { dispatched: true, outboxId: Number(row.outbox_id), jobId: result.jobId, jobCreated: result.created };
  } catch (error) {
    await p.query(
      `UPDATE aqua_outbox
          SET state = CASE WHEN attempts >= 8 THEN 'dead' ELSE 'pending' END,
              available_at = now() + CASE WHEN attempts >= 8 THEN interval '0' ELSE interval '5 seconds' END,
              claimed_by=NULL, claimed_at=NULL, last_error=$3
        WHERE outbox_id=$1 AND state='processing' AND claimed_by=$2`,
      [row.outbox_id, row.claimed_by, String(error?.message ?? error).slice(0, 1000)]);
    throw error;
  }
}

/** Publish one pending claim event into the durable queue. */
export async function dispatchOutboxRow(outboxId, { jobEnqueue = enqueue, claimer = workerIdentity() } = {}) {
  if (!isConfigured()) throw new Error('DATABASE_URL is not set — reflection outbox cannot dispatch');
  if (!Number.isFinite(Number(outboxId))) return { dispatched: false, reason: 'invalid-outbox-id' };
  await reapStaleClaimOutbox();
  const p = await getPool();
  const claimed = await claimPendingRow(Number(outboxId), claimer);
  if (!claimed) return { dispatched: false, outboxId: Number(outboxId), reason: 'not-pending-or-claimed' };
  claimed.claimed_by = claimer;
  return publishClaimedRow(p, claimed, { jobEnqueue });
}

/** Claim and publish a bounded batch with cross-process-safe ownership. */
export async function dispatchPendingClaimReflections({ limit = 25, jobEnqueue = enqueue, claimer = workerIdentity() } = {}) {
  if (!isConfigured()) throw new Error('DATABASE_URL is not set — reflection outbox cannot dispatch');
  const batch = Math.max(1, Math.min(100, Math.floor(Number(limit) || 25)));
  const reaped = await reapStaleClaimOutbox();
  const p = await getPool();
  const { rows } = await p.query(
    `SELECT outbox_id FROM aqua_outbox
      WHERE state='pending' AND event_type=ANY($1::text[]) AND available_at <= now()
      ORDER BY outbox_id ASC LIMIT $2`, [OUTBOX_EVENT_TYPES, batch]);
  const results = [];
  for (const r of rows) {
    try {
      const claimed = await claimPendingRow(Number(r.outbox_id), claimer);
      if (!claimed) {
        results.push({ dispatched: false, outboxId: Number(r.outbox_id), reason: 'lost-race' });
        continue;
      }
      claimed.claimed_by = claimer;
      results.push(await publishClaimedRow(p, claimed, { jobEnqueue }));
    } catch (error) {
      results.push({ dispatched: false, outboxId: Number(r.outbox_id), error: String(error?.message ?? error) });
    }
  }
  return { reaped, results };
}
