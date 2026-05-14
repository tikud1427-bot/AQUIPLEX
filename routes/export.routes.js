"use strict";

/**
 * routes/export.routes.js — AQUIPLEX EXPORT + GRAPH + TEMPLATE ROUTES
 *
 * New endpoints:
 *   POST /workspace/project/:id/plan       → generate architecture plan (JSON)
 *   GET  /workspace/project/:id/graph      → get all project graphs
 *   POST /workspace/project/:id/agent-gen  → run full agent pipeline
 *   GET  /workspace/project/:id/export/zip → download project as ZIP
 *   GET  /workspace/project/:id/export/deploy → get deploy configs
 *   GET  /workspace/templates              → list available templates
 *   POST /workspace/templates/:name/seed   → seed project from template
 */

const express  = require("express");
const router   = express.Router();
const path     = require("path");
const fs       = require("fs");
const fsp      = require("fs").promises;
const archiver = require("archiver");
const mongoose = require("mongoose");

const planner    = require("../engine/planner.agent");
const graphEng   = require("../engine/graph.engine");
const agentOrch  = require("../engine/agent.orchestrator");
const svc        = require("../workspace/workspace.service");
const deployGen  = require("../engine/deploy.generator");
const { createLogger }                         = require("../utils/logger");
const { asyncHandler, sendError, sendSuccess } = require("../middleware/asyncHandler");
const { usageGuard }                           = require("../middleware/usage/usageGuard");

const log          = createLogger("EXPORT_ROUTES");
const PROJECTS_DIR = path.join(__dirname, "../data/projects");

// ─────────────────────────────────────────────────────────────────────────────
// AUTH HELPER
// ─────────────────────────────────────────────────────────────────────────────

function uid(req) {
  return req.session?.userId || req.session?.user?._id || req.user?._id || null;
}

function requireLogin(req, res, next) {
  if (!uid(req)) return res.status(401).json({ error: "Login required" });
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATE REGISTRY
// ─────────────────────────────────────────────────────────────────────────────

const TEMPLATES = {
  "saas-landing": {
    name:        "SaaS Landing Page",
    description: "Modern SaaS marketing site with hero, features, pricing, CTA sections",
    type:        "saas",
    prompt:      "Build a modern SaaS landing page with hero section, feature grid, pricing table, testimonials, and CTA. Dark theme with indigo accents.",
    tags:        ["landing", "marketing", "saas"],
  },
  "dashboard": {
    name:        "Analytics Dashboard",
    description: "Admin dashboard with metrics, charts, data tables",
    type:        "dashboard",
    prompt:      "Build a dark analytics dashboard with stat cards, line charts, bar charts, data table, sidebar navigation, and top stats bar.",
    tags:        ["admin", "analytics", "data"],
  },
  "portfolio": {
    name:        "Developer Portfolio",
    description: "Personal portfolio with projects, skills, contact form",
    type:        "portfolio",
    prompt:      "Build a sleek developer portfolio with hero section, project showcase grid, skills section, about section, and contact form. Dark elegant theme.",
    tags:        ["portfolio", "personal", "developer"],
  },
  "ecommerce": {
    name:        "E-Commerce Store",
    description: "Product listing, filters, cart UI",
    type:        "ecommerce",
    prompt:      "Build an e-commerce product listing page with category filters, product grid cards with prices, add-to-cart buttons, and a cart sidebar.",
    tags:        ["store", "shop", "products"],
  },
  "ai-chat": {
    name:        "AI Chat Interface",
    description: "Chat UI with message bubbles, sidebar history, input bar",
    type:        "chat",
    prompt:      "Build a modern AI chat interface with sidebar conversation list, message bubbles (user/assistant), streaming indicator, and a fixed input bar with send button.",
    tags:        ["chat", "ai", "messaging"],
  },
  "blog-cms": {
    name:        "Blog CMS",
    description: "Blog with post listing, article view, category filter",
    type:        "blog",
    prompt:      "Build a blog CMS frontend with hero, post cards grid, category filter tabs, single post view with markdown rendering, and a minimal header/footer.",
    tags:        ["blog", "content", "cms"],
  },
  "admin-panel": {
    name:        "Admin Panel",
    description: "Full admin panel with sidebar, user table, CRUD UI",
    type:        "dashboard",
    prompt:      "Build an admin panel with left sidebar navigation, users table with actions, settings page, and dark glassmorphism design.",
    tags:        ["admin", "panel", "crud"],
  },
  "api-backend": {
    name:        "Express REST API",
    description: "Production Express.js backend with routes, MongoDB, auth",
    type:        "api",
    prompt:      "Build a production Express.js REST API with MongoDB, JWT auth, CRUD routes for users and resources, helmet, cors, rate limiting, and health endpoint.",
    tags:        ["api", "backend", "express", "node"],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /workspace/templates — list templates
router.get("/templates", asyncHandler(async (req, res) => {
  const list = Object.entries(TEMPLATES).map(([key, t]) => ({
    key,
    name:        t.name,
    description: t.description,
    type:        t.type,
    tags:        t.tags,
  }));
  sendSuccess(res, { templates: list });
}));

// POST /workspace/templates/:name/seed — seed a project from template
router.post("/templates/:name/seed", requireLogin, asyncHandler(async (req, res) => {
  const userId   = uid(req);
  const template = TEMPLATES[req.params.name];
  if (!template) return sendError(res, 404, "Template not found");

  const { projectId } = req.body;
  if (!projectId) return sendError(res, 400, "projectId required");

  // Use template's prompt to generate the project
  req.body.prompt = template.prompt;

  // Create plan from template prompt
  const plan = await planner.createProjectPlan(template.prompt);

  return sendSuccess(res, {
    template: req.params.name,
    plan,
    message: `Template plan created. Use POST /workspace/project/${projectId}/agent-gen to generate files.`,
  });
}));

// POST /workspace/project/:id/plan — generate architecture plan
router.post("/project/:id/plan", requireLogin, usageGuard("section_gen"), asyncHandler(async (req, res) => {
  const userId    = uid(req);
  const projectId = req.params.id;
  const { prompt } = req.body;

  if (!prompt || !prompt.trim()) return sendError(res, 400, "prompt required");

  const plan = await planner.createProjectPlan(prompt.trim());

  // Init architecture graph
  await graphEng.initArchitecture(projectId, plan).catch(() => {});

  sendSuccess(res, { plan });
}));

// GET /workspace/project/:id/graph — get all project graphs
router.get("/project/:id/graph", requireLogin, asyncHandler(async (req, res) => {
  const graphs = await graphEng.getAllGraphs(req.params.id);
  sendSuccess(res, { graphs });
}));

// GET /workspace/project/:id/graph/summary — compressed graph for AI context
router.get("/project/:id/graph/summary", requireLogin, asyncHandler(async (req, res) => {
  const summary = await graphEng.getGraphSummary(req.params.id);
  sendSuccess(res, { summary });
}));

// POST /workspace/project/:id/agent-gen — run full multi-agent pipeline
router.post("/project/:id/agent-gen", requireLogin, usageGuard("multi_agent_orchestration"), asyncHandler(async (req, res) => {
  const userId    = uid(req);
  const projectId = req.params.id;
  const { prompt } = req.body;

  if (!prompt || !prompt.trim()) return sendError(res, 400, "prompt required");

  // Collect status events for response (non-streaming version)
  const statusEvents = [];

  let result;
  try {
    result = await agentOrch.runAgentPipeline(
      prompt.trim(),
      projectId,
      {
        onStatus: (event) => statusEvents.push(event),
        saveFiles: async (files) => {
          const fileArray = Object.entries(files).map(([fileName, content]) => ({ fileName, content }));
          await svc.saveProjectFiles(userId, projectId, fileArray);
        },
      }
    );
  } catch (agentErr) {
    await req.creditContext?.refund?.();
    throw agentErr;
  }

  sendSuccess(res, {
    projectId,
    plan:         result.plan,
    fileCount:    result.fileCount,
    files:        Object.keys(result.mergedFiles),
    graphSummary: result.graphSummary,
    durationMs:   result.durationMs,
    statusEvents,
  });
}));

// POST /workspace/project/:id/agent-gen/stream — streaming version with SSE
router.post("/project/:id/agent-gen/stream", requireLogin, usageGuard("multi_agent_orchestration"), async (req, res) => {
  const userId    = uid(req);
  const projectId = req.params.id;
  const { prompt } = req.body;

  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: "prompt required" });
  }

  // SSE setup
  res.setHeader("Content-Type",      "text/event-stream");
  res.setHeader("Cache-Control",     "no-cache");
  res.setHeader("Connection",        "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  function sendEvent(data) {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      if (typeof res.flush === "function") res.flush();
    } catch {}
  }

  let done = false;

  try {
    const result = await agentOrch.runAgentPipeline(
      prompt.trim(),
      projectId,
      {
        onStatus: (event) => sendEvent({ type: "status", ...event }),
        saveFiles: async (files) => {
          const fileArray = Object.entries(files).map(([fileName, content]) => ({ fileName, content }));
          await svc.saveProjectFiles(userId, projectId, fileArray);
          sendEvent({ type: "files_saved", count: fileArray.length, files: fileArray.map(f => f.fileName) });
        },
      }
    );

    sendEvent({
      type:         "complete",
      projectId,
      plan:         result.plan,
      fileCount:    result.fileCount,
      files:        Object.keys(result.mergedFiles),
      graphSummary: result.graphSummary,
      durationMs:   result.durationMs,
    });
  } catch (err) {
    log.error(`Agent pipeline error: ${err.message}`);
    await req.creditContext?.refund?.();
    sendEvent({ type: "error", message: err.message });
  } finally {
    done = true;
    res.write("data: [DONE]\n\n");
    res.end();
  }

  req.on("close", () => { done = true; });
});

// GET /workspace/project/:id/export/zip — download project as ZIP
router.get("/project/:id/export/zip", requireLogin, asyncHandler(async (req, res) => {
  const userId    = uid(req);
  const projectId = req.params.id;

  // Get project files
  const { files } = await svc.readProjectFiles(userId, projectId);
  if (!files || files.length === 0) {
    return sendError(res, 404, "No files found in project");
  }

  const projectDir = path.join(PROJECTS_DIR, projectId);

  // Check if archiver is available
  let archiverAvailable = false;
  try { require("archiver"); archiverAvailable = true; } catch {}

  if (!archiverAvailable) {
    // Fallback: return files as JSON if archiver not installed
    const fileData = {};
    for (const file of files) {
      try {
        const filePath = path.join(projectDir, path.basename(file.fileName || file));
        const content  = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : (file.content || "");
        fileData[file.fileName || file] = content;
      } catch {}
    }
    res.setHeader("Content-Type", "application/json");
    return res.json({ message: "archiver not available — returning files as JSON", files: fileData });
  }

  // Stream ZIP
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="project-${projectId.slice(0, 8)}.zip"`);

  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.pipe(res);

  for (const file of files) {
    const fileName = typeof file === "string" ? file : (file.fileName || "");
    const content  = typeof file === "string" ? "" : (file.content || "");

    try {
      const filePath = path.join(projectDir, path.basename(fileName));
      if (fs.existsSync(filePath)) {
        archive.file(filePath, { name: fileName });
      } else if (content) {
        archive.append(content, { name: fileName });
      }
    } catch {}
  }

  // Add graph files
  for (const [key, gFileName] of Object.entries(graphEng.GRAPH_FILES)) {
    const gPath = path.join(projectDir, gFileName);
    if (fs.existsSync(gPath)) {
      archive.file(gPath, { name: `.aquiplex/${gFileName}` });
    }
  }

  archive.finalize();
}));

// GET /workspace/project/:id/export/deploy — get deploy configs
router.get("/project/:id/export/deploy", requireLogin, asyncHandler(async (req, res) => {
  const userId    = uid(req);
  const projectId = req.params.id;

  const arch = await graphEng.readGraph(projectId, "architecture");
  if (!arch) return sendError(res, 404, "Project architecture not found. Generate project first.");

  const brain = {
    name:        arch.title || projectId,
    projectType: arch.type || "webapp",
    stack:       arch.stack || {},
    envVars:     [],
  };

  const configs = {};

  try {
    const allFiles = deployGen.generateDeployConfigs(brain, ["auto"]);
    // Group by inferred target based on file names
    const targetMap = { vercel: [], netlify: [], railway: [], docker: [], misc: [] };
    for (const f of allFiles) {
      const fn = f.fileName || f.name || "";
      if (fn.includes("vercel"))         targetMap.vercel.push(f);
      else if (fn.includes("netlify"))   targetMap.netlify.push(f);
      else if (fn.includes("railway") || fn.includes("Procfile")) targetMap.railway.push(f);
      else if (fn.includes("Docker"))    targetMap.docker.push(f);
      else                               targetMap.misc.push(f);
    }
    for (const [target, files] of Object.entries(targetMap)) {
      if (files.length) configs[target] = files.map(f => ({ name: f.fileName || f.name, content: f.content }));
    }
  } catch (err) {
    log.warn(`Deploy config generation error: ${err.message}`);
  }

  sendSuccess(res, { projectId, architecture: arch, configs });
}));

module.exports = router;