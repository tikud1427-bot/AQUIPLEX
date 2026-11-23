/**
 * AQUA Reasoning Graph — Cross-File Reasoning (Phase 3) + Brain V1 / B1
 *
 * The Unified Reasoning Graph: one connected knowledge space where every
 * node (entity, fact, event, file, topic) links to every other through
 * typed, provenance-bearing edges. After ingestion the user asks about
 * INFORMATION, not files — this graph is what "information, not files"
 * means concretely.
 *
 * Node types:  entity | fact | event | file | topic   (extend: registerNodeType)
 * Edge types:  OPEN. Two classes, owned by ./typeRegistry.js —
 *              structural  the graph's own wiring: mentions (file→entity),
 *                          asserts (file→fact), about (fact→entity),
 *                          supports, occurs_at, involves, derived_from,
 *                          contradicts, same_as
 *              related_to  entity↔entity semantics: works_on, depends_on,
 *                          implements, uses, member_of, owns, … and anything
 *                          registered later. Not a fixed list.
 *
 * BRAIN V1 / B1 — WHAT CHANGED AND WHY
 * ------------------------------------
 * Edge types were a frozen array and addEdge threw on anything outside it.
 * The consequence was live semantic loss: graphBuilder inferred `works_on`,
 * `owns`, `affiliated_with`, `located_in` and then had to flatten all of
 * them to `related_to`, moving the true type into a free-text `reason`
 * prefix where nothing could query it. Three things changed:
 *
 *   1. Types come from a registry, not a literal. Unknown relationship
 *      types auto-register (logged once) instead of throwing — the brief's
 *      "do not hardcode relationship types" requirement. Malformed type
 *      NAMES are still rejected, so edge ids stay clean.
 *   2. Queries expand by CLASS. `edgesOf(…, { type: 'related_to' })` still
 *      returns `works_on`/`owns`/…, so every existing consumer keeps working
 *      against the newly-typed data with no change. `{ exact: true }` opts
 *      out.
 *   3. Legacy `related_to` edges self-heal. On load, an edge whose reason
 *      reads "works_on: co-mentioned in…" is rewritten to its true type; on
 *      re-insert, a generic edge is upgraded in place when a specific type
 *      arrives. No rebuild required, no duplicate edges (edge ids from
 *      graphBuilder are type-independent).
 *
 * THE REASONING CONTRACT is enforced structurally and is unchanged: no edge
 * exists without provenance. Every edge carries { confidence, evidence:
 * [evidenceId…], sourceFiles: [ukoId…], reason }. An edge with empty
 * provenance is rejected at insert. And every node/edge is tagged with an
 * epistemic `kind` — observed | derived | hypothesis | speculation — so the
 * query layer can keep them from ever mixing.
 *
 * Incremental by construction: addFile() merges a file's contribution into
 * the existing graph without a rebuild; removeFile() detaches exactly that
 * file's contribution. Per-owner, persisted through the standard
 * atomicStore + dataDir primitives, bounded, schema-versioned.
 */
import {
  createDebouncedWriter, loadJsonFile, wrapStore, unwrapStore,
} from '../core/atomicStore.js';
import { dataPath } from '../core/dataDir.js';
import { bindOwnerStore } from '../core/storage/ownerBinding.js';
import { isExternalFileId } from '../files/externalIdentity.js';
import {
  EDGE_CLASS, ensureEdgeType, isKnownEdgeType, isKnownNodeType,
  edgeClassOf, expandEdgeTypes, listEdgeTypes, listNodeTypes,
} from './typeRegistry.js';

const STORE_FILE = dataPath('.aqua-reasoning-graph.json');
const SCHEMA     = 3;   // v3: relationship evolution — lastConfirmedAt, history, observations

/**
 * Back-compat snapshots of the SEED vocabularies, taken at import time.
 * These are no longer the limit — use listEdgeTypes()/listNodeTypes() from
 * ./typeRegistry.js for the live set. Kept exported so nothing that imported
 * them breaks.
 */
export const NODE_TYPES = Object.freeze(listNodeTypes().map(t => t.type));
export const EDGE_TYPES = Object.freeze(listEdgeTypes().map(t => t.type));
export const EPISTEMIC  = Object.freeze(['observed', 'derived', 'hypothesis', 'speculation']);

export { EDGE_CLASS };

const MAX_NODES_PER_OWNER = 50_000;

/** ownerKey → { nodes: Map<id,node>, edges: Map<edgeId,edge>, byFile: Map<ukoId,{nodes:Set,edges:Set}>, adj: Map<nodeId,Set<edgeId>> } */
const store = new Map();

function graph(ownerId) {
  const key = ownerId ?? 'anon';
  let g = store.get(key);
  if (!g) { g = { nodes: new Map(), edges: new Map(), byFile: new Map(), adj: new Map() }; store.set(key, g); }
  return g;
}

// ── Legacy migration (B1) ────────────────────────────────────────────────────

/**
 * Pre-B1, graphBuilder flattened every inferred relationship to `related_to`
 * and prefixed the true type onto the reason string:
 *
 *   { type: 'related_to', reason: 'works_on: co-mentioned in 3 fact(s)…' }
 *
 * Recover the type on load. Conservative by design: only a `related_to`
 * edge, only a prefix that is a REGISTERED semantic type, and the reason
 * loses just the prefix. Anything else is left exactly as found.
 */
const LEGACY_REASON = /^([a-z][a-z0-9_]{0,63}):\s+/;

function migrateLegacyEdge(edge) {
  if (!edge || edge.type !== 'related_to' || typeof edge.reason !== 'string') return edge;
  const m = LEGACY_REASON.exec(edge.reason);
  if (!m) return edge;
  const recovered = m[1];
  if (recovered === 'related_to') return edge;
  if (!isKnownEdgeType(recovered) || edgeClassOf(recovered) !== EDGE_CLASS.RELATED) return edge;
  return { ...edge, type: recovered, reason: edge.reason.slice(m[0].length), migratedFrom: 'related_to' };
}


// ── Relationship evolution (Phase 3 / audit W4) ──────────────────────────────

/**
 * Confidence merging is FLAGGED; everything else in this section is not.
 *
 * `lastConfirmedAt`, `observations` and `history` are pure metadata — they
 * add information without changing any decision, so they ship unflagged. The
 * confidence FORMULA is different: it feeds retrieval ranking, so changing it
 * changes answers, and it gets its own switch.
 *
 * Off (default): `Math.max`, exactly as before. On: corroboration-weighted.
 */
const relEvolveEnabled = () => process.env.AQUA_REL_EVOLVE === 'on';

/** Bounded — an edge re-asserted thousands of times must not grow forever. */
const MAX_EDGE_HISTORY = 20;

/**
 * Corroboration-weighted confidence.
 *
 * `Math.max` treats one enthusiastic source as final: an edge asserted once at
 * 0.95 and then contradicted at 0.2 by ten later documents still reads 0.95.
 * A running mean weighted by observation count lets the aggregate move toward
 * what the evidence actually says, while a single strong observation still
 * dominates a single weak one.
 *
 * The result is deliberately NOT allowed below `MIN_MERGED` — a relationship
 * that real provenance supports should decay toward uncertainty, never to
 * zero, because zero reads as "known false" and nothing here establishes that.
 */
const MIN_MERGED = 0.05;

function mergeConfidence(existing, incoming, observations) {
  const prior = existing.confidence ?? 0.5;
  const n = Math.max(2, observations);
  const merged = prior + (incoming - prior) / n;
  return round3(Math.max(MIN_MERGED, Math.min(1, merged)));
}

/**
 * Append only when the value actually moved — re-confirmations that change
 * nothing would otherwise flood the ring and push out the real transitions.
 */
function appendHistory(history, before, after, at, observations) {
  const h = Array.isArray(history) ? history : [];
  if (round3(before) === round3(after)) return h;
  return [...h, { at, from: round3(before), to: round3(after), observations }].slice(-MAX_EDGE_HISTORY);
}

/**
 * Staleness-adjusted confidence — DERIVED, never stored.
 *
 * Storing a decayed value would mean the number changes whenever the file is
 * loaded, making history meaningless and writes non-idempotent. Callers that
 * care about recency ask for it; the stored value stays a faithful record of
 * what the evidence said.
 *
 * Opt-in: with no options this is the identity function.
 */
export function effectiveConfidence(edge, { now = Date.now(), halfLifeDays = null } = {}) {
  const base = edge?.confidence ?? 0;
  if (!halfLifeDays || !edge?.lastConfirmedAt) return base;
  const ageDays = (now - edge.lastConfirmedAt) / 86_400_000;
  if (ageDays <= 0) return base;
  return round3(base * Math.pow(0.5, ageDays / halfLifeDays));
}

const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * v2 → v3 self-heal. Same shape as the v1 → v2 related_to recovery: applied on
 * load, additive, never a rebuild. An edge written before this phase has no
 * confirmation history, so its creation IS its only confirmation.
 */
function migrateEdgeV3(edge) {
  if (!edge || edge.lastConfirmedAt) return edge;
  return {
    ...edge,
    peakConfidence: edge.peakConfidence ?? edge.confidence,
    observations: edge.observations ?? 1,
    lastConfirmedAt: edge.createdAt ?? Date.now(),
    history: Array.isArray(edge.history) ? edge.history : [],
  };
}

// ── Persistence ──────────────────────────────────────────────────────────────

function loadFromDisk() {
  const parsed = loadJsonFile(STORE_FILE, { label: 'reasoning-graph' });
  if (parsed == null) return;
  const { data } = unwrapStore(parsed, { expected: SCHEMA, file: STORE_FILE, label: 'reasoning-graph' });
  if (!data || typeof data !== 'object') return;
  let migrated = 0;
  let migratedV3 = 0;
  for (const [owner, g] of Object.entries(data)) {
    const gr = graph(owner);
    for (const n of Object.values(g.nodes ?? {})) gr.nodes.set(n.id, n);
    for (const raw of Object.values(g.edges ?? {})) {
      const legacy = migrateLegacyEdge(raw);
      const e = migrateEdgeV3(legacy);
      if (legacy !== raw) migrated++;
      if (e !== legacy) migratedV3++;
      gr.edges.set(e.id, e); indexEdge(gr, e);
    }
    for (const [file, links] of Object.entries(g.byFile ?? {})) {
      gr.byFile.set(file, { nodes: new Set(links.nodes ?? []), edges: new Set(links.edges ?? []) });
    }
  }
  const totals = [...store.values()].reduce((a, g) => ({ n: a.n + g.nodes.size, e: a.e + g.edges.size }), { n: 0, e: 0 });
  if (totals.n) console.log(`[REASONING] Graph loaded: ${totals.n} node(s), ${totals.e} edge(s) across ${store.size} owner(s) from ${STORE_FILE}`);
  if (migrated) {
    console.log(`[GRAPH] B1 migration: ${migrated} legacy related_to edge(s) recovered to their true relationship type`);
  }
  if (migratedV3) {
    console.log(`[GRAPH] v3 migration: ${migratedV3} edge(s) given confirmation history (lastConfirmedAt = createdAt)`);
  }
  if (migrated || migratedV3) for (const owner of store.keys()) scheduleSave(owner);
}

const _writer = createDebouncedWriter(STORE_FILE);
function scheduleSave(ownerId = null) {
  if (ownerId) binding.markDirty(ownerId);
  if (!binding.writesWholeJson()) return;
  _writer.schedule(() => {
    const data = {};
    for (const [owner, g] of store.entries()) data[owner] = encodeGraph(g);
    return JSON.stringify(wrapStore(SCHEMA, data));
  });
}

// ── Per-owner persistence (scalability Phase 2b, step 4) ─────────────────────
// WRITERS: the server (file enrichment, conversation ingest, reflection) AND
// the worker (understandTurn → ensureSelfEntity → upsertNode). Audit finding S6:
// on the whole-file path the two overwrite each other.
// MERGE, per owner graph, order-independent:
//   nodes  union by id; one in both → data shallow-merged, sourceFiles unioned
//   edges  union by id; one in both → confidence/peak/observations/
//          lastConfirmedAt = max, evidence + sourceFiles unioned, history merged
//          by time (capped at MAX_EDGE_HISTORY), type upgraded only per isTypeUpgrade
//   byFile union per file
// DELETION: removeFile is recorded as a file tombstone (`removedFiles`) that
// travels with the graph, so the other process's copy cannot bring that file's
// nodes and edges back through the union. Account purge → row tombstone.
// `removedFiles` is only written while partitions are on (off: unchanged file).
const MAX_REMOVED_FILES = 500;

function encodeGraph(g) {
  const out = {
    nodes: Object.fromEntries(g.nodes),
    edges: Object.fromEntries(g.edges),
    byFile: Object.fromEntries([...g.byFile].map(([k, v]) => [k, v.at ? { nodes: [...v.nodes], edges: [...v.edges], at: v.at } : { nodes: [...v.nodes], edges: [...v.edges] }])),
  };
  if (g.removedFiles?.size) out.removedFiles = Object.fromEntries(g.removedFiles);
  return out;
}

function decodeGraph(obj) {
  const g = { nodes: new Map(), edges: new Map(), byFile: new Map(), adj: new Map() };
  for (const n of Object.values(obj?.nodes ?? {})) g.nodes.set(n.id, n);
  for (const e of Object.values(obj?.edges ?? {})) { g.edges.set(e.id, e); indexEdge(g, e); }
  for (const [file, links] of Object.entries(obj?.byFile ?? {})) {
    const l = { nodes: new Set(links.nodes ?? []), edges: new Set(links.edges ?? []) };
    if (links.at) l.at = links.at;
    g.byFile.set(file, l);
  }
  if (obj?.removedFiles) g.removedFiles = new Map(Object.entries(obj.removedFiles));
  return g;
}

const union = (a = [], b = []) => [...new Set([...a, ...b])];

function mergeEdge(t, o) {
  const history = [...(t.history ?? []), ...(o.history ?? [])]
    .filter((h, i, arr) => arr.findIndex(x => JSON.stringify(x) === JSON.stringify(h)) === i)
    .sort((x, y) => (Number(x?.at) || 0) - (Number(y?.at) || 0))
    .slice(-MAX_EDGE_HISTORY);
  const type = isTypeUpgrade(t.type, o.type) ? o.type : isTypeUpgrade(o.type, t.type) ? t.type : o.type;
  return {
    ...t, ...o,
    type,
    reason: type === o.type ? o.reason : t.reason,
    confidence: Math.max(Number(t.confidence) || 0, Number(o.confidence) || 0),
    peakConfidence: Math.max(Number(t.peakConfidence ?? t.confidence) || 0, Number(o.peakConfidence ?? o.confidence) || 0),
    observations: Math.max(Number(t.observations) || 1, Number(o.observations) || 1),
    lastConfirmedAt: Math.max(Number(t.lastConfirmedAt) || 0, Number(o.lastConfirmedAt) || 0) || undefined,
    evidence: union(t.evidence, o.evidence),
    sourceFiles: union(t.sourceFiles, o.sourceFiles),
    ...(history.length ? { history } : {}),
  };
}

/**
 * `ctx.allowExternalAdditions === false` (a partition flush WITHOUT a valid
 * connect fence, Safety Fix 2), for EXTERNAL files (ext_… ids):
 *   · a removed external file is never re-linked (whatever the link's time);
 *   · an external file link the database copy does not hold is not written
 *     (a deletion there wins; an addition needs a connect fence);
 *   · node/edge provenance (sourceFiles) citing such a file is dropped;
 *   · (Safety Fix 3) an external file link the database copy DOES hold, and a
 *     node/edge whose provenance is external only, keep the database's version
 *     (no unfenced update); an external-only node/edge the database does not
 *     hold is not written (no unfenced addition).
 * Without ctx (or with a fence) the merge is exactly as before.
 */
export function mergeGraphs(ours, theirs, ctx = {}) {
  const removed = { ...(theirs.removedFiles ?? {}) };
  for (const [f, at] of Object.entries(ours.removedFiles ?? {})) removed[f] = Math.max(Number(removed[f]) || 0, Number(at) || 0);
  const unfenced = ctx.allowExternalAdditions === false;
  const refusedExternal = new Set();
  if (unfenced) {
    for (const f of Object.keys(removed)) if (isExternalFileId(f)) refusedExternal.add(f);
    for (const f of Object.keys(ours.byFile ?? {})) {
      if (isExternalFileId(f) && !Object.prototype.hasOwnProperty.call(theirs.byFile ?? {}, f)) refusedExternal.add(f);
    }
  }
  // A file link survives a removal only if it was made AFTER it (re-linked).
  // Symmetric: whichever side still holds a pre-removal link, it is dropped.
  const keepLink = (f, l) => !refusedExternal.has(f) && (!removed[f] || (Number(l?.at) || 0) > removed[f]);
  const cleanSources = x => (refusedExternal.size && Array.isArray(x?.sourceFiles) && x.sourceFiles.some(id => refusedExternal.has(id))
    ? { ...x, sourceFiles: x.sourceFiles.filter(id => !refusedExternal.has(id)) } : x);
  // Unfenced: OUR version of an external link the database holds is ignored (theirs stands).
  const ignoredOurs = f => unfenced && isExternalFileId(f) && Object.prototype.hasOwnProperty.call(theirs.byFile ?? {}, f);
  const externalOnly = x => Array.isArray(x?.sourceFiles) && x.sourceFiles.length > 0 && x.sourceFiles.every(id => isExternalFileId(id));
  const dropNodes = new Set();
  const dropEdges = new Set();
  const keptNodes = new Set();
  const keptEdges = new Set();
  for (const side of [ours, theirs]) {
    for (const [f, l] of Object.entries(side.byFile ?? {})) {
      if (side === ours && ignoredOurs(f)) continue;
      const into = keepLink(f, l) ? [keptNodes, keptEdges] : [dropNodes, dropEdges];
      for (const n of l.nodes ?? []) into[0].add(n);
      for (const e of l.edges ?? []) into[1].add(e);
    }
  }
  const goneNode = id => dropNodes.has(id) && !keptNodes.has(id);
  const goneEdge = id => dropEdges.has(id) && !keptEdges.has(id);
  const nodes = {};
  for (const [id, n] of Object.entries(theirs.nodes ?? {})) if (!goneNode(id)) nodes[id] = n;
  for (const [id, o] of Object.entries(ours.nodes ?? {})) {
    if (goneNode(id)) continue;
    const t = nodes[id];
    if (unfenced && (t ? externalOnly(t) : externalOnly(o))) continue;   // external-only: the database's version / no addition
    nodes[id] = t ? { ...t, ...o, data: { ...(t.data ?? {}), ...(o.data ?? {}) }, sourceFiles: union(t.sourceFiles, o.sourceFiles) } : o;
  }
  const edges = {};
  for (const [id, e] of Object.entries(theirs.edges ?? {})) if (!goneEdge(id)) edges[id] = e;
  for (const [id, o] of Object.entries(ours.edges ?? {})) {
    if (goneEdge(id)) continue;
    if (unfenced && (edges[id] ? externalOnly(edges[id]) : externalOnly(o))) continue;
    edges[id] = edges[id] ? mergeEdge(edges[id], o) : o;
  }
  const byFile = {};
  for (const side of [theirs, ours]) {
    for (const [f, l] of Object.entries(side.byFile ?? {})) {
      if (!keepLink(f, l)) continue;
      if (side === ours && ignoredOurs(f)) continue;
      const cur = byFile[f] ?? { nodes: [], edges: [] };
      byFile[f] = { nodes: union(cur.nodes, l.nodes).filter(id => nodes[id]), edges: union(cur.edges, l.edges).filter(id => edges[id]) };
      const at = Math.max(Number(cur.at) || 0, Number(l.at) || 0);
      if (at) byFile[f].at = at;
    }
  }
  if (refusedExternal.size) {
    for (const [id, n] of Object.entries(nodes)) nodes[id] = cleanSources(n);
    for (const [id, e] of Object.entries(edges)) edges[id] = cleanSources(e);
  }
  const out = { nodes, edges, byFile };
  const kept = Object.entries(removed).sort((a, b) => b[1] - a[1]).slice(0, MAX_REMOVED_FILES);
  if (kept.length) out.removedFiles = Object.fromEntries(kept);
  return out;
}

const graphChangedAt = obj => Math.max(0,
  ...Object.values(obj?.nodes ?? {}).map(n => Number(n?.updatedAt ?? n?.createdAt) || 0),
  ...Object.values(obj?.edges ?? {}).map(e => Number(e?.lastConfirmedAt ?? e?.createdAt) || 0),
  ...Object.values(obj?.removedFiles ?? {}).map(Number));

const binding = bindOwnerStore({
  storeKey: '.aqua-reasoning-graph.json',
  file: STORE_FILE,
  label: 'reasoning-graph',
  schema: SCHEMA,
  encode: owner => { const g = store.get(owner); return g ? encodeGraph(g) : undefined; },
  decode: decodeGraph,
  install: (owner, g) => { if (g) store.set(owner, g); else store.delete(owner); },
  merge: mergeGraphs,
  externalAware: true,      // Safety Fix 3: the merge also guards first writes (no row) of external file links
  changedAt: graphChangedAt,
  // After an account purge: only what was created or confirmed after it.
  pruneBefore: (obj, at) => {
    for (const [id, n] of Object.entries(obj.nodes ?? {})) if ((Number(n?.createdAt) || 0) < at) delete obj.nodes[id];
    for (const [id, e] of Object.entries(obj.edges ?? {})) if ((Number(e?.lastConfirmedAt ?? e?.createdAt) || 0) < at) delete obj.edges[id];
    for (const l of Object.values(obj.byFile ?? {})) {
      l.nodes = (l.nodes ?? []).filter(id => obj.nodes[id]);
      l.edges = (l.edges ?? []).filter(id => obj.edges[id]);
    }
    delete obj.removedFiles;
    return Object.keys(obj.nodes ?? {}).length || Object.keys(obj.edges ?? {}).length ? obj : null;
  },
  evict: owner => store.delete(owner),
  reloadJson: () => loadFromDisk(),
});
export function graphPartitionBinding() { return binding; }
export function graphOwnerReady(ownerId) { return !ownerId || binding.ready(ownerId); }

if (binding.loadsJsonAtBoot()) loadFromDisk();

function indexEdge(g, edge) {
  for (const nid of [edge.from, edge.to]) {
    if (!g.adj.has(nid)) g.adj.set(nid, new Set());
    g.adj.get(nid).add(edge.id);
  }
}

// ── Node / edge insertion (provenance enforced) ──────────────────────────────

/**
 * Upsert a node. Merges label/aliases/provenance; never duplicates by id.
 *
 * Node types remain validated against the registry: a node type is a
 * STRUCTURAL class (entity vs fact vs event), not a user-world category —
 * a Person / Project / Repository is an `entity` whose data.entityType says
 * which. New classes are added deliberately via registerNodeType(), so a
 * typo here is still an error rather than a silently interned new class.
 *
 * @param {object} node - { id, type, label, kind?, data?, sourceFiles?[] }
 */
export function upsertNode(ownerId, node, { fileId = null } = {}) {
  if (!isKnownNodeType(node.type)) throw new Error(`upsertNode: bad type ${node.type}`);
  if (!node.id) throw new Error('upsertNode: id required');
  const g = graph(ownerId);
  if (g.nodes.size >= MAX_NODES_PER_OWNER && !g.nodes.has(node.id)) return g.nodes.get(node.id) ?? null;

  const existing = g.nodes.get(node.id);
  const merged = existing ? {
    ...existing,
    label: node.label ?? existing.label,
    data: { ...existing.data, ...node.data },
    sourceFiles: [...new Set([...(existing.sourceFiles ?? []), ...(node.sourceFiles ?? [])])],
  } : {
    id: node.id, type: node.type, label: node.label ?? node.id,
    kind: node.kind ?? (node.type === 'fact' ? 'observed' : 'derived'),
    data: node.data ?? {}, sourceFiles: node.sourceFiles ?? [], createdAt: Date.now(),
  };
  g.nodes.set(node.id, merged);
  if (fileId) linkFile(g, fileId).nodes.add(node.id);
  scheduleSave(ownerId ?? 'anon');
  return merged;
}

/**
 * Is `incoming` a strictly more specific relationship type than `current`?
 * Only the generic `related_to` is ever upgraded, and only to another member
 * of its own class — a structural edge is never silently reclassified.
 */
function isTypeUpgrade(current, incoming) {
  return current === 'related_to'
    && incoming !== 'related_to'
    && edgeClassOf(incoming) === EDGE_CLASS.RELATED;
}

/**
 * Add a provenance-bearing edge. REJECTS edges without provenance — the
 * reasoning contract has teeth.
 *
 * The type is registered on the way in (B1): a type nobody has used before
 * joins the `related_to` class and is logged once, rather than throwing.
 * Set AQUA_GRAPH_STRICT_TYPES=1 to pin the vocabulary instead.
 *
 * @param {object} edge - { from, to, type, kind?, confidence, evidence?[], sourceFiles[], reason }
 */
export function addEdge(ownerId, edge, { fileId = null } = {}) {
  ensureEdgeType(edge.type);
  const sourceFiles = edge.sourceFiles ?? [];
  const evidence    = edge.evidence ?? [];
  if (!sourceFiles.length && !evidence.length) {
    throw new Error(`addEdge: edge ${edge.type} has no provenance (evidence or sourceFiles required) — reasoning contract violation`);
  }
  const g = graph(ownerId);
  const id = edge.id ?? `${edge.from}|${edge.type}|${edge.to}`;
  const existing = g.edges.get(id);
  const now = Date.now();
  const incoming = edge.confidence ?? (existing ? 0 : 0.5);

  let rec;
  if (existing) {
    const observations = (existing.observations ?? 1) + 1;
    const peak = Math.max(existing.peakConfidence ?? existing.confidence, incoming);
    const confidence = relEvolveEnabled()
      ? mergeConfidence(existing, incoming, observations)
      : Math.max(existing.confidence, incoming);

    rec = {
      ...existing,
      // Type upgrade: a stored generic edge takes the specific type when one
      // finally arrives (callers that pin an explicit `id` — graphBuilder does
      // — would otherwise keep the pre-B1 type forever).
      type: isTypeUpgrade(existing.type, edge.type) ? edge.type : existing.type,
      reason: isTypeUpgrade(existing.type, edge.type) ? (edge.reason ?? existing.reason) : existing.reason,
      confidence,
      peakConfidence: peak,
      evidence: [...new Set([...existing.evidence, ...evidence])],
      sourceFiles: [...new Set([...existing.sourceFiles, ...sourceFiles])],
      // A relationship that keeps being re-asserted is not the same as one
      // asserted once and never seen again. Without this, an edge contradicted
      // by every later document keeps its peak forever (audit W4).
      observations,
      lastConfirmedAt: now,
      history: appendHistory(existing.history, existing.confidence, confidence, now, observations),
    };
  } else {
    rec = {
      id, from: edge.from, to: edge.to, type: edge.type,
      kind: edge.kind ?? 'derived',
      confidence: incoming,
      peakConfidence: incoming,
      evidence, sourceFiles,
      reason: edge.reason ?? edge.type,
      observations: 1,
      createdAt: now,
      lastConfirmedAt: now,
      history: [],
    };
  }
  g.edges.set(id, rec);
  indexEdge(g, rec);
  if (fileId) linkFile(g, fileId).edges.add(id);
  scheduleSave(ownerId ?? 'anon');
  return rec;
}

function linkFile(g, fileId) {
  let l = g.byFile.get(fileId);
  if (!l) {
    l = { nodes: new Set(), edges: new Set() };
    // Partitions on: when the link was made, so a removal can tell a re-link from a stale copy.
    if (binding.mode !== 'off') l.at = Date.now();
    g.byFile.set(fileId, l);
    g.removedFiles?.delete(fileId);
  }
  return l;
}

// ── Query surface (traversal; reasoning layers build on this) ────────────────

export function getNode(ownerId, id) { return graph(ownerId).nodes.get(id) ?? null; }

export function nodesByType(ownerId, type) {
  return [...graph(ownerId).nodes.values()].filter(n => n.type === type);
}

/**
 * Edges touching a node, optionally filtered by type.
 *
 * `type` may be a concrete type, a list, or a CLASS name. Passing the class
 * `related_to` matches every semantic relationship (works_on, owns, …) —
 * which is exactly what pre-B1 callers meant when they asked for
 * `related_to`, so they keep working unchanged against typed data.
 *
 * @param {object} [opts] - { type?: string|string[], exact?: boolean }
 */
/**
 * How many edges the last lookups INSPECTED.
 *
 * Exported for the "indexed, not a scan" test. That test previously asserted
 * `queryMs < 200`, which could never fail: `Date.now()` has millisecond
 * resolution and an indexed lookup is sub-millisecond, so it read `0 < 200`.
 * A full scan of the same graph would also have passed comfortably — the
 * assertion could not detect the regression its own message named.
 *
 * An inspection count is exact and load-independent: indexed means it equals
 * the node's DEGREE, a scan means it equals the graph's TOTAL edges. Same
 * instrument as the contradiction pass's comparison counter, for the same
 * reason.
 */
let edgesInspected = 0;
export function _edgesInspectedForTests() { return edgesInspected; }
export function _resetEdgesInspectedForTests() { edgesInspected = 0; }

export function edgesOf(ownerId, nodeId, { type = null, exact = false } = {}) {
  const g = graph(ownerId);
  const want = expandEdgeTypes(type, { exact });
  const ids = g.adj.get(nodeId) ?? [];
  edgesInspected += ids.size ?? ids.length ?? 0;
  return [...ids]
    .map(eid => g.edges.get(eid))
    .filter(e => e && (!want || want.has(e.type)));
}

export function neighbors(ownerId, nodeId, { type = null, edgeType = null, exact = false } = {}) {
  const g = graph(ownerId);
  const out = [];
  for (const e of edgesOf(ownerId, nodeId, { type: edgeType, exact })) {
    const otherId = e.from === nodeId ? e.to : e.from;
    const node = g.nodes.get(otherId);
    if (node && (!type || node.type === type)) out.push({ node, edge: e });
  }
  return out;
}

/**
 * Bounded BFS returning the connected sub-graph around a node — the
 * multi-hop traversal primitive the query engine and (next phase) the
 * reasoning planner use. Every returned edge still carries its provenance.
 *
 * `edgeTypes` expands by class like edgesOf, so a traversal restricted to
 * `['related_to']` walks the whole semantic relationship layer.
 */
export function traverse(ownerId, startId, { maxHops = 3, maxNodes = 50, edgeTypes = null, exact = false } = {}) {
  const g = graph(ownerId);
  if (!g.nodes.has(startId)) return { nodes: [], edges: [], paths: new Map() };
  const allowed = expandEdgeTypes(edgeTypes, { exact });
  const seenN = new Set([startId]);
  const seenE = new Set();
  const paths = new Map([[startId, []]]);
  let frontier = [startId];

  for (let hop = 0; hop < maxHops && seenN.size < maxNodes; hop++) {
    const next = [];
    for (const nid of frontier) {
      for (const e of edgesOf(ownerId, nid)) {
        if (allowed && !allowed.has(e.type)) continue;
        seenE.add(e.id);
        const other = e.from === nid ? e.to : e.from;
        if (!seenN.has(other) && seenN.size < maxNodes) {
          seenN.add(other);
          paths.set(other, [...(paths.get(nid) ?? []), e]);
          next.push(other);
        }
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return {
    nodes: [...seenN].map(id => g.nodes.get(id)).filter(Boolean),
    edges: [...seenE].map(id => g.edges.get(id)).filter(Boolean),
    paths,
  };
}

// ── Incremental maintenance ──────────────────────────────────────────────────

/**
 * Phase 1a.2 — remove every trace of deleted files from the graph by PROVENANCE.
 *
 * removeFile() only drops what was linked to the file through `byFile`. Entity
 * nodes are cross-file by nature and are upserted without that link (the
 * resolver works over all files at once), so an entity contributed ONLY by a
 * deleted file survived removeFile and kept surfacing in the knowledge lane as
 * "Entity: … appears in" with no live file behind it. Here every node and edge
 * loses the deleted ids from its `sourceFiles`; one left with no source at all
 * is removed with its incident edges. Anything another file still supports
 * stays. Idempotent. Returns { nodes, edges } removed.
 */
export function detachFiles(ownerId, fileIds = []) {
  const gone = new Set(fileIds);
  if (!gone.size) return { nodes: 0, edges: 0 };
  const g = graph(ownerId);
  let nodes = 0, edges = 0;
  const dropEdge = eid => {
    const e = g.edges.get(eid);
    if (!e) return;
    g.adj.get(e.from)?.delete(eid);
    g.adj.get(e.to)?.delete(eid);
    g.edges.delete(eid);
    edges++;
  };
  for (const [eid, e] of [...g.edges]) {
    const src = e.sourceFiles ?? [];
    if (!src.some(f => gone.has(f))) continue;
    const keep = src.filter(f => !gone.has(f));
    if (keep.length) e.sourceFiles = keep; else dropEdge(eid);
  }
  for (const [nid, n] of [...g.nodes]) {
    const src = n.sourceFiles ?? [];
    if (!src.some(f => gone.has(f))) continue;
    const keep = src.filter(f => !gone.has(f));
    if (keep.length) { n.sourceFiles = keep; continue; }
    for (const eid of [...(g.adj.get(nid) ?? [])]) dropEdge(eid);
    g.nodes.delete(nid);
    g.adj.delete(nid);
    nodes++;
  }
  for (const [f, l] of g.byFile) {
    if (gone.has(f)) { g.byFile.delete(f); continue; }
    for (const nid of [...l.nodes]) if (!g.nodes.has(nid)) l.nodes.delete(nid);
    for (const eid of [...l.edges]) if (!g.edges.has(eid)) l.edges.delete(eid);
  }
  if (nodes || edges) {
    if (binding.mode !== 'off') for (const f of gone) (g.removedFiles ??= new Map()).set(f, Date.now());
    scheduleSave(ownerId ?? 'anon');
  }
  return { nodes, edges };
}

/** Phase 1a.2 — file ids this owner's graph holds contributions for (source-scoped deletion sweep). */
export function graphFileIds(ownerId) {
  return [...graph(ownerId).byFile.keys()];
}

export function removeFile(ownerId, ukoId) {
  const g = graph(ownerId);
  const links = g.byFile.get(ukoId);
  if (!links) return false;
  for (const eid of links.edges) {
    const e = g.edges.get(eid);
    if (e) { g.adj.get(e.from)?.delete(eid); g.adj.get(e.to)?.delete(eid); }
    g.edges.delete(eid);
  }
  for (const nid of links.nodes) {
    // Only drop a node if no OTHER file still contributes it.
    const stillReferenced = [...g.byFile].some(([f, l]) => f !== ukoId && l.nodes.has(nid));
    if (!stillReferenced && !(g.adj.get(nid)?.size)) { g.nodes.delete(nid); g.adj.delete(nid); }
  }
  g.byFile.delete(ukoId);
  // Partitions on: the removal travels with the graph (see mergeGraphs).
  if (binding.mode !== 'off') (g.removedFiles ??= new Map()).set(ukoId, Date.now());
  scheduleSave(ownerId ?? 'anon');
  return true;
}

/**
 * Account deletion — drop an owner's entire graph (nodes, edges, file links,
 * adjacency). Returns { nodes, edges } counts removed.
 */
export function purgeOwner(ownerId) {
  const key = ownerId ?? 'anon';
  const g = store.get(key);
  if (!g) { binding.markDeleted(key); return { nodes: 0, edges: 0 }; }
  const removed = { nodes: g.nodes.size, edges: g.edges.size };
  store.delete(key);
  binding.markDeleted(key);
  scheduleSave();
  return removed;
}

export function graphStats(ownerId) {
  const g = graph(ownerId);
  const byType = {};
  for (const n of g.nodes.values()) byType[n.type] = (byType[n.type] ?? 0) + 1;
  // byEdgeType (B1): relationship types are now real data, so make them
  // visible — this is the signal that the related_to collapse is gone.
  const byEdgeType = {};
  for (const e of g.edges.values()) byEdgeType[e.type] = (byEdgeType[e.type] ?? 0) + 1;
  return { nodes: g.nodes.size, edges: g.edges.size, files: g.byFile.size, byNodeType: byType, byEdgeType };
}

/**
 * Every owner with a graph. Read-only enumeration for admin tooling —
 * backfills and migrations need to walk owners without guessing at the
 * store's internal shape.
 */
export function listOwners() { return [...store.keys()]; }

export function _migrateEdgeV3ForTests(edge) { return migrateEdgeV3(edge); }

export function _resetGraphForTests() { store.clear(); binding._reset(); }