/**
 * project.routes.js — Aquiplex AI Website Execution Engine [v3]
 *
 * Mounted at: /workspace/project
 *
 * CHANGELOG v3:
 * - [FIX-1] GET /:id calls res.render("workspace", {...}) — not res.json()
 * - [FIX-2] GET /api/:id — dedicated JSON endpoint for programmatic consumers
 * - [FIX-3] GET /:id fetches full workspace + bundles so workspace.ejs gets
 *           the same data shape as GET /workspace
 * - [v3-1]  POST /generate: delegates file writing to svc.generateProject,
 *           then writes a parallel copy to PROJECTS_ROOT for iframe serving.
 *           meta.json kept for iframe-serving compatibility. _index.json is
 *           the canonical source of truth.
 * - [v3-2]  GET /list: proxies to svc.getProjectList for consistent metadata
 * - [v3-3]  POST /create: writes both meta.json (for iframe serving) and
 *           calls svc.createProject to initialise _index.json
 * - [v3-4]  DELETE /:id: removes both PROJECTS_ROOT dir and svc data dir
 * - [v3-5]  GET /:id/files: reads from svc for consistent file list
 * - [v3-6]  All error messages are explicit — no silent failures
 *
 * ROUTES:
 *   POST   /workspace/project/create       → create new project
 *   POST   /workspace/project/generate     → AI generation
 *   POST   /workspace/project/edit         → AI file edit
 *   GET    /workspace/project/list         → list user projects
 *   GET    /workspace/project/:id          → render workspace SPA, auto-open builder
 *   GET    /workspace/project/api/:id      → JSON metadata
 *   GET    /workspace/project/:id/files    → list project files
 *   GET    /workspace/project/:id/:file    → serve raw file for iframe
 *   DELETE /workspace/project/:id          → delete project
 */

"use strict";

const express  = require("express");
const router   = express.Router();
const fs       = require("fs");
const path     = require("path");
const { v4: uuidv4 } = require("uuid");

// ── Models needed for workspace render ───────────────────────────────────────
const Workspace = require("../models/Workspace");
const Bundle    = require("../models/Bundle");

// ── Workspace service — canonical source of truth for project data ────────────
const svc = require("../services/workspace.service");

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

// PROJECTS_ROOT: serves static files for iframes (raw file access)
const PROJECTS_ROOT = path.join(process.cwd(), "projects");

if (!fs.existsSync(PROJECTS_ROOT)) {
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function uid(req) {
  return (
    req.session?.userId    ||
    req.session?.user?._id ||
    req.user?._id          ||
    req.user?.id           ||
    null
  );
}

function handleErr(res, err, status = 500) {
  console.error("[PROJECT ENGINE]", err?.message || err);
  res.status(status).json({ success: false, error: err?.message || "Internal error" });
}

function projectRootDir(projectId) {
  return path.join(PROJECTS_ROOT, projectId);
}

/**
 * Read meta.json from PROJECTS_ROOT (for iframe-serving compatibility).
 * Falls back gracefully if missing.
 */
function readMeta(projectId) {
  try {
    const p = path.join(projectRootDir(projectId), "meta.json");
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Write meta.json to PROJECTS_ROOT (for iframe-serving compatibility).
 */
function writeMeta(projectId, data) {
  const dir = projectRootDir(projectId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(data, null, 2), "utf8");
}

function safeFilename(name) {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isAllowedExt(filename) {
  const allowed = [".html", ".css", ".js", ".json", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf"];
  return allowed.includes(path.extname(filename).toLowerCase());
}

/**
 * Mirror files to PROJECTS_ROOT so GET /:id/:file can serve them for iframes.
 * This is a best-effort sync — failures are logged, not thrown.
 */
function mirrorFilesToRoot(projectId, files) {
  const dir = projectRootDir(projectId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  for (const file of files) {
    try {
      const safeName = safeFilename(file.fileName);
      if (!safeName || !isAllowedExt(safeName)) continue;
      fs.writeFileSync(path.join(dir, safeName), file.content, "utf8");
    } catch (e) {
      console.warn(`[PROJECT ENGINE] mirrorFilesToRoot: failed to write ${file.fileName}:`, e.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/project/create
// ─────────────────────────────────────────────────────────────────────────────

router.post("/create", async (req, res) => {
  try {
    const userId    = uid(req);
    if (!userId) return res.status(401).json({ success: false, error: "Unauthorized" });

    const { name }  = req.body || {};
    const projectId = uuidv4();

    // Initialise _index.json via service (canonical)
    await svc.createProject(userId, name, projectId);

    // Write meta.json for iframe-serving compatibility
    const meta = {
      projectId,
      userId:    String(userId),
      name:      name || "Untitled Project",
      files:     [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeMeta(projectId, meta);

    res.json({ success: true, projectId, name: meta.name });
  } catch (err) {
    handleErr(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/project/generate
// ─────────────────────────────────────────────────────────────────────────────

router.post("/generate", async (req, res) => {
  try {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ success: false, error: "Unauthorized" });

    const { projectId, prompt } = req.body || {};
    if (!projectId || !prompt) {
      return res.status(400).json({ success: false, error: "projectId and prompt are required" });
    }

    // Verify project ownership via meta.json or _index.json
    const meta = readMeta(projectId);
    if (meta && meta.userId && meta.userId !== String(userId)) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    // Delegate all generation + persistence to the service
    const result = await svc.generateProject(userId, projectId, prompt);

    if (!result.success) {
      return res.status(500).json({ success: false, error: "Generation failed" });
    }

    // Mirror files to PROJECTS_ROOT for iframe serving
    mirrorFilesToRoot(projectId, result.fileData);

    // Update meta.json with final file list
    const updatedMeta = {
      projectId,
      userId:    String(userId),
      name:      result.name || (meta && meta.name) || String(prompt).slice(0, 80) || "Generated Project",
      files:     result.files,
      prompt:    String(prompt).slice(0, 500),
      updatedAt: new Date().toISOString(),
      createdAt: (meta && meta.createdAt) || new Date().toISOString(),
    };
    writeMeta(projectId, updatedMeta);

    res.json({
      success:   true,
      projectId,
      name:      updatedMeta.name,
      files:     result.files,
    });
  } catch (err) {
    console.error("[Project Engine] /generate error:", err);
    handleErr(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/project/edit
// AI-powered single-file edit via natural language.
// Body: { projectId, fileName, instruction }
// ─────────────────────────────────────────────────────────────────────────────

router.post("/edit", async (req, res) => {
  try {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ success: false, error: "Unauthorized" });

    const { projectId, fileName, instruction } = req.body || {};
    if (!projectId || !fileName || !instruction) {
      return res.status(400).json({ success: false, error: "projectId, fileName, and instruction are required" });
    }

    const result = await svc.editProjectFile(userId, projectId, fileName, instruction);

    // Re-mirror the updated file to PROJECTS_ROOT for iframe serving
    for (const updatedFileName of (result.updatedFiles || [fileName])) {
      try {
        const fileResult = await svc.getProjectFile(userId, projectId, updatedFileName);
        const safeName   = safeFilename(updatedFileName);
        if (safeName && isAllowedExt(safeName)) {
          const dir = projectRootDir(projectId);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, safeName), fileResult.content, "utf8");
        }
      } catch (mirrorErr) {
        console.warn(`[PROJECT ENGINE] /edit mirror failed for ${updatedFileName}:`, mirrorErr.message);
      }
    }

    res.json(result);
  } catch (err) {
    handleErr(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /workspace/project/list
// ─────────────────────────────────────────────────────────────────────────────

router.get("/list", async (req, res) => {
  try {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ success: false, error: "Unauthorized" });
    const result = await svc.getProjectList(userId);
    res.json(result);
  } catch (err) {
    handleErr(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /workspace/project/api/:id
// JSON metadata endpoint for programmatic consumers.
// ─────────────────────────────────────────────────────────────────────────────

router.get("/api/:id", async (req, res) => {
  try {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ success: false, error: "Unauthorized" });

    const result = await svc.getProjectFiles(userId, req.params.id);
    res.json(result);
  } catch (err) {
    handleErr(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /workspace/project/:id
// Render workspace SPA with auto-open for this project.
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id", async (req, res, next) => {
  // Guard: skip reserved keyword segments
  const reserved = ["create", "generate", "edit", "list", "api"];
  if (reserved.includes(req.params.id)) return next();

  try {
    const userId = uid(req);
    if (!userId) return res.redirect("/login");

    // Validate project — check meta.json first, then svc index
    let projectName = null;
    const meta = readMeta(req.params.id);

    if (meta) {
      if (meta.userId && meta.userId !== String(userId)) {
        return res.status(403).render("error", {
          message: "You do not have access to this project.",
          status:  403,
        });
      }
      projectName = meta.name;
    } else {
      // Fall back to service index
      try {
        const svcResult = await svc.getProjectFiles(userId, req.params.id);
        projectName = svcResult.name || "Project";
      } catch {
        return res.status(404).render("error", {
          message: "Project not found.",
          status:  404,
        });
      }
    }

    // Load workspace + bundles — same query as workspace_routes.js GET /
    let ws = await Workspace.findOne({ userId }).populate("tools").lean();
    if (!ws) {
      ws = await new Workspace({ userId }).save();
      ws = ws.toObject ? ws.toObject() : ws;
    }
    if (ws.workspaceMemory instanceof Map) {
      ws.workspaceMemory = Object.fromEntries(ws.workspaceMemory);
    }
    const bundles = await Bundle.find({ userId }).sort({ updatedAt: -1 }).lean();

    return res.render("workspace", {
      workspace:       ws,
      bundles,
      page:            "workspace",
      openProjectId:   req.params.id,
      openProjectName: projectName,
    });
  } catch (err) {
    console.error("[PROJECT ENGINE] GET /:id render error:", err);
    res.status(500).send("Failed to load workspace for this project.");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /workspace/project/:id/files
// List files in a project using the service (consistent with _index.json).
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id/files", async (req, res) => {
  try {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ success: false, error: "Unauthorized" });

    const result = await svc.getProjectFiles(userId, req.params.id);
    res.json({ success: true, files: result.files, projectId: req.params.id });
  } catch (err) {
    handleErr(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /workspace/project/:id/:file
// Serve raw file for iframe preview.
// Reads from PROJECTS_ROOT (mirrored on generate/edit).
// Falls back to service if not found in PROJECTS_ROOT.
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id/:file", async (req, res) => {
  try {
    const { id, file } = req.params;
    const safeName     = safeFilename(file);

    if (!isAllowedExt(safeName)) {
      return res.status(403).send("File type not allowed");
    }

    const rootFilePath = path.join(projectRootDir(id), safeName);

    // Primary: serve from PROJECTS_ROOT (fast, sync)
    if (fs.existsSync(rootFilePath)) {
      const ext = path.extname(safeName).toLowerCase();
      const mimeMap = {
        ".html": "text/html; charset=utf-8",
        ".css":  "text/css; charset=utf-8",
        ".js":   "application/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg":  "image/svg+xml",
        ".png":  "image/png",
        ".jpg":  "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif":  "image/gif",
        ".ico":  "image/x-icon",
        ".woff": "font/woff",
        ".woff2":"font/woff2",
        ".ttf":  "font/ttf",
      };
      const mime = mimeMap[ext] || "application/octet-stream";
      res.setHeader("Content-Type", mime);
      res.setHeader("X-Frame-Options", "SAMEORIGIN");
      return res.sendFile(rootFilePath);
    }

    // Fallback: read from service data dir and mirror for next request
    try {
      const userId  = uid(req);
      const content = await svc.readSingleFile(id, safeName);

      // Mirror to PROJECTS_ROOT for future requests
      try {
        const dir = projectRootDir(id);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(rootFilePath, content, "utf8");
      } catch { /* mirror failed — not fatal */ }

      const ext = path.extname(safeName).toLowerCase();
      const textExts = [".html", ".css", ".js", ".json", ".svg", ".txt", ".md"];
      if (textExts.includes(ext)) {
        const mimeMap = {
          ".html": "text/html; charset=utf-8",
          ".css":  "text/css; charset=utf-8",
          ".js":   "application/javascript; charset=utf-8",
          ".json": "application/json; charset=utf-8",
          ".svg":  "image/svg+xml",
        };
        res.setHeader("Content-Type", mimeMap[ext] || "text/plain; charset=utf-8");
        res.setHeader("X-Frame-Options", "SAMEORIGIN");
        return res.send(content);
      }

      return res.status(404).send("File not found");
    } catch {
      return res.status(404).send("File not found");
    }
  } catch (err) {
    console.error("[PROJECT ENGINE] GET /:id/:file error:", err.message);
    res.status(500).send("Error serving file");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /workspace/project/:id
// Removes both PROJECTS_ROOT dir and service data dir.
// ─────────────────────────────────────────────────────────────────────────────

router.delete("/:id", async (req, res) => {
  try {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ success: false, error: "Unauthorized" });

    // Verify ownership
    const meta = readMeta(req.params.id);
    if (meta && meta.userId && meta.userId !== String(userId)) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    // Remove from PROJECTS_ROOT (iframe serving dir)
    const rootDir = projectRootDir(req.params.id);
    if (fs.existsSync(rootDir)) {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }

    // Remove from service data dir (canonical)
    await svc.deleteProjectById(userId, req.params.id);

    res.json({ success: true });
  } catch (err) {
    handleErr(res, err);
  }
});

module.exports = router;
