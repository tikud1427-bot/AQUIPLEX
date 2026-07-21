/**
 * AQUA Task Graph — Orchestration 2.0
 *
 * Pure data model for directed task graphs with dependencies. No I/O, no
 * model calls — construction + validation + topological layering only.
 * graphPlanner.js builds these; graphRuntime.js executes them.
 *
 * Node: {
 *   id: string,                unique within the graph
 *   capability: string,        specialistRouter key (reason|code|math|…)
 *   instruction: string,       what this subtask must produce
 *   deps: string[],            node ids whose outputs feed this node
 *   critical: boolean,         failure aborts (true) vs degrade-and-continue
 *   taskTypeHint?: string,     overrides the specialist's provider-quality hint
 *   meta?: object              planner annotations (stage name, part index…)
 * }
 *
 * validateGraph() enforces: unique ids, every dep exists, acyclic (Kahn),
 * exactly one terminal node reachable from everything is NOT required —
 * multi-leaf graphs are fine (the runtime's synthesis step consumes leaves).
 * topoLayers() returns execution waves: every node in layer N depends only
 * on layers < N, so a whole layer can run in parallel.
 */

export const CAPABILITIES = Object.freeze([
  'reason', 'code', 'math', 'summarize', 'verify', 'translate',
  'extract', 'search', 'evidence', 'memory', 'vision', 'synthesize',
]);

export function createGraph() {
  return { nodes: new Map(), createdAt: Date.now() };
}

export function addNode(graph, {
  id, capability = 'reason', instruction, deps = [], critical = true,
  taskTypeHint = null, meta = {},
}) {
  if (!id || typeof id !== 'string') throw new Error('addNode: id required');
  if (graph.nodes.has(id)) throw new Error(`addNode: duplicate node id "${id}"`);
  if (!instruction || typeof instruction !== 'string') throw new Error(`addNode: instruction required for "${id}"`);
  const cap = CAPABILITIES.includes(capability) ? capability : 'reason';
  const node = {
    id, capability: cap, instruction: instruction.trim(),
    deps: [...new Set(deps)], critical: Boolean(critical),
    taskTypeHint, meta,
  };
  graph.nodes.set(id, node);
  return node;
}

/**
 * @returns {{ valid: boolean, problems: string[], layers: string[][] }}
 *   layers is populated only when valid (Kahn's algorithm output).
 */
export function validateGraph(graph) {
  const problems = [];
  const nodes = [...graph.nodes.values()];
  if (!nodes.length) return { valid: false, problems: ['graph has no nodes'], layers: [] };

  for (const n of nodes) {
    for (const d of n.deps) {
      if (!graph.nodes.has(d)) problems.push(`node "${n.id}" depends on missing node "${d}"`);
      if (d === n.id) problems.push(`node "${n.id}" depends on itself`);
    }
  }
  if (problems.length) return { valid: false, problems, layers: [] };

  // Kahn: peel zero-indegree waves; leftovers ⇒ cycle.
  const indeg = new Map(nodes.map(n => [n.id, n.deps.length]));
  const dependents = new Map(nodes.map(n => [n.id, []]));
  for (const n of nodes) for (const d of n.deps) dependents.get(d).push(n.id);

  const layers = [];
  let frontier = nodes.filter(n => indeg.get(n.id) === 0).map(n => n.id);
  const seen = new Set();
  while (frontier.length) {
    layers.push([...frontier].sort());
    const next = [];
    for (const id of frontier) {
      seen.add(id);
      for (const dep of dependents.get(id)) {
        indeg.set(dep, indeg.get(dep) - 1);
        if (indeg.get(dep) === 0) next.push(dep);
      }
    }
    frontier = next;
  }
  if (seen.size !== nodes.length) {
    const cyclic = nodes.filter(n => !seen.has(n.id)).map(n => n.id);
    return { valid: false, problems: [`cycle detected involving: ${cyclic.join(', ')}`], layers: [] };
  }
  return { valid: true, problems: [], layers };
}

/** Nodes nothing depends on — the synthesis step consumes these. */
export function leafNodes(graph) {
  const depended = new Set();
  for (const n of graph.nodes.values()) for (const d of n.deps) depended.add(d);
  return [...graph.nodes.values()].filter(n => !depended.has(n.id)).map(n => n.id);
}

/** Compact, loggable shape. */
export function graphSummary(graph) {
  return [...graph.nodes.values()].map(n => ({
    id: n.id, capability: n.capability, deps: n.deps, critical: n.critical,
    instruction: n.instruction.slice(0, 90),
  }));
}
