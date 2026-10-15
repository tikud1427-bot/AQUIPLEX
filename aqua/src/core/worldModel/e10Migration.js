/**
 * E10 — store unification: the migration machinery (2026-10-04).
 *
 * Moves what only the legacy evidence store knows into canonical claims,
 * PER OWNER, with everything a production migration needs and nothing
 * irreversible:
 *
 *   plan        pure: which legacy facts canonical already covers (by turn, via
 *               turnReconciliation) and which it lacks
 *   dry-run     the DEFAULT: computes and records the plan, writes no claim
 *   apply       backfills ONLY the facts canonical lacks (backfill.js: one
 *               transaction per fact, idempotent, actor = the run), then
 *               re-measures parity
 *   checkpoint  one audit row per (owner, run): a finished owner is skipped on
 *               re-run, so a crashed run resumes where it stopped
 *   parity      every legacy fact is accounted for: covered by an E6 turn,
 *               backfilled (linked through the retrieval bridge), or reported
 *               unprojectable — never silently dropped
 *   rollback    the run's claims are ARCHIVED through the audited lifecycle
 *               transition, never deleted (L5)
 *   legacy-write detection  are legacy facts still being written after a
 *               cutover? (the evidence for "stop old writes")
 *
 * What it deliberately does NOT do: flip AQUA_CANONICAL_READ, stop the legacy
 * lane, or delete legacy data. Those are deployment decisions taken on the
 * reports this produces (Blueprint §10.2 flip protocol).
 */
import { getPool, isConfigured } from '../db/pool.js';
import { reconcileTurns } from './turnReconciliation.js';
import { canonicalTurnSourceId, parseLegacyFactTurn } from './turnSourceIdentity.js';
import { backfillOwner } from '../claims/backfill.js';
import { transition } from './worldModelRepository.js';

export const MIGRATION = 'e10-legacy-facts';

/** Canonical claims per conversation source — joins to legacy turns. */
export const CLAIMS_BY_SOURCE_SQL = `
  SELECT s.source_id, count(DISTINCT ce.claim_id)::int AS n
    FROM aqua_sources s
    LEFT JOIN aqua_evidence e        ON e.source_id = s.source_id AND e.owner_id = s.owner_id
    LEFT JOIN aqua_claim_evidence ce ON ce.evidence_id = e.evidence_id AND ce.owner_id = s.owner_id
   WHERE s.owner_id = $1 AND s.kind = 'conversation'
   GROUP BY s.source_id`;

const runActor = runId => `import:e10:${runId}`;

/**
 * PURE. Split an owner's legacy facts into what canonical already covers and
 * what it lacks. A fact is covered when its turn has canonical claims, or when
 * it was already backfilled (its id is a retrieval key in the bridge).
 */
export function planOwner(ownerId, legacyFacts = [], claimsBySource = new Map(), backfilledFactIds = new Set()) {
  const before = reconcileTurns(ownerId, legacyFacts, claimsBySource);
  const covered = [];
  const lacking = [];
  for (const f of legacyFacts) {
    const id = String(f?.id ?? '');
    if (backfilledFactIds.has(id)) { covered.push({ id, by: 'backfill' }); continue; }
    const t = parseLegacyFactTurn(id);
    if (t && (claimsBySource.get(canonicalTurnSourceId(ownerId, t.conversationId, t.turn)) ?? 0) > 0) {
      covered.push({ id, by: 'e6-turn' });
      continue;
    }
    lacking.push(f);
  }
  return { before, covered, lacking };
}

/** PURE. Every legacy fact accounted for after a run? */
export function parityOf(plan, backfillReport = null) {
  const projected = new Set((backfillReport?.mappings ?? []).map(m => String(m.factId)));
  const unprojectable = new Set((backfillReport?.skipped ?? []).map(s => String(s.id)));
  const failed = new Set((backfillReport?.failures ?? []).map(s => String(s.id)));
  const unaccounted = plan.lacking
    .map(f => String(f.id))
    .filter(id => !projected.has(id) && !unprojectable.has(id) && !failed.has(id));
  return {
    legacyFacts: plan.covered.length + plan.lacking.length,
    coveredBefore: plan.covered.length,
    lackingBefore: plan.lacking.length,
    backfilled: projected.size,
    unprojectable: unprojectable.size,
    failed: failed.size,
    unaccounted: unaccounted.length,
    ok: unaccounted.length === 0 && failed.size === 0,
  };
}

/** PURE. Facts the legacy lane wrote AFTER a cutover instant — evidence it is still live. */
export function legacyWritesSince(legacyFacts = [], sinceMs) {
  const since = Number(sinceMs);
  const late = legacyFacts.filter(f => Number(f?.createdAt ?? 0) > since);
  return { since: new Date(since).toISOString(), count: late.length, sample: late.slice(0, 5).map(f => String(f.id)) };
}

async function db(pool) {
  if (pool) return pool;
  if (!isConfigured()) throw new Error('E10 migration: DATABASE_URL is not configured');
  return getPool();
}

async function readCanonical(p, ownerId) {
  const { rows } = await p.query(CLAIMS_BY_SOURCE_SQL, [ownerId]);
  const claimsBySource = new Map(rows.map(r => [r.source_id, r.n]));
  const bridged = await p.query(
    `SELECT b.retrieval_key FROM aqua_claim_retrieval_bridge b
       JOIN aqua_claims c ON c.owner_id=b.owner_id AND c.claim_id=b.claim_id
      WHERE b.owner_id=$1 AND c.state <> 'archived'`, [ownerId]);
  return { claimsBySource, backfilledFactIds: new Set(bridged.rows.map(r => String(r.retrieval_key))) };
}

/**
 * Migrate ONE owner. `mode` is 'dry-run' (default) or 'apply'.
 * Re-running an owner whose apply already finished for this run is a no-op.
 */
export async function migrateOwner({ ownerId, runId, mode = 'dry-run', facts = [], evidenceById = new Map(), operator = 'operator', pool = null } = {}) {
  if (!ownerId || !runId) throw new Error('migrateOwner requires ownerId and runId');
  if (!['dry-run', 'apply'].includes(mode)) throw new Error(`unknown mode ${mode}`);
  const p = await db(pool);

  const done = await p.query(
    `SELECT status, result FROM aqua_migration_runs WHERE owner_id=$1 AND run_id=$2 AND migration=$3`,
    [ownerId, runId, MIGRATION]);
  if (done.rows[0]?.status === 'done' && mode === 'apply' && done.rows[0].result?.mode === 'apply') {
    return { ownerId, runId, skipped: 'checkpoint: already applied for this run', result: done.rows[0].result };
  }
  if (done.rows[0]?.status === 'rolled_back') {
    return { ownerId, runId, skipped: 'run was rolled back for this owner — start a new run id' };
  }

  await p.query(
    `INSERT INTO aqua_migration_runs (run_id, owner_id, migration, mode, status, actor)
     VALUES ($1,$2,$3,$4,'running',$5)
     ON CONFLICT (owner_id, run_id, migration)
     DO UPDATE SET mode=EXCLUDED.mode, status='running', error=NULL, started_at=now(), finished_at=NULL`,
    [runId, ownerId, MIGRATION, mode, operator]);

  try {
    const canon = await readCanonical(p, ownerId);
    const plan = planOwner(ownerId, facts, canon.claimsBySource, canon.backfilledFactIds);
    const report = await backfillOwner(ownerId, plan.lacking, evidenceById,
      { dryRun: mode !== 'apply', actor: runActor(runId) });
    let after = null;
    if (mode === 'apply') {
      const again = await readCanonical(p, ownerId);
      after = planOwner(ownerId, facts, again.claimsBySource, again.backfilledFactIds);
    }
    // Dry-run reports PROJECTED parity: would every lacking fact be accounted
    // for (backfilled or reported unprojectable) if this run were applied?
    const skippedIds = new Set((report.skipped ?? []).map(x => String(x.id)));
    const parity = mode === 'apply'
      ? parityOf(plan, report)
      : { ...parityOf(plan, {
            mappings: plan.lacking.filter(f => !skippedIds.has(String(f.id))).map(f => ({ factId: f.id })),
            skipped: report.skipped,
          }), projected: true };
    const result = {
      mode, parity,
      wouldBackfill: mode === 'apply' ? undefined : report.projected,
      backfilled: mode === 'apply' ? report.projected : 0,
      alreadyPresent: report.alreadyPresent ?? 0,
      lackingAfter: after ? after.lacking.length : null,
    };
    await p.query(
      `UPDATE aqua_migration_runs SET status='done', before_report=$4::jsonb, after_report=$5::jsonb,
              result=$6::jsonb, finished_at=now()
        WHERE owner_id=$1 AND run_id=$2 AND migration=$3`,
      [ownerId, runId, MIGRATION, JSON.stringify(plan.before), JSON.stringify(after?.before ?? {}), JSON.stringify(result)]);
    return { ownerId, runId, ...result };
  } catch (err) {
    await p.query(
      `UPDATE aqua_migration_runs SET status='failed', error=$4, finished_at=now()
        WHERE owner_id=$1 AND run_id=$2 AND migration=$3`,
      [ownerId, runId, MIGRATION, String(err?.message ?? err).slice(0, 500)]);
    throw err;
  }
}

/**
 * Roll back ONE owner's apply for a run: every claim the run wrote is
 * ARCHIVED through the audited lifecycle transition (L5 — nothing deleted).
 */
export async function rollbackOwner({ ownerId, runId, operator = 'operator', pool = null } = {}) {
  const p = await db(pool);
  const { rows } = await p.query(
    `SELECT claim_id FROM aqua_claims WHERE owner_id=$1 AND actor=$2 AND state <> 'archived'`,
    [ownerId, runActor(runId)]);
  for (const r of rows) {
    await transition({
      ownerId, targetKind: 'claim', targetId: r.claim_id, toState: 'archived',
      reason: `e10-rollback:${runId}`, actor: `import:e10-rollback:${operator}`, source: 'e10',
    });
  }
  await p.query(
    `UPDATE aqua_migration_runs SET status='rolled_back', mode='rollback', finished_at=now(),
            result = result || jsonb_build_object('archived', $4::int)
      WHERE owner_id=$1 AND run_id=$2 AND migration=$3`,
    [ownerId, runId, MIGRATION, rows.length]);
  return { ownerId, runId, archived: rows.length };
}

export async function runStatus(runId, { pool = null } = {}) {
  const p = await db(pool);
  const { rows } = await p.query(
    `SELECT owner_id, mode, status, result, error, started_at, finished_at FROM aqua_migration_runs
      WHERE run_id=$1 AND migration=$2 ORDER BY owner_id`, [runId, MIGRATION]);
  return rows;
}

/** G4: an owner's migration audit rows go with the account. */
export async function purgeOwner(ownerId) {
  if (!ownerId || !isConfigured()) return 0;
  const p = await getPool();
  const r = await p.query('DELETE FROM aqua_migration_runs WHERE owner_id=$1', [ownerId]);
  return r.rowCount ?? 0;
}
