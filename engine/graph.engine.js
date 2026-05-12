"use strict";

/**
 * engine/graph.engine.js — AQUIPLEX PROJECT GRAPH ENGINE
 *
 * Maintains the structural graph of a project:
 *   architecture.json    — high-level project metadata + stack
 *   dependency-graph.json — file-to-file import/link relationships
 *   route-map.json        — all routes (frontend pages + backend APIs)
 *   component-tree.json   — UI component hierarchy
 *
 * Updated automatically after every file write.
 * Read by agents to understand project structure without re-reading all files.
 */

const fs   = require("fs").promises;
const path = require("path");
const { createLogger } = require("../utils/logger");

const log = createLogger("GRAPH");

const PROJECTS_DIR = path.join(__dirname, "../data/projects");

// ─────────────────────────────────────────────────────────────────────────────
// GRAPH FILE NAMES
// ─────────────────────────────────────────────────────────────────────────────

const GRAPH_FILES = {
  architecture:    "_architecture.json",
  dependencyGraph: "_dependency-graph.json",
  routeMap:        "_route-map.json",
  componentTree:   "_component-tree.json",
};

// ─────────────────────────────────────────────────────────────────────────────
// GRAPH READERS
// ─────────────────────────────────────────────────────────────────────────────

async function readGraph(projectId, graphKey) {
  try {
    const dir  = path.join(PROJECTS_DIR, projectId);
    const file = path.join(dir, GRAPH_FILES[graphKey]);
    const raw  = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeGraph(projectId, graphKey, data) {
  try {
    const dir  = path.join(PROJECTS_DIR, projectId);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, GRAPH_FILES[graphKey]);
    await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    log.warn(`writeGraph(${projectId}, ${graphKey}) failed: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ARCHITECTURE GRAPH
// ─────────────────────────────────────────────────────────────────────────────

/**
 * initArchitecture — called when a project plan is created
 */
async function initArchitecture(projectId, plan) {
  const arch = {
    projectId,
    title:       plan.meta?.title || "",
    description: plan.meta?.description || "",
    type:        plan.meta?.type || "webapp",
    complexity:  plan.meta?.complexity || "simple",
    stack:       plan.stack || {},
    designSystem: plan.designSystem || {},
    files:       (plan.files || []).map(f => f.path || f),
    features:    plan.features || [],
    deployment:  plan.deployment || {},
    createdAt:   new Date().toISOString(),
    updatedAt:   new Date().toISOString(),
  };

  await writeGraph(projectId, "architecture", arch);
  return arch;
}

/**
 * updateArchitecture — patch specific fields
 */
async function updateArchitecture(projectId, patch) {
  const existing = await readGraph(projectId, "architecture") || {};
  const updated  = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  await writeGraph(projectId, "architecture", updated);
  return updated;
}

// ─────────────────────────────────────────────────────────────────────────────
// DEPENDENCY GRAPH
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract import/link relationships from file content
 */
function extractDependencies(fileName, content) {
  const deps = [];
  const ext  = path.extname(fileName);

  if (ext === ".html") {
    // CSS links
    const cssLinks = content.match(/href=["']([^"']+\.css)["']/g) || [];
    cssLinks.forEach(m => {
      const match = m.match(/href=["']([^"']+)["']/);
      if (match) deps.push({ from: fileName, to: match[1], type: "stylesheet" });
    });

    // Script tags
    const scriptTags = content.match(/src=["']([^"']+\.(?:js|mjs))["']/g) || [];
    scriptTags.forEach(m => {
      const match = m.match(/src=["']([^"']+)["']/);
      if (match) deps.push({ from: fileName, to: match[1], type: "script" });
    });
  }

  if (ext === ".js" || ext === ".ts" || ext === ".mjs") {
    // require() calls
    const requires = content.match(/require\(["']([^"']+)["']\)/g) || [];
    requires.forEach(m => {
      const match = m.match(/require\(["']([^"']+)["']\)/);
      if (match && !match[1].startsWith("node:")) {
        deps.push({ from: fileName, to: match[1], type: "require" });
      }
    });

    // import statements
    const imports = content.match(/import\s+(?:\w+|\{[^}]+\})\s+from\s+["']([^"']+)["']/g) || [];
    imports.forEach(m => {
      const match = m.match(/from\s+["']([^"']+)["']/);
      if (match) deps.push({ from: fileName, to: match[1], type: "import" });
    });
  }

  return deps;
}

/**
 * updateDependencyGraph — called after a file is written
 */
async function updateDependencyGraph(projectId, fileName, content) {
  const graph = await readGraph(projectId, "dependencyGraph") || {
    projectId,
    nodes: [],
    edges: [],
    updatedAt: new Date().toISOString(),
  };

  // Remove old edges from this file
  graph.edges = graph.edges.filter(e => e.from !== fileName);

  // Add file to nodes if not present
  if (!graph.nodes.includes(fileName)) {
    graph.nodes.push(fileName);
  }

  // Extract new dependencies
  const newEdges = extractDependencies(fileName, content);
  graph.edges.push(...newEdges);

  // Add dependency targets to nodes
  newEdges.forEach(e => {
    if (!graph.nodes.includes(e.to)) graph.nodes.push(e.to);
  });

  graph.updatedAt = new Date().toISOString();
  await writeGraph(projectId, "dependencyGraph", graph);
  return graph;
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE MAP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract routes from server.js / routes files
 */
function extractRoutes(content) {
  const routes = [];

  const routePatterns = [
    { re: /app\.(get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/g,  type: "express" },
    { re: /router\.(get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/g, type: "router" },
  ];

  for (const { re, type } of routePatterns) {
    let match;
    const regex = new RegExp(re.source, re.flags);
    while ((match = regex.exec(content)) !== null) {
      routes.push({
        method:  match[1].toUpperCase(),
        path:    match[2],
        type,
      });
    }
  }

  return routes;
}

/**
 * updateRouteMap — called after server.js or route files are written
 */
async function updateRouteMap(projectId, fileName, content) {
  if (!fileName.match(/server\.(js|ts)|routes?\//)) return;

  const routeMap = await readGraph(projectId, "routeMap") || {
    projectId,
    frontend: [],
    backend:  [],
    updatedAt: new Date().toISOString(),
  };

  const extracted = extractRoutes(content);

  // Remove old routes from this file
  routeMap.backend = routeMap.backend.filter(r => r.sourceFile !== fileName);

  // Add new routes
  extracted.forEach(r => {
    routeMap.backend.push({ ...r, sourceFile: fileName });
  });

  routeMap.updatedAt = new Date().toISOString();
  await writeGraph(projectId, "routeMap", routeMap);
  return routeMap;
}

/**
 * updateFrontendPages — called with the plan's pages list
 */
async function updateFrontendPages(projectId, pages) {
  const routeMap = await readGraph(projectId, "routeMap") || {
    projectId,
    frontend: [],
    backend:  [],
    updatedAt: new Date().toISOString(),
  };

  routeMap.frontend = pages || [];
  routeMap.updatedAt = new Date().toISOString();
  await writeGraph(projectId, "routeMap", routeMap);
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT TREE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract components from HTML (sections, nav, footer, etc.)
 */
function extractComponents(htmlContent) {
  const components = [];

  const sectionTags = htmlContent.match(/<(section|nav|header|footer|main|aside|article)[^>]*(?:id|class)=["']([^"']*)["'][^>]*>/gi) || [];
  sectionTags.forEach(tag => {
    const nameMatch = tag.match(/(?:id|class)=["']([^"']+)["']/);
    const tagMatch  = tag.match(/^<(\w+)/);
    if (nameMatch && tagMatch) {
      const names = nameMatch[1].split(/\s+/).filter(Boolean);
      names.forEach(n => {
        components.push({
          name:    n,
          tagType: tagMatch[1],
          type:    "section",
        });
      });
    }
  });

  return components;
}

/**
 * updateComponentTree — called after index.html is written
 */
async function updateComponentTree(projectId, fileName, content) {
  if (path.extname(fileName) !== ".html") return;

  const tree = await readGraph(projectId, "componentTree") || {
    projectId,
    components: [],
    updatedAt: new Date().toISOString(),
  };

  const extracted = extractComponents(content);
  // Merge — keep existing from other files, add new from this file
  const fromThisFile = extracted.map(c => ({ ...c, sourceFile: fileName }));
  tree.components    = [
    ...tree.components.filter(c => c.sourceFile !== fileName),
    ...fromThisFile,
  ];
  tree.updatedAt = new Date().toISOString();
  await writeGraph(projectId, "componentTree", tree);
  return tree;
}

// ─────────────────────────────────────────────────────────────────────────────
// BATCH UPDATE (called after project generation)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * updateGraphsForFiles — process multiple files at once
 * @param {string} projectId
 * @param {Array<{ fileName: string, content: string }>} files
 */
async function updateGraphsForFiles(projectId, files) {
  await Promise.all(
    files.map(({ fileName, content }) =>
      Promise.all([
        updateDependencyGraph(projectId, fileName, content),
        updateRouteMap(projectId, fileName, content),
        updateComponentTree(projectId, fileName, content),
      ])
    )
  );
  log.info(`Graphs updated for project ${projectId} (${files.length} files)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// GRAPH SUMMARY (compressed context for AI agents)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * getGraphSummary — returns a compressed string suitable for AI context injection
 */
async function getGraphSummary(projectId) {
  const [arch, depGraph, routeMap, compTree] = await Promise.all([
    readGraph(projectId, "architecture"),
    readGraph(projectId, "dependencyGraph"),
    readGraph(projectId, "routeMap"),
    readGraph(projectId, "componentTree"),
  ]);

  const parts = [];

  if (arch) {
    parts.push(`PROJECT: ${arch.title} [${arch.type}/${arch.stack?.framework}]`);
    parts.push(`STACK: ${JSON.stringify(arch.stack)}`);
    if (arch.files?.length) parts.push(`FILES: ${arch.files.join(", ")}`);
  }

  if (depGraph?.edges?.length) {
    const edgeSummary = depGraph.edges.slice(0, 10).map(e => `${e.from} → ${e.to}`).join("; ");
    parts.push(`DEPS: ${edgeSummary}`);
  }

  if (routeMap?.backend?.length) {
    const routeSummary = routeMap.backend.slice(0, 8).map(r => `${r.method} ${r.path}`).join(", ");
    parts.push(`API_ROUTES: ${routeSummary}`);
  }

  if (compTree?.components?.length) {
    const compNames = compTree.components.slice(0, 10).map(c => c.name).join(", ");
    parts.push(`COMPONENTS: ${compNames}`);
  }

  return parts.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// READ ALL GRAPHS
// ─────────────────────────────────────────────────────────────────────────────

async function getAllGraphs(projectId) {
  const [architecture, dependencyGraph, routeMap, componentTree] = await Promise.all([
    readGraph(projectId, "architecture"),
    readGraph(projectId, "dependencyGraph"),
    readGraph(projectId, "routeMap"),
    readGraph(projectId, "componentTree"),
  ]);

  return { architecture, dependencyGraph, routeMap, componentTree };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  initArchitecture,
  updateArchitecture,
  updateDependencyGraph,
  updateRouteMap,
  updateFrontendPages,
  updateComponentTree,
  updateGraphsForFiles,
  getGraphSummary,
  getAllGraphs,
  readGraph,
  GRAPH_FILES,
};
