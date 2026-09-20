/**
 * AQUA Brain — E9 / PR-8 canonical reflection reconciliation.
 *
 * The canonical outbox is authoritative. A reflection job may say `done` while
 * the Mind snapshot contains no corresponding effect marker (for example a
 * process can die before the debounced Mind snapshot reaches disk). In that
 * case we do not create a second job: the original durable row is reopened.
 * This preserves its idempotency key and attempt history.
 */
import { getPool, isConfigured } from '../../core/db/pool.js';
import { getMind, touchMind } from '../../mind/mindStore.js';
import { hasReflectionEffect } from './reflectionIdempotency.js';
import { isClaimReflectionEvent, reflectionJobKey } from './reflectionOutbox.js';

const CLAIM_EVENTS = [
  'claim.created',
  'claim.corroborated',
  'claim.contradicted',
  'claim.superseded',
  'claim.stale',
];

export function needsReflectionReconciliation({ jobState, hasEffect }) {
  if (hasEffect) return false;
  return jobState === 'done' || jobState === 'dead' || jobState == null;
}

export function reconciliationDecision({ eventType, jobState, hasEffect }) {
  if (!isClaimReflectionEvent(eventType)) return 'ignore';
  if (hasEffect) return 'applied';
  if (jobState === 'queued' || jobState === 'running') return 'in-flight';
  if (jobState === 'done') return 'requeue-done';
  if (jobState === 'dead') return 'requeue-dead';
  return 'missing-job';
}

/**
 * Reopen one completed/dead reflection job whose effect is absent from Mind.
 * The caller supplies the already-inspected effect state so this primitive is
 * also easy to test without a database.
 */
export async function requeueUnappliedReflectionJob(jobId, ownerId, { hasEffect = false } = {}) {
  if (!jobId || !ownerId) throw new Error('reflection reconciliation requires jobId and ownerId');
  if (hasEffect) return { requeued: false, reason: 'already-applied' };
  if (!isConfigured()) throw new Error('DATABASE_URL is not set — reflection reconciliation cannot run');
  const p = await getPool();
  await p.query('BEGIN');
  try {
    const { rows } = await p.query(
      `SELECT job_id, owner_id, kind, state
         FROM aqua_jobs
        WHERE job_id=$1 AND owner_id=$2
        FOR UPDATE`, [jobId, ownerId]);
    if (!rows.length) {
      await p.query('COMMIT');
      return { requeued: false, reason: 'not-found' };
    }
    const row = rows[0];
    if (row.kind !== 'claim.reflection.v1') {
      await p.query('COMMIT');
      return { requeued: false, reason: 'wrong-kind' };
    }
    if (!['done', 'dead'].includes(row.state)) {
      await p.query('COMMIT');
      return { requeued: false, reason: `state:${row.state}` };
    }

    const { rowCount } = await p.query(
      `UPDATE aqua_jobs
          SET state='queued', run_after=now(), claimed_by=NULL, claimed_at=NULL,
              last_error=CASE WHEN state='dead' THEN last_error ELSE 'reconciled: effect marker absent' END,
              updated_at=now()
        WHERE job_id=$1 AND owner_id=$2 AND state IN ('done','dead')`, [jobId, ownerId]);
    await p.query('COMMIT');
    return { requeued: rowCount === 1, jobId: Number(jobId), previousState: row.state };
  } catch (err) {
    await p.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/**
 * Reconcile claim-reflection jobs against the current owner's Mind ledger.
 * Missing jobs are returned for the outbox dispatcher; existing done/dead jobs
 * are reopened in-place. No Mind mutation occurs here.
 */
export async function reconcileClaimReflectionJobs({ ownerId, limit = 100, mind = null } = {}) {
  if (!ownerId) throw new Error('reconcile claim reflections requires ownerId');
  if (!isConfigured()) throw new Error('DATABASE_URL is not set — reflection reconciliation cannot run');
  const p = await getPool();
  const { rows } = await p.query(
    `SELECT o.outbox_id, o.event_type, o.aggregate_id, o.payload,
            j.job_id, j.state AS job_state
       FROM aqua_outbox o
       LEFT JOIN aqua_jobs j
         ON j.owner_id=o.owner_id
        AND j.idempotency_key=('e9:claim-reflection:outbox:' || o.outbox_id::text)
      WHERE o.owner_id=$1
        AND o.event_type = ANY($2::text[])
        AND o.state IN ('pending','published','dead')
      ORDER BY o.outbox_id ASC
      LIMIT $3`, [ownerId, CLAIM_EVENTS, limit]);

  const currentMind = mind ?? getMind(ownerId);
  const results = [];
  for (const row of rows) {
    const event = {
      ownerId,
      outboxId: Number(row.outbox_id),
      eventType: row.event_type,
      claimId: row.payload?.claimId ?? row.aggregate_id,
    };
    const key = reflectionJobKey(event);
    const applied = hasReflectionEffect(currentMind, key);
    const action = reconciliationDecision({ eventType: row.event_type, jobState: row.job_state, hasEffect: applied });

    if (action === 'requeue-done' || action === 'requeue-dead') {
      results.push(await requeueUnappliedReflectionJob(Number(row.job_id), ownerId, { hasEffect: false }));
    } else {
      results.push({ outboxId: event.outboxId, action, jobId: row.job_id ? Number(row.job_id) : null });
    }
  }
  return results;
}
