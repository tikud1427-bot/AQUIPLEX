/**
 * project.routes.js — Aquiplex AI Website Execution Engine
 *
 * Mounted at: /workspace/project
 * Requires: requireLogin middleware from index.js
 *
 * ROUTES:
 *   POST   /workspace/project/create       → create new project + folder
 *   POST   /workspace/project/generate     → AI generates + writes files
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

/** Resolve the project folder path and verify it belongs to the user */
function projectDir(projectId) {
  const dir = path.join(PROJECTS_ROOT, projectId);
  return dir;
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
 * Handles:
 *   - ```json ... ```
 *   - ``` ... ```
 *   - Trailing/leading prose
 */
function extractJSON(raw) {
  if (!raw) throw new Error("AI returned empty response");

  // Remove code fences
  let cleaned = raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  // Find first { to last }
  const start = cleaned.indexOf("{");
  const end   = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found in AI response");

  cleaned = cleaned.slice(start, end + 1);
  return JSON.parse(cleaned);
}

/**
 * Sanitize a filename to prevent path traversal.
 */
function safeFilename(name) {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Check if a file extension is allowed to be served.
 */
function isAllowedExt(filename) {
  const allowed = [".html", ".css", ".js", ".json", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf"];
  return allowed.includes(path.extname(filename).toLowerCase());
}

/**
 * Multi-provider AI call for structured JSON output.
 * Returns parsed { files: [...] } object.
 */
async function callAIForFiles(systemPrompt, userPrompt) {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user",   content: userPrompt   },
  ];

  // 1. Try Groq
  try {
    const res = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.1-70b-versatile",
        messages,
        temperature: 0.4,
        max_tokens: 8192,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 45000,
      }
    );
    const raw = res.data?.choices?.[0]?.message?.content;
    if (raw) return extractJSON(raw);
  } catch (err) {
    console.warn("[AI:Groq] failed:", err.message);
  }

  // 2. Try OpenRouter
  try {
    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "mistralai/mixtral-8x7b-instruct",
        messages,
        temperature: 0.4,
        max_tokens: 8192,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 50000,
      }
    );
    const raw = res.data?.choices?.[0]?.message?.content;
    if (raw) return extractJSON(raw);
  } catch (err) {
    console.warn("[AI:OpenRouter] failed:", err.message);
  }

  // 3. Try Gemini
  try {
    const geminiKey = process.env.Gemini_API_Key;
    if (geminiKey) {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`,
        {
          contents: [
            { role: "user", parts: [{ text: systemPrompt + "\n\n" + userPrompt }] }
          ],
          generationConfig: { temperature: 0.4, maxOutputTokens: 8192 },
        },
        { timeout: 40000 }
      );
      const raw = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (raw) return extractJSON(raw);
    }
  } catch (err) {
    console.warn("[AI:Gemini] failed:", err.message);
  }

  throw new Error("All AI providers failed. Check API keys.");
}

/**
 * Call AI for a single file edit (returns updated file content string).
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
// POST /workspace/project/create
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
// POST /workspace/project/generate
// Body: { projectId, prompt }
// ─────────────────────────────────────────────────────────────────────────────

router.post("/generate", async (req, res) => {
  try {
    const userId             = uid(req);
    const { projectId, prompt } = req.body || {};

    if (!projectId || !prompt) {
      return res.status(400).json({ success: false, error: "projectId and prompt are required" });
    }

    const meta = readMeta(projectId);
    if (!meta || meta.userId !== String(userId)) {
      return res.status(404).json({ success: false, error: "Project not found" });
    }

    const systemPrompt = `You are an expert web developer. Generate complete, production-quality websites.

CRITICAL RULES:
1. Respond ONLY with a valid JSON object. No prose, no markdown, no explanation.
2. The JSON must match this exact schema:
   {
     "files": [
       { "name": "index.html", "content": "..." },
       { "name": "style.css",  "content": "..." },
       { "name": "script.js",  "content": "..." }
     ]
   }
3. Always include at minimum: index.html, style.css
4. Use modern HTML5, CSS3 (flexbox/grid), vanilla JS
5. Make the site visually stunning — real gradients, animations, professional typography
6. ALL CSS must be in style.css (linked from index.html). ALL JS in script.js (linked from index.html)
7. index.html must link style.css as: <link rel="stylesheet" href="style.css">
8. index.html must link script.js as: <script src="script.js"></script> (if JS is needed)
9. No external dependencies — inline fonts via Google Fonts @import in CSS only
10. Content must be realistic, detailed and filled-in — no placeholder text like "Lorem ipsum"`;

    const userPrompt = `Build this website: ${prompt}

Respond with ONLY the JSON object. Do not include any text before or after the JSON.`;

    const result = await callAIForFiles(systemPrompt, userPrompt);

    if (!result.files || !Array.isArray(result.files) || result.files.length === 0) {
      throw new Error("AI did not return any files");
    }

    const dir      = projectDir(projectId);
    const written  = [];

    for (const file of result.files) {
      if (!file.name || file.content === undefined) continue;
      const safeName = safeFilename(file.name);
      const filePath = path.join(dir, safeName);
      fs.writeFileSync(filePath, file.content, "utf8");
      written.push(safeName);
    }

    // Update meta
    meta.files     = written;
    meta.prompt    = prompt;
    meta.updatedAt = new Date().toISOString();
    writeMeta(projectId, meta);

    res.json({ success: true, projectId, files: written });
  } catch (err) {
    handleErr(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/project/edit
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
// GET /workspace/project/list
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
// GET /workspace/project/:id  — project metadata
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id", async (req, res, next) => {
  // Skip if :id is a known sub-route keyword to avoid conflicts
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
// GET /workspace/project/:id/files  — list files
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
// GET /workspace/project/:id/:file  — serve project file for iframe preview
// NOTE: This route intentionally does NOT require login — the iframe needs
//       to load files. Security is via unguessable UUID project IDs.
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

    // Set correct content type
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
// DELETE /workspace/project/:id
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
