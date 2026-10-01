/**
 * AQUA Brain — E9/PR-8 canonical revision feed.
 *
 * The canonical World Model already records every lifecycle/revision write in
 * `aqua_revisions`. The older PIC ledger is still useful as a compatibility
 * fallback for pre-migration reflections, but it must not remain the only
 * readable history once canonical rows exist.
 *
 * This module is intentionally read-only. It creates no new knowledge shape;
 * it simply maps canonical revision rows into the stable change-feed contract.
 */
import { getPool, isConfigured } from '../../core/db/pool.js';

const MAX_LIMIT = 100;

function clampLimit(value, fallback = 20) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(1, Math.min(MAX_LIMIT, n));
}

function asObject(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function summaryFor(row) {
  const changeKind = row.change_kind ?? row.changeKind;
  const targetKind = row.target_kind ?? row.targetKind;
  const targetId = row.target_id ?? row.targetId;
  const subject = row.after?.canonicalLabel
    ?? row.after?.statementText
    ?? row.after?.predicate
    ?? row.before?.canonicalLabel
    ?? targetKind;
  const verb = changeKind === 'create' ? 'learned'
    : changeKind === 'update' ? 'updated'
    : changeKind === 'delete' ? 'removed'
    : changeKind ?? 'changed';
  return `${verb} ${String(subject ?? targetId ?? '').trim()}`.trim();
}

export function mapRevision(row) {
  return {
    id: row.revision_id ?? row.revisionId ?? null,
    at: row.created_at ?? row.createdAt ?? null,
    summary: row.summary ?? summaryFor({
      ...row,
      before: asObject(row.before),
      after: asObject(row.after),
    }),
    entities: row.target_kind === 'entity' ? 1 : 0,
    relationships: row.target_kind === 'edge' ? 1 : 0,
    obsoleted: ['archive', 'supersede'].includes(row.change_kind) ? 1 : 0,
    revised: row.change_kind === 'update' ? 1 : 0,
    applied: row.applied !== false,
    targetKind: row.target_kind ?? row.targetKind ?? null,
    targetId: row.target_id ?? row.targetId ?? null,
    changeKind: row.change_kind ?? row.changeKind ?? null,
    reason: row.reason ?? null,
    actor: row.actor ?? null,
    source: row.source ?? null,
    reversible: row.reversible !== false,
  };
}

/**
 * Read canonical owner-scoped revisions. Returns null when Postgres is not
 * configured so callers can deliberately fall back to the legacy ledger.
 */
export async function readCanonicalRevisionFeed(ownerId, { limit = 20, dbPool = null } = {}) {
  if (!ownerId) return [];
  if (!isConfigured() && !dbPool) return null;
  const p = dbPool ?? getPool();
  const safeLimit = clampLimit(limit);
  const { rows } = await p.query(
    `SELECT revision_id, owner_id, target_kind, target_id, change_kind,
            before, after, reason, actor, source, reversible, created_at
       FROM aqua_revisions
      WHERE owner_id = $1
      ORDER BY created_at DESC, revision_id DESC
      LIMIT $2`,
    [ownerId, safeLimit],
  );
  return rows.map(mapRevision);
}

/**
 * Canonical-first feed with a compatibility fallback.
 * `legacyReader` is deliberately injected so the route can keep using its
 * existing PIC ledger without making that ledger part of the new core API.
 */
export async function getRevisionFeed(ownerId, { limit = 20, canonicalReader = readCanonicalRevisionFeed, legacyReader = null } = {}) {
  const safeLimit = clampLimit(limit);
  try {
    const canonical = await canonicalReader(ownerId, { limit: safeLimit });
    if (Array.isArray(canonical) && canonical.length) return { source: 'canonical', changes: canonical };
  } catch (err) {
    // Fail open. Revision history is enrichment; it must never sink the turn or
    // the dashboard. The legacy reader remains the compatibility path.
    console.warn(`[REFLECTION] canonical revision feed unavailable: ${err?.message ?? err}`);
  }

  if (typeof legacyReader === 'function') {
    try {
      const legacy = await legacyReader(ownerId, safeLimit);
      return { source: 'legacy', changes: Array.isArray(legacy) ? legacy.slice(0, safeLimit) : [] };
    } catch { /* empty feed is honest */ }
  }
  return { source: 'empty', changes: [] };
}
