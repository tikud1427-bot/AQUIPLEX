/**
 * AQUA — the slice of ONE owner's canonical World Model the welcome line reads
 * (2026-10-10).
 *
 * One bounded, owner-scoped query (L19, G6). Reads the predicates that say
 * what a person is working on, toward, blocked by, or has just finished:
 * current claims, plus claims superseded in the last 30 days (a REPLACED plan
 * is itself the development worth acknowledging). Nothing is written.
 */
import { getPool, isConfigured } from '../../core/db/pool.js';

const MAX_CLAIMS = 400;
export const WELCOME_PREDICATES = Object.freeze(['builds', 'plans_to', 'task_owner', 'decided', 'rejected',
  'has_status', 'deadline_for', 'blocks', 'blocked_by', 'depends_on', 'owns', 'owned_by', 'manages', 'member_of']);

function objectOf(r) {
  if (r.object_entity_id) return { kind: 'entity', entityId: r.object_entity_id, label: r.object_label ?? null };
  if (r.object_quantity != null) return { kind: 'quantity', quantity: Number(r.object_quantity), unit: r.object_unit ?? null };
  if (r.object_time_from) return { kind: 'time', from: r.object_time_from, to: r.object_time_to ?? null };
  return { kind: 'literal', value: r.object_literal ?? null };
}

export async function loadWelcomeSlice(ownerId, { limit = MAX_CLAIMS, pool = null } = {}) {
  if (!ownerId) throw new Error('loadWelcomeSlice: ownerId is required');
  if (!pool && !isConfigured()) throw new Error('DATABASE_URL is not configured');
  const p = pool ?? await getPool();
  const { rows } = await p.query(`
    SELECT c.claim_id, c.subject_entity_id, se.canonical_label AS subject_label, se.type AS subject_type,
           c.predicate, c.object_entity_id, oe.canonical_label AS object_label,
           c.object_literal, c.object_quantity, c.object_unit, c.object_time_from, c.object_time_to,
           c.polarity, c.modality, c.valid_to, c.asserted_at, c.updated_at,
           c.state, c.superseded_by, c.extractor,
           c.confidence_extraction, c.confidence_source, c.confidence_corroboration,
           (SELECT count(*)::int FROM aqua_claim_evidence ce
             WHERE ce.owner_id=c.owner_id AND ce.claim_id=c.claim_id AND ce.role <> 'contradicting') AS evidence_count
      FROM aqua_claims c
      JOIN aqua_entities se ON se.entity_id=c.subject_entity_id AND se.owner_id=c.owner_id
      LEFT JOIN aqua_entities oe ON oe.entity_id=c.object_entity_id AND oe.owner_id=c.owner_id
     WHERE c.owner_id=$1
       AND c.predicate = ANY($2)
       AND ( c.state IN ('active','trusted','disputed')
          OR (c.state='superseded' AND c.updated_at > now() - interval '30 days') )
     ORDER BY c.asserted_at DESC, c.claim_id
     LIMIT $3`, [String(ownerId), [...WELCOME_PREDICATES], Math.min(Math.max(1, limit), MAX_CLAIMS)]);
  return rows.map(r => ({
    claimId: r.claim_id, subjectEntityId: r.subject_entity_id, subject: r.subject_label,
    subjectIsSelf: r.subject_type === 'self',
    predicate: r.predicate, object: objectOf(r), polarity: r.polarity, modality: r.modality,
    validTo: r.valid_to, assertedAt: r.asserted_at, updatedAt: r.updated_at,
    state: r.state, supersededBy: r.superseded_by, extractor: r.extractor,
    evidenceCount: Number(r.evidence_count ?? 0),
    // Same derivation as the proactive slice (geometric mean of the stored
    // components, without recency — age is the selector's call, not this one's).
    confidence: { derived: Number(Math.cbrt(Number(r.confidence_extraction ?? 0.5) * Number(r.confidence_source ?? 0.5)
      * Math.max(0.5, Number(r.confidence_corroboration ?? 0))).toFixed(3)) },
  }));
}
