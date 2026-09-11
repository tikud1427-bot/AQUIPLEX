/**
 * AQUA Mind — Relationship Graph (Layer 7) + Organization Memory (Layer 16)
 * ─────────────────────────────────────────────────────────────────────────────
 * Connected knowledge instead of isolated memories. Nodes: people, orgs,
 * projects, goals, technologies, episodes. Edges: typed, weighted, re-seen
 * edges strengthen. Organizations are first-class nodes whose neighborhoods
 * (teams, repos, products, shared goals) form the org memory — same graph,
 * no duplicate storage.
 *
 * Population sources (all reuse existing extraction — no new parsing pass):
 *   • schema facts (workplace, spouse, children → person/org nodes)
 *   • observer tech hints (→ technology nodes, `uses` edges)
 *   • goal tracker (→ goal nodes, `targets` edges)
 *   • workspaces (→ project nodes, `works_on` edges)
 */
import { createNode, createEdge, CAPS } from './mindSchema.js';
import { touchMind } from './mindStore.js';

function nodeKey(type, label) {
  return `${type}:${String(label).toLowerCase().trim()}`;
}

export function upsertNode(mind, type, label) {
  if (!label) return null;
  const g = mind.graph;
  const key = nodeKey(type, label);
  let node = g.nodes[key];
  if (node) {
    node.weight += 1;
    return node;
  }
  if (Object.keys(g.nodes).length >= CAPS.GRAPH_NODES) return null; // reflection prunes
  node = createNode({ type, label: String(label).trim() });
  node.key = key;
  g.nodes[key] = node;
  return node;
}

export function upsertEdge(mind, fromKey, toKey, type, note = '') {
  const g = mind.graph;
  if (!g.nodes[fromKey] || !g.nodes[toKey] || fromKey === toKey) return null;
  const ekey = `${fromKey}|${type}|${toKey}`;
  let edge = g.edges[ekey];
  if (edge) {
    edge.weight += 1;
    edge.lastSeenAt = Date.now();
    return edge;
  }
  edge = createEdge({ from: fromKey, to: toKey, type, note });
  edge.key = ekey;
  g.edges[ekey] = edge;
  return edge;
}

const SELF = 'person:__self__';
function ensureSelf(mind) {
  if (!mind.graph.nodes[SELF]) {
    const n = createNode({ type: 'person', label: 'user' });
    n.key = SELF;
    mind.graph.nodes[SELF] = n;
  }
  return mind.graph.nodes[SELF];
}

/**
 * Per-turn graph update from already-computed turn artifacts.
 */
export function updateGraph(mind, { extractedFacts = [], hints = {}, goalsTouched = [], workspaceId = null }) {
  ensureSelf(mind);
  let wrote = false;

  for (const fact of extractedFacts) {
    if (fact.key === 'workplace' && fact.value) {
      const org = upsertNode(mind, 'organization', fact.value);
      if (org) { upsertEdge(mind, SELF, org.key, 'part_of', 'workplace fact'); wrote = true; }
    }
    if ((fact.key === 'spouse' || fact.key === 'siblings' || fact.key === 'cofounder') && fact.value) {
      const rel = fact.key === 'cofounder' ? 'works_with' : (fact.key === 'spouse' ? 'related_to' : 'related_to');
      const vals = Array.isArray(fact.value) ? fact.value : [fact.value];
      for (const v of vals) {
        const name = typeof v === 'object' ? v.name : v;
        if (!name) continue;
        const p = upsertNode(mind, 'person', name);
        if (p) { upsertEdge(mind, SELF, p.key, rel, fact.key); wrote = true; }
      }
    }
    if (fact.key === 'children' && fact.value?.name) {
      const p = upsertNode(mind, 'person', fact.value.name);
      if (p) { upsertEdge(mind, SELF, p.key, 'related_to', 'family'); wrote = true; }
    }
    // v3 (Extraction Audit): projects & goals are now first-class facts — they
    // must land in the graph as nodes the user works_on / targets (Req 4/9).
    if ((fact.key === 'project') && fact.value) {
      const vals = Array.isArray(fact.value) ? fact.value : [fact.value];
      for (const v of vals) {
        const pn = upsertNode(mind, 'project', v);
        if (pn) { upsertEdge(mind, SELF, pn.key, 'works_on', 'project fact'); wrote = true; }
      }
    }
    if (fact.key === 'goal' && fact.value) {
      const vals = Array.isArray(fact.value) ? fact.value : [fact.value];
      for (const v of vals) {
        const gn = upsertNode(mind, 'goal', String(v).slice(0, 60));
        if (gn) { upsertEdge(mind, SELF, gn.key, 'targets', 'goal fact'); wrote = true; }
      }
    }
  }

  for (const tech of hints.tech || []) {
    const t = upsertNode(mind, 'technology', tech);
    if (t) { upsertEdge(mind, SELF, t.key, 'uses'); wrote = true; }
  }

  let projectNode = null;
  if (workspaceId) {
    projectNode = upsertNode(mind, 'project', workspaceId);
    if (projectNode) { upsertEdge(mind, SELF, projectNode.key, 'works_on'); wrote = true; }
    for (const tech of hints.tech || []) {
      const t = mind.graph.nodes[nodeKey('technology', tech)];
      if (t && projectNode) upsertEdge(mind, projectNode.key, t.key, 'uses');
    }
  }

  for (const goal of goalsTouched) {
    const gn = upsertNode(mind, 'goal', goal.title);
    if (gn) {
      upsertEdge(mind, SELF, gn.key, 'targets');
      if (projectNode) upsertEdge(mind, gn.key, projectNode.key, 'related_to');
      wrote = true;
    }
  }

  if (wrote) touchMind(mind);
  return wrote;
}

/** BFS neighborhood — retrieval + explainability use this. */
export function neighborhood(mind, startKey, depth = 2, maxNodes = 12) {
  const g = mind.graph;
  if (!g.nodes[startKey]) return { nodes: [], edges: [] };
  const seenN = new Set([startKey]);
  const seenE = [];
  let frontier = [startKey];
  for (let d = 0; d < depth && seenN.size < maxNodes; d++) {
    const next = [];
    for (const key of frontier) {
      for (const edge of Object.values(g.edges)) {
        const other = edge.from === key ? edge.to : edge.to === key ? edge.from : null;
        if (!other) continue;
        seenE.push(edge);
        if (!seenN.has(other) && seenN.size < maxNodes) {
          seenN.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  return {
    nodes: [...seenN].map(k => g.nodes[k]).filter(Boolean),
    edges: [...new Set(seenE)],
  };
}

/** Org memory view: an organization node + its full neighborhood. */
export function organizationView(mind, orgLabel) {
  const key = nodeKey('organization', orgLabel);
  return mind.graph.nodes[key] ? neighborhood(mind, key, 2, 20) : null;
}

/** Reflection hook: drop weakest leaf nodes when over cap. */
export function pruneGraph(mind) {
  const g = mind.graph;
  const over = Object.keys(g.nodes).length - CAPS.GRAPH_NODES;
  if (over <= 0) return 0;
  const degree = new Map();
  for (const e of Object.values(g.edges)) {
    degree.set(e.from, (degree.get(e.from) || 0) + e.weight);
    degree.set(e.to,   (degree.get(e.to)   || 0) + e.weight);
  }
  const victims = Object.values(g.nodes)
    .filter(n => n.key !== SELF)
    .sort((a, b) => ((degree.get(a.key) || 0) + a.weight) - ((degree.get(b.key) || 0) + b.weight))
    .slice(0, over);
  for (const v of victims) {
    delete g.nodes[v.key];
    for (const [ekey, e] of Object.entries(g.edges)) {
      if (e.from === v.key || e.to === v.key) delete g.edges[ekey];
    }
  }
  touchMind(mind);
  return victims.length;
}

export const SELF_KEY = SELF;
