/**
 * AQUA — bounded action runs, persistence (Phase 5, 2026-10-06).
 * Owner-scoped, bounded, compare-and-set; every transition is audited in the
 * L1 delta log (aqua_outbox record rows `action.*`).
 */
import crypto from 'node:crypto';
import { getPool, isConfigured } from '../../core/db/pool.js';

async function pool() {
  if (!isConfigured()) throw new Error('DATABASE_URL is not set — action runs need Postgres');
  return getPool();
}

async function audit(client, ownerId, runId, eventType, payload, actor) {
  await client.query(`
    INSERT INTO aqua_outbox (owner_id, event_type, aggregate_kind, aggregate_id, payload, actor, state, published_at)
    VALUES ($1,$2,'action',$3,$4::jsonb,$5,'published',now())`, [ownerId, eventType, runId, JSON.stringify(payload ?? {}), actor]);
}

const COLS = `run_id, owner_id, intervention_id, kind, title, plan, status, approval, result, error, attempts,
  max_attempts, step_budget, expires_at, created_at, approved_at, started_at, finished_at`;
const api = r => (r ? {
  runId: r.run_id, interventionId: r.intervention_id, kind: r.kind, title: r.title, plan: r.plan, status: r.status,
  approval: r.approval, result: r.result, error: r.error, attempts: r.attempts, maxAttempts: r.max_attempts,
  stepBudget: r.step_budget, expiresAt: r.expires_at, createdAt: r.created_at, approvedAt: r.approved_at,
  startedAt: r.started_at, finishedAt: r.finished_at,
} : null);

/** Propose a run for an intervention. Idempotent on (owner, intervention, kind). */
export async function proposeRun(ownerId, { interventionId = null, plan, expiresAt, actor = 'aqua:planner' }) {
  const p = await pool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const runId = crypto.randomUUID();
    const key = `${interventionId ? `iv:${interventionId}` : `adhoc:${crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 24)}`}:${plan.kind}`;
    const { rows } = await client.query(`
      INSERT INTO aqua_action_runs (run_id, owner_id, intervention_id, kind, title, plan, idempotency_key,
        max_attempts, step_budget, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
      ON CONFLICT (owner_id, idempotency_key) DO NOTHING RETURNING ${COLS}`,
    [runId, ownerId, interventionId, plan.kind, plan.title, JSON.stringify(plan), key,
      plan.maxAttempts ?? 3, plan.stepBudget ?? plan.steps.length, expiresAt]);
    if (!rows.length) {
      await client.query('ROLLBACK');
      const ex = await p.query(`SELECT ${COLS} FROM aqua_action_runs WHERE owner_id=$1 AND idempotency_key=$2`, [ownerId, key]);
      return { created: false, run: api(ex.rows[0]) };
    }
    await audit(client, ownerId, runId, 'action.proposed', { kind: plan.kind, interventionId }, actor);
    await client.query('COMMIT');
    return { created: true, run: api(rows[0]) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

export async function getRun(ownerId, runId) {
  const p = await pool();
  const { rows } = await p.query(`SELECT ${COLS} FROM aqua_action_runs WHERE owner_id=$1 AND run_id=$2`, [ownerId, runId]);
  return api(rows[0]);
}

export async function listRuns(ownerId, { status = null, limit = 50 } = {}) {
  const p = await pool();
  const { rows } = await p.query(`SELECT ${COLS} FROM aqua_action_runs WHERE owner_id=$1 AND ($2::text IS NULL OR status=$2)
    ORDER BY created_at DESC LIMIT $3`, [ownerId, status, Math.min(Math.max(1, limit), 200)]);
  return rows.map(api);
}

/**
 * Compare-and-set a status transition. Returns the updated run, or null when
 * the run was not in `from` (someone else won, or it already moved).
 */
export async function transitionRun(ownerId, runId, from, to, { set = {}, actor = 'user', audit: auditPayload = {} } = {}) {
  const p = await pool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const fields = ['status=$4'];
    const params = [ownerId, runId, from, to];
    for (const [col, val] of Object.entries(set)) {
      params.push(val && typeof val === 'object' && !(val instanceof Date) ? JSON.stringify(val) : val);
      fields.push(`${col}=$${params.length}${['approval', 'result'].includes(col) ? '::jsonb' : ''}`);
    }
    const { rows } = await client.query(`UPDATE aqua_action_runs SET ${fields.join(', ')}
      WHERE owner_id=$1 AND run_id=$2 AND status = ANY($3::text[]) RETURNING ${COLS}`,
    [ownerId, runId, Array.isArray(from) ? from : [from], to, ...params.slice(4)]);
    if (!rows.length) { await client.query('ROLLBACK'); return null; }
    await audit(client, ownerId, runId, `action.${to}`, { from, ...auditPayload }, actor);
    await client.query('COMMIT');
    return api(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

/** Persist the per-step results as they complete (retries skip finished steps). */
export async function saveResult(ownerId, runId, result) {
  const p = await pool();
  await p.query(`UPDATE aqua_action_runs SET result=$3::jsonb WHERE owner_id=$1 AND run_id=$2`, [ownerId, runId, JSON.stringify(result)]);
}

export async function expireRuns(ownerId, now = new Date()) {
  const p = await pool();
  const { rowCount } = await p.query(`UPDATE aqua_action_runs SET status='expired' WHERE owner_id=$1 AND status='proposed' AND expires_at <= $2`, [ownerId, now]);
  return rowCount ?? 0;
}

/** G4. Runs reference interventions, so they go first (accountPurge orders the steps). */
export async function purgeOwner(ownerId) {
  if (!ownerId) return { runs: 0, skipped: 'no owner' };
  if (!isConfigured()) return { runs: 0, skipped: 'postgres not configured' };
  const p = await getPool();
  const r = await p.query('DELETE FROM aqua_action_runs WHERE owner_id=$1', [ownerId]);
  return { runs: r.rowCount ?? 0, skipped: null };
}
