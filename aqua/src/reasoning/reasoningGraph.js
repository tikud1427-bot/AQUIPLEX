/**
 * AQUA Reasoning Graph — Cross-File Reasoning (Phase 3)
 *
 * The Unified Reasoning Graph: one connected knowledge space where every
 * node (entity, fact, event, file, topic) links to every other through
 * typed, provenance-bearing edges. After ingestion the user asks about
 * INFORMATION, not files — this graph is what "information, not files"
 * means concretely.
 *
 * Node types:  entity | fact | event | file | topic
 * Edge types:  mentions (file→entity), asserts (file→fact),
 *              about (fact→entity), supports (evidence-backed fact→claim),
 *              occurs_at (event→timepoint), involves (event→entity),
 *              derived_from (event→fact), related_to (entity→entity),
 *              contradicts (fact↔fact), same_as (entity merge record)
 *
 * THE REASONING CONTRACT is enforced structurally: no edge exists without
 * provenance. Every edge carries { confidence, evidence: [evidenceId…],
 * sourceFiles: [ukoId…], reason }. An edge with empty provenance is
 * rejected at insert. And every node/edge is tagged with an epistemic
 * `kind` — observed | derived | hypothesis | speculation — so the query
 * layer can keep them from ever mixing (facts are observed; inferred
 * relationships are derived; contradiction pairings are derived; nothing
 * here is speculation, but the field exists for the reasoning phase).
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

const STORE_FILE = dataPath('.aqua-reasoning-graph.json');
const SCHEMA     = 1;

export const NODE_TYPES = Object.freeze(['entity', 'fact', 'event', 'file', 'topic']);
export const EDGE_TYPES = Object.freeze([
  'mentions', 'asserts', 'about', 'supports', 'occurs_at', 'involves',
  'derived_from', 'related_to', 'contradicts', 'same_as',
]);
export const EPISTEMIC = Object.freeze(['observed', 'derived', 'hypothesis', 'speculation']);

const MAX_NODES_PER_OWNER = 50_000;

/** ownerKey → { nodes: Map<id,node>, edges: Map<edgeId,edge>, byFile: Map<ukoId,{nodes:Set,edges:Set}>, adj: Map<nodeId,Set<edgeId>> } */
const store = new Map();

function graph(ownerId) {
  const key = ownerId ?? 'anon';
  let g = store.get(key);
  if (!g) { g = { nodes: new Map(), edges: new Map(), byFile: new Map(), adj: new Map() }; store.set(key, g); }
  return g;
}

// ── Persistence ──────────────────────────────────────────────────────────────

function loadFromDisk() {
  const parsed = loadJsonFile(STORE_FILE, { label: 'reasoning-graph' });
  if (parsed == null) return;
  const { data } = unwrapStore(parsed, { expected: SCHEMA, file: STORE_FILE, label: 'reasoning-graph' });
  if (!data || typeof data !== 'object') return;
  for (const [owner, g] of Object.entries(data)) {
    const gr = graph(owner);
    for (const n of Object.values(g.nodes ?? {})) gr.nodes.set(n.id, n);
    for (const e of Object.values(g.edges ?? {})) { gr.edges.set(e.id, e); indexEdge(gr, e); }
    for (const [file, links] of Object.entries(g.byFile ?? {})) {
      gr.byFile.set(file, { nodes: new Set(links.nodes ?? []), edges: new Set(links.edges ?? []) });
    }
  }
  const totals = [...store.values()].reduce((a, g) => ({ n: a.n + g.nodes.size, e: a.e + g.edges.size }), { n: 0, e: 0 });
  if (totals.n) console.log(`[REASONING] Graph loaded: ${totals.n} node(s), ${totals.e} edge(s) across ${store.size} owner(s) from ${STORE_FILE}`);
}

const _writer = createDebouncedWriter(STORE_FILE);
function scheduleSave() {
  _writer.schedule(() => {
    const data = {};
    for (const [owner, g] of store.entries()) {
      data[owner] = {
        nodes: Object.fromEntries(g.nodes),
        edges: Object.fromEntries(g.edges),
        byFile: Object.fromEntries([...g.byFile].map(([k, v]) => [k, { nodes: [...v.nodes], edges: [...v.edges] }])),
      };
    }
    return JSON.stringify(wrapStore(SCHEMA, data));
  });
}

loadFromDisk();

function indexEdge(g, edge) {
  for (const nid of [edge.from, edge.to]) {
    if (!g.adj.has(nid)) g.adj.set(nid, new Set());
    g.adj.get(nid).add(edge.id);
  }
}

// ── Node / edge insertion (provenance enforced) ──────────────────────────────

/**
 * Upsert a node. Merges label/aliases/provenance; never duplicates by id.
 * @param {object} node - { id, type, label, kind?, data?, sourceFiles?[] }
 */
export function upsertNode(ownerId, node, { fileId = null } = {}) {
  if (!NODE_TYPES.includes(node.type)) throw new Error(`upsertNode: bad type ${node.type}`);
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
  scheduleSave();
  return merged;
}

/**
 * Add a provenance-bearing edge. REJECTS edges without provenance — the
 * reasoning contract has teeth.
 * @param {object} edge - { from, to, type, kind?, confidence, evidence?[], sourceFiles[], reason }
 */
export function addEdge(ownerId, edge, { fileId = null } = {}) {
  if (!EDGE_TYPES.includes(edge.type)) throw new Error(`addEdge: bad type ${edge.type}`);
  const sourceFiles = edge.sourceFiles ?? [];
  const evidence    = edge.evidence ?? [];
  if (!sourceFiles.length && !evidence.length) {
    throw new Error(`addEdge: edge ${edge.type} has no provenance (evidence or sourceFiles required) — reasoning contract violation`);
  }
  const g = graph(ownerId);
  const id = edge.id ?? `${edge.from}|${edge.type}|${edge.to}`;
  const existing = g.edges.get(id);
  const rec = existing ? {
    ...existing,
    confidence: Math.max(existing.confidence, edge.confidence ?? 0),
    evidence: [...new Set([...existing.evidence, ...evidence])],
    sourceFiles: [...new Set([...existing.sourceFiles, ...sourceFiles])],
  } : {
    id, from: edge.from, to: edge.to, type: edge.type,
    kind: edge.kind ?? 'derived',
    confidence: edge.confidence ?? 0.5,
    evidence, sourceFiles,
    reason: edge.reason ?? edge.type,
    createdAt: Date.now(),
  };
  g.edges.set(id, rec);
  indexEdge(g, rec);
  if (fileId) linkFile(g, fileId).edges.add(id);
  scheduleSave();
  return rec;
}

function linkFile(g, fileId) {
  let l = g.byFile.get(fileId);
  if (!l) { l = { nodes: new Set(), edges: new Set() }; g.byFile.set(fileId, l); }
  return l;
}

// ── Query surface (traversal; reasoning layers build on this) ────────────────

export function getNode(ownerId, id) { return graph(ownerId).nodes.get(id) ?? null; }

export function nodesByType(ownerId, type) {
  return [...graph(ownerId).nodes.values()].filter(n => n.type === type);
}

export function edgesOf(ownerId, nodeId, { type = null } = {}) {
  const g = graph(ownerId);
  return [...(g.adj.get(nodeId) ?? [])].map(eid => g.edges.get(eid)).filter(e => e && (!type || e.type === type));
}

export function neighbors(ownerId, nodeId, { type = null, edgeType = null } = {}) {
  const g = graph(ownerId);
  const out = [];
  for (const e of edgesOf(ownerId, nodeId, { type: edgeType })) {
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
 */
export function traverse(ownerId, startId, { maxHops = 3, maxNodes = 50, edgeTypes = null } = {}) {
  const g = graph(ownerId);
  if (!g.nodes.has(startId)) return { nodes: [], edges: [], paths: new Map() };
  const seenN = new Set([startId]);
  const seenE = new Set();
  const paths = new Map([[startId, []]]);
  let frontier = [startId];

  for (let hop = 0; hop < maxHops && seenN.size < maxNodes; hop++) {
    const next = [];
    for (const nid of frontier) {
      for (const e of edgesOf(ownerId, nid)) {
        if (edgeTypes && !edgeTypes.includes(e.type)) continue;
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
  scheduleSave();
  return true;
}

/**
 * Account deletion — drop an owner's entire graph (nodes, edges, file links,
 * adjacency). Returns { nodes, edges } counts removed.
 */
export function purgeOwner(ownerId) {
  const key = ownerId ?? 'anon';
  const g = store.get(key);
  if (!g) return { nodes: 0, edges: 0 };
  const removed = { nodes: g.nodes.size, edges: g.edges.size };
  store.delete(key);
  scheduleSave();
  return removed;
}

export function graphStats(ownerId) {
  const g = graph(ownerId);
  const byType = {};
  for (const n of g.nodes.values()) byType[n.type] = (byType[n.type] ?? 0) + 1;
  return { nodes: g.nodes.size, edges: g.edges.size, files: g.byFile.size, byNodeType: byType };
}

export function _resetGraphForTests() { store.clear(); }
