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
           e.mention_count, e.confidence_resolution, e.status, e.first_seen_at AS created_at, e.last_seen_at AS updated_at,
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
           e.mention_count, e.confidence_resolution, e.status, e.first_seen_at AS created_at, e.last_seen_at AS updated_at,
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

/** First-person words that make the user themselves an anchor of the question. */
const FIRST_PERSON = /(^|\s)(i|i'm|im|i've|i'd|i'll|me|my|mine|myself|we|we're|we've|us|our|ours|ourselves)(\s|$)/;

/**
 * POSSESSIVE / DEFINITE REFERENCES (2026-10-04). People rarely name the thing
 * they mean: "when is OUR LAUNCH?", "what happened with MY PROJECT?", "where
 * is MY COMPANY based?". Two generic resolutions, both owner-scoped:
 *
 *  1. HEAD NOUN — "our launch", "the migration" anchor on entities whose label
 *     ENDS with that noun ("iOS launch", "Kafka to NATS migration"). The label
 *     is matched, never used as an id (L8).
 *  2. ROLE NOUN through the user's OWN relations — "my company" is whatever
 *     the user currently works_at / is a member_of / founded; "my manager" is
 *     who they report_to; "our office" is where they are located_in. Resolved
 *     from current claims about the user's self entity, by type, not label.
 */
const DETERMINER_REF = new Set(['my', 'our', 'the', 'this', 'that']);
const PHRASE_STOP = new Set(['to', 'of', 'for', 'in', 'on', 'at', 'by', 'from', 'with', 'about', 'and', 'or', 'is', 'are', 'was', 'were', 'be', 'do', 'does', 'did', 'has', 'have', 'had', 'will', 'would', 'should', 'can', 'could', 'going', 'been', 'now', 'next', 'last', 'this', 'that', 'my', 'our', 'the', 'a', 'an']);
const NOT_HEAD = new Set(['is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'have', 'has', 'had',
  'and', 'or', 'but', 'for', 'with', 'about', 'next', 'last', 'first', 'same', 'other', 'most', 'best', 'way',
  'thing', 'things', 'one', 'ones', 'time', 'week', 'month', 'year', 'day', 'today', 'tomorrow', 'moment']);
export const ROLE_NOUNS = Object.freeze({
  company: ['works_at', 'member_of', 'founded'], employer: ['works_at'], startup: ['works_at', 'founded', 'member_of'],
  business: ['works_at', 'founded', 'member_of'], firm: ['works_at', 'member_of'], organisation: ['works_at', 'member_of'],
  organization: ['works_at', 'member_of'], org: ['works_at', 'member_of'], workplace: ['works_at'], job: ['works_at'],
  manager: ['reports_to'], boss: ['reports_to'], supervisor: ['reports_to'],
  team: ['member_of'], group: ['member_of'], club: ['member_of'],
  office: ['located_in'], city: ['located_in'], hometown: ['located_in'], base: ['located_in'],
});

/** The head nouns and role nouns a question refers to by possessive/definite phrase. */
export function referenceNouns(question) {
  const tokens = String(question ?? '').toLowerCase().replace(/[^a-z0-9' -]+/g, ' ').split(/\s+/).filter(Boolean);
  const heads = new Set();
  const roles = new Set();
  for (let i = 0; i < tokens.length; i++) {
    if (!DETERMINER_REF.has(tokens[i])) continue;
    // Up to three words of the phrase, stopping at a preposition/auxiliary.
    // EVERY word is a candidate head: "our iOS launch" offers ios + launch,
    // "my company based" offers company + based. A candidate only matters if
    // an entity label ENDS with it (or a role noun names it), so a stray verb
    // anchors nothing — no part-of-speech guessing.
    for (let j = i + 1; j < Math.min(tokens.length, i + 4); j++) {
      const w = tokens[j].replace(/'s$/, '');
      if (PHRASE_STOP.has(w) || w.length < 3) break;
      if (NOT_HEAD.has(w)) continue;
      heads.add(w);
      if ((tokens[i] === 'my' || tokens[i] === 'our') && ROLE_NOUNS[w]) roles.add(w);
    }
  }
  return { heads: [...heads].slice(0, 6), roles: [...roles].slice(0, 4) };
}

/**
 * Entities a question is ABOUT.
 *
 * FIXED 2026-10-03 — the match was inverted. It asked whether an entity's
 * label CONTAINS THE WHOLE QUESTION (`label ILIKE '%what is blocking the
 * launch?%'`), which only ever matched when the user typed a bare name. Any
 * natural question anchored on nothing, so the structured and graph lanes ran
 * on predicate hints alone or not at all. Now an entity anchors when its label
 * occurs in the question as whole words (labels of 3+ chars), and the old
 * direction is kept for partial names ("onboard" → "onboarding flow").
 *
 * SELF ANCHOR. The user is stored as the owner's single `type='self'` entity,
 * whose label is "You" — a label the user never types about themselves. A
 * first-person question ("what am I building?", "what should I focus on?")
 * therefore anchors on the self entity BY TYPE, never by label (L8). The self
 * entity is excluded from the label branches so "can you help" does not
 * anchor on the user.
 */
export async function findEntities(ownerId, query, { limit = 20, pool = null } = {}) {
  const owner = requireOwner(ownerId);
  const q = String(query ?? '').trim().slice(0, 200);
  if (!q) return [];
  const p = await db(pool);
  const lowered = q.toLowerCase().replace(/\s+/g, ' ');
  const words = lowered.replace(/[^a-z0-9'\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const firstPerson = FIRST_PERSON.test(words);
  const { rows } = await p.query(`
    SELECT DISTINCT e.entity_id, e.owner_id, e.type, e.canonical_label, e.normalized_label,
           e.mention_count, e.confidence_resolution,
           CASE WHEN e.type='self' THEN 1.5
                WHEN e.normalized_label=$2 THEN 3.0
                WHEN position(' ' || e.normalized_label || ' ' IN ' ' || $5 || ' ') > 0 THEN 2.5
                WHEN e.normalized_label ILIKE $3 THEN 2.0
                ELSE 1.0 END AS match_score
      FROM aqua_entities e
      LEFT JOIN aqua_entity_aliases a
        ON a.owner_id=e.owner_id AND a.entity_id=e.entity_id
     WHERE e.owner_id=$1 AND e.status='active'
       AND (
         (e.type <> 'self' AND (
            e.normalized_label ILIKE $3 OR a.normalized ILIKE $3
            OR (length(e.normalized_label) >= 3 AND position(' ' || e.normalized_label || ' ' IN ' ' || $5 || ' ') > 0)
            OR (length(a.normalized) >= 3 AND position(' ' || a.normalized || ' ' IN ' ' || $5 || ' ') > 0)))
         OR ($6::boolean AND e.type = 'self'))
     ORDER BY match_score DESC, e.mention_count DESC, e.entity_id
     LIMIT $4`, [owner, lowered, `%${lowered}%`, clampLimit(limit, 20), words, firstPerson]);
  const found = new Map(rows.map(r => [String(r.entity_id), r]));

  const { heads, roles } = referenceNouns(q);
  if (heads.length) {
    const { rows: byHead } = await p.query(`
      SELECT e.entity_id, e.owner_id, e.type, e.canonical_label, e.mention_count, e.confidence_resolution, 2.2 AS match_score
        FROM aqua_entities e
       WHERE e.owner_id=$1 AND e.status='active' AND e.type <> 'self'
         AND (e.normalized_label = ANY($2::text[])
              OR reverse(split_part(reverse(e.normalized_label), ' ', 1)) = ANY($2::text[]))
       ORDER BY e.mention_count DESC, e.entity_id
       LIMIT $3`, [owner, heads, clampLimit(limit, 20)]);
    for (const r of byHead) if (!found.has(String(r.entity_id))) found.set(String(r.entity_id), r);
  }
  if (roles.length) {
    const predicates = [...new Set(roles.flatMap(r => ROLE_NOUNS[r]))];
    const { rows: byRole } = await p.query(`
      SELECT DISTINCT oe.entity_id, oe.owner_id, oe.type, oe.canonical_label, oe.mention_count, oe.confidence_resolution, 2.6 AS match_score
        FROM aqua_claims c
        JOIN aqua_entities se ON se.owner_id=c.owner_id AND se.entity_id=c.subject_entity_id AND se.type='self'
        JOIN aqua_entities oe ON oe.owner_id=c.owner_id AND oe.entity_id=c.object_entity_id AND oe.status='active'
       WHERE c.owner_id=$1 AND c.predicate = ANY($2::text[]) AND c.polarity='asserted' AND c.modality='fact'
         AND c.state = ANY($3::text[])
       LIMIT 8`, [owner, predicates, CURRENT_STATES]);
    for (const r of byRole) found.set(String(r.entity_id), r);
  }

  return [...found.values()]
    .sort((a, b) => Number(b.match_score) - Number(a.match_score) || Number(b.mention_count ?? 0) - Number(a.mention_count ?? 0)
      || String(a.entity_id).localeCompare(String(b.entity_id)))
    .slice(0, clampLimit(limit, 20))
    .map(r => ({
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

/**
 * THE OWNER'S CURRENT WORLD (2026-10-11) — every claim that is true now or
 * stated for the future: current states only (never superseded/archived), and
 * a validity window that has not CLOSED in the past ("I lived in Kyoto until
 * 2023" is history, not the present). Future-dated claims ("moving to Kuala
 * Lumpur in January") are kept; the caller labels them. Owner-scoped (L19) and
 * bounded (G6): most recently updated first, at most `limit` rows.
 */
export async function currentWorld(ownerId, { limit = 80, pool = null } = {}) {
  const owner = requireOwner(ownerId);
  const p = await db(pool);
  const rows = await claimRows(p, owner, {
    limit: Math.min(160, clampLimit(limit, 80)),
    where: 'AND (c.valid_to IS NULL OR c.valid_to >= now())',
  });
  return rows.map(claim);
}

/**
 * RETIRED STATEMENTS (2026-10-11): source sentences behind at least one claim
 * that is no longer current (superseded/archived). A sentence can carry a
 * retired claim AND a current one ("My biggest client is a restaurant called
 * Fennel" → role retired, "Fennel is a restaurant" current); quoting it whole
 * re-asserts the retired part. Owner-scoped, bounded.
 */
export async function retiredStatements(ownerId, { limit = 400, pool = null } = {}) {
  const owner = requireOwner(ownerId);
  const p = await db(pool);
  const { rows } = await p.query(`
    SELECT DISTINCT statement_text FROM aqua_claims
     WHERE owner_id=$1 AND state IN ('superseded','archived') AND statement_text IS NOT NULL
     LIMIT $2`, [owner, Math.min(1000, clampLimit(limit, 400))]);
  return rows.map(r => r.statement_text);
}

/**
 * CURRENT ROLE HOLDERS (2026-10-11): who currently plays which role for the
 * owner (related_to, prompt rule 13) — "Sam Patel → mentor", "Sora Studio →
 * biggest client". Lets retrieval resolve "my mentor" in a question to the
 * entity it names. Owner-scoped, current, asserted facts only; bounded.
 */
export async function roleHolders(ownerId, { limit = 64, pool = null } = {}) {
  const owner = requireOwner(ownerId);
  const p = await db(pool);
  const { rows } = await p.query(`
    SELECT c.subject_entity_id, se.canonical_label AS label, c.object_literal AS role
      FROM aqua_claims c
      JOIN aqua_entities se ON se.owner_id=c.owner_id AND se.entity_id=c.subject_entity_id
     WHERE c.owner_id=$1 AND c.predicate='related_to' AND c.state=ANY($2::text[])
       AND c.polarity='asserted' AND c.modality='fact' AND c.object_literal IS NOT NULL
       AND (c.valid_to IS NULL OR c.valid_to >= now())
     ORDER BY c.updated_at DESC, c.claim_id
     LIMIT $3`, [owner, CURRENT_STATES, clampLimit(limit, 64)]);
  return rows.map(r => ({ entityId: String(r.subject_entity_id), label: r.label, role: r.role }));
}

/**
 * LEXICAL TERMS (2026-10-06). `plainto_tsquery('simple', question)` ANDs every
 * word of the question — stopwords included, the 'simple' config keeps them —
 * so "Who is my tech lead going forward?" only matched a claim containing all
 * of who/is/my/tech/lead/going/forward. Over a full World-Model Lift run the
 * lane contributed ZERO selected items. The lane now matches ANY content word
 * (OR), ranked by ts_rank_cd; bounded to 12 terms.
 */
const LEXICAL_STOP = new Set(('a an the is are was were be been being am i me my mine we our ours us you your yours it its '
  + 'this that these those to of in on at for with from by and or but do does did what where when who whom whose how why '
  + 'which can could should would will shall have has had not no so if then than there their they them he she his her '
  + 'about into up out just now any some all please tell know going').split(/\s+/));
export function lexicalTerms(query) {
  return [...new Set(String(query ?? '').toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u)
    .filter(t => t.length > 1 && !LEXICAL_STOP.has(t)))].slice(0, 12);
}

export async function searchClaims(ownerId, query, { limit = 32, retrospective = false, pool = null } = {}) {
  const owner = requireOwner(ownerId);
  const q = String(query ?? '').trim().slice(0, 300);
  if (!q) return [];
  const terms = lexicalTerms(q);
  if (!terms.length) return [];
  // to_tsquery syntax: terms are letters/digits only (split above), OR-joined.
  const tsq = terms.join(' | ');
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
           ts_rank_cd(to_tsvector('simple', coalesce(c.statement_text,'')), to_tsquery('simple',$2)) AS rank
      FROM aqua_claims c
      JOIN aqua_entities se ON se.owner_id=c.owner_id AND se.entity_id=c.subject_entity_id
      LEFT JOIN aqua_entities oe ON oe.owner_id=c.owner_id AND oe.entity_id=c.object_entity_id
     WHERE c.owner_id=$1
       AND c.state = ANY($3::text[])
       AND (to_tsvector('simple', coalesce(c.statement_text,'')) @@ to_tsquery('simple',$2)
            OR c.statement_text ILIKE '%' || $5 || '%')
     ORDER BY rank DESC, c.updated_at DESC, c.claim_id
     LIMIT $4`, [owner, tsq, states, k, q]);
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

/**
 * RE-EXPLANATION RATE (Blueprint V2 §2.10, §13.4) — derived, never stored (L7).
 *
 * "The frequency with which a user restates information Aqua should already
 * understand." S8 records an exact restatement as a `corroborating` evidence
 * row on the claim it already holds, so the rate is computable from the World
 * Model itself, per owner, per week, across processes (the worker that writes
 * and the server that reads share no memory):
 *
 *     re-explained / all conversation evidence, bucketed by ISO week
 *
 * A LOWER BOUND, stated in the payload: S8 matches exactly, so a paraphrased
 * restatement is a new claim, not a re-explanation. The product promise is that
 * this series falls for a user over time; a flat or rising series means the
 * loop is not closing. Bounded: owner-scoped (L19), ≤ 52 weekly rows.
 */
export async function reexplanationStats(ownerId, { sinceDays = 90, pool = null } = {}) {
  const owner = requireOwner(ownerId);
  const days = Math.max(1, Math.min(366, Math.floor(Number(sinceDays) || 90)));
  const p = await db(pool);
  const { rows } = await p.query(`
    SELECT date_trunc('week', ce.added_at) AS week,
           count(*) FILTER (WHERE ce.role = 'corroborating')::int AS reexplained,
           count(*)::int AS statements
      FROM aqua_claim_evidence ce
      JOIN aqua_evidence e ON e.owner_id = ce.owner_id AND e.evidence_id = ce.evidence_id
      JOIN aqua_sources  s ON s.owner_id = e.owner_id AND s.source_id = e.source_id
     WHERE ce.owner_id = $1 AND s.kind = 'conversation'
       AND ce.added_at >= now() - make_interval(days => $2)
     GROUP BY 1 ORDER BY 1
     LIMIT 52`, [owner, days]);
  const weeks = rows.map(r => ({
    week: new Date(r.week).toISOString().slice(0, 10),
    reexplained: r.reexplained,
    statements: r.statements,
    rate: r.statements ? Number((r.reexplained / r.statements).toFixed(4)) : null,
  }));
  const reexplained = weeks.reduce((n, w) => n + w.reexplained, 0);
  const statements = weeks.reduce((n, w) => n + w.statements, 0);
  return {
    sinceDays: days,
    reexplained, statements,
    rate: statements ? Number((reexplained / statements).toFixed(4)) : null,
    weeks,
    lowerBound: true,
    method: 'exact S8 restatements (corroborating evidence) / all conversation evidence; paraphrases are not counted',
  };
}

/**
 * LEARNING metrics (Phase 3, 2026-10-06) — derived from the canonical tables,
 * owner-scoped, bounded (≤ 52 weekly rows). Nothing new is stored.
 *
 *   corrections        explicit corrections (POST /brain/claims/:id/correct) and
 *                      in-conversation revisions (claims the user marked as a
 *                      change/correction — evidence locator `revision: true` —
 *                      that superseded an older claim), per week
 *   correctionLatency  how long a corrected claim had been believed before the
 *                      explicit correction (median hours) — lower = errors
 *                      caught sooner
 *   repeatedErrors     (subject, predicate) pairs explicitly corrected more than
 *                      once in the window — the same mistake recurring
 *   reexplanation      reexplanationStats (volunteered restatements)
 * Intended direction over time: corrections and repeated errors DOWN once the
 * World Model has absorbed them; re-explanation DOWN.
 */
export async function learningStats(ownerId, { sinceDays = 90, pool = null } = {}) {
  const owner = requireOwner(ownerId);
  const days = Math.max(1, Math.min(366, Math.floor(Number(sinceDays) || 90)));
  const p = await db(pool);
  const [explicit, revisions, latency, repeated] = await Promise.all([
    p.query(`SELECT date_trunc('week', created_at) AS week, count(*)::int AS n FROM aqua_corrections
              WHERE owner_id=$1 AND action='correct' AND created_at >= now() - make_interval(days => $2)
              GROUP BY 1 ORDER BY 1 LIMIT 52`, [owner, days]),
    p.query(`SELECT date_trunc('week', c.asserted_at) AS week, count(DISTINCT old.claim_id)::int AS n
               FROM aqua_claims old
               JOIN aqua_claims c ON c.owner_id=old.owner_id AND c.claim_id=old.superseded_by
               JOIN aqua_claim_evidence ce ON ce.owner_id=c.owner_id AND ce.claim_id=c.claim_id
               JOIN aqua_evidence e ON e.owner_id=ce.owner_id AND e.evidence_id=ce.evidence_id
              WHERE old.owner_id=$1 AND old.state='superseded' AND e.locator->>'revision' = 'true'
                AND c.asserted_at >= now() - make_interval(days => $2)
              GROUP BY 1 ORDER BY 1 LIMIT 52`, [owner, days]),
    p.query(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (k.created_at - c.asserted_at)) / 3600.0) AS median_h,
                    count(*)::int AS n
               FROM aqua_corrections k JOIN aqua_claims c ON c.owner_id=k.owner_id AND c.claim_id=k.target_id
              WHERE k.owner_id=$1 AND k.action='correct' AND k.target_kind='claim'
                AND k.created_at >= now() - make_interval(days => $2)`, [owner, days]),
    p.query(`SELECT c.subject_entity_id, c.predicate, count(*)::int AS n
               FROM aqua_corrections k JOIN aqua_claims c ON c.owner_id=k.owner_id AND c.claim_id=k.target_id
              WHERE k.owner_id=$1 AND k.action='correct' AND k.created_at >= now() - make_interval(days => $2)
              GROUP BY 1,2 HAVING count(*) > 1 LIMIT 100`, [owner, days]),
  ]);
  const week = r => new Date(r.week).toISOString().slice(0, 10);
  const weeks = new Map();
  for (const r of explicit.rows) weeks.set(week(r), { week: week(r), explicitCorrections: r.n, conversationalRevisions: 0 });
  for (const r of revisions.rows) {
    const w = weeks.get(week(r)) ?? { week: week(r), explicitCorrections: 0, conversationalRevisions: 0 };
    w.conversationalRevisions = r.n;
    weeks.set(week(r), w);
  }
  const l = latency.rows[0] ?? {};
  return {
    sinceDays: days,
    corrections: [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)),
    correctionLatencyHours: l.n ? { median: Number(Number(l.median_h).toFixed(2)), n: l.n } : null,
    repeatedErrors: { pairs: repeated.rows.length, corrections: repeated.rows.reduce((n, r) => n + r.n, 0) },
    reexplanation: await reexplanationStats(owner, { sinceDays: days, pool: p }),
  };
}

/**
 * Reference candidates for S6½ (understanding/referenceResolver.js). All
 * owner-scoped (L19), bounded, current claims only; the self side is found by
 * entity TYPE, never by label (L8).
 */
export async function referenceRoleObjects(ownerId, predicates = [], { pool = null } = {}) {
  const owner = requireOwner(ownerId);
  if (!predicates.length) return [];
  const p = await db(pool);
  const { rows } = await p.query(`
    SELECT DISTINCT ON (oe.entity_id) oe.canonical_label AS label, c.predicate, c.claim_id
      FROM aqua_claims c
      JOIN aqua_entities se ON se.owner_id=c.owner_id AND se.entity_id=c.subject_entity_id AND se.type='self'
      JOIN aqua_entities oe ON oe.owner_id=c.owner_id AND oe.entity_id=c.object_entity_id AND oe.status='active'
     WHERE c.owner_id=$1 AND c.predicate = ANY($2::text[]) AND c.polarity='asserted' AND c.modality='fact'
       AND c.state = ANY($3::text[])
     ORDER BY oe.entity_id, c.asserted_at DESC
     LIMIT 8`, [owner, predicates.map(String), CURRENT_STATES]);
  return rows.map(r => ({ label: r.label, via: `self ${r.predicate}`, claimId: r.claim_id }));
}

export async function referenceHeadNoun(ownerId, head, { pool = null } = {}) {
  const owner = requireOwner(ownerId);
  const h = String(head ?? '').toLowerCase().trim();
  if (h.length < 3) return [];
  const p = await db(pool);
  const { rows } = await p.query(`
    SELECT e.canonical_label AS label
      FROM aqua_entities e
     WHERE e.owner_id=$1 AND e.status='active' AND e.type <> 'self'
       AND (e.normalized_label = $2 OR e.normalized_label LIKE '% ' || $2)
     ORDER BY e.mention_count DESC, e.entity_id
     LIMIT 8`, [owner, h]);
  return rows.map(r => ({ label: r.label, via: `label head "${h}"` }));
}

/** Non-self entities claimed in one earlier source (the previous turn). */
export async function referencePreviousTurn(ownerId, sourceId, { pool = null } = {}) {
  const owner = requireOwner(ownerId);
  if (!sourceId) return [];
  const p = await db(pool);
  const { rows } = await p.query(`
    SELECT DISTINCT e.canonical_label AS label
      FROM aqua_evidence ev
      JOIN aqua_claim_evidence ce ON ce.owner_id=ev.owner_id AND ce.evidence_id=ev.evidence_id
      JOIN aqua_claims c ON c.owner_id=ce.owner_id AND c.claim_id=ce.claim_id
      JOIN aqua_entities e ON e.owner_id=c.owner_id AND e.entity_id IN (c.subject_entity_id, c.object_entity_id)
     WHERE ev.owner_id=$1 AND ev.source_id=$2 AND e.type <> 'self' AND e.status='active'
     LIMIT 8`, [owner, sourceId]);
  return rows.map(r => ({ label: r.label, via: 'previous turn' }));
}

/**
 * Revision voice (2026-10-04): claim transitions into superseded/disputed past
 * the owner's watermark, each with the retired claim, its successor (or, for a
 * dispute, the newest other still-DISPUTED claim on the same subject+predicate), the
 * old claim's CURRENT state (so a since-resolved dispute is not raised) and the
 * successor's source ref (so the caller can tell which conversation it came
 * from). Oldest first, keyed exactly like the watermark. Owner-scoped (L19).
 */
export async function revisionVoiceCandidates(ownerId, { pool = null, limit = 50 } = {}) {
  const owner = requireOwner(ownerId);
  const p = await db(pool);
  const { rows } = await p.query(`
    WITH mark AS (
      SELECT surfaced_at, surfaced_transition_id FROM aqua_revision_voice_state WHERE owner_id=$1
    )
    SELECT lt.transition_id, lt.created_at, lt.to_state, lt.reason, lt.actor,
           old.claim_id AS old_id, old.statement_text AS old_text, old.state AS current_state,
           nw.claim_id AS new_id, nw.statement_text AS new_text, nw.actor AS new_actor,
           (SELECT s.external_ref
              FROM aqua_claim_evidence ce
              JOIN aqua_evidence ev ON ev.owner_id=ce.owner_id AND ev.evidence_id=ce.evidence_id
              JOIN aqua_sources s ON s.owner_id=ev.owner_id AND s.source_id=ev.source_id
             WHERE ce.owner_id=$1 AND ce.claim_id=nw.claim_id
             ORDER BY s.ingested_at ASC LIMIT 1) AS new_ref
      FROM aqua_lifecycle_transitions lt
      LEFT JOIN mark ON true
      JOIN aqua_claims old ON old.owner_id=lt.owner_id AND old.claim_id=lt.target_id
      LEFT JOIN LATERAL (
        SELECT c.claim_id, c.statement_text, c.actor FROM aqua_claims c
         WHERE c.owner_id=old.owner_id AND (
                 (lt.to_state='superseded' AND c.claim_id=old.superseded_by)
              OR (lt.to_state='disputed' AND c.claim_id<>old.claim_id
                  AND c.subject_entity_id=old.subject_entity_id AND c.predicate=old.predicate
                  AND c.state='disputed'))   -- the worker disputes BOTH sides; a claim merely current is not the other side
         ORDER BY c.asserted_at DESC, c.claim_id DESC LIMIT 1) nw ON true
     WHERE lt.owner_id=$1 AND lt.target_kind='claim' AND lt.to_state IN ('superseded','disputed')
       AND (mark.surfaced_at IS NULL
            OR (lt.created_at, lt.transition_id) > (mark.surfaced_at, mark.surfaced_transition_id))
     ORDER BY lt.created_at ASC, lt.transition_id ASC
     LIMIT $2`, [owner, clampLimit(limit, 50)]);
  return rows.map(r => ({
    transitionId: r.transition_id, createdAt: r.created_at, toState: r.to_state, reason: r.reason, actor: r.actor,
    oldClaimId: r.old_id, oldText: r.old_text, currentState: r.current_state,
    newClaimId: r.new_id, newText: r.new_text, newActor: r.new_actor, newRef: r.new_ref,
  }));
}

/**
 * EXTRACTION CONTEXT (D6, 2026-10-05) — what the extractor may use to RESOLVE
 * a reference, never to extract from. Read-only.
 *
 * The extractor sees one sentence. "It's written in Rust", "No, it's Rust",
 * "the launch date changed to May 2" name no subject it can see, so the change
 * was lost or attached to the speaker. The World Model already knows both
 * things that disambiguate them:
 *   · conversation — claims said EARLIER in this conversation (sources carry
 *     `<conversationId>:turn:<n>`), most recent turn first;
 *   · facts        — the owner's current claims, most recently updated first.
 * Values are rendered as `subject | relation | value`; the user is "self".
 */
export async function extractionContext(ownerId, { conversationId = null, turn = null, conversationLimit = 8, factLimit = 30, pool = null } = {}) {
  const owner = requireOwner(ownerId);
  const p = await db(pool);
  const line = r => `${r.subject_type === 'self' ? 'self' : r.subject} | ${r.predicate} | ${r.value}${r.polarity === 'negated' ? ' (NOT)' : ''}`;
  const value = `COALESCE(oe.canonical_label, c.object_literal, c.object_quantity::text || COALESCE(' ' || c.object_unit, ''), c.object_time_from::text)`;

  let conversation = [];
  if (conversationId) {
    const prefix = `${conversationId}:turn:`;
    const { rows } = await p.query(`
      SELECT DISTINCT ON (c.claim_id) c.claim_id, se.canonical_label AS subject, se.type AS subject_type,
             c.predicate, ${value} AS value, c.polarity, s.external_ref
        FROM aqua_claims c
        JOIN aqua_entities se ON se.owner_id = c.owner_id AND se.entity_id = c.subject_entity_id
        LEFT JOIN aqua_entities oe ON oe.owner_id = c.owner_id AND oe.entity_id = c.object_entity_id
        JOIN aqua_claim_evidence ce ON ce.owner_id = c.owner_id AND ce.claim_id = c.claim_id
        JOIN aqua_evidence ev ON ev.owner_id = ce.owner_id AND ev.evidence_id = ce.evidence_id
        JOIN aqua_sources s ON s.owner_id = ev.owner_id AND s.source_id = ev.source_id
       WHERE c.owner_id = $1 AND left(s.external_ref, length($2)) = $2
         AND c.predicate <> 'unresolved' AND c.state <> 'archived'`, [owner, prefix]);
    const turnOf = r => Number.parseInt(String(r.external_ref).slice(prefix.length), 10);
    conversation = rows
      .filter(r => Number.isFinite(turnOf(r)) && (!Number.isInteger(turn) || turnOf(r) < turn))
      .sort((a, b) => turnOf(b) - turnOf(a))
      .slice(0, clampLimit(conversationLimit, 8))
      .map(line);
  }

  const { rows: facts } = await p.query(`
    SELECT se.canonical_label AS subject, se.type AS subject_type, c.predicate, ${value} AS value, c.polarity
      FROM aqua_claims c
      JOIN aqua_entities se ON se.owner_id = c.owner_id AND se.entity_id = c.subject_entity_id
      LEFT JOIN aqua_entities oe ON oe.owner_id = c.owner_id AND oe.entity_id = c.object_entity_id
     WHERE c.owner_id = $1 AND c.state = ANY($2::text[]) AND c.predicate <> 'unresolved'
     ORDER BY c.updated_at DESC, c.claim_id
     LIMIT $3`, [owner, CURRENT_STATES, clampLimit(factLimit, 30)]);
  return { conversation, facts: [...new Set(facts.map(line))] };
}
