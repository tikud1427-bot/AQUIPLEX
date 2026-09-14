/**
 * AQUA Brain — E9 / PR-7 reflection recovery + reconciliation policy.
 *
 * Recovery is explicit and observable. A dead reflection job is evidence of a
 * failed delivery, not a reason to silently mutate Mind from a scanner.
 * Requeue is idempotent and owner-scoped; reconciliation reports whether the
 * canonical event has a durable job and whether Mind already records its
 * effect.
 */
import { getPool, isConfigured } from '../../core/db/pool.js';
import { enqueue } from '../../core/jobs/jobQueue.js';
import { reflectionEffectKey } from './reflectionIdempotency.js';
import { isClaimReflectionEvent, toReflectionJob } from './reflectionOutbox.js';

export function reflectionRecoveryAction({ jobState, hasEffect }) {
  if (hasEffect) return 'already-applied';
  if (jobState === 'dead') return 'requeue-required';
  if (jobState === 'queued' || jobState === 'running') return 'in-flight';
  if (jobState === 'done') return 'reconcile-required';
  return 'missing';
}

export function reflectionReconciliation({ outboxRow, jobRow = null, hasEffect = false } = {}) {
  if (!outboxRow || !isClaimReflectionEvent(outboxRow.eventType)) {
    return { relevant: false, action: 'ignore' };
  }
  const jobState = jobRow?.state ?? null;
  return {
    relevant: true,
    ownerId: outboxRow.ownerId,
    outboxId: Number(outboxRow.outboxId),
    claimId: outboxRow.payload?.claimId ?? outboxRow.aggregateId,
    jobState,
    hasEffect: Boolean(hasEffect),
    action: reflectionRecoveryAction({ jobState, hasEffect }),
  };
}

/** Explicitly recover one dead reflection job. Never resurrect another owner. */
export async function requeueDeadReflectionJob(jobId, { ownerId } = {}) {
  if (!jobId || !ownerId) throw new Error('requeue dead reflection job requires jobId and ownerId');
  if (!isConfigured()) throw new Error('DATABASE_URL is not set — reflection recovery cannot run');
  const p = await getPool();
  const { rows } = await p.query(
    `SELECT job_id, owner_id, kind, payload, state
       FROM aqua_jobs WHERE job_id=$1 AND owner_id=$2 FOR UPDATE`, [jobId, ownerId]);
  if (!rows.length) return { requeued: false, reason: 'not-found' };
  const row = rows[0];
  if (row.kind !== 'claim.reflection.v1') return { requeued: false, reason: 'wrong-kind' };
  if (row.state !== 'dead') return { requeued: false, reason: `state:${row.state}` };

  const outboxId = row.payload?.outboxId;
  const eventType = row.payload?.eventType;
  const claimId = row.payload?.claimId;
  if (!outboxId || !claimId || !isClaimReflectionEvent(eventType)) {
    return { requeued: false, reason: 'invalid-reflection-payload' };
  }

  // Reuse the original durable row. Creating a second row would violate the
  // queue's (owner,idempotency_key) uniqueness and, more importantly, would
  // obscure the retry history. The dead row itself becomes the retry record.
  const { rowCount } = await p.query(
    `UPDATE aqua_jobs
        SET state='queued', run_after=now(), claimed_by=NULL, claimed_at=NULL,
            last_error=NULL, updated_at=now()
      WHERE job_id=$1 AND owner_id=$2 AND state='dead'`, [jobId, ownerId]);
  return { requeued: rowCount === 1, jobId: Number(jobId), sourceJobId: Number(jobId), attempts: row.attempts };
}

/**
 * Report pending claim events and their current durable reflection job state.
 * This is intentionally read-only; operators can then choose explicit retry.
 */
export async function reconcilePendingClaimReflections({ ownerId = null, limit = 100 } = {}) {
  if (!isConfigured()) throw new Error('DATABASE_URL is not set — reflection reconciliation cannot run');
  const p = await getPool();
  const args = [];
  const ownerClause = ownerId ? `AND o.owner_id=$${args.push(ownerId)}` : '';
  const limitPos = args.push(limit);
  const { rows } = await p.query(
    `SELECT o.outbox_id, o.owner_id, o.event_type, o.aggregate_id, o.payload,
            j.job_id, j.state AS job_state
       FROM aqua_outbox o
       LEFT JOIN aqua_jobs j
         ON j.owner_id=o.owner_id
        AND j.idempotency_key=('e9:claim-reflection:outbox:' || o.outbox_id::text)
      WHERE o.event_type = ANY($${args.push([...new Set(['claim.created','claim.corroborated','claim.contradicted','claim.superseded','claim.stale'])])}::text[])
        AND o.state IN ('pending','published','dead') ${ownerClause}
      ORDER BY o.outbox_id ASC LIMIT $${limitPos}`,
    args);
  return rows.map(row => reflectionReconciliation({
    outboxRow: { outboxId: row.outbox_id, ownerId: row.owner_id, eventType: row.event_type, aggregateId: row.aggregate_id, payload: row.payload },
    jobRow: row.job_id ? { jobId: row.job_id, state: row.job_state } : null,
    hasEffect: false,
  }));
}
