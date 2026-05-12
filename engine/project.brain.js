"use strict";

/**
 * engine/project.brain.js — AQUIPLEX PROJECT BRAIN
 *
 * Persistent project intelligence layer.
 * Maintains: framework, architecture, dependencies, file relationships,
 * components, coding style, active tasks, edit history, known issues.
 *
 * Stored as _brain.json alongside project files.
 * Injected as compressed context during edits and generations.
 */

const fs   = require("fs").promises;
const path = require("path");
const { createLogger } = require("../utils/logger");

const log = createLogger("PROJECT_BRAIN");

const PROJECTS_DIR = path.join(__dirname, "../data/projects");
const BRAIN_FILE   = "_brain.json";

// ─────────────────────────────────────────────────────────────────────────────
// BRAIN SCHEMA
// ─────────────────────────────────────────────────────────────────────────────

function createEmptyBrain(projectId) {
  return {
    projectId,
    createdAt:   new Date().toISOString(),
    updatedAt:   new Date().toISOString(),

    // Project identity
    name:        "",
    projectType: "",
    description: "",

    // Architecture
    framework:   "vanilla",       // vanilla | react | vue | svelte | node
    entryFile:   "index.html",
    stylesheets: [],
    scripts:     [],

    // File relationships
    fileGraph: {},                 // { "index.html": ["style.css","script.js"] }

    // Component registry
    components: [],                // ["navbar","hero","cards","footer"]

    // Style system
    colorPalette:   [],           // ["#0a0a0f","#6366f1","#e2e8f0"]
    fontPrimary:    "",
    fontSecondary:  "",
    designTheme:    "",

    // Dependencies (CDN)
    cdnLibraries:   [],           // ["Chart.js","Three.js"]

    // Coding patterns
    codingStyle: {
      usesClasses:       false,
      usesModules:       false,
      usesLocalStorage:  false,
      usesWebComponents: false,
      usesCanvas:        false,
      usesWebAudio:      false,
      usesAnimations:    true,
      usesIntersectionObserver: false,
    },

    // Edit history
    editHistory: [],              // [{ ts, file, instruction, summary }] last 20

    // Known issues
    knownIssues: [],              // [{ severity, file, description }]

    // Active tasks
    activeTasks: [],

    // Version snapshots index
    snapshots: [],                // [{ version, ts, files: [] }]

    // ── Fullstack intelligence ──────────────────────────────────────────────
    isFullstack:  false,
    stack: {
      frontend:   "",             // vanilla | react | vue
      backend:    "",             // express | none
      database:   "",             // mongodb | sqlite | none
      auth:       "",             // session | jwt | none
    },
    routes:       [],             // [{ method, path, description }]
    dbModels:     [],             // [{ name, fields: [] }]
    envVars:      [],             // ["VAR=description"]
    deployTarget: "",             // vercel | render | railway | node
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FILE I/O
// ─────────────────────────────────────────────────────────────────────────────

function brainPath(projectId) {
  return path.join(PROJECTS_DIR, projectId, BRAIN_FILE);
}

async function loadBrain(projectId) {
  try {
    const raw  = await fs.readFile(brainPath(projectId), "utf8");
    return JSON.parse(raw);
  } catch {
    return createEmptyBrain(projectId);
  }
}

async function saveBrain(brain) {
  try {
    brain.updatedAt = new Date().toISOString();
    const dir = path.join(PROJECTS_DIR, brain.projectId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(brainPath(brain.projectId), JSON.stringify(brain, null, 2), "utf8");
  } catch (e) {
    log.warn(`saveBrain failed: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BRAIN ANALYSIS — extract intelligence from file contents
// ─────────────────────────────────────────────────────────────────────────────

function analyzeFiles(files) {
  const intel = {
    components:   [],
    cdnLibraries: [],
    colorPalette: [],
    fontPrimary:  "",
    fontSecondary: "",
    codingStyle:  {},
    fileGraph:    {},
  };

  for (const file of files) {
    const name    = file.fileName || file.name || "";
    const content = file.content || "";

    // ── HTML analysis ──
    if (name.endsWith(".html")) {
      // CDN libraries
      const cdnMatches = content.matchAll(/cdn\.[^"'\s]+\/([^/]+)(?:\.min)?\.js/gi);
      for (const m of cdnMatches) {
        const lib = m[1].replace(/[@\-][0-9.]+.*/, "");
        if (!intel.cdnLibraries.includes(lib)) intel.cdnLibraries.push(lib);
      }

      // File graph — linked resources
      const links = [];
      const linkRe = /href="([^"]+\.css)"/gi;
      const srcRe  = /src="([^"]+\.js)"/gi;
      for (const m of content.matchAll(linkRe)) links.push(m[1]);
      for (const m of content.matchAll(srcRe))  links.push(m[1]);
      if (links.length) intel.fileGraph[name] = links;

      // Component detection from HTML structure
      if (/<nav\b/i.test(content))            intel.components.push("navbar");
      if (/<hero|class="hero/i.test(content)) intel.components.push("hero");
      if (/<canvas\b/i.test(content))         intel.components.push("canvas");
      if (/class=".*card/i.test(content))     intel.components.push("cards");
      if (/<footer\b/i.test(content))         intel.components.push("footer");
      if (/<form\b/i.test(content))           intel.components.push("form");
      if (/sidebar/i.test(content))           intel.components.push("sidebar");
      if (/modal/i.test(content))             intel.components.push("modal");
      if (/chart/i.test(content))             intel.components.push("charts");

      // Google Fonts
      const fontMatch = content.match(/family=([^&"':]+)/i);
      if (fontMatch) {
        intel.fontPrimary = decodeURIComponent(fontMatch[1]).replace(/\+/g, " ").split(":")[0];
      }
    }

    // ── CSS analysis ──
    if (name.endsWith(".css")) {
      // Color palette from :root vars
      const colorMatches = content.matchAll(/#([0-9a-f]{3,8})\b/gi);
      const colors = new Set();
      for (const m of colorMatches) {
        if (m[1].length >= 6) colors.add(`#${m[1].toLowerCase()}`);
      }
      intel.colorPalette = [...colors].slice(0, 8);
    }

    // ── JS analysis ──
    if (name.endsWith(".js")) {
      const style = {};
      if (/\bclass\s+\w+/i.test(content))                style.usesClasses = true;
      if (/localStorage/i.test(content))                  style.usesLocalStorage = true;
      if (/requestAnimationFrame/i.test(content))         style.usesCanvas = true;
      if (/AudioContext|OscillatorNode/i.test(content))   style.usesWebAudio = true;
      if (/IntersectionObserver/i.test(content))          style.usesIntersectionObserver = true;
      if (/@keyframes|animation:/i.test(content))         style.usesAnimations = true;
      Object.assign(intel.codingStyle, style);
    }
  }

  // Deduplicate
  intel.components = [...new Set(intel.components)];

  return intel;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * initBrain — called after project generation
 */
async function initBrain(projectId, { name, projectType, files, designTheme, prompt, stack, routes, dbModels, envVars, deployTarget }) {
  const brain = createEmptyBrain(projectId);

  brain.name        = name || "";
  brain.projectType = projectType || "static";
  brain.description = (prompt || "").slice(0, 200);
  brain.designTheme = designTheme || "";
  brain.entryFile   = "index.html";
  brain.stylesheets = (files || []).filter(f => (f.fileName||f.name||"").endsWith(".css")).map(f => f.fileName||f.name);
  brain.scripts     = (files || []).filter(f => (f.fileName||f.name||"").endsWith(".js")).map(f => f.fileName||f.name);

  // Analyze file contents
  if (files?.length) {
    const intel = analyzeFiles(files);
    brain.components    = intel.components;
    brain.cdnLibraries  = intel.cdnLibraries;
    brain.colorPalette  = intel.colorPalette;
    brain.fontPrimary   = intel.fontPrimary;
    brain.fileGraph     = intel.fileGraph;
    Object.assign(brain.codingStyle, intel.codingStyle);
  }

  // Fullstack intelligence
  if (stack || routes || dbModels) {
    brain.isFullstack  = true;
    if (stack)        Object.assign(brain.stack, stack);
    if (routes)       brain.routes      = routes.slice(0, 50);
    if (dbModels)     brain.dbModels    = dbModels.slice(0, 20);
    if (envVars)      brain.envVars     = envVars.slice(0, 30);
    if (deployTarget) brain.deployTarget = deployTarget;
  }

  await saveBrain(brain);
  log.info(`initBrain: ${projectId} type=${projectType} fullstack=${brain.isFullstack} components=[${brain.components.join(",")}]`);
  return brain;
}

/**
 * updateBrainAfterEdit — record edit in history, re-analyze changed files
 */
async function updateBrainAfterEdit(projectId, { files, instruction, updatedFiles }) {
  const brain = await loadBrain(projectId);

  // Record edit in history
  const editEntry = {
    ts:          new Date().toISOString(),
    files:       updatedFiles || [],
    instruction: (instruction || "").slice(0, 200),
  };
  brain.editHistory.unshift(editEntry);
  if (brain.editHistory.length > 20) brain.editHistory = brain.editHistory.slice(0, 20);

  // Re-analyze changed files
  if (files?.length) {
    const changedFiles = files.filter(f =>
      (updatedFiles || []).includes(f.fileName || f.name)
    );
    if (changedFiles.length) {
      const intel = analyzeFiles(changedFiles);
      if (intel.colorPalette.length)  brain.colorPalette  = intel.colorPalette;
      if (intel.fontPrimary)          brain.fontPrimary   = intel.fontPrimary;
      Object.assign(brain.codingStyle, intel.codingStyle);
      // Merge components
      brain.components = [...new Set([...brain.components, ...intel.components])];
    }
  }

  await saveBrain(brain);
}

/**
 * recordIssue — add a known issue to the brain
 */
async function recordIssue(projectId, { severity, file, description }) {
  const brain = await loadBrain(projectId);
  brain.knownIssues.unshift({ severity, file, description, ts: new Date().toISOString() });
  if (brain.knownIssues.length > 10) brain.knownIssues = brain.knownIssues.slice(0, 10);
  await saveBrain(brain);
}

/**
 * resolveIssue — remove a known issue
 */
async function resolveIssue(projectId, description) {
  const brain = await loadBrain(projectId);
  brain.knownIssues = brain.knownIssues.filter(i => i.description !== description);
  await saveBrain(brain);
}

/**
 * getBrainContext — returns a compressed context string for injection into AI prompts
 */
async function getBrainContext(projectId, opts = {}) {
  const brain = await loadBrain(projectId);
  const { focusFile, maxLength = 800 } = opts;

  const parts = [];

  if (brain.name)        parts.push(`Project: ${brain.name}`);
  if (brain.projectType) parts.push(`Type: ${brain.projectType}`);
  if (brain.designTheme) parts.push(`Design: ${brain.designTheme}`);
  if (brain.fontPrimary) parts.push(`Font: ${brain.fontPrimary}`);
  if (brain.colorPalette.length) parts.push(`Colors: ${brain.colorPalette.slice(0, 4).join(", ")}`);
  if (brain.components.length)   parts.push(`Components: ${brain.components.join(", ")}`);
  if (brain.cdnLibraries.length) parts.push(`CDN libs: ${brain.cdnLibraries.join(", ")}`);

  // Relevant coding style
  const styleFlags = Object.entries(brain.codingStyle)
    .filter(([, v]) => v)
    .map(([k]) => k.replace("uses", ""));
  if (styleFlags.length) parts.push(`Style: ${styleFlags.join(", ")}`);

  // File relationships for focus file
  if (focusFile && brain.fileGraph[focusFile]) {
    parts.push(`${focusFile} links: ${brain.fileGraph[focusFile].join(", ")}`);
  }

  // Fullstack intelligence
  if (brain.isFullstack) {
    const s = brain.stack;
    parts.push(`Stack: ${s.frontend}+${s.backend}+${s.database} auth=${s.auth}`);
    if (brain.routes?.length) {
      const routes = brain.routes.slice(0, 6)
        .map(r => `  ${r.method} ${r.path}`)
        .join("\n");
      parts.push(`API Routes:\n${routes}`);
    }
    if (brain.dbModels?.length) {
      parts.push(`DB Models: ${brain.dbModels.map(m => m.name).join(", ")}`);
    }
    if (brain.deployTarget) parts.push(`Deploy: ${brain.deployTarget}`);
  }

  // Recent edits
  if (brain.editHistory.length) {
    const recent = brain.editHistory.slice(0, 3)
      .map(e => `  • ${e.files.join(",")} — ${e.instruction}`)
      .join("\n");
    parts.push(`Recent edits:\n${recent}`);
  }

  // Known issues
  if (brain.knownIssues.length) {
    const issues = brain.knownIssues.slice(0, 3)
      .map(i => `  • [${i.severity}] ${i.file}: ${i.description}`)
      .join("\n");
    parts.push(`Known issues:\n${issues}`);
  }

  let ctx = `━━━ PROJECT BRAIN ━━━\n${parts.join("\n")}\n━━━━━━━━━━━━━━━━━━━━━`;
  if (ctx.length > maxLength) ctx = ctx.slice(0, maxLength) + "\n[...truncated]";

  return ctx;
}

/**
 * saveSnapshot — save a version snapshot of current project files
 */
async function saveSnapshot(projectId, files, label) {
  const brain = await loadBrain(projectId);

  const snap = {
    version: brain.snapshots.length + 1,
    label:   label || `v${brain.snapshots.length + 1}`,
    ts:      new Date().toISOString(),
    files:   (files || []).map(f => ({
      fileName: f.fileName || f.name,
      content:  (f.content || "").slice(0, 50000), // cap at 50k per file
    })),
  };

  brain.snapshots.unshift(snap);
  if (brain.snapshots.length > 10) brain.snapshots = brain.snapshots.slice(0, 10);
  await saveBrain(brain);

  log.info(`saveSnapshot: ${projectId} v${snap.version} files=${snap.files.length}`);
  return snap.version;
}

/**
 * getSnapshot — retrieve a specific snapshot
 */
async function getSnapshot(projectId, version) {
  const brain = await loadBrain(projectId);
  if (version === "latest" || !version) return brain.snapshots[0] || null;
  return brain.snapshots.find(s => s.version === version) || null;
}

/**
 * listSnapshots — list all snapshots for a project
 */
async function listSnapshots(projectId) {
  const brain = await loadBrain(projectId);
  return brain.snapshots.map(s => ({
    version: s.version,
    label:   s.label,
    ts:      s.ts,
    fileCount: s.files?.length || 0,
  }));
}

module.exports = {
  loadBrain,
  saveBrain,
  initBrain,
  updateBrainAfterEdit,
  recordIssue,
  resolveIssue,
  getBrainContext,
  saveSnapshot,
  getSnapshot,
  listSnapshots,
  analyzeFiles,
};