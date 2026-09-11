/**
 * AQUA — durable job queue (E4/PR-3)
 * Blueprint E4 · G2 idempotent · G3 owner-scoped · G4 purgeable · G6 bounded
 *
 * The in-memory registry drains on SIGTERM and loses everything if the process
 * dies any other way. This is where a job outlives the process that made it.
 *
 * 🔴 PER-OWNER ORDERING IS ENFORCED IN SQL, NOT BY AGREEMENT BETWEEN WORKERS.
 *
 * E4/PR-4 gave the in-memory path a per-owner chain, which works because there
 * is one process holding one Map. A durable queue has N workers and no shared
 * memory, so the same guarantee has to live in the claim query: a job is only
 * claimable if that owner has nothing already running. Two workers racing for
 * the same owner both run the predicate inside their own transaction, and
 * `FOR UPDATE SKIP LOCKED` means the loser takes a different job instead of
 * blocking behind the winner.
 *
 * NOTHING IS DELETED (L5). `done` and `dead` rows stay. A dead job is the only
 * record that work was asked for and never happened; deleting it turns a
 * reportable failure into an absence, which is the failure mode this whole
 * subsystem exists to end.
 *
 * FAIL-CLOSED, NOT FAIL-OPEN (L11). Enrichment fails open; a QUEUE does not. If
 * the database is unavailable, `enqueue` throws rather than pretending the work
 * is scheduled — a caller that believes its job is queued when it is not is
 * worse off than one that knows the enqueue failed.
 */
import { getPool, isConfigured } from '../db/pool.js';

/** Attempt N waits 2^N seconds, capped. Deterministic, so a test can assert it. */
export const BACKOFF_CAP_MS = 15 * 60 * 1000;

/**
 * How long before a failed attempt is retried.
 *
 * Exported and pure because the schedule is a policy decision someone will want
 * to argue with, and an argument needs a number they can run.
 */
export function backoffMs(attempts, capMs = BACKOFF_CAP_MS) {
  const n = Math.max(0, Number(attempts) || 0);
  return Math.min(capMs, 2 ** n * 1000);
}

async function pool() {
  if (!isConfigured()) throw new Error('DATABASE_URL is not set — the job queue has nowhere to go');
  return getPool();
}

/**
 * Schedule work. Idempotent on (owner, key).
 *
 * Returns `{ jobId, created }`. `created: false` means this exact job was
 * already scheduled and nothing new happened — the caller retried, and the
 * queue absorbed it. That is the normal case on a retry, not an error.
 */
export async function enqueue({
  ownerId, kind, payload = {}, idempotencyKey,
  priority = 100, maxAttempts = 5, runAfter = null,
} = {}) {
  if (!ownerId) throw new Error('enqueue: ownerId is required — every job is owned (G3)');
  if (!kind) throw new Error('enqueue: kind is required');
  if (!idempotencyKey) throw new Error('enqueue: idempotencyKey is required — without it a retry is a duplicate');

  const p = await pool();
  const { rows } = await p.query(
    `INSERT INTO aqua_jobs (owner_id, kind, payload, idempotency_key, priority, max_attempts, run_after)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, COALESCE($7::timestamptz, now()))
     ON CONFLICT (owner_id, idempotency_key) DO NOTHING
     RETURNING job_id`,
    [ownerId, kind, JSON.stringify(payload), idempotencyKey, priority, maxAttempts, runAfter]);

  if (rows.length) return { jobId: Number(rows[0].job_id), created: true };

  const existing = await p.query(
    'SELECT job_id FROM aqua_jobs WHERE owner_id = $1 AND idempotency_key = $2',
    [ownerId, idempotencyKey]);
  return { jobId: Number(existing.rows[0]?.job_id ?? 0), created: false };
}

/**
 * Take the next runnable job, or null.
 *
 * The `NOT EXISTS` clause is the per-owner guarantee. `SKIP LOCKED` is what
 * stops two workers serialising against each other: the loser of a race moves
 * on to a different owner's job instead of waiting.
 */
export async function claim(workerId, { kinds = null } = {}) {
  const p = await pool();
  const { rows } = await p.query(
    `UPDATE aqua_jobs SET
       state = 'running', attempts = attempts + 1,
       claimed_by = $1, claimed_at = now(), updated_at = now()
     WHERE job_id = (
       SELECT j.job_id FROM aqua_jobs j
        WHERE j.state = 'queued'
          AND j.run_after <= now()
          AND ($2::text[] IS NULL OR j.kind = ANY($2))
          AND NOT EXISTS (
                SELECT 1 FROM aqua_jobs r
                 WHERE r.owner_id = j.owner_id AND r.state = 'running')
        ORDER BY j.priority ASC, j.run_after ASC, j.job_id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1)
     RETURNING job_id, owner_id, kind, payload, attempts, max_attempts`,
    [workerId, kinds]);

  if (!rows.length) return null;
  const r = rows[0];
  return {
    jobId: Number(r.job_id), ownerId: r.owner_id, kind: r.kind,
    payload: r.payload, attempts: r.attempts, maxAttempts: r.max_attempts,
  };
}

/** Mark done. Kept, not deleted (L5) — the record is the evidence it ran. */
export async function complete(jobId) {
  const p = await pool();
  await p.query(
    `UPDATE aqua_jobs SET state = 'done', claimed_by = NULL, updated_at = now()
      WHERE job_id = $1`, [jobId]);
}

/**
 * Record a failure: retry with backoff, or dead-letter.
 *
 * Returns `{ state, retryInMs }` so the caller can log which happened without
 * re-reading the row and without guessing.
 */
export async function fail(jobId, error) {
  const p = await pool();
  const message = String(error?.message ?? error ?? 'unknown').slice(0, 2000);

  const { rows } = await p.query(
    'SELECT attempts, max_attempts FROM aqua_jobs WHERE job_id = $1', [jobId]);
  if (!rows.length) return { state: 'missing', retryInMs: 0 };

  const { attempts, max_attempts: max } = rows[0];
  if (attempts >= max) {
    await p.query(
      `UPDATE aqua_jobs SET state = 'dead', last_error = $2, claimed_by = NULL, updated_at = now()
        WHERE job_id = $1`, [jobId, message]);
    return { state: 'dead', retryInMs: 0 };
  }

  const wait = backoffMs(attempts);
  await p.query(
    `UPDATE aqua_jobs SET state = 'queued', last_error = $2, claimed_by = NULL,
       run_after = now() + ($3::int * interval '1 millisecond'), updated_at = now()
      WHERE job_id = $1`, [jobId, message, wait]);
  return { state: 'queued', retryInMs: wait };
}

/**
 * A job claimed by a worker that died is stuck in `running` forever, and its
 * owner is blocked behind it by the very predicate that guarantees ordering.
 * Reclaiming is not optional: without it one crash wedges one user permanently.
 */
export async function reapStale(olderThanMs = 10 * 60 * 1000) {
  const p = await pool();
  const { rowCount } = await p.query(
    `UPDATE aqua_jobs SET state = 'queued', claimed_by = NULL, updated_at = now(),
       last_error = COALESCE(last_error, 'reclaimed: worker vanished mid-job')
      WHERE state = 'running' AND claimed_at < now() - ($1::int * interval '1 millisecond')`,
    [olderThanMs]);
  return rowCount ?? 0;
}

/** What an operator needs to see, in one query. */
export async function queueStats() {
  const p = await pool();
  const { rows } = await p.query(
    'SELECT state, count(*)::int AS n FROM aqua_jobs GROUP BY state');
  const out = { queued: 0, running: 0, done: 0, dead: 0 };
  for (const r of rows) out[r.state] = r.n;
  return out;
}

/** The DLQ, newest first. Reasons included — a DLQ without them is a list of regrets. */
export async function deadLetters(limit = 50) {
  const p = await pool();
  const { rows } = await p.query(
    `SELECT job_id, owner_id, kind, attempts, last_error, updated_at
       FROM aqua_jobs WHERE state = 'dead' ORDER BY updated_at DESC LIMIT $1`, [limit]);
  return rows;
}

/** G4. Account deletion reaches the queue like everything else. */
export async function purgeOwner(ownerId) {
  if (!ownerId) return { jobs: 0, skipped: 'no owner' };
  if (!isConfigured()) return { jobs: 0, skipped: 'postgres not configured' };
  const p = await getPool();
  const { rowCount } = await p.query('DELETE FROM aqua_jobs WHERE owner_id = $1', [ownerId]);
  return { jobs: rowCount ?? 0, skipped: null };
}
