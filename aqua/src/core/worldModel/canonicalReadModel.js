/**
 * AQUA — canonical World Model read model (E10).
 *
 * The Postgres World Model is now the authoritative read path when the
 * canonical-read gate is enabled. This module is a projection only: it never
 * writes facts, stores derived scores, or invents knowledge shapes.
 *
 * Guarantees:
 *   - owner_id is present in every query predicate (L19);
 *   - state/validity are selected explicitly so "current" means current;
 *   - confidence is returned as its component vector plus a derived summary;
 *   - timeline is a projection over canonical claims/events/revisions (L7);
 *   - all limits are bounded in code (G6);
 *   - any database error is surfaced to the caller so the Brain facade can
 *     fail-open to its legacy projection during migration (L11).
 */
import { getPool, isConfigured } from '../db/pool.js';

const MAX_LIMIT = 500;
const CURRENT_STATES = Object.freeze(['active', 'trusted', 'disputed', 'stale']);
const RETROSPECTIVE_STATES = Object.freeze([...CURRENT_STATES, 'superseded']);

function clampLimit(v, fallback = 50) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_LIMIT) : fallback;
}

function requireOwner(ownerId) {
  if (!ownerId) throw new Error('ownerId is required');
  return String(ownerId);
}

async function db(pool = null) {
  if (!pool && !isConfigured()) throw new Error('DATABASE_URL is not configured');
  return pool ?? getPool();
}

function recencyScore(assertedAt) {
  if (!assertedAt) return 0.5;
  const ageMs = Math.max(0, Date.now() - new Date(assertedAt).getTime());
  const halfLifeMs = 1000 * 60 * 60 * 24 * 180;
  return Math.exp(-Math.log(2) * ageMs / halfLifeMs);
}

function derivedConfidence({ extraction = 0.5, source = 0.5, corroboration = 0, consistency = 1, recency = 0.5 } = {}) {
  const values = [extraction, source, Math.max(0.5, corroboration), consistency, recency]
    .map(Number).filter(Number.isFinite).map(v => Math.max(0, Math.min(1, v)));
  if (!values.length) return 0;
  const gm = values.reduce((acc, v) => acc * Math.max(v, 1e-6), 1) ** (1 / values.length);
  return Math.min(0.99, Number(gm.toFixed(4)));
}

function confidence(row) {
  const state = row.state ?? 'active';
  return {
    extraction: Number(row.confidence_extraction ?? 0.5),
    source: Number(row.confidence_source ?? 0.5),
    corroboration: Number(row.confidence_corroboration ?? 0),
    recency: recencyScore(row.asserted_at),
    consistency: state === 'disputed' ? 0.35 : state === 'stale' ? 0.55 : 1,
    derived: derivedConfidence({
      extraction: row.confidence_extraction,
      source: row.confidence_source,
      corroboration: row.confidence_corroboration,
      consistency: state === 'disputed' ? 0.35 : state === 'stale' ? 0.55 : 1,
      recency: recencyScore(row.asserted_at),
    }),
  };
}

function objectOf(row) {
  if (row.object_entity_id) return { kind: 'entity', entityId: row.object_entity_id, label: row.object_entity_label ?? null };
  if (row.object_quantity !== null && row.object_quantity !== undefined) return { kind: 'quantity', quantity: Number(row.object_quantity), unit: row.object_unit ?? null };
  if (row.object_time_from) return { kind: 'time', from: row.object_time_from, to: row.object_time_to ?? null };
  return { kind: 'literal', value: row.object_literal ?? null };
}

function claim(row) {
  return {
    claimId: row.claim_id,
    ownerId: row.owner_id,
    subjectEntityId: row.subject_entity_id,
    subject: row.subject_label ?? null,
    predicate: row.predicate,
    object: objectOf(row),
    polarity: row.polarity,
    modality: row.modality,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    assertedAt: row.asserted_at,
    timePrecision: row.time_precision,
    state: row.state,
    supersededBy: row.superseded_by,
    statement: row.statement_text,
    statementText: row.statement_text,
    confidence: confidence(row),
    sourceKind: row.source_kind ?? 'conversation',
    sourceId: row.source_id ?? null,
    sourceExternalRef: row.source_external_ref ?? null,
    episodeId: row.source_external_ref ?? null,
    conversationId: row.source_external_ref ? String(row.source_external_ref).split(':turn:')[0] : null,
    evidence: row.evidence ?? [],
    ref: `/brain/claims/${encodeURIComponent(String(row.claim_id))}`,
  };
}

async function claimRows(p, ownerId, { where = '', params = [], limit = 100, retrospective = false } = {}) {
  const states = retrospective ? RETROSPECTIVE_STATES : CURRENT_STATES;
  const stateParam = params.length + 2;
  const limitParam = stateParam + 1;
  const sql = `
    SELECT c.claim_id, c.owner_id, c.subject_entity_id,
           se.canonical_label AS subject_label,
           c.predicate, c.object_entity_id,
           oe.canonical_label AS object_entity_label,
           c.object_literal, c.object_quantity, c.object_unit,
           c.object_time_from, c.object_time_to,
           c.polarity, c.modality, c.valid_from, c.valid_to,
           c.asserted_at, c.time_precision, c.state, c.superseded_by,
           c.statement_text,
           c.confidence_extraction, c.confidence_source, c.confidence_corroboration,
           COALESCE(MAX(s.kind), 'conversation') AS source_kind,
           MAX(s.source_id::text) AS source_id,
           MAX(s.external_ref) AS source_external_ref,
           COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
             'evidenceId', ev.evidence_id,
             'quote', ev.quote,
             'locator', ev.locator,
             'role', ce.role,
             'sourceId', ev.source_id
           )) FILTER (WHERE ev.evidence_id IS NOT NULL), '[]'::jsonb) AS evidence
      FROM aqua_claims c
      JOIN aqua_entities se ON se.entity_id=c.subject_entity_id AND se.owner_id=c.owner_id
      LEFT JOIN aqua_entities oe ON oe.entity_id=c.object_entity_id AND oe.owner_id=c.owner_id
      LEFT JOIN aqua_claim_evidence ce ON ce.owner_id=c.owner_id AND ce.claim_id=c.claim_id
      LEFT JOIN aqua_evidence ev ON ev.owner_id=ce.owner_id AND ev.evidence_id=ce.evidence_id
      LEFT JOIN aqua_sources s ON s.owner_id=ev.owner_id AND s.source_id=ev.source_id
     WHERE c.owner_id=$1
       AND c.state = ANY($${stateParam}::text[])
       ${where}
     GROUP BY c.claim_id, se.canonical_label, oe.canonical_label
     ORDER BY c.updated_at DESC, c.claim_id DESC
     LIMIT $${limitParam}`;
  return p.query(sql, [ownerId, ...params, states, clampLimit(limit)]).then(r => r.rows);
}

/** List canonical entities with derived relationship/claim counts. */
export async function listEntities(ownerId, { type = null, minImportance = 0, limit = 50, pool = null } = {}) {
  const owner = requireOwner(ownerId);
  const p = await db(pool);
  const params = [owner];
  let where = `WHERE e.owner_id=$1 AND e.status='active'`;
  if (type) { params.push(String(type)); where += ` AND e.type=$${params.length}`; }
  const { rows } = await p.query(`
    SELECT e.entity_id, e.owner_id, e.type, e.canonical_label, e.normalized_label,
           e.mention_count, e.confidence_resolution, e.status, e.created_at, e.updated_at,
           COALESCE((SELECT count(*) FROM aqua_claims c WHERE c.owner_id=e.owner_id AND c.subject_entity_id=e.entity_id AND c.state IN ('active','trusted','disputed','stale')),0)::int AS claim_count,
           COALESCE((SELECT count(*) FROM aqua_edges g WHERE g.owner_id=e.owner_id AND (g.from_entity_id=e.entity_id OR g.to_entity_id=e.entity_id) AND g.state IN ('active','trusted','disputed','stale')),0)::int AS relationship_count,
           COALESCE((SELECT jsonb_agg(a.surface_form ORDER BY a.is_canonical DESC, a.surface_form) FROM aqua_entity_aliases a WHERE a.owner_id=e.owner_id AND a.entity_id=e.entity_id), '[]'::jsonb) AS aliases
      FROM aqua_entities e
      ${where}
     ORDER BY (e.mention_count * GREATEST(e.confidence_resolution,0.01)) DESC,
              e.last_seen_at DESC NULLS LAST, e.entity_id
     LIMIT $${params.length + 1}`,
    [...params, clampLimit(limit)]
  );
  const threshold = Math.max(0, Number(minImportance) || 0);
  return rows.map(r => {
    const importance = Math.min(1, 0.35 * Math.min(1, Number(r.mention_count ?? 0) / 20) + 0.65 * Number(r.confidence_resolution ?? 0));
    return {
      id: r.entity_id,
      ownerId: r.owner_id,
      title: r.canonical_label,
      label: r.canonical_label,
      type: r.type,
      aliases: r.aliases ?? [],
      mentionCount: Number(r.mention_count ?? 0),
      claimCount: Number(r.claim_count ?? 0),
      relationshipCount: Number(r.relationship_count ?? 0),
      confidence: Number(r.confidence_resolution ?? 0.5),
      importance,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      sourceRefs: { canonical: true },
      ref: `/brain/entity/${encodeURIComponent(String(r.entity_id))}`,
    };
  }).filter(e => e.importance >= threshold);
}

export async function getEntity(ownerId, entityId, { pool = null } = {}) {
  const owner = requireOwner(ownerId);
  const p = await db(pool);
  const { rows } = await p.query(`
    SELECT e.entity_id, e.owner_id, e.type, e.canonical_label, e.normalized_label,
           e.mention_count, e.confidence_resolution, e.status, e.created_at, e.updated_at,
           COALESCE(jsonb_agg(a.surface_form ORDER BY a.is_canonical DESC, a.surface_form)
             FILTER (WHERE a.alias_id IS NOT NULL), '[]'::jsonb) AS aliases
      FROM aqua_entities e
      LEFT JOIN aqua_entity_aliases a
        ON a.owner_id=e.owner_id AND a.entity_id=e.entity_id
     WHERE e.owner_id=$1 AND e.entity_id=$2 AND e.status='active'
     GROUP BY e.entity_id`, [owner, entityId]);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: r.entity_id, ownerId: r.owner_id, title: r.canonical_label, label: r.canonical_label,
    type: r.type, aliases: r.aliases ?? [], mentionCount: Number(r.mention_count ?? 0),
    confidence: Number(r.confidence_resolution ?? 0.5), status: r.status,
    createdAt: r.created_at, updatedAt: r.updated_at,
    ref: `/brain/entity/${encodeURIComponent(String(r.entity_id))}`,
  };
}

export async function findEntities(ownerId, query, { limit = 20, pool = null } = {}) {
  const owner = requireOwner(ownerId);
  const q = String(query ?? '').trim().slice(0, 200);
  if (!q) return [];
  const p = await db(pool);
  const { rows } = await p.query(`
    SELECT DISTINCT e.entity_id, e.owner_id, e.type, e.canonical_label, e.normalized_label,
           e.mention_count, e.confidence_resolution,
           CASE WHEN e.normalized_label=$2 THEN 3.0
                WHEN e.normalized_label ILIKE $3 THEN 2.0
                ELSE 1.0 END AS match_score
      FROM aqua_entities e
      LEFT JOIN aqua_entity_aliases a
        ON a.owner_id=e.owner_id AND a.entity_id=e.entity_id
     WHERE e.owner_id=$1 AND e.status='active'
       AND (e.normalized_label ILIKE $3 OR a.normalized ILIKE $3)
     ORDER BY match_score DESC, e.mention_count DESC, e.entity_id
     LIMIT $4`, [owner, q.toLowerCase().replace(/\s+/g, ' '), `%${q.toLowerCase()}%`, clampLimit(limit, 20)]);
  return rows.map(r => ({
    id: r.entity_id, ownerId: r.owner_id, title: r.canonical_label, label: r.canonical_label,
    type: r.type, confidence: Number(r.confidence_resolution ?? 0.5), mentionCount: Number(r.mention_count ?? 0),
    ref: `/brain/entity/${encodeURIComponent(String(r.entity_id))}`,
  }));
}

export async function getRelationships(ownerId, entityId, { limit = 20, retrospective = false, pool = null } = {}) {
  const owner = requireOwner(ownerId);
  const p = await db(pool);
  const states = retrospective ? RETROSPECTIVE_STATES : CURRENT_STATES;
  const { rows } = await p.query(`
    SELECT g.edge_id, g.claim_id, g.from_entity_id, fe.canonical_label AS from_label,
           g.to_entity_id, te.canonical_label AS to_label, g.predicate,
           g.state, g.valid_from, g.valid_to, c.polarity, c.modality,
           c.statement_text, c.confidence_extraction, c.confidence_source,
           c.confidence_corroboration, c.asserted_at
      FROM aqua_edges g
      JOIN aqua_entities fe ON fe.owner_id=g.owner_id AND fe.entity_id=g.from_entity_id
      JOIN aqua_entities te ON te.owner_id=g.owner_id AND te.entity_id=g.to_entity_id
      JOIN aqua_claims c ON c.owner_id=g.owner_id AND c.claim_id=g.claim_id
     WHERE g.owner_id=$1
       AND (g.from_entity_id=$2 OR g.to_entity_id=$2)
       AND g.state = ANY($3::text[])
       AND ( $4::boolean OR g.valid_to IS NULL OR g.valid_to >= now() )
     ORDER BY g.updated_at DESC, g.edge_id
     LIMIT $5`, [owner, entityId, states, retrospective, clampLimit(limit, 20)]);
  return rows.map(r => ({
    id: r.edge_id, edgeId: r.edge_id, claimId: r.claim_id, ownerId: owner,
    from: { id: r.from_entity_id, label: r.from_label },
    to: { id: r.to_entity_id, label: r.to_label },
    predicate: r.predicate, state: r.state,
    validFrom: r.valid_from, validTo: r.valid_to,
    polarity: r.polarity, modality: r.modality, statement: r.statement_text,
    confidence: confidence(r),
    ref: `/brain/claims/${encodeURIComponent(String(r.claim_id))}`,
  }));
}

export async function getObservations(ownerId, entityId, { limit = 25, retrospective = false, pool = null } = {}) {
  const owner = requireOwner(ownerId);
  const p = await db(pool);
  const rows = await claimRows(p, owner, { limit, retrospective, where: 'AND c.subject_entity_id=$2', params: [entityId] });
  return rows.map(claim);
}

export async function getEvents(ownerId, entityId = null, { limit = 25, retrospective = false, pool = null } = {}) {
  const owner = requireOwner(ownerId);
  const p = await db(pool);
  const states = retrospective ? RETROSPECTIVE_STATES : CURRENT_STATES;
  const params = [owner];
  let where = '';
  if (entityId) { params.push(entityId); where = ` AND e.subject_entity_id=$${params.length}`; }
  const { rows } = await p.query(`
    SELECT e.event_id, e.owner_id, e.event_type, e.statement_text,
           e.subject_entity_id, se.canonical_label AS subject_label,
           e.claim_id, e.occurred_at, e.occurred_to, e.asserted_at,
           e.time_precision, e.state
      FROM aqua_events e
      LEFT JOIN aqua_entities se ON se.owner_id=e.owner_id AND se.entity_id=e.subject_entity_id
     WHERE e.owner_id=$1 AND e.state = ANY($${params.length + 1}::text[])
       ${where}
     ORDER BY e.occurred_at DESC NULLS LAST, e.asserted_at DESC, e.event_id
     LIMIT $${params.length + 2}`,
    [...params, states, clampLimit(limit, 25)]
  );
  return rows.map(r => ({
    id: r.event_id, eventId: r.event_id, ownerId: owner, type: r.event_type,
    statement: r.statement_text, subjectEntityId: r.subject_entity_id,
    subject: r.subject_label ?? null, claimId: r.claim_id,
    timestamp: r.occurred_at ?? r.asserted_at, occurredAt: r.occurred_at,
    occurredTo: r.occurred_to, assertedAt: r.asserted_at,
    timePrecision: r.time_precision, state: r.state,
    ref: r.claim_id ? `/brain/claims/${encodeURIComponent(String(r.claim_id))}` : null,
  }));
}

export async function getTimeline(ownerId, { limit = 100, retrospective = false, subject = null, pool = null } = {}) {
  const owner = requireOwner(ownerId);
  const p = await db(pool);
  const events = await getEvents(owner, null, { limit: Math.min(500, clampLimit(limit, 100)), retrospective, pool: p });
  const claims = await claimRows(p, owner, {
    limit: Math.min(500, clampLimit(limit, 100)), retrospective,
    where: subject ? `AND (se.canonical_label ILIKE $2 OR c.statement_text ILIKE $2)` : '',
    params: subject ? [`%${String(subject).slice(0, 200)}%`] : [],
  });
  const claimEvents = claims.map(r => ({
    id: `claim:${r.claim_id}`, eventId: null, ownerId: owner, type: 'claim',
    statement: r.statement_text, subjectEntityId: r.subject_entity_id,
    subject: r.subject_label, claimId: r.claim_id,
    timestamp: r.valid_from ?? r.asserted_at, occurredAt: r.valid_from ?? null,
    occurredTo: r.valid_to ?? null, assertedAt: r.asserted_at,
    timePrecision: r.time_precision, state: r.state,
    modality: r.modality, predicate: r.predicate,
    confidence: confidence(r), ref: `/brain/claims/${encodeURIComponent(String(r.claim_id))}`,
  }));
  const merged = [...events, ...claimEvents]
    .filter(e => !subject || String(e.subject ?? '').toLowerCase().includes(String(subject).toLowerCase()) || String(e.statement ?? '').toLowerCase().includes(String(subject).toLowerCase()))
    .sort((a, b) => new Date(b.timestamp ?? 0).getTime() - new Date(a.timestamp ?? 0).getTime())
    .slice(0, clampLimit(limit, 100));

  const chains = [];
  const bySubject = new Map();
  for (const e of merged) {
    const key = e.subjectEntityId ?? e.subject ?? 'unknown';
    const arr = bySubject.get(key) ?? [];
    arr.push(e);
    bySubject.set(key, arr);
  }
  for (const [key, arr] of bySubject) {
    if (arr.length < 2) continue;
    chains.push({ id: `canonical:${key}`, subjectEntityId: key, stages: arr.slice().reverse(), progressionOnly: true });
  }
  return {
    events: merged,
    chains: chains.slice(0, Math.min(100, Math.ceil(clampLimit(limit, 100) / 2))),
    stats: { source: 'canonical', events: merged.length, claims: claimEvents.length, entities: new Set(merged.map(e => e.subjectEntityId).filter(Boolean)).size },
  };
}

export async function worldStats(ownerId, { pool = null } = {}) {
  const owner = requireOwner(ownerId);
  const p = await db(pool);
  const { rows } = await p.query(`
    SELECT
      (SELECT count(*) FROM aqua_entities WHERE owner_id=$1 AND status='active')::int AS entities,
      (SELECT count(*) FROM aqua_claims WHERE owner_id=$1 AND state <> 'archived')::int AS claims,
      (SELECT count(*) FROM aqua_edges WHERE owner_id=$1 AND state <> 'archived')::int AS relationships,
      (SELECT count(*) FROM aqua_events WHERE owner_id=$1 AND state <> 'archived')::int AS events,
      (SELECT count(*) FROM aqua_revisions WHERE owner_id=$1)::int AS revisions,
      (SELECT count(*) FROM aqua_corrections WHERE owner_id=$1)::int AS corrections,
      (SELECT count(*) FROM aqua_claims WHERE owner_id=$1 AND state IN ('active','trusted','disputed','stale'))::int AS live_claims,
      (SELECT count(*) FROM aqua_claims WHERE owner_id=$1 AND state='disputed')::int AS disputed_claims,
      (SELECT count(*) FROM aqua_claims WHERE owner_id=$1 AND state='stale')::int AS stale_claims`, [owner]);
  return { ...rows[0], source: 'canonical' };
}

/** Small helper for retrieval lanes. */
export async function readClaims(ownerId, claimIds, { pool = null, retrospective = false } = {}) {
  const owner = requireOwner(ownerId);
  const ids = [...new Set((claimIds ?? []).map(String))].slice(0, 256);
  if (!ids.length) return [];
  const p = await db(pool);
  const rows = await claimRows(p, owner, {
    limit: ids.length,
    retrospective,
    where: `AND c.claim_id = ANY($2::uuid[])`,
    params: [ids],
  });
  const byId = new Map(rows.map(r => [String(r.claim_id), claim(r)]));
  return ids.map(id => byId.get(id)).filter(Boolean);
}

export async function listClaims(ownerId, { limit = 64, retrospective = false, pool = null } = {}) {
  const owner = requireOwner(ownerId);
  const p = await db(pool);
  const rows = await claimRows(p, owner, { limit: Math.min(256, clampLimit(limit, 64)), retrospective });
  return rows.map(claim);
}

export async function searchClaims(ownerId, query, { limit = 32, retrospective = false, pool = null } = {}) {
  const owner = requireOwner(ownerId);
  const q = String(query ?? '').trim().slice(0, 300);
  if (!q) return [];
  const p = await db(pool);
  const states = retrospective ? RETROSPECTIVE_STATES : CURRENT_STATES;
  const k = clampLimit(limit, 32);
  const { rows } = await p.query(`
    SELECT c.claim_id, c.owner_id, c.subject_entity_id, se.canonical_label AS subject_label,
           c.predicate, c.object_entity_id, oe.canonical_label AS object_entity_label,
           c.object_literal, c.object_quantity, c.object_unit, c.object_time_from, c.object_time_to,
           c.polarity, c.modality, c.valid_from, c.valid_to, c.asserted_at, c.time_precision,
           c.state, c.superseded_by, c.statement_text,
           c.confidence_extraction, c.confidence_source, c.confidence_corroboration,
           ts_rank_cd(to_tsvector('simple', coalesce(c.statement_text,'')), plainto_tsquery('simple',$2)) AS rank
      FROM aqua_claims c
      JOIN aqua_entities se ON se.owner_id=c.owner_id AND se.entity_id=c.subject_entity_id
      LEFT JOIN aqua_entities oe ON oe.owner_id=c.owner_id AND oe.entity_id=c.object_entity_id
     WHERE c.owner_id=$1
       AND c.state = ANY($3::text[])
       AND (to_tsvector('simple', coalesce(c.statement_text,'')) @@ plainto_tsquery('simple',$2)
            OR c.statement_text ILIKE '%' || $2 || '%')
     ORDER BY rank DESC, c.updated_at DESC, c.claim_id
     LIMIT $4`, [owner, q, states, k]);
  // Evidence is loaded in one bounded batch to keep citations complete.
  if (!rows.length) return [];
  const ids = rows.map(r => r.claim_id);
  const hydrated = await readClaims(owner, ids, { pool: p, retrospective });
  const byId = new Map(hydrated.map(c => [String(c.claimId), c]));
  return rows.map(r => ({ ...(byId.get(String(r.claim_id)) ?? claim(r)), retrievalScore: Number(r.rank ?? 0) }));
}

export async function findEntityIds(ownerId, query, { limit = 8, pool = null } = {}) {
  return (await findEntities(ownerId, query, { limit, pool })).map(e => String(e.id));
}

export async function structuredClaims(ownerId, { entityIds = [], predicates = [], modality = null, currentOnly = true, limit = 24, pool = null } = {}) {
  const owner = requireOwner(ownerId);
  const p = await db(pool);
  const states = currentOnly ? CURRENT_STATES : RETROSPECTIVE_STATES;
  const params = [owner, states];
  const where = ['c.owner_id=$1', 'c.state=ANY($2::text[])'];
  if (entityIds.length) { params.push([...new Set(entityIds.map(String))].slice(0, 32)); where.push(`(c.subject_entity_id = ANY($${params.length}::uuid[]) OR c.object_entity_id = ANY($${params.length}::uuid[]))`); }
  if (predicates.length) { params.push([...new Set(predicates.map(String))].slice(0, 32)); where.push(`c.predicate = ANY($${params.length}::text[])`); }
  if (modality) { params.push(String(modality)); where.push(`c.modality=$${params.length}`); }
  if (currentOnly) where.push('(c.valid_from IS NULL OR c.valid_from <= now()) AND (c.valid_to IS NULL OR c.valid_to >= now())');
  params.push(clampLimit(limit, 24));
  const { rows } = await p.query(`
    SELECT c.claim_id, c.owner_id, c.subject_entity_id, se.canonical_label AS subject_label,
           c.predicate, c.object_entity_id, oe.canonical_label AS object_entity_label,
           c.object_literal, c.object_quantity, c.object_unit, c.object_time_from, c.object_time_to,
           c.polarity, c.modality, c.valid_from, c.valid_to, c.asserted_at, c.time_precision,
           c.state, c.superseded_by, c.statement_text,
           c.confidence_extraction, c.confidence_source, c.confidence_corroboration,
           c.updated_at
      FROM aqua_claims c
      JOIN aqua_entities se ON se.owner_id=c.owner_id AND se.entity_id=c.subject_entity_id
      LEFT JOIN aqua_entities oe ON oe.owner_id=c.owner_id AND oe.entity_id=c.object_entity_id
     WHERE ${where.join(' AND ')}
     ORDER BY c.updated_at DESC, c.claim_id
     LIMIT $${params.length}`, params);
  return rows.map(r => claim(r));
}
