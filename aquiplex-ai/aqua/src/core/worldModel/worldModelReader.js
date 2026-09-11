/** Canonical World Model read projection. Read-only; never creates identity. */
import { getPool, isConfigured } from '../db/pool.js';

const norm = value => String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const tokens = text => [...new Set(norm(text).split(/[^a-z0-9_]+/).filter(t => t.length > 2))];
const confidence = (r) => Math.max(0, Math.min(1,
  0.55 * Number(r.confidence_extraction ?? 0.5) +
  0.30 * Number(r.confidence_source ?? 0.5) +
  0.15 * Number(r.confidence_corroboration ?? 0)));

export function readerEnabled() { return isConfigured(); }

/**
 * Search canonical claims/entities for a query. The query is bounded before
 * ranking so a large owner cannot turn one chat turn into a full table scan.
 * SQL narrows by owner and a small OR predicate; JS performs the final token
 * scoring and lifecycle filtering.
 */
export async function searchWorldModel(ownerId, query, { limit = 12, candidateLimit = 200 } = {}) {
  if (!ownerId || !query || !isConfigured()) return { items: [], stats: { enabled: false } };
  const qs = tokens(query).slice(0, 8);
  if (!qs.length) return { items: [], stats: { enabled: true, candidates: 0 } };
  const p = await getPool();
  const clauses = [];
  const params = [ownerId];
  qs.forEach((t, i) => {
    params.push(`%${t}%`);
    clauses.push(`(c.statement_norm ILIKE $${i + 2} OR c.predicate ILIKE $${i + 2} OR s.normalized_label ILIKE $${i + 2} OR o.normalized_label ILIKE $${i + 2})`);
  });
  params.push(Math.min(Math.max(limit, 1) * 20, candidateLimit));
  const sql = `
    SELECT DISTINCT ON (c.claim_id) c.claim_id,c.predicate,c.statement_text,c.statement_norm,c.polarity,c.modality,c.state,
           c.valid_from,c.valid_to,c.asserted_at,c.time_precision,
           c.confidence_extraction,c.confidence_source,c.confidence_corroboration,c.extractor_version,
           s.entity_id AS subject_id,s.identity_key AS subject_identity,s.canonical_label AS subject_label,s.type AS subject_type,
           o.entity_id AS object_id,o.identity_key AS object_identity,o.canonical_label AS object_label,o.type AS object_type,
           src.kind AS source_type,src.title AS source_title
      FROM aqua_claims c
      JOIN aqua_entities s ON s.entity_id=c.subject_entity_id AND s.owner_id=c.owner_id
      LEFT JOIN aqua_entities o ON o.entity_id=c.object_entity_id AND o.owner_id=c.owner_id
      LEFT JOIN aqua_claim_evidence ce ON ce.owner_id=c.owner_id AND ce.claim_id=c.claim_id
      LEFT JOIN aqua_evidence ev ON ev.owner_id=ce.owner_id AND ev.evidence_id=ce.evidence_id
      LEFT JOIN aqua_sources src ON src.source_id=ev.source_id AND src.owner_id=ev.owner_id
     WHERE c.owner_id=$1 AND c.state IN ('active','trusted','disputed')
       AND (${clauses.join(' OR ')})
     ORDER BY c.claim_id, c.updated_at DESC
     LIMIT $${params.length}`;
  const result = await p.query(sql, params);

  const scored = result.rows.map(r => {
    const text = String(r.statement_text ?? '');
    const hay = new Set(tokens(`${text} ${r.predicate} ${r.subject_label ?? ''} ${r.object_label ?? ''}`));
    const covered = qs.filter(t => hay.has(t)).length;
    const score = covered / qs.length;
    return {
      kind: 'fact',
      id: r.claim_id,
      text,
      confidence: confidence(r),
      citations: [],
      trusted: r.state === 'trusted',
      disputed: r.state === 'disputed' || r.polarity === 'negated',
      stale: r.state !== 'active' && r.state !== 'trusted',
      via: 'canonical-world-model',
      sourceType: r.source_type === 'conversation' ? 'conversation' : (r.source_type ?? 'unknown'),
      entityIds: [r.subject_id, r.object_id].filter(Boolean),
      hops: 0,
      timestamp: r.asserted_at,
      semanticId: r.claim_id,
      epistemic: r.modality === 'fact' ? 'observed' : 'stated',
      relevance: score,
      canonical: {
        claimId: r.claim_id, predicate: r.predicate, polarity: r.polarity, modality: r.modality,
        validFrom: r.valid_from, validTo: r.valid_to, assertedAt: r.asserted_at,
        subject: { id: r.subject_id, identityKey: r.subject_identity, label: r.subject_label, type: r.subject_type },
        object: r.object_id
          ? { kind: 'entity', id: r.object_id, identityKey: r.object_identity, label: r.object_label, type: r.object_type }
          : null,
      },
    };
  });

  scored.sort((a, b) => b.relevance - a.relevance || b.confidence - a.confidence);
  return { items: scored.slice(0, limit), stats: { enabled: true, candidates: result.rowCount ?? result.rows.length, returned: Math.min(limit, scored.length) } };
}

/** Lightweight owner snapshot used by reflection/timeline consumers. */
export async function snapshotWorldModel(ownerId, { claimLimit = 500 } = {}) {
  if (!ownerId || !isConfigured()) return { entities: [], claims: [], edges: [], events: [] };
  const p = await getPool();
  const [entities, claims, edges, events] = await Promise.all([
    p.query(`SELECT e.entity_id,e.identity_key,e.type,e.canonical_label,e.normalized_label,e.confidence_resolution,e.mention_count,e.status,e.first_seen_at,e.last_seen_at,
       COALESCE((SELECT COUNT(DISTINCT ev.source_id) FROM aqua_claims c2
                 JOIN aqua_claim_evidence ce2 ON ce2.owner_id=c2.owner_id AND ce2.claim_id=c2.claim_id
                 JOIN aqua_evidence ev ON ev.owner_id=ce2.owner_id AND ev.evidence_id=ce2.evidence_id
                 WHERE c2.owner_id=e.owner_id AND c2.subject_entity_id=e.entity_id
                   AND c2.state IN ('active','trusted','disputed')), 0) AS source_count
       FROM aqua_entities e
       WHERE e.owner_id=$1 AND e.status='active'
       ORDER BY e.last_seen_at DESC LIMIT 1000`, [ownerId]),
    p.query(`SELECT c.claim_id,c.subject_entity_id,c.predicate,c.object_entity_id,c.object_literal,c.object_quantity,c.object_unit,c.object_time_from,c.object_time_to,
       c.polarity,c.modality,c.valid_from,c.valid_to,c.asserted_at,c.time_precision,c.state,c.confidence_extraction,c.confidence_source,
       c.confidence_corroboration,c.statement_text,c.created_at,c.updated_at,
       s.canonical_label AS subject_label,s.identity_key AS subject_identity,
       o.canonical_label AS object_label,o.identity_key AS object_identity
       FROM aqua_claims c
       JOIN aqua_entities s ON s.owner_id=c.owner_id AND s.entity_id=c.subject_entity_id
       LEFT JOIN aqua_entities o ON o.owner_id=c.owner_id AND o.entity_id=c.object_entity_id
       WHERE c.owner_id=$1 AND c.state IN ('active','trusted','disputed')
       ORDER BY c.updated_at DESC LIMIT $2`, [ownerId, claimLimit]),
    p.query(`SELECT edge_id,from_entity_id,predicate,to_entity_id,claim_id,confidence,state,actor,created_at FROM aqua_edges WHERE owner_id=$1 AND state='active' ORDER BY created_at DESC LIMIT 2000`, [ownerId]),
    p.query(`SELECT event_id,event_type,subject_entity_id,claim_id,occurred_at,payload,actor,created_at FROM aqua_events WHERE owner_id=$1 ORDER BY occurred_at DESC NULLS LAST, created_at DESC LIMIT 2000`, [ownerId]),
  ]);
  return { entities: entities.rows, claims: claims.rows, edges: edges.rows, events: events.rows };
}
