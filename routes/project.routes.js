/**
 * project.routes.js — Aquiplex AI Website Execution Engine  [FIXED v2]
 *
 * Mounted at: /workspace/project
 *
 * BUGFIX CHANGELOG:
 * - [FIX-1] GET /:id now calls res.render("workspace", {...}) instead of res.json(...)
 *           This was the root cause: the browser was receiving raw JSON instead of HTML.
 * - [FIX-2] Added GET /api/:id — dedicated JSON endpoint for programmatic consumers.
 *           API routes are always prefixed /api/ to prevent mixing concerns.
 * - [FIX-3] GET /:id fetches the user's full workspace + bundles so workspace.ejs
 *           receives the same data shape as GET /workspace (workspace_routes.js line 99).
 *
 * ROUTES:
 *   POST   /workspace/project/create       → create new project + folder
 *   POST   /workspace/project/generate     → AI + template hybrid generation
 *   POST   /workspace/project/edit         → AI edits file via natural language
 *   GET    /workspace/project/list         → list user's projects
 *   GET    /workspace/project/:id          → [FIXED] render workspace SPA, auto-open builder
 *   GET    /workspace/project/api/:id      → [NEW]   JSON metadata (for programmatic use)
 *   GET    /workspace/project/:id/files    → list files in project
 *   GET    /workspace/project/:id/:file    → serve raw file (for iframe)
 *   DELETE /workspace/project/:id          → delete project
 */

"use strict";

const express  = require("express");
const router   = express.Router();
const fs       = require("fs");
const path     = require("path");
const { v4: uuidv4 } = require("uuid");
const axios    = require("axios");

// ── Models needed for workspace render ───────────────────────────────────────
// [FIX-3] project route must pull the same data that workspace_routes.js GET /
// passes to the EJS template: { workspace, bundles, page }
const Workspace = require("../models/Workspace");
const Bundle    = require("../models/Bundle");

// ── Builder service ───────────────────────────────────────────────────────────
const builderService = require("../services/builder.service");

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

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

function projectDir(projectId) {
  return path.join(PROJECTS_ROOT, projectId);
}

function readMeta(projectId) {
  try {
    const p = path.join(projectDir(projectId), "meta.json");
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeMeta(projectId, data) {
  const p = path.join(projectDir(projectId), "meta.json");
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}

function extractJSON(raw) {
  if (!raw) throw new Error("AI returned empty response");
  let cleaned = raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end   = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found in AI response");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function safeFilename(name) {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isAllowedExt(filename) {
  const allowed = [".html", ".css", ".js", ".json", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf"];
  return allowed.includes(path.extname(filename).toLowerCase());
}

function normalizeFiles(filesOutput) {
  if (!filesOutput) return {};
  if (!Array.isArray(filesOutput) && typeof filesOutput === "object") return filesOutput;
  if (Array.isArray(filesOutput)) {
    const result = {};
    for (const f of filesOutput) {
      if (f.name && f.content !== undefined) result[f.name] = f.content;
    }
    return result;
  }
  return {};
}

async function callAIForEdit(systemPrompt, userPrompt) {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user",   content: userPrompt   },
  ];

  async function tryProvider(fn) {
    try { return await fn(); } catch { return null; }
  }

  const groqResult = await tryProvider(async () => {
    const res = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      { model: "llama-3.1-70b-versatile", messages, temperature: 0.3, max_tokens: 8192 },
      { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" }, timeout: 45000 }
    );
    const raw = res.data?.choices?.[0]?.message?.content;
    if (!raw) throw new Error("empty");
    return raw;
  });
  if (groqResult) return groqResult;

  const orResult = await tryProvider(async () => {
    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      { model: "mistralai/mixtral-8x7b-instruct", messages, temperature: 0.3, max_tokens: 8192 },
      { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" }, timeout: 50000 }
    );
    const raw = res.data?.choices?.[0]?.message?.content;
    if (!raw) throw new Error("empty");
    return raw;
  });
  if (orResult) return orResult;

  throw new Error("All AI providers failed for edit.");
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/project/create  — UNCHANGED
// ─────────────────────────────────────────────────────────────────────────────

router.post("/create", async (req, res) => {
  try {
    const userId    = uid(req);
    const { name }  = req.body || {};
    const projectId = uuidv4();
    const dir       = projectDir(projectId);

    fs.mkdirSync(dir, { recursive: true });

    const meta = {
      projectId,
      userId: String(userId),
      name:   name || "Untitled Project",
      files:  [],
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
// POST /workspace/project/generate  — UNCHANGED
// ─────────────────────────────────────────────────────────────────────────────

router.post("/generate", async (req, res) => {
  try {
    const userId              = uid(req);
    const { projectId, prompt } = req.body || {};

    if (!projectId || !prompt) {
      return res.status(400).json({ success: false, error: "projectId and prompt are required" });
    }

    const meta = readMeta(projectId);
    if (!meta || meta.userId !== String(userId)) {
      return res.status(404).json({ success: false, error: "Project not found" });
    }

    const buildResult = await builderService.generate(prompt);
    const filesMap    = normalizeFiles(buildResult.files);
    const dir         = projectDir(projectId);
    const written     = [];

    for (const [filename, content] of Object.entries(filesMap)) {
      const safeName = safeFilename(filename);
      if (!safeName || !isAllowedExt(safeName)) continue;
      fs.writeFileSync(path.join(dir, safeName), content, "utf8");
      written.push(safeName);
    }

    meta.files     = written;
    meta.prompt    = prompt;
    meta.intent    = buildResult.intent;
    meta.source    = buildResult.source;
    meta.updatedAt = new Date().toISOString();
    writeMeta(projectId, meta);

    console.log(`[Project Engine] Generated ${written.length} files via ${buildResult.source} (intent: ${buildResult.intent})`);

    res.json({
      success: true,
      projectId,
      files:   written,
      source:  buildResult.source,
      intent:  buildResult.intent,
    });
  } catch (err) {
    console.error("[Project Engine] /generate unexpected error:", err);
    handleErr(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/project/edit  — UNCHANGED
// ─────────────────────────────────────────────────────────────────────────────

router.post("/edit", async (req, res) => {
  try {
    const userId = uid(req);
    const { projectId, command, filename = "index.html" } = req.body || {};

    if (!projectId || !command) {
      return res.status(400).json({ success: false, error: "projectId and command are required" });
    }

    const meta = readMeta(projectId);
    if (!meta || meta.userId !== String(userId)) {
      return res.status(404).json({ success: false, error: "Project not found" });
    }

    const safeName = safeFilename(filename);
    const filePath = path.join(projectDir(projectId), safeName);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: `File ${safeName} not found in project` });
    }

    const currentContent = fs.readFileSync(filePath, "utf8");

    const systemPrompt = `You are an expert web developer editing an existing file.

CRITICAL RULES:
1. Return ONLY the complete, updated file content. No explanation, no markdown, no code fences.
2. Apply the user's instruction to the existing code exactly.
3. Preserve everything not mentioned in the instruction.
4. Return raw file content only — the exact bytes that should be written to ${safeName}.`;

    const userPrompt = `Current ${safeName} content:
${currentContent}

Instruction: ${command}

Return ONLY the updated complete file content. Nothing else.`;

    const updatedContent = await callAIForEdit(systemPrompt, userPrompt);

    const cleanContent = updatedContent
      .replace(/^```[a-zA-Z]*\n?/gm, "")
      .replace(/^```\n?/gm, "")
      .trim();

    fs.writeFileSync(filePath, cleanContent, "utf8");

    meta.updatedAt = new Date().toISOString();
    writeMeta(projectId, meta);

    res.json({ success: true, projectId, filename: safeName, updated: true });
  } catch (err) {
    handleErr(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /workspace/project/list  — UNCHANGED
// ─────────────────────────────────────────────────────────────────────────────

router.get("/list", async (req, res) => {
  try {
    const userId   = String(uid(req));
    const projects = [];

    if (!fs.existsSync(PROJECTS_ROOT)) {
      return res.json({ success: true, projects: [] });
    }

    const dirs = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const dir of dirs) {
      const meta = readMeta(dir);
      if (meta && meta.userId === userId) {
        projects.push({
          projectId:  meta.projectId,
          name:       meta.name,
          files:      meta.files || [],
          createdAt:  meta.createdAt,
          updatedAt:  meta.updatedAt,
        });
      }
    }

    projects.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    res.json({ success: true, projects });
  } catch (err) {
    handleErr(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// [NEW] GET /workspace/project/api/:id  — JSON metadata for programmatic use
//
// Kept here so AJAX callers that previously hit /:id for JSON continue to work
// after the fix. Prefix all API-only routes with /api/ to prevent collisions
// with view routes.
// ─────────────────────────────────────────────────────────────────────────────

router.get("/api/:id", async (req, res) => {
  try {
    const userId = String(uid(req));
    const meta   = readMeta(req.params.id);

    if (!meta || meta.userId !== userId) {
      return res.status(404).json({ success: false, error: "Project not found" });
    }

    res.json({
      success: true,
      project: {
        projectId:  meta.projectId,
        name:       meta.name,
        files:      meta.files || [],
        createdAt:  meta.createdAt,
        updatedAt:  meta.updatedAt,
      },
    });
  } catch (err) {
    handleErr(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// [FIXED] GET /workspace/project/:id  — Render workspace SPA, auto-open builder
//
// ROOT CAUSE OF BUG:
//   The old code did res.json({ success: true, project: {...} }) here.
//   The browser received raw JSON instead of HTML, so no UI rendered.
//
// FIX:
//   1. Validate the project belongs to the user (unchanged).
//   2. Load the same workspace + bundles data that GET /workspace loads
//      (workspace_routes.js line 87-99) so workspace.ejs gets everything it needs.
//   3. Pass `openProjectId` as an extra EJS variable — workspace.ejs uses
//      this to auto-open the Site Builder panel for this project on load.
//   4. Call res.render("workspace", {...}) — NOT res.json().
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id", async (req, res, next) => {
  // Guard: skip reserved keyword segments so they fall through to their own routes
  const reserved = ["create", "generate", "edit", "list", "api"];
  if (reserved.includes(req.params.id)) return next();

  try {
    const userId = uid(req);
    if (!userId) return res.redirect("/login");

    // 1. Validate project ownership
    const meta = readMeta(req.params.id);
    if (!meta || meta.userId !== String(userId)) {
      return res.status(404).render("error", {
        message: "Project not found or you don't have access to it.",
        status:  404,
      });
    }

    // 2. Load workspace + bundles — same query as workspace_routes.js GET /
    let ws = await Workspace.findOne({ userId }).populate("tools").lean();
    if (!ws) {
      ws = await new Workspace({ userId }).save();
      ws = ws.toObject ? ws.toObject() : ws;
    }
    if (ws.workspaceMemory instanceof Map) {
      ws.workspaceMemory = Object.fromEntries(ws.workspaceMemory);
    }
    const bundles = await Bundle.find({ userId }).sort({ updatedAt: -1 }).lean();

    // 3. Render workspace.ejs with the same data shape it always expects,
    //    PLUS openProjectId so the client-side JS knows which project to open.
    return res.render("workspace", {
      workspace:     ws,
      bundles,
      page:          "workspace",
      openProjectId: meta.projectId,   // ← NEW: tells the SPA to auto-open this project
      openProjectName: meta.name,      // ← NEW: avoids an extra fetch for the project name
    });
  } catch (err) {
    console.error("[PROJECT ENGINE] GET /:id render error:", err);
    res.status(500).send("Failed to load workspace for this project.");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /workspace/project/:id/files  — UNCHANGED
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id/files", async (req, res) => {
  try {
    const userId = String(uid(req));
    const meta   = readMeta(req.params.id);

    if (!meta || meta.userId !== userId) {
      return res.status(404).json({ success: false, error: "Project not found" });
    }

    const dir   = projectDir(req.params.id);
    const files = fs.readdirSync(dir)
      .filter(f => f !== "meta.json" && isAllowedExt(f));

    res.json({ success: true, files });
  } catch (err) {
    handleErr(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /workspace/project/:id/:file  — UNCHANGED
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id/:file", (req, res) => {
  try {
    const { id, file } = req.params;
    const safeName     = safeFilename(file);

    if (!isAllowedExt(safeName)) {
      return res.status(403).send("File type not allowed");
    }

    const filePath = path.join(projectDir(id), safeName);

    if (!fs.existsSync(filePath)) {
      return res.status(404).send("File not found");
    }

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
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).send("Error serving file");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /workspace/project/:id  — UNCHANGED
// ─────────────────────────────────────────────────────────────────────────────

router.delete("/:id", async (req, res) => {
  try {
    const userId = String(uid(req));
    const meta   = readMeta(req.params.id);

    if (!meta || meta.userId !== userId) {
      return res.status(404).json({ success: false, error: "Project not found" });
    }

    const dir = projectDir(req.params.id);
    fs.rmSync(dir, { recursive: true, force: true });

    res.json({ success: true });
  } catch (err) {
    handleErr(res, err);
  }
});

module.exports = router;
