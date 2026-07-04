/**
 * AQUA Dependency Graph
 *
 * Lightweight directed graph: file → files it imports (local only).
 * Also tracks reverse: who imports each file.
 * Tracks class inheritance chains.
 *
 * Queries:
 *   whoImports(workspaceId, filePath)  → files that depend on this file
 *   whatImports(workspaceId, filePath) → files this file depends on
 */

// workspaceId → GraphState
const graphs = new Map();

// ── Build ─────────────────────────────────────────────────────────────────────

/**
 * @param {string} workspaceId
 * @param {Array<ParsedFile>} parsedFiles
 * @returns {Graph}
 */
export function buildDependencyGraph(workspaceId, parsedFiles) {
  const graph = {
    imports:     new Map(),   // filePath → Set<filePath> (files it imports)
    importedBy:  new Map(),   // filePath → Set<filePath> (files that import it)
    inheritance: new Map(),   // className → { file, extends }
    builtAt:     Date.now(),
  };

  const pathSet = new Set(parsedFiles.map(f => f.path));

  for (const file of parsedFiles) {
    if (!graph.imports.has(file.path)) graph.imports.set(file.path, new Set());

    for (const imp of file.imports ?? []) {
      // Only track local imports (relative paths)
      if (imp.startsWith('.') || imp.startsWith('/')) {
        const resolved = _resolveLocal(file.path, imp, pathSet);
        if (resolved) {
          graph.imports.get(file.path).add(resolved);
          if (!graph.importedBy.has(resolved)) graph.importedBy.set(resolved, new Set());
          graph.importedBy.get(resolved).add(file.path);
        }
      }
    }

    // Track class inheritance
    for (const cls of file.classes ?? []) {
      const name = typeof cls === 'string' ? cls : cls.name;
      const ext  = typeof cls === 'object' ? cls.extends : null;
      if (name) graph.inheritance.set(name, { file: file.path, extends: ext });
    }
  }

  graphs.set(workspaceId, graph);
  console.log(`[GRAPH] Dependencies updated workspace=${workspaceId} files=${parsedFiles.length}`);
  return graph;
}

// Resolve a relative import path against the known file set
function _resolveLocal(fromPath, importPath, pathSet) {
  const fromDir = fromPath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  const base    = fromDir ? `${fromDir}/${importPath}` : importPath;

  const candidates = [
    base,
    `${base}.js`,   `${base}.ts`,   `${base}.jsx`,  `${base}.tsx`,
    `${base}/index.js`, `${base}/index.ts`,
  ];

  for (const c of candidates) {
    const norm = _normPath(c);
    if (pathSet.has(norm)) return norm;
  }
  return null;
}

function _normPath(p) {
  const parts = p.replace(/\\/g, '/').split('/');
  const out = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part !== '.') out.push(part);
  }
  return out.join('/');
}

// ── Query ─────────────────────────────────────────────────────────────────────

export function getGraph(workspaceId) {
  return graphs.get(workspaceId) ?? null;
}

export function clearGraph(workspaceId) {
  graphs.delete(workspaceId);
}

/** Files that import the given file */
export function whoImports(workspaceId, filePath) {
  const graph = graphs.get(workspaceId);
  return graph ? [...(graph.importedBy.get(filePath) ?? [])] : [];
}

/** Files that the given file imports */
export function whatImports(workspaceId, filePath) {
  const graph = graphs.get(workspaceId);
  return graph ? [...(graph.imports.get(filePath) ?? [])] : [];
}

/**
 * Serialise graph to adjacency list (JSON-safe, no Sets).
 * Only includes files with at least one local dependency.
 */
export function serializeGraph(workspaceId) {
  const graph = graphs.get(workspaceId);
  if (!graph) return null;

  const adj = {};
  for (const [file, deps] of graph.imports.entries()) {
    if (deps.size > 0) adj[file] = [...deps];
  }
  return adj;
}

/**
 * Detect dependency cycles using DFS.
 * Returns array of cycle paths (each path is an array of file names).
 */
export function detectCycles(workspaceId) {
  const graph = graphs.get(workspaceId);
  if (!graph) return [];

  const cycles   = [];
  const visited  = new Set();
  const inStack  = new Set();

  function dfs(node, stack) {
    visited.add(node);
    inStack.add(node);
    stack.push(node);

    for (const dep of graph.imports.get(node) ?? []) {
      if (!visited.has(dep)) {
        dfs(dep, stack);
      } else if (inStack.has(dep)) {
        const idx = stack.indexOf(dep);
        cycles.push(stack.slice(idx).concat(dep));
      }
    }

    stack.pop();
    inStack.delete(node);
  }

  for (const file of graph.imports.keys()) {
    if (!visited.has(file)) dfs(file, []);
  }

  return cycles;
}
