/**
 * AQUA Mind — Graph Recall (Memory 5.0, Phase B)
 * ─────────────────────────────────────────────────────────────────────────────
 * The relationship graph was write-only: populated every turn, traversed
 * never. This module makes it answer questions — multi-hop, query-driven.
 *
 *   recallGraphPaths(mind, query, opts) →
 *     [{ line: "Aquiplex —owns→ AQUA —uses→ node.js", score }]
 *
 * Method (pure, zero-LLM, bounded):
 *   1. SEED — nodes whose label shares a token with the query (whole-token
 *      match, 3+ chars; "self" never seeds — every path from self is trivial).
 *   2. WALK — BFS up to maxHops from each seed over BOTH edge directions.
 *      Path score = seed match strength × Σ edge weights × hop decay.
 *   3. RENDER — the top paths as compact arrow lines the LLM reads natively.
 *
 * A path is only as interesting as what it CONNECTS: single isolated seed
 * nodes (no edges) return nothing — the fact layer already covers those.
 * Fail-open: malformed graphs return [].
 */

const HOP_DECAY = 0.6;        // each extra hop multiplies score by this
const MAX_PATHS_DEFAULT = 3;
const MAX_HOPS_DEFAULT = 2;
const MIN_TOKEN_LEN = 3;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'what', 'who', 'how', 'why',
  'when', 'where', 'about', 'tell', 'know', 'does', 'did', 'are', 'was',
  'were', 'you', 'your', 'have', 'has', 'can', 'could', 'should', 'would',
  'from', 'into', 'onto', 'over', 'under', 'they', 'them', 'their', 'our',
  'out', 'not', 'but', 'all', 'any', 'get', 'use', 'using', 'work', 'working',
]);

function queryTokens(query) {
  return new Set(
    (String(query || '').toLowerCase().match(/[a-z0-9_.-]+/g) || [])
      .filter(t => t.length >= MIN_TOKEN_LEN && !STOPWORDS.has(t))
  );
}

/** Adjacency: nodeKey → [{ edge, otherKey, dir }] over both directions. */
function buildAdjacency(graph) {
  const adj = new Map();
  const push = (key, entry) => {
    if (!adj.has(key)) adj.set(key, []);
    adj.get(key).push(entry);
  };
  for (const edge of Object.values(graph.edges || {})) {
    if (!graph.nodes?.[edge.from] || !graph.nodes?.[edge.to]) continue;
    push(edge.from, { edge, otherKey: edge.to, dir: 'out' });
    push(edge.to,   { edge, otherKey: edge.from, dir: 'in' });
  }
  return adj;
}

/** Seed strength: how much of the node label the query actually names. */
function seedStrength(label, tokens) {
  const labelTokens = String(label).toLowerCase().match(/[a-z0-9_.-]+/g) || [];
  let hits = 0;
  for (const lt of labelTokens) if (tokens.has(lt)) hits++;
  if (!hits) return 0;
  return hits / Math.max(1, labelTokens.length); // full-label match = 1
}

function renderPath(nodes, edges) {
  const parts = [nodes[0].label];
  for (let i = 0; i < edges.length; i++) {
    const { edge, dir } = edges[i];
    const arrow = dir === 'out' ? `—${edge.type}→` : `←${edge.type}—`;
    parts.push(arrow, nodes[i + 1].label);
  }
  return parts.join(' ');
}

/**
 * @param {object} mind
 * @param {string} query
 * @param {{ maxHops?: number, maxPaths?: number }} opts
 * @returns {Array<{ line: string, score: number, nodes: string[] }>}
 */
export function recallGraphPaths(mind, query, { maxHops = MAX_HOPS_DEFAULT, maxPaths = MAX_PATHS_DEFAULT } = {}) {
  try {
    const graph = mind?.graph;
    if (!graph?.nodes || !Object.keys(graph.nodes).length) return [];
    const tokens = queryTokens(query);
    if (!tokens.size) return [];

    // 1. Seeds
    const seeds = [];
    for (const node of Object.values(graph.nodes)) {
      if (!node?.label || node.key === 'self' || node.type === 'self') continue;
      const strength = seedStrength(node.label, tokens);
      if (strength > 0) seeds.push({ node, strength });
    }
    if (!seeds.length) return [];

    const adj = buildAdjacency(graph);

    // 2. BFS per seed, collect scored paths
    const found = []; // { line, score, nodeKeys }
    for (const { node: seed, strength } of seeds) {
      const neighbors = adj.get(seed.key);
      if (!neighbors?.length) continue; // isolated node — fact layer's job

      // frontier entries: { nodes:[node..], edges:[{edge,dir}..], weightSum }
      let frontier = [{ nodes: [seed], edges: [], weightSum: 0 }];
      for (let hop = 0; hop < maxHops; hop++) {
        const next = [];
        for (const p of frontier) {
          const tail = p.nodes[p.nodes.length - 1];
          for (const step of adj.get(tail.key) || []) {
            if (p.nodes.some(n => n.key === step.otherKey)) continue; // no cycles
            const otherNode = graph.nodes[step.otherKey];
            if (!otherNode || otherNode.key === 'self') continue;
            const ext = {
              nodes: [...p.nodes, otherNode],
              edges: [...p.edges, step],
              weightSum: p.weightSum + (step.edge.weight || 1),
            };
            next.push(ext);
            const hops = ext.edges.length;
            const score = strength * ext.weightSum * Math.pow(HOP_DECAY, hops - 1);
            found.push({
              line: renderPath(ext.nodes, ext.edges),
              score,
              nodeKeys: ext.nodes.map(n => n.key),
            });
          }
        }
        frontier = next;
        if (!frontier.length) break;
      }
    }
    if (!found.length) return [];

    // 3. Rank; prefer longer informative paths over their own prefixes.
    found.sort((a, b) => b.score - a.score || b.nodeKeys.length - a.nodeKeys.length);
    const picked = [];
    for (const p of found) {
      const dup = picked.some(q =>
        q.line.includes(p.line) || p.line.includes(q.line));
      if (!dup) picked.push(p);
      if (picked.length >= maxPaths) break;
    }
    return picked.map(({ line, score, nodeKeys }) => ({ line, score: +score.toFixed(2), nodes: nodeKeys }));
  } catch {
    return []; // fail-open, like every memory stage
  }
}

/** Prompt block for the recall lines. '' when empty. */
export function formatGraphRecall(paths) {
  if (!paths?.length) return '';
  return [
    '--- RELATED KNOWLEDGE (relationship graph) ---',
    ...paths.map(p => `- ${p.line}`),
    '--- END RELATED KNOWLEDGE ---',
  ].join('\n');
}
