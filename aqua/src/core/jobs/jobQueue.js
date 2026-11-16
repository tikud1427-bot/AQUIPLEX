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

/**
 * Provider CAPACITY failures (rate limit, 429, quota, every key cooling down)
 * clear on a minutes scale — Groq's free tier is tokens-per-MINUTE per
 * organisation. On the 2^n-seconds schedule a turn retried for ~30 s and was
 * dead-lettered while the limit was still in force: the user's change was lost
 * (live product journey, 2026-10-16: "we moved the launch to May 2" never
 * reached memory). Capacity failures wait 1, 2, 4, 8 min, then the cap.
 */
export const CAPACITY_ERROR_RE = /rate.?limit|\b429\b|quota|cooling down|too many requests|tokens per (minute|day)/i;

export function capacityBackoffMs(attempts, capMs = BACKOFF_CAP_MS) {
  const n = Math.max(1, Number(attempts) || 1);
  return Math.min(capMs, 60_000 * 2 ** (n - 1));
}

/** The retry wait for a failure message: capacity errors on the minutes schedule. */
export function retryWaitMs(attempts, message) {
  return CAPACITY_ERROR_RE.test(String(message ?? '')) ? capacityBackoffMs(attempts) : backoffMs(attempts);
}

/**
 * Is there a durable queue to schedule onto? Lets callers above the storage
 * layer ask WITHOUT importing the pool (the pool has a declared-consumers guard).
 */
export function queueConfigured() {
  return isConfigured();
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
  conversationId = null, sourceRef = null, dependsOn = null,
} = {}, { client = null } = {}) {
  if (!ownerId) throw new Error('enqueue: ownerId is required — every job is owned (G3)');
  if (!kind) throw new Error('enqueue: kind is required');
  if (!idempotencyKey) throw new Error('enqueue: idempotencyKey is required — without it a retry is a duplicate');

  // `client`: a transaction's client (Phase 3) — the job commits with the
  // caller's other writes or not at all.
  const p = client ?? await pool();
  const { rows } = await p.query(
    `INSERT INTO aqua_jobs (owner_id, kind, payload, idempotency_key, priority, max_attempts, run_after,
                            conversation_id, source_ref, depends_on)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, COALESCE($7::timestamptz, now()), $8, $9::jsonb, $10)
     ON CONFLICT (owner_id, idempotency_key) DO NOTHING
     RETURNING job_id`,
    [ownerId, kind, JSON.stringify(payload), idempotencyKey, priority, maxAttempts, runAfter,
      conversationId, sourceRef == null ? null : JSON.stringify(sourceRef), dependsOn?.length ? dependsOn : null]);

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
/**
 * Phase 4B — AGING (found by the Linux worker investigation,
 * AQUIPLEX_WORKER_FAILURE_INVESTIGATION.md). Strict priority let a sustained
 * stream of higher-priority work — 989 claim-embedding jobs failing fast and
 * coming back on short backoffs, at priority 40 — keep a turn's learning jobs
 * (priority 50) waiting for minutes: nothing was stuck, the worker was busy the
 * whole time, and a user's learning was not reached. A job's effective
 * priority now improves by 1 for every AQUA_JOB_AGING_SECONDS (default 5) it
 * has been RUNNABLE (since run_after), by at most 100: a job waiting 50 s
 * outranks a freshly retried job 10 priority points better. 0 disables aging
 * (strict priority, the previous behaviour).
 */
export const JOB_AGING_SECONDS = (() => {
  const v = Number(process.env.AQUA_JOB_AGING_SECONDS);
  return Number.isFinite(v) && v >= 0 ? v : 5;
})();
const AGED_PRIORITY = JOB_AGING_SECONDS > 0
  ? `(j.priority - LEAST(100, floor(GREATEST(0, extract(epoch FROM now() - j.run_after)) / ${JOB_AGING_SECONDS})))`
  : 'j.priority';

export async function claim(workerId, { kinds = null } = {}) {
  const p = await pool();
  // Phase 3 (found by the multi-worker journey, 2026-11-14): the single
  // statement below is NOT enough for per-owner exclusivity. Two workers
  // claiming at the same instant each skip the other's locked row (SKIP
  // LOCKED), pick a DIFFERENT job of the SAME owner, and neither sees the
  // other's uncommitted 'running' row — both run. Measured: two Mind jobs of
  // one owner ran concurrently and an increment was lost. So: choose
  // candidates, take a transaction-scoped advisory lock on the candidate's
  // OWNER (try-lock: never wait), re-check "nothing running" now that any
  // competing claim has either committed (visible) or not started, then claim.
  // The lock is released at COMMIT, together with the claim becoming visible.
  if (typeof p.connect === 'function') {
    const client = await p.connect();
    try {
      await client.query('BEGIN');
      const { rows: candidates } = await client.query(
        `SELECT j.job_id, j.owner_id FROM aqua_jobs j
          WHERE j.state = 'queued'
            AND j.run_after <= now()
            AND ($1::text[] IS NULL OR j.kind = ANY($1))
            AND NOT EXISTS (SELECT 1 FROM aqua_jobs r WHERE r.owner_id = j.owner_id AND r.state = 'running')
            AND (j.depends_on IS NULL OR NOT EXISTS (
                  SELECT 1 FROM aqua_jobs d
                   WHERE d.owner_id = j.owner_id AND d.idempotency_key = ANY(j.depends_on)
                     AND d.state IN ('queued', 'running')))
          ORDER BY ${AGED_PRIORITY} ASC, j.run_after ASC, j.job_id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 20`, [kinds]);
      const tried = new Set();
      for (const c of candidates) {
        if (tried.has(c.owner_id)) continue;
        tried.add(c.owner_id);
        const { rows: [lock] } = await client.query(
          'SELECT pg_try_advisory_xact_lock($1::int, hashtext($2)) AS ok', [OWNER_CLAIM_LOCK, c.owner_id]);
        if (!lock.ok) continue;                               // another worker is claiming for this owner right now
        const { rows: busy } = await client.query(
          `SELECT 1 FROM aqua_jobs WHERE owner_id = $1 AND state = 'running' LIMIT 1`, [c.owner_id]);
        if (busy.length) continue;                            // it committed a claim just before us
        const { rows } = await client.query(
          `UPDATE aqua_jobs SET
             state = 'running', attempts = attempts + 1,
             claimed_by = $1, claimed_at = now(), heartbeat_at = now(),
             started_at = COALESCE(started_at, now()), updated_at = now()
           WHERE job_id = $2
           RETURNING job_id, owner_id, kind, payload, attempts, max_attempts, conversation_id, source_ref,
                     created_at, claimed_at`, [workerId, c.job_id]);
        await client.query('COMMIT');
        return claimedJob(rows[0], workerId);
      }
      await client.query('COMMIT');
      return null;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
      throw err;
    } finally {
      client.release();
    }
  }
  // Fallback for a pool without transactions (in-memory test doubles): the
  // original single statement. NOT exclusive per owner across concurrent workers.
  //
  // Phase 3: a job whose DEPENDENCIES (same owner, by idempotency key) are
  // still queued or running is not claimable — reflection waits for the turn's
  // ingest even when the ingest is backing off between retries. A dead
  // dependency does not block: the in-process pipeline was fail-open per stage
  // and that semantics is kept.
  const { rows } = await p.query(
    `UPDATE aqua_jobs SET
       state = 'running', attempts = attempts + 1,
       claimed_by = $1, claimed_at = now(), heartbeat_at = now(),
       started_at = COALESCE(started_at, now()), updated_at = now()
     WHERE job_id = (
       SELECT j.job_id FROM aqua_jobs j
        WHERE j.state = 'queued'
          AND j.run_after <= now()
          AND ($2::text[] IS NULL OR j.kind = ANY($2))
          AND NOT EXISTS (
                SELECT 1 FROM aqua_jobs r
                 WHERE r.owner_id = j.owner_id AND r.state = 'running')
          AND (j.depends_on IS NULL OR NOT EXISTS (
                SELECT 1 FROM aqua_jobs d
                 WHERE d.owner_id = j.owner_id AND d.idempotency_key = ANY(j.depends_on)
                   AND d.state IN ('queued', 'running')))
        ORDER BY ${AGED_PRIORITY} ASC, j.run_after ASC, j.job_id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1)
     RETURNING job_id, owner_id, kind, payload, attempts, max_attempts, conversation_id, source_ref,
               created_at, claimed_at`,
    [workerId, kinds]);

  if (!rows.length) return null;
  return claimedJob(rows[0], workerId);
}

/** Advisory-lock namespace for per-owner claim serialization (first key of the two-int form). */
const OWNER_CLAIM_LOCK = 84125320;

function claimedJob(r, workerId) {
  return {
    jobId: Number(r.job_id), ownerId: r.owner_id, kind: r.kind,
    payload: r.payload, attempts: r.attempts, maxAttempts: r.max_attempts,
    conversationId: r.conversation_id ?? null, sourceRef: r.source_ref ?? null,
    createdAt: r.created_at, claimedAt: r.claimed_at,
    // The FENCE: this worker's claim of this attempt. heartbeat/complete/fail
    // apply only while the row still carries it, so a worker whose job was
    // reclaimed (it looked dead) can never complete or fail it afterwards.
    fence: { workerId, attempts: r.attempts },
  };
}

const fenceSql = (n) => `AND state = 'running' AND claimed_by = $${n} AND attempts = $${n + 1}`;

/**
 * Lease renewal for a running job (Phase 3). Returns false when this worker no
 * longer holds the job (it was reclaimed): the caller should stop and must not
 * report a result.
 */
export async function heartbeat(jobId, fence) {
  const p = await pool();
  const { rowCount } = await p.query(
    `UPDATE aqua_jobs SET heartbeat_at = now() WHERE job_id = $1 ${fenceSql(2)}`,
    [jobId, fence.workerId, fence.attempts]);
  return (rowCount ?? 0) === 1;
}

/**
 * Mark done. Kept, not deleted (L5) — the record is the evidence it ran.
 * With a fence (Phase 3), only the worker still holding the claim can complete
 * it; returns false otherwise (a reclaimed job's late result is discarded).
 */
export async function complete(jobId, fence = null) {
  const p = await pool();
  const { rowCount } = await p.query(
    `UPDATE aqua_jobs SET state = 'done', claimed_by = NULL, finished_at = now(), updated_at = now()
      WHERE job_id = $1 ${fence ? fenceSql(2) : ''}`, fence ? [jobId, fence.workerId, fence.attempts] : [jobId]);
  return (rowCount ?? 0) === 1;
}

/**
 * Record a failure: retry with backoff, or dead-letter.
 *
 * Returns `{ state, retryInMs }` so the caller can log which happened without
 * re-reading the row and without guessing.
 */
export async function fail(jobId, error, fence = null) {
  const p = await pool();
  const message = String(error?.message ?? error ?? 'unknown').slice(0, 2000);

  const { rows } = await p.query(
    'SELECT attempts, max_attempts, state, claimed_by FROM aqua_jobs WHERE job_id = $1', [jobId]);
  if (!rows.length) return { state: 'missing', retryInMs: 0 };
  // Fenced (Phase 3): a worker that lost its claim must not move the job.
  if (fence && (rows[0].state !== 'running' || rows[0].claimed_by !== fence.workerId || rows[0].attempts !== fence.attempts)) {
    return { state: 'lost', retryInMs: 0 };
  }

  const { attempts, max_attempts: max } = rows[0];
  const params = n => (fence ? [fence.workerId, fence.attempts] : []);
  if (attempts >= max) {
    await p.query(
      `UPDATE aqua_jobs SET state = 'dead', last_error = $2, claimed_by = NULL, finished_at = now(), updated_at = now()
        WHERE job_id = $1 ${fence ? fenceSql(3) : ''}`, [jobId, message, ...params()]);
    return { state: 'dead', retryInMs: 0 };
  }

  const wait = retryWaitMs(attempts, message);
  await p.query(
    `UPDATE aqua_jobs SET state = 'queued', last_error = $2, claimed_by = NULL,
       run_after = now() + ($3::int * interval '1 millisecond'), updated_at = now()
      WHERE job_id = $1 ${fence ? fenceSql(4) : ''}`, [jobId, message, wait, ...params()]);
  return { state: 'queued', retryInMs: wait };
}

/**
 * Give a claimed job back WITHOUT counting the attempt — graceful shutdown or
 * an owner that cannot be loaded right now (database interruption). Fenced.
 */
export async function release(jobId, fence, { delayMs = 0, reason = 'released' } = {}) {
  const p = await pool();
  const { rowCount } = await p.query(
    `UPDATE aqua_jobs SET state = 'queued', claimed_by = NULL, attempts = GREATEST(attempts - 1, 0),
       last_error = $4, run_after = now() + ($5::int * interval '1 millisecond'), updated_at = now()
      WHERE job_id = $1 ${fenceSql(2)}`, [jobId, fence.workerId, fence.attempts, reason, delayMs]);
  return (rowCount ?? 0) === 1;
}

/**
 * A job claimed by a worker that died is stuck in `running` forever, and its
 * owner is blocked behind it by the very predicate that guarantees ordering.
 * Reclaiming is not optional: without it one crash wedges one user permanently.
 */
export async function reapStale(olderThanMs = 10 * 60 * 1000, { heartbeatStaleMs = Math.min(HEARTBEAT_STALE_MS, olderThanMs) } = {}) {
  const p = await pool();
  // Phase 3: a job with heartbeats is stale only when its HEARTBEAT is — a
  // long job whose worker keeps renewing is never handed to a second worker.
  // A job without heartbeats (claimed by a pre-Phase-3 worker) keeps the old
  // claim-age rule.
  //
  // A job whose attempts are already exhausted is dead-lettered instead of
  // requeued: a job that kills its worker every time (out of memory on one
  // input) would otherwise be reclaimed and re-run forever.
  const { rowCount } = await p.query(
    `UPDATE aqua_jobs SET
       state = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
       finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE finished_at END,
       claimed_by = NULL, updated_at = now(),
       last_error = CASE WHEN attempts >= max_attempts
                         THEN 'dead: worker vanished mid-job on its last attempt'
                         ELSE 'reclaimed: worker vanished mid-job' END
      WHERE state = 'running'
        AND ((heartbeat_at IS NOT NULL AND heartbeat_at < now() - ($2::int * interval '1 millisecond'))
          OR (heartbeat_at IS NULL AND claimed_at < now() - ($1::int * interval '1 millisecond')))`,
    [olderThanMs, heartbeatStaleMs]);
  return rowCount ?? 0;
}

/** ops.canary.v1: hold one pooled connection in the database for `ms`. Writes nothing. */
export async function canarySleep(ms) {
  const p = await pool();
  await p.query('SELECT pg_sleep($1::float8 / 1000.0)', [Math.max(0, Number(ms) || 0)]);
}

/**
 * Phase 3 measurement, from the queue's own timestamps (so it is the same in
 * every process): per kind, jobs finished in the window, queue wait
 * (created → first claim) and processing time (first claim → finish), p50 /
 * p95 / max in ms, plus retries and dead letters.
 */
export async function jobTimings({ windowMinutes = 60, kinds = null } = {}) {
  const p = await pool();
  const { rows } = await p.query(
    `SELECT kind,
            count(*)::int AS jobs,
            count(*) FILTER (WHERE state = 'dead')::int AS dead,
            COALESCE(sum(GREATEST(attempts - 1, 0)), 0)::int AS retries,
            percentile_cont(0.5)  WITHIN GROUP (ORDER BY extract(epoch FROM started_at - created_at) * 1000) AS wait_p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM started_at - created_at) * 1000) AS wait_p95,
            max(extract(epoch FROM started_at - created_at) * 1000) AS wait_max,
            percentile_cont(0.5)  WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - started_at) * 1000) AS run_p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - started_at) * 1000) AS run_p95,
            max(extract(epoch FROM finished_at - started_at) * 1000) AS run_max
       FROM aqua_jobs
      WHERE finished_at IS NOT NULL AND started_at IS NOT NULL
        AND finished_at >= now() - make_interval(mins => $1)
        AND ($2::text[] IS NULL OR kind = ANY($2))
      GROUP BY kind ORDER BY kind`, [Math.max(1, Number(windowMinutes) || 60), kinds]);
  const r = v => (v == null ? null : Math.round(Number(v)));
  return rows.map(x => ({ kind: x.kind, jobs: x.jobs, dead: x.dead, retries: x.retries,
    waitMs: { p50: r(x.wait_p50), p95: r(x.wait_p95), max: r(x.wait_max) },
    runMs: { p50: r(x.run_p50), p95: r(x.run_p95), max: r(x.run_max) } }));
}

/** A running job's heartbeat older than this is reclaimed (AQUA_JOB_HEARTBEAT_STALE_MS, default 120 s). */
export const HEARTBEAT_STALE_MS = (() => {
  const v = Number(process.env.AQUA_JOB_HEARTBEAT_STALE_MS);
  return Number.isFinite(v) && v >= 1000 ? v : 120_000;
})();

/**
 * Phase 4B — queue lag: runnable jobs and how long the oldest has waited, per
 * priority band. A worker that is busy but never reaching a band shows up here
 * (the starvation found in AQUIPLEX_WORKER_FAILURE_INVESTIGATION.md).
 */
export async function queueLag() {
  const p = await pool();
  const { rows } = await p.query(
    `SELECT priority, count(*)::int AS runnable,
            round(max(extract(epoch FROM now() - run_after)) * 1000)::bigint AS oldest_ms
       FROM aqua_jobs WHERE state = 'queued' AND run_after <= now()
      GROUP BY priority ORDER BY priority`);
  return rows.map(r => ({ priority: r.priority, runnable: r.runnable, oldestMs: Number(r.oldest_ms) }));
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

/**
 * E12 — retries and dead letters over a window, per kind. Derived from the
 * queue itself, so it is the same number in the worker and the server (the
 * in-memory counters of one process never reach the other's /metrics).
 */
export async function retryStats({ windowHours = 24 } = {}) {
  const p = await pool();
  const { rows } = await p.query(
    `SELECT kind, state, count(*)::int AS jobs, COALESCE(sum(GREATEST(attempts - 1, 0)), 0)::int AS retries
       FROM aqua_jobs WHERE updated_at >= now() - make_interval(hours => $1)
      GROUP BY kind, state`, [Math.max(1, Math.min(24 * 30, Number(windowHours) || 24))]);
  return rows;
}

/** The DLQ, newest first. Reasons included — a DLQ without them is a list of regrets. */
export async function deadLetters(limit = 50) {
  const p = await pool();
  const { rows } = await p.query(
    `SELECT job_id, owner_id, kind, attempts, last_error, updated_at
       FROM aqua_jobs WHERE state = 'dead' ORDER BY updated_at DESC LIMIT $1`, [limit]);
  return rows;
}

/**
 * E4/PR-7 — operator action: give one dead job a fresh retry budget.
 *
 * Reversible and non-destructive (L5): the row is kept, `last_error` is kept as
 * the record of why it died, only state/attempts/run_after change. It requeues
 * a job ONLY while it is `dead` — a running or done job is never touched, so a
 * double-click cannot run the same work twice. Idempotent consumers (G2) make
 * the re-run itself safe.
 * @returns {Promise<{ requeued: boolean }>}
 */
export async function requeueDead(jobId) {
  const id = Number(jobId);
  if (!Number.isInteger(id) || id <= 0) return { requeued: false };
  const p = await pool();
  const { rowCount } = await p.query(
    `UPDATE aqua_jobs
        SET state = 'queued', attempts = 0, run_after = now(),
            claimed_by = NULL, updated_at = now()
      WHERE job_id = $1 AND state = 'dead'`, [id]);
  return { requeued: (rowCount ?? 0) === 1 };
}

/** G4. Account deletion reaches the queue like everything else. */
export async function purgeOwner(ownerId) {
  if (!ownerId) return { jobs: 0, skipped: 'no owner' };
  if (!isConfigured()) return { jobs: 0, skipped: 'postgres not configured' };
  const p = await getPool();
  const { rowCount } = await p.query('DELETE FROM aqua_jobs WHERE owner_id = $1', [ownerId]);
  return { jobs: rowCount ?? 0, skipped: null };
}
