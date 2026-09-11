/**
 * AQUA — the claim projection
 * Blueprint E5/PR-5 · D3 (the world model is a VIEW), L7 (derive, don't store)
 *
 * The read path. "What do we know about X?" answered from claims.
 *
 * WHY THIS IS A PROJECTION AND NOT A STORE
 * ----------------------------------------
 * The audit found three semantic stores whose contents had to agree and
 * couldn't. A fourth store of "current beliefs" would be the same mistake with
 * a newer schema: the moment a derived view is persisted, it can disagree with
 * what it was derived from, and then something has to reconcile them.
 *
 * So nothing here is written. Every function is a query over `aqua_claims`,
 * and the answer is recomputed on demand. L7: derive, don't store.
 *
 * THE ONE THING THIS FIXES THAT THE ENGINE CANNOT EXPRESS
 * ------------------------------------------------------
 * `state <> 'superseded'` and the validity window.
 *
 * The retrieval baseline measures the cost of not having them: **superseded
 * recall 20%** — asked "where do I work", the engine returns the OLD employer,
 * because it has no way to say one fact replaced another. Here that is a WHERE
 * clause, not a ranking accident.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 *   no ranking by relevance   That is retrieval (E7). This answers "what is
 *                             true about X", not "what is relevant to this
 *                             question". Mixing them is how the current lane
 *                             ended up with a self-anchor that fires on any
 *                             first-person query with no relevance gate.
 *   no confidence collapsing  `overall` stays underived (L7). Callers get the
 *                             three components and decide.
 *   no contradiction resolving  Contradictions are SURFACED. The existing
 *                             graph already does this correctly and it is one
 *                             of the better decisions in the codebase.
 */
import { getPool, isConfigured } from '../db/pool.js';
import { inverseOf } from './predicateRegistry.js';
import { UNRESOLVED } from './backfill.js';

/**
 * "True at time T" — a validity window test, NOT a state test.
 *
 * 🔴 The first version also required `state <> 'superseded'`, which made every
 * historical query return nothing: a superseded claim is exactly the one that
 * was true in the past, and excluding it means `asOf: 2023` answers "I know
 * nothing about 2023" rather than "Intercom".
 *
 * Supersession and validity are DIFFERENT questions. `superseded` says a claim
 * was replaced; `valid_to` says when it stopped being true. The window alone
 * answers both — a live claim has no `valid_to`, so it passes at every cutoff,
 * and a superseded one passes only before its end date.
 */
const TRUE_AT = `
      (valid_from IS NULL OR valid_from <= $CUTOFF)
  AND (valid_to   IS NULL OR valid_to   >= $CUTOFF)
  AND (state <> 'superseded' OR valid_to IS NOT NULL)`;

async function pool() {
  if (!isConfigured()) return null;
  return getPool();
}

/**
 * Everything currently believed about one entity.
 *
 * `asOf` makes the temporal question answerable rather than implicit: "where
 * did I work in 2023" is the same query with a different cutoff. An engine
 * that can only answer "now" cannot tell you it ever changed.
 */
export async function whatWeKnow(ownerId, entityId, { asOf = new Date(), includeUnresolved = true } = {}) {
  const p = await pool();
  if (!p) return { configured: false, claims: [], unresolved: 0 };

  const { rows } = await p.query(
    `SELECT claim_id, predicate, object_entity_id, object_literal, object_quantity,
            object_time_from, polarity, modality, valid_from, valid_to, asserted_at,
            state, confidence_extraction, confidence_source, confidence_corroboration,
            statement_text
       FROM aqua_claims
      WHERE owner_id = $1 AND subject_entity_id = $2
        AND ${TRUE_AT.replaceAll('$CUTOFF', '$3')}
        ${includeUnresolved ? '' : `AND predicate <> '${UNRESOLVED}'`}
      ORDER BY asserted_at DESC`,
    [ownerId, entityId, asOf]);

  return {
    configured: true,
    claims: rows.map(shape),
    // Reported alongside, never mixed in. A caller that does not know how much
    // is un-understood will read a thin answer as a complete one.
    unresolved: rows.filter(r => r.predicate === UNRESOLVED).length,
  };
}

/**
 * Confidence as a VECTOR with a derived summary — never a stored number.
 *
 * The three components are multiplied rather than averaged: a claim extracted
 * badly from a trusted source is still badly extracted, and averaging would
 * let one strong component mask a fatal weak one. Corroboration is a BONUS on
 * top rather than a factor, because a single well-extracted statement from the
 * user themselves is not one-third as good as three.
 */
export function confidenceOf(claim) {
  const base = (claim.confidence_extraction ?? 0) * (claim.confidence_source ?? 0);
  const bonus = (1 - base) * (claim.confidence_corroboration ?? 0);
  return {
    extraction: claim.confidence_extraction,
    source: claim.confidence_source,
    corroboration: claim.confidence_corroboration,
    derived: Math.min(0.99, base + bonus),   // never certainty
  };
}

function shape(row) {
  return {
    claimId: row.claim_id,
    predicate: row.predicate,
    object: row.object_entity_id ?? row.object_literal ?? row.object_quantity ?? row.object_time_from,
    objectIsEntity: row.object_entity_id != null,
    polarity: row.polarity,
    modality: row.modality,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    assertedAt: row.asserted_at,
    statement: row.statement_text,
    unresolved: row.predicate === UNRESOLVED,
    confidence: confidenceOf(row),
  };
}

/**
 * Claims where this entity is the OBJECT, read through the inverse.
 *
 * `manages(Priya, Dev)` answers "who does Dev report to" without a second row.
 * A predicate with no inverse is reported as-is rather than dropped — dropping
 * it would silently hide half the graph from anyone asking backwards.
 */
export async function whatPointsAt(ownerId, entityId, { asOf = new Date() } = {}) {
  const p = await pool();
  if (!p) return [];
  const { rows } = await p.query(
    `SELECT claim_id, subject_entity_id, predicate, polarity, modality, statement_text
       FROM aqua_claims
      WHERE owner_id = $1 AND object_entity_id = $2
        AND ${TRUE_AT.replaceAll('$CUTOFF', '$3')}
      ORDER BY asserted_at DESC`,
    [ownerId, entityId, asOf]);

  return rows.map(r => ({
    claimId: r.claim_id,
    subjectEntityId: r.subject_entity_id,
    predicate: r.predicate,
    readsAs: inverseOf(r.predicate),   // null when the relation has no inverse
    polarity: r.polarity,
    modality: r.modality,
    statement: r.statement_text,
  }));
}

/**
 * The history of one predicate — every value, current and past.
 *
 * This is what makes "where did I work before" answerable at all. The current
 * engine has no notion of before.
 */
export async function historyOf(ownerId, entityId, predicate) {
  const p = await pool();
  if (!p) return [];
  const { rows } = await p.query(
    `SELECT claim_id, object_entity_id, object_literal, polarity, state,
            valid_from, valid_to, asserted_at, superseded_by, statement_text
       FROM aqua_claims
      WHERE owner_id = $1 AND subject_entity_id = $2 AND predicate = $3
      ORDER BY COALESCE(valid_from, asserted_at) DESC`,
    [ownerId, entityId, predicate]);

  return rows.map(r => ({
    claimId: r.claim_id,
    object: r.object_entity_id ?? r.object_literal,
    polarity: r.polarity,
    current: r.state !== 'superseded',
    validFrom: r.valid_from,
    validTo: r.valid_to,
    supersededBy: r.superseded_by,
    statement: r.statement_text,
  }));
}

/**
 * Disagreements, SURFACED not resolved.
 *
 * Two live claims on the same (subject, predicate) with different objects, or
 * opposite polarity on the same object. The existing reasoning graph already
 * refuses to resolve contradictions and that is one of the better decisions in
 * the codebase — this preserves it rather than quietly picking a winner.
 */
export async function contradictions(ownerId, { asOf = new Date() } = {}) {
  const p = await pool();
  if (!p) return [];
  const { rows } = await p.query(
    `SELECT a.claim_id AS a_id, b.claim_id AS b_id,
            a.subject_entity_id, a.predicate,
            a.statement_text AS a_text, b.statement_text AS b_text,
            a.polarity AS a_pol, b.polarity AS b_pol
       FROM aqua_claims a
       JOIN aqua_claims b
         ON a.owner_id = b.owner_id
        AND a.subject_entity_id = b.subject_entity_id
        AND a.predicate = b.predicate
        AND a.claim_id < b.claim_id
      WHERE a.owner_id = $1
        AND a.predicate <> '${UNRESOLVED}'
        AND a.state <> 'superseded' AND b.state <> 'superseded'
        AND (a.polarity <> b.polarity
             OR COALESCE(a.object_literal, '') <> COALESCE(b.object_literal, ''))`,
    [ownerId]);

  return rows.map(r => ({
    subjectEntityId: r.subject_entity_id,
    predicate: r.predicate,
    kind: r.a_pol !== r.b_pol ? 'polarity' : 'value',
    sides: [
      { claimId: r.a_id, polarity: r.a_pol, statement: r.a_text },
      { claimId: r.b_id, polarity: r.b_pol, statement: r.b_text },
    ],
  }));
}

/** How much of what is stored is still not understood. The honest headline. */
export async function coverage(ownerId) {
  const p = await pool();
  if (!p) return { configured: false };
  const { rows } = await p.query(
    // `count(*) FILTER (WHERE ...)` is silently ignored by pg-mem — it returns
    // the UNFILTERED count, so every number here would have been the total.
    // `SUM(CASE ...)` is identical in Postgres and correct in both. Same
    // reasoning as E5/PR-1's `quote <> ''`: choose the portable form rather
    // than shim the simulator, because a query that only works in production
    // is a query nobody tests.
    `SELECT count(*)::int AS total,
            SUM(CASE WHEN predicate = '${UNRESOLVED}' THEN 1 ELSE 0 END)::int AS unresolved,
            SUM(CASE WHEN state = 'superseded' THEN 1 ELSE 0 END)::int AS superseded
       FROM aqua_claims WHERE owner_id = $1`, [ownerId]);
  const r = rows[0] ?? {};
  const total = Number(r.total ?? 0);
  const unresolved = Number(r.unresolved ?? 0);
  return {
    configured: true,
    total,
    unresolved,
    superseded: Number(r.superseded ?? 0),
    understood: total - unresolved,
    // Reported as a fraction rather than a score, because a score invites
    // being quoted without its denominator.
    understoodFraction: total ? (total - unresolved) / total : 0,
  };
}
