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

function requireOwner(ownerId) {
  if (!ownerId) throw new Error('reflection outbox: ownerId is required');
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
  const job = toReflectionJob(row);
  if (!job) return { dispatched: false, reason: 'not-claim-reflection-event' };

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
      LIMIT $2`, [[...CLAIM_EVENTS], limit]);
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
