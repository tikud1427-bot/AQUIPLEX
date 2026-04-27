/**
 * project.routes.js — Aquiplex AI Website Execution Engine  [UPGRADED]
 *
 * Mounted at: /workspace/project
 *
 * UPGRADE CHANGELOG:
 * - [UPGRADE-1] POST /generate now uses builderService.generate(prompt)
 *               → intent detection + AI generation + template fallback
 *               → ZERO FAILURE: always returns a working result
 * - [UPGRADE-2] Accepts both old array format { files: [...] }
 *               and new object format { files: { "name": "content" } }
 * - [UPGRADE-3] Logs source (ai | template | nuclear_fallback) for debugging
 *
 * ALL OTHER ROUTES: UNCHANGED — backward compatible.
 *
 * ROUTES:
 *   POST   /workspace/project/create       → create new project + folder
 *   POST   /workspace/project/generate     → AI + template hybrid generation [UPGRADED]
 *   POST   /workspace/project/edit         → AI edits file via natural language
 *   GET    /workspace/project/list         → list user's projects
 *   GET    /workspace/project/:id          → project metadata
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

// ── [UPGRADE-1] Import builder service ────────────────────────────────────────
const builderService = require("../services/builder.service");

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const PROJECTS_ROOT = path.join(process.cwd(), "projects");

// Ensure projects root exists on startup
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

/** Resolve the project folder path */
function projectDir(projectId) {
  return path.join(PROJECTS_ROOT, projectId);
}

/** Read the project manifest (meta.json) safely */
function readMeta(projectId) {
  try {
    const p = path.join(projectDir(projectId), "meta.json");
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** Write the project manifest */
function writeMeta(projectId, data) {
  const p = path.join(projectDir(projectId), "meta.json");
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}

/**
 * Strip markdown fences and extract JSON from AI response.
 * Kept for the /edit route which still uses direct AI calls.
 */
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

/** Sanitize a filename to prevent path traversal */
function safeFilename(name) {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** Check if a file extension is allowed to be served */
function isAllowedExt(filename) {
  const allowed = [".html", ".css", ".js", ".json", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf"];
  return allowed.includes(path.extname(filename).toLowerCase());
}

/**
 * [UPGRADE-2] Normalize builder output to { filename: content } map.
 * Builder returns { files: { "index.html": "..." } } (object format).
 * Old code used { files: [{ name, content }] } (array format).
 * This handles both for backward compatibility.
 */
function normalizeFiles(filesOutput) {
  if (!filesOutput) return {};

  // Object format (new): { "index.html": "content" }
  if (!Array.isArray(filesOutput) && typeof filesOutput === "object") {
    return filesOutput;
  }

  // Array format (old): [{ name: "index.html", content: "..." }]
  if (Array.isArray(filesOutput)) {
    const result = {};
    for (const f of filesOutput) {
      if (f.name && f.content !== undefined) {
        result[f.name] = f.content;
      }
    }
    return result;
  }

  return {};
}

/**
 * Multi-provider AI call for single file edits — unchanged from original.
 */
async function callAIForEdit(systemPrompt, userPrompt) {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user",   content: userPrompt   },
  ];

  async function tryProvider(fn) {
    try { return await fn(); } catch { return null; }
  }

  // Groq
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

  // OpenRouter
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
// POST /workspace/project/generate  — [UPGRADED] Uses Builder Service
// Body: { projectId, prompt }
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

    // ── [UPGRADE-1] Call builder service (never throws) ────────────────────
    const buildResult = await builderService.generate(prompt);

    // buildResult is always { files: {...}, source: "ai"|"template"|..., intent: "..." }
    const filesMap = normalizeFiles(buildResult.files);

    const dir     = projectDir(projectId);
    const written = [];

    for (const [filename, content] of Object.entries(filesMap)) {
      if (!filename || content === undefined) continue;
      const safeName = safeFilename(filename);
      const filePath = path.join(dir, safeName);
      fs.writeFileSync(filePath, content, "utf8");
      written.push(safeName);
    }

    // Update meta
    meta.files     = written;
    meta.prompt    = prompt;
    meta.intent    = buildResult.intent;   // [UPGRADE-3] store intent for debugging
    meta.source    = buildResult.source;   // [UPGRADE-3] store source
    meta.updatedAt = new Date().toISOString();
    writeMeta(projectId, meta);

    console.log(`[Project Engine] Generated ${written.length} files via ${buildResult.source} (intent: ${buildResult.intent})`);

    res.json({
      success: true,
      projectId,
      files:   written,
      source:  buildResult.source,   // "ai" | "template" | "nuclear_fallback"
      intent:  buildResult.intent,
    });

  } catch (err) {
    // Even if something unexpected explodes, don't surface raw error to user
    console.error("[Project Engine] /generate unexpected error:", err);
    handleErr(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/project/edit  — UNCHANGED
// Body: { projectId, command, filename? }
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

    // Strip any accidental code fences from response
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
// GET /workspace/project/:id  — UNCHANGED
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id", async (req, res, next) => {
  const reserved = ["create", "generate", "edit", "list"];
  if (reserved.includes(req.params.id)) return next();

  try {
    const userId = String(uid(req));
    const meta   = readMeta(req.params.id);

    if (!meta || meta.userId !== userId) {
      return res.status(404).json({ success: false, error: "Project not found" });
    }

    res.json({ success: true, project: {
      projectId:  meta.projectId,
      name:       meta.name,
      files:      meta.files || [],
      createdAt:  meta.createdAt,
      updatedAt:  meta.updatedAt,
    }});
  } catch (err) {
    handleErr(res, err);
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
