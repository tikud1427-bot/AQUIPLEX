/**
 * AQUA Graph Type Registry — Brain V1 / B1
 *
 * WHY THIS EXISTS
 * ---------------
 * The reasoning graph shipped with two frozen vocabularies:
 *
 *   NODE_TYPES = ['entity','fact','event','file','topic']
 *   EDGE_TYPES = ['mentions','asserts',…,'related_to',…]
 *
 * …and `addEdge` threw on anything else. The Brain V1 brief requires the
 * opposite: "Do NOT hardcode relationship types. The graph must be
 * extensible." The frozen list also caused real, live semantic loss —
 * graphBuilder inferred `works_on` / `owns` / `located_in` / `affiliated_with`
 * and then had to flatten every one of them to `related_to`, demoting the
 * true type into a free-text `reason` prefix. Typed traversal, per-type
 * queries and relationship-distance scoring were all impossible as a result.
 *
 * HOW IT WORKS
 * ------------
 * A registry, not a list. Types are registered (seeded here, extended at
 * runtime by any layer) and carry metadata:
 *
 *   { type, class, symmetric, inverse, description, source }
 *
 * CLASSES are the back-compatibility mechanism. Every entity↔entity
 * relationship registers under the `related_to` class. A query for
 * `related_to` therefore still returns `works_on`, `depends_on`, … — so
 * existing consumers (queryEngine.explainEntity) keep working unchanged
 * while the graph starts storing the true type. Callers that want the
 * literal type only pass `{ exact: true }`.
 *
 * Structural edges (mentions/asserts/about/…) stay a closed, graph-owned
 * set: they encode the graph's own wiring, not user-world semantics.
 *
 * OPEN, NOT UNGUARDED
 * -------------------
 * Unknown EDGE types are auto-registered into the `related_to` class and
 * logged once — extensibility with an audit trail, no schema migration
 * needed for a new relationship kind. What is still rejected is a
 * malformed type NAME (`/^[a-z][a-z0-9_]{0,63}$/`), which keeps edge ids
 * clean and catches typos-as-garbage rather than silently interning them.
 * `AQUA_GRAPH_STRICT_TYPES=1` restores hard rejection for CI runs that want
 * the vocabulary pinned.
 *
 * Unknown NODE types are still rejected. Node types are structural classes
 * (an `entity` node vs a `fact` node), not user-world categories — a Person
 * / Project / Repository is an `entity` whose `data.entityType` says which.
 * Adding node classes is a deliberate act, so it goes through
 * registerNodeType() rather than happening by accident on a typo.
 *
 * Pure, zero-dependency, no I/O. Safe to import from any layer.
 */

// ── Type-name grammar ────────────────────────────────────────────────────────

/** Edge ids are `from|type|to`, so a type may never contain `|` or spaces. */
const TYPE_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export const EDGE_CLASS = Object.freeze({
  /** The graph's own wiring: file→fact, fact→entity, event→fact, … */
  STRUCTURAL: 'structural',
  /** User-world semantics between entities. The extensible class. */
  RELATED: 'related_to',
});

// ── Seed vocabularies ────────────────────────────────────────────────────────

/**
 * Structural edges — the graph's internal wiring. Closed set: these are
 * emitted by graphBuilder itself and mean something specific to traversal.
 */
const SEED_STRUCTURAL = [
  ['mentions',     { description: 'file → entity: the entity appears in the file' }],
  ['asserts',      { description: 'file → fact: the file states the fact' }],
  ['about',        { description: 'fact → entity: the fact concerns the entity' }],
  ['supports',     { description: 'evidence-backed fact → claim' }],
  ['occurs_at',    { description: 'event → timepoint' }],
  ['involves',     { description: 'event → entity' }],
  ['derived_from', { description: 'event → fact it was derived from' }],
  ['contradicts',  { description: 'fact ↔ fact: cross-file disagreement', symmetric: true }],
  ['same_as',      { description: 'entity merge record', symmetric: true }],
];

/**
 * Semantic relationships — entity ↔ entity, the user's actual world.
 * OPEN set: this is the seed, not the limit. Anything registered later (or
 * auto-registered on first use) joins the same class and is queryable
 * exactly like these.
 *
 * `related_to` is both a concrete type (the fallback when nothing more
 * specific is inferable) and the class name every specific type answers to.
 */
const SEED_RELATED = [
  // generic fallback
  ['related_to',      { description: 'unspecified association', symmetric: true }],
  // brief-specified vocabulary
  ['created_by',      { description: 'X was created by Y', inverse: 'created' }],
  ['belongs_to',      { description: 'X belongs to Y', inverse: 'owns' }],
  ['works_on',        { description: 'person → project/effort' }],
  ['depends_on',      { description: 'X requires Y', inverse: 'supports_dependency' }],
  ['implements',      { description: 'X is an implementation of Y' }],
  ['uses',            { description: 'X makes use of Y (tool, technology, service)' }],
  ['member_of',       { description: 'person → organization/team' }],
  ['friend_of',       { description: 'person ↔ person, social', symmetric: true }],
  ['parent_of',       { description: 'X is parent of Y', inverse: 'child_of' }],
  ['child_of',        { description: 'X is child of Y', inverse: 'parent_of' }],
  ['inspired_by',     { description: 'X drew from Y' }],
  ['blocks',          { description: 'X blocks progress on Y', inverse: 'blocked_by' }],
  // already inferred by relationshipEngine — previously flattened away
  ['affiliated_with', { description: 'person ↔ organization', symmetric: true }],
  ['associated_with', { description: 'person ↔ person, unspecified', symmetric: true }],
  ['owns',            { description: 'organization → project/asset', inverse: 'belongs_to' }],
  ['located_in',      { description: 'X is located in place Y' }],
];

const SEED_NODES = [
  ['entity', { description: 'a thing in the world; data.entityType carries the sub-kind' }],
  ['fact',   { description: 'a grounded observation extracted from a source' }],
  ['event',  { description: 'something that happened, with a timestamp' }],
  ['file',   { description: 'an ingested source object (UKO)' }],
  ['topic',  { description: 'a thematic cluster' }],
];

// ── Registry state ───────────────────────────────────────────────────────────

/** type → { type, class, symmetric, inverse, description, source } */
const edgeTypes = new Map();
/** type → { type, description, source } */
const nodeTypes = new Map();
/** Types auto-registered this process, so we log each exactly once. */
const autoLogged = new Set();

function seed() {
  edgeTypes.clear();
  nodeTypes.clear();
  autoLogged.clear();
  for (const [type, meta] of SEED_STRUCTURAL) define(type, { ...meta, class: EDGE_CLASS.STRUCTURAL, source: 'seed' });
  for (const [type, meta] of SEED_RELATED)    define(type, { ...meta, class: EDGE_CLASS.RELATED,    source: 'seed' });
  for (const [type, meta] of SEED_NODES)      nodeTypes.set(type, { type, ...meta, source: 'seed' });
}

function define(type, meta) {
  edgeTypes.set(type, {
    type,
    class: meta.class ?? EDGE_CLASS.RELATED,
    symmetric: meta.symmetric === true,
    inverse: meta.inverse ?? null,
    description: meta.description ?? '',
    source: meta.source ?? 'runtime',
  });
}

seed();

// ── Validation ───────────────────────────────────────────────────────────────

function strictMode() {
  return String(process.env.AQUA_GRAPH_STRICT_TYPES ?? '') === '1';
}

/** @throws if the name could never be a safe type (bad chars, empty, too long). */
function assertName(kind, type) {
  if (typeof type !== 'string' || !TYPE_NAME.test(type)) {
    throw new Error(`${kind} type "${type}" is malformed — expected /^[a-z][a-z0-9_]{0,63}$/`);
  }
}

// ── Public API — edges ───────────────────────────────────────────────────────

/**
 * Register (or refine) a relationship type. Idempotent: re-registering an
 * existing type merges metadata but never changes its class, so a caller
 * cannot reclassify a structural edge out from under the graph.
 *
 * @param {string} type
 * @param {object} [meta] - { class?, symmetric?, inverse?, description?, source? }
 * @returns {object} the registry record
 */
export function registerEdgeType(type, meta = {}) {
  assertName('edge', type);
  const existing = edgeTypes.get(type);
  if (existing) {
    edgeTypes.set(type, {
      ...existing,
      symmetric: meta.symmetric ?? existing.symmetric,
      inverse: meta.inverse ?? existing.inverse,
      description: meta.description || existing.description,
    });
    return edgeTypes.get(type);
  }
  define(type, { ...meta, class: meta.class ?? EDGE_CLASS.RELATED });
  return edgeTypes.get(type);
}

/**
 * Called by the graph on insert. Known type → passthrough. Unknown but
 * well-formed → auto-registered as a semantic relationship (logged once).
 * Malformed, or strict mode → throws.
 */
export function ensureEdgeType(type, { source = 'auto' } = {}) {
  assertName('edge', type);
  const known = edgeTypes.get(type);
  if (known) return known;
  if (strictMode()) throw new Error(`addEdge: unregistered edge type "${type}" (AQUA_GRAPH_STRICT_TYPES=1)`);
  define(type, { class: EDGE_CLASS.RELATED, source });
  if (!autoLogged.has(type)) {
    autoLogged.add(type);
    console.log(`[GRAPH] New relationship type registered: "${type}" (class=${EDGE_CLASS.RELATED}, source=${source})`);
  }
  return edgeTypes.get(type);
}

export function isKnownEdgeType(type) { return edgeTypes.has(type); }

export function edgeTypeMeta(type) { return edgeTypes.get(type) ?? null; }

/** @returns {string|null} the class of a type, or null if unregistered. */
export function edgeClassOf(type) { return edgeTypes.get(type)?.class ?? null; }

/** @returns {boolean} true when the type is an entity↔entity semantic relation. */
export function isSemanticEdgeType(type) { return edgeClassOf(type) === EDGE_CLASS.RELATED; }

export function listEdgeTypes({ cls = null } = {}) {
  const all = [...edgeTypes.values()];
  return cls ? all.filter(t => t.class === cls) : all;
}

/**
 * Resolve a query filter to the concrete set of edge types it should match.
 *
 * THE BACK-COMPAT RULE: asking for a class name returns every member of that
 * class. `{ type: 'related_to' }` matches `works_on`, `owns`, `depends_on`, …
 * so consumers written against the old flattened vocabulary keep working
 * against the new typed data. `{ exact: true }` opts out.
 *
 * @param {string|string[]|null} filter
 * @param {object} [opts] - { exact?: boolean }
 * @returns {Set<string>|null} null means "no filter"
 */
export function expandEdgeTypes(filter, { exact = false } = {}) {
  if (filter == null) return null;
  const wanted = Array.isArray(filter) ? filter : [filter];
  const out = new Set();
  for (const t of wanted) {
    if (typeof t !== 'string' || !t) continue;
    out.add(t);
    if (exact) continue;
    // A class name pulls in its whole membership.
    const isClassName = t === EDGE_CLASS.RELATED || t === EDGE_CLASS.STRUCTURAL;
    if (isClassName) for (const meta of edgeTypes.values()) if (meta.class === t) out.add(meta.type);
  }
  return out;
}

// ── Public API — nodes ───────────────────────────────────────────────────────

/**
 * Register a new node class. Deliberate by design — node classes are
 * structural (entity | fact | event | file | topic | …), not user-world
 * categories. B3 registers `conversation` and `goal` here when conversation
 * ingest lands.
 */
export function registerNodeType(type, meta = {}) {
  assertName('node', type);
  if (!nodeTypes.has(type)) nodeTypes.set(type, { type, description: meta.description ?? '', source: meta.source ?? 'runtime' });
  return nodeTypes.get(type);
}

export function isKnownNodeType(type) { return nodeTypes.has(type); }

export function listNodeTypes() { return [...nodeTypes.values()]; }

// ── Introspection / tests ────────────────────────────────────────────────────

export function registryStats() {
  const byClass = {};
  for (const t of edgeTypes.values()) byClass[t.class] = (byClass[t.class] ?? 0) + 1;
  return {
    edgeTypes: edgeTypes.size,
    nodeTypes: nodeTypes.size,
    byClass,
    autoRegistered: [...edgeTypes.values()].filter(t => t.source === 'auto').map(t => t.type),
  };
}

export function _resetRegistryForTests() { seed(); }
