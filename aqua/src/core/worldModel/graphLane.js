/**
 * AQUA — canonical graph lane (Blueprint E7/PR-4)
 *
 * The typed k-hop traversal over `aqua_edges` that Part 7 §7.5 lists as
 * "GRAPH — recursive CTE hop from anchor entities via edges". READ-ONLY: an
 * index over claims (an edge IS a materialised entity-to-entity claim), never
 * a second source of truth. This is NOT the legacy in-memory graph the PIC
 * lane walks; it reads the canonical Postgres substrate only.
 *
 * GUARANTEES (each one is a test in graphLane.test.js)
 *   G3 owner-first   `owner_id = $1` is in BOTH directions of the traversal
 *                    step, so it drives the (owner_id, from|to_entity_id,
 *                    state) index and a foreign owner's edges are never even
 *                    visited. Anchors that belong to someone else simply have
 *                    no edges under this owner — nothing leaks, nothing errors.
 *   G6 bounded       hops <= MAX_HOPS, per-node fanout <= MAX_FANOUT,
 *                    anchors <= MAX_ANCHORS, returned entities <= MAX_ENTITIES.
 *                    Callers can ask for less, never more. Worst-case rows
 *                    walked = anchors * fanout^hops = 8 * 12^3 = 13,824 —
 *                    bounded by construction, not by hoping the graph is small.
 *   lifecycle        superseded/archived/extracted edges are not walked by
 *                    default; an edge whose valid_to has passed is not walked
 *                    for a present-tense question. `retrospective: true` (the
 *                    same currency==='past' / negated cases the PIC lane and
 *                    the canonical dense lane already honour) walks superseded
 *                    edges and drops the validity window. Archived is never
 *                    walked. disputed/stale edges ARE walked and carry their
 *                    state back so the renderer can say so (L: disputed is
 *                    shown as disputed, not silently dropped).
 *   provenance       every returned entity carries the edge, the CLAIM that
 *                    edge projects, the predicate, the direction, the anchor it
 *                    was reached from and the full entity path.
 *   determinism      preferred edges: current before ended, newest first, then
 *                    edge_id. Same graph + same arguments = same rows, always.
 *   G1 fail-open     a DB error returns { ok:false, entities:[] } and a
 *                    structured log line. Retrieval degrades to its other
 *                    lanes; a broken graph lane never fails a turn. It does
 *                    NOT invent edges to compensate (truth fails closed).
 *   G5 observable    every call returns `stats` and logs one JSON line.
 *
 * Takes an injected `pool` (anything with .query) instead of importing the
 * shared pool, so this module stays a pure reader the caller wires up.
 */

export const MAX_HOPS = 3;
export const MAX_FANOUT = 12;
export const MAX_ANCHORS = 8;
export const MAX_ENTITIES = 200;

export const DEFAULT_HOPS = 2;
export const DEFAULT_FANOUT = 6;
export const DEFAULT_ENTITIES = 50;

/** Walked by default. superseded only with `retrospective`; archived never. */
export const CURRENT_STATES = Object.freeze(['active', 'trusted', 'disputed', 'stale']);
export const RETROSPECTIVE_STATES = Object.freeze([...CURRENT_STATES, 'superseded']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const clamp = (v, def, max) => {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(n, max);
};

/**
 * One SQL statement. $1 owner · $2 anchors uuid[] · $3 max hops · $4 fanout ·
 * $5 walkable states · $6 predicate filter (NULL = any) · $7 as-of instant
 * (NULL = no validity window) · $8 max entities.
 *
 * The cycle check sits BEFORE the LIMIT, so a neighbour already on the path
 * never spends a fanout slot. The recursive reference appears exactly once
 * (Postgres requires that), as the outer side of the LATERAL join.
 */
export const GRAPH_SQL = `
WITH RECURSIVE walk AS (
  SELECT a.id AS entity_id, 0 AS hop, ARRAY[a.id] AS path, a.id AS anchor_id,
         NULL::uuid AS edge_id, NULL::uuid AS claim_id, NULL::text AS predicate,
         NULL::text AS direction, NULL::text AS edge_state
  FROM unnest($2::uuid[]) AS a(id)
  UNION ALL
  SELECT s.next_id, w.hop + 1, w.path || s.next_id, w.anchor_id,
         s.edge_id, s.claim_id, s.predicate, s.direction, s.state
  FROM walk w
  CROSS JOIN LATERAL (
    SELECT x.*
    FROM (
      SELECT e.to_entity_id AS next_id, e.edge_id, e.claim_id, e.predicate,
             'out'::text AS direction, e.state, e.valid_to, e.updated_at
      FROM aqua_edges e
      WHERE e.owner_id = $1 AND e.from_entity_id = w.entity_id
        AND e.state = ANY($5::text[])
        AND ($6::text[] IS NULL OR e.predicate = ANY($6::text[]))
        AND ($7::timestamptz IS NULL OR e.valid_to IS NULL OR e.valid_to > $7::timestamptz)
      UNION ALL
      SELECT e.from_entity_id AS next_id, e.edge_id, e.claim_id, e.predicate,
             'in'::text AS direction, e.state, e.valid_to, e.updated_at
      FROM aqua_edges e
      WHERE e.owner_id = $1 AND e.to_entity_id = w.entity_id
        AND e.state = ANY($5::text[])
        AND ($6::text[] IS NULL OR e.predicate = ANY($6::text[]))
        AND ($7::timestamptz IS NULL OR e.valid_to IS NULL OR e.valid_to > $7::timestamptz)
    ) x
    WHERE NOT (x.next_id = ANY(w.path))
    ORDER BY (x.valid_to IS NOT NULL), x.updated_at DESC, x.edge_id
    LIMIT $4::int
  ) s
  WHERE w.hop < $3::int
)
SELECT entity_id, hop, anchor_id, edge_id, claim_id, predicate, direction, edge_state, path
FROM (
  SELECT DISTINCT ON (entity_id)
         entity_id, hop, anchor_id, edge_id, claim_id, predicate, direction, edge_state, path
  FROM walk
  WHERE hop > 0
  ORDER BY entity_id, hop, edge_id
) best
ORDER BY hop, entity_id
LIMIT $8::int`;

/**
 * @param {{query:Function}} pool
 * @param {string} ownerId
 * @param {string[]} anchorEntityIds opaque entity ids (uuid) — never labels (L8)
 * @param {object} [opts]
 * @param {number} [opts.maxHops]      default 2, hard cap 3
 * @param {number} [opts.fanout]       default 6, hard cap 12, per node per hop
 * @param {number} [opts.maxEntities]  default 50, hard cap 200
 * @param {string[]} [opts.predicates] typed hop: only these predicates
 * @param {boolean} [opts.retrospective] walk superseded edges, no validity window
 * @param {Date|string} [opts.asOf]    present-tense instant (default: now)
 * @param {(line:string)=>void} [opts.log]
 * @returns {Promise<{ok:boolean, entities:object[], stats:object, reason?:string}>}
 */
export async function traverseGraph(pool, ownerId, anchorEntityIds, opts = {}) {
  const started = Date.now();
  const log = opts.log ?? ((l) => console.log(l));
  const maxHops = clamp(opts.maxHops, DEFAULT_HOPS, MAX_HOPS);
  const fanout = clamp(opts.fanout, DEFAULT_FANOUT, MAX_FANOUT);
  const maxEntities = clamp(opts.maxEntities, DEFAULT_ENTITIES, MAX_ENTITIES);
  const retrospective = opts.retrospective === true;

  const done = (ok, entities, extra = {}) => {
    const stats = {
      ok, anchors: extra.anchors ?? 0, maxHops, fanout, maxEntities, retrospective,
      returned: entities.length, capped: entities.length >= maxEntities,
      ms: Date.now() - started, ...(extra.reason ? { reason: extra.reason } : {}),
    };
    // Structured, PII-free: no owner id, no entity ids, no labels.
    log(`[GRAPH_LANE] ${JSON.stringify(stats)}`);
    return { ok, entities, stats, ...(extra.reason ? { reason: extra.reason } : {}) };
  };

  if (!ownerId) return done(false, [], { reason: 'owner_required' });

  const anchors = [...new Set((Array.isArray(anchorEntityIds) ? anchorEntityIds : [])
    .filter(id => typeof id === 'string' && UUID_RE.test(id)))]
    .sort()
    .slice(0, MAX_ANCHORS);
  if (!anchors.length) return done(true, [], { anchors: 0, reason: 'no_valid_anchor' });

  const predicates = Array.isArray(opts.predicates) && opts.predicates.length
    ? opts.predicates.filter(p => typeof p === 'string' && p).slice(0, 32) : null;
  const asOf = retrospective ? null : new Date(opts.asOf ?? Date.now()).toISOString();

  try {
    const { rows } = await pool.query(GRAPH_SQL, [
      ownerId, anchors, maxHops, fanout,
      retrospective ? RETROSPECTIVE_STATES : CURRENT_STATES,
      predicates, asOf, maxEntities,
    ]);
    const entities = rows.map(r => ({
      entityId: r.entity_id,
      hop: Number(r.hop),
      anchorId: r.anchor_id,
      viaEdgeId: r.edge_id,
      viaClaimId: r.claim_id,
      predicate: r.predicate,
      direction: r.direction,
      state: r.edge_state,
      path: r.path,
    }));
    return done(true, entities, { anchors: anchors.length });
  } catch (err) {
    return done(false, [], { anchors: anchors.length, reason: `query_failed: ${String(err?.message ?? err).slice(0, 120)}` });
  }
}
