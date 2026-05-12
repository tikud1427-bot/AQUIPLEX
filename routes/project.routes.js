// FILE: routes/project.routes.js
"use strict";

const express        = require("express");
const router         = express.Router();
const fs             = require("fs");
const path           = require("path");
const { v4: uuidv4 } = require("uuid");

const Workspace = require("../models/Workspace");
const Bundle    = require("../models/Bundle");
const svc       = require("../workspace/workspace.service");
const { createLogger }            = require("../utils/logger");
const { asyncHandler, sendError } = require("../middleware/asyncHandler");

const log = createLogger("PROJECT_ROUTE");

// ── Config ────────────────────────────────────────────────────────────────────

const PROJECTS_ROOT = path.join(process.cwd(), "projects");
if (!fs.existsSync(PROJECTS_ROOT)) fs.mkdirSync(PROJECTS_ROOT, { recursive: true });

const MIME_MAP = {
  ".html": "text/html; charset=utf-8",   ".htm": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",    ".js":  "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",  ".png": "image/png",
  ".jpg":  "image/jpeg",     ".jpeg": "image/jpeg",
  ".gif":  "image/gif",      ".ico": "image/x-icon",
  ".woff": "font/woff",      ".woff2": "font/woff2",  ".ttf": "font/ttf",
  ".txt":  "text/plain; charset=utf-8",  ".md": "text/plain; charset=utf-8",
};
const ALLOWED_EXTENSIONS = new Set(Object.keys(MIME_MAP));
const RESERVED = new Set(["create", "generate", "edit", "list", "api", "preview", "files"]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid(req) {
  return (
    req.session?.userId    ||
    req.session?.user?._id ||
    req.user?._id          ||
    req.user?.id           ||
    null
  );
}

function projectRootDir(projectId) {
  const safe = path.basename(projectId);
  if (!safe || safe !== projectId) throw new Error("Invalid projectId");
  return path.join(PROJECTS_ROOT, safe);
}

/**
 * safeResolvePath — resolves a relative path inside a project dir.
 * Returns null if the resolved path escapes the project root.
 */
function safeResolvePath(projectId, relPath) {
  const projectDir = path.resolve(projectRootDir(projectId));
  // Normalise: strip leading traversal segments, collapse ..
  const normalised = path
    .normalize(relPath)
    .replace(/^(\.\.([/\\]|$))+/, "");
  const resolved = path.resolve(projectDir, normalised);
  // Must remain strictly inside projectDir
  if (resolved !== projectDir && !resolved.startsWith(projectDir + path.sep)) return null;
  return resolved;
}

function isAllowedExt(filename) {
  return ALLOWED_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

function readMeta(projectId) {
  try {
    const metaPath = path.join(projectRootDir(projectId), "meta.json");
    if (!fs.existsSync(metaPath)) return null;
    return JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch { return null; }
}

function writeMeta(projectId, data) {
  try {
    const dir = projectRootDir(projectId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    log.warn(`writeMeta failed: ${e.message}`);
  }
}

function mirrorFilesToRoot(projectId, files) {
  const dir = projectRootDir(projectId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  for (const file of files) {
    try {
      if (!file?.fileName || file.content === undefined) continue;
      const safeName = path.basename(file.fileName);
      if (!safeName || !isAllowedExt(safeName)) continue;
      const destPath = path.join(dir, safeName);
      // Path traversal guard
      if (!destPath.startsWith(path.resolve(dir) + path.sep)) continue;
      fs.writeFileSync(destPath, file.content, "utf8");
      log.info(`Mirrored: ${safeName} → ${dir}`);
    } catch (e) {
      log.warn(`mirrorFilesToRoot: failed to write ${file.fileName}: ${e.message}`);
    }
  }
}

function setCacheControlNoStore(req, res, next) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  next();
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.post("/create", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);

  const { name } = req.body || {};
  const projectId = uuidv4();

  await svc.createProject(userId, name, projectId);
  writeMeta(projectId, {
    projectId,
    userId:    String(userId),
    name:      name || "Untitled Project",
    files:     [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  res.json({ success: true, projectId, name: name || "Untitled Project" });
}));

router.post("/generate", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);

  const { prompt, projectId, name } = req.body || {};
  if (!prompt)    return sendError(res, "prompt required", 400);
  if (!projectId) return sendError(res, "projectId required", 400);

  const result = await svc.generateProject(userId, projectId, prompt);

  if (Array.isArray(result.fileData) && result.fileData.length > 0) {
    mirrorFilesToRoot(result.projectId, result.fileData);
    writeMeta(result.projectId, {
      projectId: result.projectId,
      userId:    String(userId),
      name:      result.name || name || "Untitled Project",
      files:     result.fileData.map(f => f.fileName),
      updatedAt: new Date().toISOString(),
    });
  }

  res.json(result);
}));

router.post("/edit", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);

  const { projectId, fileName, instruction } = req.body || {};
  if (!projectId || !fileName || !instruction) {
    return sendError(res, "projectId, fileName, and instruction required", 400);
  }

  const result = await svc.editProjectFile(userId, projectId, fileName, instruction);

  if (Array.isArray(result.updatedFiles)) {
    for (const updatedFileName of result.updatedFiles) {
      try {
        const content  = await svc.readSingleFile(projectId, updatedFileName);
        const dir      = projectRootDir(projectId);
        const safeName = path.basename(updatedFileName);
        if (safeName && isAllowedExt(safeName)) {
          const destPath = path.join(dir, safeName);
          // Path traversal guard
          if (!destPath.startsWith(path.resolve(dir) + path.sep)) continue;
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(destPath, content, "utf8");
        }
      } catch (e) {
        log.warn(`post-edit mirror failed: ${e.message}`);
      }
    }
  }

  res.json(result);
}));

router.get("/list", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);
  res.json(await svc.getProjectList(userId));
}));

router.get("/api/:id", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);
  const result = await svc.getProjectFiles(userId, req.params.id);
  res.json({ success: true, ...result });
}));

router.use("/:id/preview", setCacheControlNoStore, async (req, res) => {
  try {
    const { id }  = req.params;
    const relPath = (req.path && req.path !== "/") ? req.path.slice(1) : "index.html";
    const target  = relPath || "index.html";
    const ext     = path.extname(target).toLowerCase();

    if (!ALLOWED_EXTENSIONS.has(ext) && ext !== "") return res.status(403).send("File type not allowed.");

    const absPath = safeResolvePath(id, target);
    if (!absPath) return res.status(400).send("Invalid file path.");

    const mimeType = MIME_MAP[ext] || "application/octet-stream";

    if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
      res.setHeader("Content-Type", mimeType);
      res.setHeader("X-Frame-Options", "SAMEORIGIN");
      return res.sendFile(absPath);
    }

    let content;
    try {
      content = await svc.readSingleFile(id, path.basename(target));
    } catch {
      return res.status(404).send("File not found.");
    }

    try {
      const dir = path.dirname(absPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(absPath, content, "utf8");
    } catch { /* non-fatal */ }

    res.setHeader("Content-Type", mimeType);
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    return res.send(content);
  } catch (err) {
    log.error(`GET /:id/preview/* error: ${err.message}`);
    res.status(500).send("Error serving preview file.");
  }
});

router.get("/:id/files", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);
  const result = await svc.getProjectFiles(userId, req.params.id);
  res.json({ success: true, files: result.files, projectId: req.params.id });
}));

router.get("/:id", async (req, res, next) => {
  if (RESERVED.has(req.params.id)) return next();
  try {
    const userId = uid(req);
    if (!userId) return res.redirect("/login");

    let projectName = null;
    const meta = readMeta(req.params.id);

    if (meta) {
      if (meta.userId && meta.userId !== String(userId)) {
        return res.status(403).render("error", { message: "You do not have access to this project.", status: 403 });
      }
      projectName = meta.name;
    } else {
      try {
        const svcResult = await svc.getProjectFiles(userId, req.params.id);
        projectName     = svcResult.name || "Project";
      } catch {
        return res.status(404).render("error", { message: "Project not found.", status: 404 });
      }
    }

    let ws = await Workspace.findOne({ userId }).populate("tools").lean();
    if (!ws) {
      ws = await new Workspace({ userId }).save();
      ws = ws.toObject ? ws.toObject() : ws;
    }
    if (ws.workspaceMemory instanceof Map) ws.workspaceMemory = Object.fromEntries(ws.workspaceMemory);

    const bundles = await Bundle.find({ userId }).sort({ updatedAt: -1 }).lean();
    return res.render("workspace", {
      workspace: ws, bundles, page: "workspace",
      openProjectId: req.params.id, openProjectName: projectName,
    });
  } catch (err) {
    log.error(`GET /:id render error: ${err.message}`);
    res.status(500).send("Failed to load workspace for this project.");
  }
});

router.delete("/:id", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);

  const meta = readMeta(req.params.id);
  if (meta?.userId && meta.userId !== String(userId)) return sendError(res, "Access denied", 403);

  try {
    const rootDir = projectRootDir(req.params.id);
    if (fs.existsSync(rootDir)) fs.rmSync(rootDir, { recursive: true, force: true });
  } catch (e) {
    log.warn(`DELETE: failed to remove mirror dir: ${e.message}`);
  }

  await svc.deleteProjectById(userId, req.params.id);
  res.json({ success: true });
}));

// ── Project Brain routes ──────────────────────────────────────────────────────

const brain      = require("../engine/project.brain");
const deployGen  = require("../engine/deploy.generator");

/** GET /projects/:id/brain — get project intelligence */
router.get("/:id/brain", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);
  const b = await brain.loadBrain(req.params.id);
  res.json({ success: true, brain: b });
}));

/** GET /projects/:id/snapshots — list version snapshots */
router.get("/:id/snapshots", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);
  const snapshots = await brain.listSnapshots(req.params.id);
  res.json({ success: true, snapshots });
}));

/** POST /projects/:id/snapshots — create manual snapshot */
router.post("/:id/snapshots", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);
  const { label } = req.body;
  const { fileData } = await svc.getProjectFiles(userId, req.params.id);
  const version = await brain.saveSnapshot(req.params.id, fileData, label || "manual snapshot");
  res.json({ success: true, version });
}));

/** POST /projects/:id/rollback — restore to a snapshot version */
router.post("/:id/rollback", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);
  const { version } = req.body;
  const snap = await brain.getSnapshot(req.params.id, version);
  if (!snap) return sendError(res, "Snapshot not found", 404);

  // Restore snapshot files
  for (const f of snap.files) {
    await svc.writeSingleFile(req.params.id, f.fileName, f.content).catch(() => {});
  }

  res.json({ success: true, version: snap.version, label: snap.label, filesRestored: snap.files.length });
}));

/** GET /projects/:id/quality — get quality score for current files */
router.get("/:id/quality", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);
  const { validateAndRepair, isFullstackFileSet, scoreFullstackFiles, scoreFiles } = require("../engine/repair.engine");
  const { fileData } = await svc.getProjectFiles(userId, req.params.id);

  // Build fileMap to detect mode
  const fileMap = {};
  for (const f of fileData) fileMap[f.fileName || f.name] = f.content || "";
  const isFullstack = isFullstackFileSet(fileMap);

  const result = await validateAndRepair(fileData, { skipRepair: true });

  // Group issues by severity for easier UI rendering
  const grouped = { critical: [], warning: [], info: [] };
  for (const issue of (result.issues || [])) {
    (grouped[issue.severity] || grouped.info).push(issue);
  }

  res.json({
    success:    true,
    score:      result.score,
    passed:     result.passed,
    mode:       isFullstack ? "fullstack" : "frontend",
    issues:     result.issues,
    grouped,
    summary: {
      critical: grouped.critical.length,
      warning:  grouped.warning.length,
      info:     grouped.info.length,
      total:    result.issues.length,
    },
  });
}));

// ── Validation + Repair Route ─────────────────────────────────────────────────

/**
 * POST /projects/:id/repair
 *
 * Run the full validate → local-repair → (optional AI-repair) loop on the
 * current project files and save the repaired versions back to disk.
 *
 * Body: { aiRepair: true|false }  — defaults to false (local repairs only)
 *
 * Returns: { score, repairs[], issues[], mode, saved }
 */
router.post("/:id/repair", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);

  const { aiRepair = false } = req.body || {};
  const { fileData, projectId } = await svc.getProjectFiles(userId, req.params.id);
  if (!fileData?.length) return sendError(res, "Project has no files", 400);

  const { validateAndRepair } = require("../engine/repair.engine");

  // Build AI caller if requested
  let callAI = null;
  if (aiRepair) {
    const { _isModelHealthy, _withModelRetry, buildModelRegistry } = svc;
    if (buildModelRegistry) {
      callAI = async (messages) => {
        const models = buildModelRegistry();
        const model  = models.find(m => _isModelHealthy?.(m.id));
        if (!model) return null;
        return _withModelRetry?.(model, messages, "repair").catch(() => null);
      };
    }
  }

  const result = await validateAndRepair(fileData, { callAI, skipRepair: false });

  // Save repaired files back
  const saved = [];
  if (result.repairs.length > 0) {
    for (const file of result.files) {
      try {
        await svc.saveProjectFile(userId, req.params.id, file.fileName, file.content);
        saved.push(file.fileName);
      } catch (e) {
        log.warn(`repair: failed to save ${file.fileName}: ${e.message}`);
      }
    }
    log.info(`repair: ${req.params.id} saved ${saved.length} repaired files, score=${result.score}`);
  }

  res.json({
    success:  true,
    score:    result.score,
    passed:   result.passed,
    mode:     result.mode,
    repairs:  result.repairs,
    issues:   result.issues,
    saved,
    message:  result.repairs.length
      ? `${result.repairs.length} repairs applied, score: ${result.score}/100`
      : `No repairs needed, score: ${result.score}/100`,
  });
}));

// ── Deploy Config Routes ───────────────────────────────────────────────────────

/**
 * GET /projects/:id/deploy-targets
 * Returns available deploy targets for the project.
 */
router.get("/:id/deploy-targets", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);
  const b = await brain.loadBrain(req.params.id);
  const targets = deployGen.getAvailableTargets(b);
  res.json({ success: true, targets, isFullstack: b.isFullstack || false, deployTarget: b.deployTarget || null });
}));

/**
 * POST /projects/:id/deploy-configs
 * Generate and save deployment config files for the project.
 *
 * Body: { targets: ["vercel","docker"] }  — or omit for "auto"
 *
 * Returns the generated file list and saves them into the project store.
 */
router.post("/:id/deploy-configs", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);

  const { targets = ["auto"] } = req.body || {};

  // Load brain
  const b = await brain.loadBrain(req.params.id);
  if (!b) return sendError(res, "Project brain not found", 404);

  // Generate config files
  const configFiles = deployGen.generateDeployConfigs(b, targets);
  if (!configFiles.length) {
    return sendError(res, "No deploy configs generated for given targets", 400);
  }

  // Save each config file into the project store
  const saved = [];
  for (const file of configFiles) {
    try {
      await svc.saveProjectFile(userId, req.params.id, file.fileName, file.content);
      saved.push(file.fileName);

      // Mirror to disk for preview serving
      const dir      = projectRootDir(req.params.id);
      const safeName = path.basename(file.fileName);
      if (safeName && isAllowedExt(safeName)) {
        const destPath = path.join(dir, safeName);
        if (destPath.startsWith(path.resolve(dir) + path.sep) || destPath === path.resolve(dir)) {
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(destPath, file.content, "utf8");
        }
      }
    } catch (e) {
      log.warn(`deploy-configs: failed to save ${file.fileName}: ${e.message}`);
    }
  }

  log.info(`deploy-configs: ${req.params.id} saved [${saved.join(", ")}]`);

  res.json({
    success:  true,
    projectId: req.params.id,
    targets:  targets.includes("auto") ? deployGen.getAvailableTargets(b) : targets,
    files:    configFiles.map(f => ({ fileName: f.fileName, size: f.content.length })),
    saved,
  });
}));

// ── ZIP Export ─────────────────────────────────────────────────────────────────

/**
 * GET /projects/:id/export
 *
 * Downloads all project files as a ZIP archive.
 *
 * For fullstack projects the ZIP preserves subdirectory paths
 * (e.g. routes/users.js, models/User.js).
 * For frontend-only projects it's a flat ZIP.
 *
 * Always includes:
 *   - All source files from the project store
 *   - .aquiplex-meta.json (project metadata)
 *   - README.md if not already present (minimal fallback)
 */
router.get("/:id/export", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);

  // Load project files
  let projectData;
  try {
    projectData = await svc.getProjectFiles(userId, req.params.id);
  } catch (e) {
    return sendError(res, `Project not found: ${e.message}`, 404);
  }

  const { name, fileData, projectId } = projectData;
  if (!fileData || fileData.length === 0) {
    return sendError(res, "Project has no files to export", 400);
  }

  // Load brain for metadata (top-level brain require, not inline)
  let brainData = null;
  try {
    brainData = await brain.loadBrain(projectId);
  } catch { /* non-fatal */ }

  // Auto-generate deploy configs for fullstack projects
  let deployConfigFiles = [];
  if (brainData?.isFullstack) {
    try {
      deployConfigFiles = deployGen.generateDeployConfigs(brainData, ["auto"]);
      log.info(`ZIP export: bundling ${deployConfigFiles.length} deploy config files`);
    } catch (e) {
      log.warn(`ZIP export: deploy config gen failed: ${e.message}`);
    }
  }

  // Build ZIP using adm-zip
  const AdmZip = require("adm-zip");
  const zip    = new AdmZip();

  // Sanitise project name for use in folder name
  const safeName = (name || "project")
    .replace(/[^a-zA-Z0-9_\-. ]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40) || "aquiplex-project";

  const folderPrefix = safeName + "/";

  // Add each source file — preserve subdirectory paths
  const addedFiles = new Set();
  for (const file of fileData) {
    if (!file?.fileName || file.content === undefined) continue;

    const filePath = file.fileName.replace(/\\/g, "/").replace(/^\/+/, "");
    if (addedFiles.has(filePath)) continue;
    addedFiles.add(filePath);

    const content = typeof file.content === "string"
      ? Buffer.from(file.content, "utf8")
      : Buffer.from(String(file.content ?? ""), "utf8");

    // adm-zip: addFile(entryName, buffer)
    zip.addFile(folderPrefix + filePath, content);
  }

  // Add deploy config files (skip any already present from source files)
  for (const dcFile of deployConfigFiles) {
    const dcPath = dcFile.fileName.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!addedFiles.has(dcPath)) {
      addedFiles.add(dcPath);
      zip.addFile(folderPrefix + dcPath, Buffer.from(dcFile.content || "", "utf8"));
    }
  }

  // Inject README.md if missing
  if (!addedFiles.has("README.md")) {
    const isFullstack = brainData?.isFullstack;
    const stack       = brainData?.stack || {};
    const routes      = brainData?.routes || [];
    const envVars     = brainData?.envVars || [];
    const deployTarget = brainData?.deployTarget || "node";

    const routeDocs = routes.length
      ? "\n## API Routes\n" + routes.map(r => `- \`${r.method} ${r.path}\` — ${r.description}`).join("\n")
      : "";

    const envDocs = envVars.length
      ? "\n## Environment Variables\n" + envVars.map(v => `- \`${v}\``).join("\n")
      : "";

    const deploySection = isFullstack ? `
## Deployment (${deployTarget})

### Render / Railway
1. Connect this repo to Render or Railway
2. Set build command: \`npm install\`
3. Set start command: \`node server.js\`
4. Add environment variables from \`.env.example\`

### Vercel (serverless)
Add a \`vercel.json\`:
\`\`\`json
{ "version": 2, "builds": [{ "src": "server.js", "use": "@vercel/node" }] }
\`\`\`
` : "";

    const readme = `# ${name || "My Project"}

Generated by [AQUIPLEX](https://aquiplex.com) — AI Software Development Platform.

## Quick Start

\`\`\`bash
${isFullstack ? "npm install\ncp .env.example .env\n# Edit .env with your values\nnode server.js" : "# Open index.html in your browser"}
\`\`\`
${isFullstack ? `
## Stack
- Frontend: ${stack.frontend || "vanilla"} HTML/CSS/JS
- Backend: Node.js + Express
- Database: ${stack.database || "none"}
- Auth: ${stack.auth || "none"}` : ""}
${routeDocs}
${envDocs}
${deploySection}
---
*Generated by AQUIPLEX on ${new Date().toISOString().slice(0, 10)}*
`;
    zip.addFile(folderPrefix + "README.md", Buffer.from(readme, "utf8"));
  }

  // Inject .aquiplex-meta.json
  const meta = {
    projectId,
    name,
    exportedAt: new Date().toISOString(),
    files:      [...addedFiles],
    isFullstack: brainData?.isFullstack || false,
    stack:       brainData?.stack || null,
    deployTarget: brainData?.deployTarget || null,
    deployConfigs: deployConfigFiles.map(f => f.fileName),
    generatedBy: "AQUIPLEX",
  };
  zip.addFile(folderPrefix + ".aquiplex-meta.json", Buffer.from(JSON.stringify(meta, null, 2), "utf8"));

  // Stream ZIP to client
  const zipBuffer   = zip.toBuffer();
  const zipFileName = `${safeName}.zip`;

  log.info(`ZIP export: ${projectId} → ${zipFileName} (${fileData.length} files, ${zipBuffer.length} bytes)`);

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${zipFileName}"`);
  res.setHeader("Content-Length", zipBuffer.length);
  res.setHeader("Cache-Control", "no-store");
  res.end(zipBuffer);
}));

// ── Share / Public Preview Routes ─────────────────────────────────────────────

const SHARE_INDEX_PATH = path.join(PROJECTS_ROOT, "_share_index.json");

/** Load the global shareId → projectId map */
function loadShareIndex() {
  try { return JSON.parse(fs.readFileSync(SHARE_INDEX_PATH, "utf8")); }
  catch { return {}; }
}

/** Save the global shareId → projectId map */
function saveShareIndex(index) {
  fs.writeFileSync(SHARE_INDEX_PATH, JSON.stringify(index, null, 2), "utf8");
}

/** Read _index.json for a project */
function readProjectIndex(projectId) {
  const indexPath = path.join(projectRootDir(projectId), "_index.json");
  try { return JSON.parse(fs.readFileSync(indexPath, "utf8")); }
  catch { return null; }
}

/** Write updated _index.json for a project */
function writeProjectIndex(projectId, data) {
  const indexPath = path.join(projectRootDir(projectId), "_index.json");
  fs.writeFileSync(indexPath, JSON.stringify(data, null, 2), "utf8");
}

/**
 * POST /projects/:id/share
 * Create a public share link for the project.
 * Returns: { shareId, shareUrl, expiresAt? }
 */
router.post("/:id/share", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);

  const projectId = req.params.id;
  const projIndex = readProjectIndex(projectId);
  if (!projIndex) return sendError(res, "Project not found", 404);

  // Reuse existing shareId or generate new one
  let shareId = projIndex.shareId;
  if (!shareId) {
    shareId = require("crypto").randomBytes(10).toString("hex"); // 20-char hex
  }

  // Update _index.json
  projIndex.shareId   = shareId;
  projIndex.isPublic  = true;
  projIndex.sharedAt  = new Date().toISOString();
  projIndex.sharedBy  = String(userId);
  writeProjectIndex(projectId, projIndex);

  // Update global share index
  const shareIndex = loadShareIndex();
  shareIndex[shareId] = { projectId, sharedAt: projIndex.sharedAt };
  saveShareIndex(shareIndex);

  const shareUrl = `${req.protocol}://${req.get("host")}/workspace/project/${projectId}/share/${shareId}`;

  log.info(`share: project=${projectId} shareId=${shareId}`);

  res.json({
    success:  true,
    shareId,
    shareUrl,
    projectId,
    name:     projIndex.name || "Project",
    sharedAt: projIndex.sharedAt,
  });
}));

/**
 * DELETE /projects/:id/share
 * Revoke the public share link for the project.
 */
router.delete("/:id/share", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);

  const projectId = req.params.id;
  const projIndex = readProjectIndex(projectId);
  if (!projIndex) return sendError(res, "Project not found", 404);

  const oldShareId = projIndex.shareId;

  // Remove share from _index.json
  delete projIndex.shareId;
  delete projIndex.sharedAt;
  delete projIndex.sharedBy;
  projIndex.isPublic = false;
  writeProjectIndex(projectId, projIndex);

  // Remove from global share index
  if (oldShareId) {
    const shareIndex = loadShareIndex();
    delete shareIndex[oldShareId];
    saveShareIndex(shareIndex);
  }

  log.info(`share: revoked project=${projectId} shareId=${oldShareId}`);
  res.json({ success: true, message: "Share link revoked" });
}));

/**
 * GET /projects/:id/share/:shareId
 * Public share preview page — no auth required.
 * Serves a self-contained HTML page with file browser + preview.
 */
router.get("/:id/share/:shareId", async (req, res) => {
  try {
    const { id: projectId, shareId } = req.params;

    // Validate share
    const shareIndex = loadShareIndex();
    const entry = shareIndex[shareId];
    if (!entry || entry.projectId !== projectId) {
      return res.status(404).send("<h2>Share link not found or has been revoked.</h2>");
    }

    const projIndex = readProjectIndex(projectId);
    if (!projIndex || !projIndex.isPublic) {
      return res.status(404).send("<h2>This project is no longer shared.</h2>");
    }

    // Load files
    const dir      = projectRootDir(projectId);
    const fileList = (projIndex.files || []).filter(f => isAllowedExt(path.basename(f)));
    const filesData = [];
    for (const fname of fileList) {
      const fpath = path.join(dir, fname);
      try {
        const content = fs.readFileSync(fpath, "utf8");
        filesData.push({ name: fname, content, size: content.length });
      } catch { /* skip unreadable */ }
    }

    const projectName = projIndex.name || "Project";
    const isFullstack = projIndex.isFullstack || false;
    const stack       = projIndex.stack || {};
    const sharedAt    = projIndex.sharedAt || "";
    const exportUrl   = `/workspace/project/${projectId}/export`;

    // Render the share page
    const filesJson   = JSON.stringify(filesData).replace(/</g, "\\u003c");
    const metaJson    = JSON.stringify({ projectName, isFullstack, stack, sharedAt, exportUrl }).replace(/</g, "\\u003c");

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${projectName} — AQUIPLEX Share</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg:        #0d0d14;
    --bg2:       #13131e;
    --surface:   #1a1a2e;
    --border:    rgba(255,255,255,0.08);
    --accent:    #6366f1;
    --text:      #e2e8f0;
    --text2:     #94a3b8;
    --green:     #22c55e;
    --radius:    10px;
    --sidebar-w: 220px;
  }
  body { background: var(--bg); color: var(--text); font-family: "Inter", system-ui, sans-serif; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }

  /* Header */
  .header { display: flex; align-items: center; gap: 12px; padding: 10px 18px; background: var(--bg2); border-bottom: 1px solid var(--border); flex-shrink: 0; }
  .logo   { font-weight: 800; font-size: .85rem; letter-spacing: .08em; color: var(--accent); }
  .proj-name { font-weight: 600; font-size: .9rem; }
  .badge  { font-size: .7rem; padding: 2px 8px; border-radius: 20px; background: rgba(99,102,241,.15); color: var(--accent); border: 1px solid rgba(99,102,241,.3); }
  .header-right { margin-left: auto; display: flex; gap: 8px; }
  .btn { padding: 6px 14px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text); font-size: .8rem; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: 6px; transition: background .15s; }
  .btn:hover { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }

  /* Layout */
  .workspace { display: flex; flex: 1; min-height: 0; }
  .sidebar   { width: var(--sidebar-w); background: var(--bg2); border-right: 1px solid var(--border); overflow-y: auto; flex-shrink: 0; }
  .sidebar-title { padding: 10px 14px; font-size: .72rem; font-weight: 600; color: var(--text2); letter-spacing: .06em; text-transform: uppercase; border-bottom: 1px solid var(--border); }
  .file-item { display: flex; align-items: center; gap: 8px; padding: 7px 14px; font-size: .8rem; cursor: pointer; border-left: 2px solid transparent; transition: all .12s; }
  .file-item:hover { background: var(--surface); }
  .file-item.active { background: rgba(99,102,241,.12); border-left-color: var(--accent); color: var(--accent); }
  .file-icon { font-size: .9rem; flex-shrink: 0; }
  .file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file-size { font-size: .68rem; color: var(--text2); }

  /* Editor */
  .editor-area { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .editor-tab  { padding: 8px 16px; background: var(--bg2); border-bottom: 1px solid var(--border); font-size: .8rem; color: var(--text2); flex-shrink: 0; }
  .editor-tab span { color: var(--text); font-weight: 500; }
  .code-view   { flex: 1; overflow: auto; padding: 20px 24px; background: var(--bg); }
  pre          { font-family: "JetBrains Mono", "Fira Code", "Cascadia Code", monospace; font-size: .78rem; line-height: 1.7; color: var(--text); white-space: pre; tab-size: 2; }

  /* Preview pane (shown for HTML files) */
  .preview-pane { flex: 1; border: none; background: #fff; }
  .view-toggle  { display: flex; gap: 6px; padding: 4px 16px; background: var(--bg2); border-bottom: 1px solid var(--border); flex-shrink: 0; }
  .toggle-btn   { font-size: .75rem; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--text2); cursor: pointer; }
  .toggle-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }

  .empty-state  { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--text2); flex-direction: column; gap: 8px; }

  /* Toast */
  .toast { position: fixed; bottom: 20px; right: 20px; background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 10px 18px; border-radius: 10px; font-size: .82rem; opacity: 0; transition: opacity .2s; pointer-events: none; }
  .toast.show { opacity: 1; }
</style>
</head>
<body>
<div class="header">
  <span class="logo">AQUIPLEX</span>
  <span style="color:var(--text2)">›</span>
  <span class="proj-name">${projectName}</span>
  ${isFullstack ? `<span class="badge">⚡ Fullstack · ${stack.backend || "express"}+${stack.database || "none"}</span>` : '<span class="badge">Frontend</span>'}
  <div class="header-right">
    <button class="btn" onclick="copyShareLink()">🔗 Copy Link</button>
    <a class="btn btn-primary" href="${exportUrl}" download>⬇ Download ZIP</a>
  </div>
</div>

<div class="workspace">
  <div class="sidebar">
    <div class="sidebar-title">Files</div>
    <div id="fileList"></div>
  </div>
  <div class="editor-area" id="editorArea">
    <div class="empty-state" id="emptyState">
      <div style="font-size:2rem">📁</div>
      <div>Select a file to view</div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const FILES = ${filesJson};
const META  = ${metaJson};
let currentIdx = -1;

function getIcon(name) {
  if (name.endsWith('.html')) return '🌐';
  if (name.endsWith('.css'))  return '🎨';
  if (name.endsWith('.js'))   return '📜';
  if (name.endsWith('.json')) return '{}';
  if (name.endsWith('.md'))   return '📝';
  if (name.endsWith('.env') || name.includes('env.example')) return '🔑';
  if (name.endsWith('.yaml') || name.endsWith('.yml')) return '⚙️';
  if (name === 'Dockerfile' || name === '.dockerignore') return '🐳';
  return '📄';
}

function kb(bytes) {
  if (bytes < 1024) return bytes + ' B';
  return (bytes / 1024).toFixed(1) + ' KB';
}

function buildSidebar() {
  const list = document.getElementById('fileList');
  list.innerHTML = FILES.map((f, i) => \`
    <div class="file-item" onclick="openFile(\${i})" id="fi_\${i}">
      <span class="file-icon">\${getIcon(f.name)}</span>
      <span class="file-name">\${f.name}</span>
      <span class="file-size">\${kb(f.size)}</span>
    </div>
  \`).join('');
  if (FILES.length > 0) openFile(0);
}

function openFile(idx) {
  if (idx === currentIdx) return;
  currentIdx = idx;
  const f = FILES[idx];

  // Update sidebar active state
  document.querySelectorAll('.file-item').forEach((el, i) => el.classList.toggle('active', i === idx));

  const isHtml = f.name.endsWith('.html');
  const area = document.getElementById('editorArea');

  if (isHtml) {
    area.innerHTML = \`
      <div class="editor-tab"><span>\${f.name}</span></div>
      <div class="view-toggle">
        <button class="toggle-btn active" id="tCode" onclick="showCode()">Code</button>
        <button class="toggle-btn" id="tPreview" onclick="showPreview()">Preview</button>
      </div>
      <pre class="code-view" id="codeView">\${escHtml(f.content)}</pre>
      <iframe class="preview-pane" id="previewPane" style="display:none"></iframe>
    \`;
  } else {
    area.innerHTML = \`
      <div class="editor-tab"><span>\${f.name}</span></div>
      <div class="code-view"><pre>\${escHtml(f.content)}</pre></div>
    \`;
  }
}

function showCode() {
  document.getElementById('codeView').style.display = '';
  document.getElementById('previewPane').style.display = 'none';
  document.getElementById('tCode').classList.add('active');
  document.getElementById('tPreview').classList.remove('active');
}

function showPreview() {
  const f = FILES[currentIdx];
  const iframe = document.getElementById('previewPane');
  iframe.srcdoc = f.content;
  iframe.style.display = '';
  document.getElementById('codeView').style.display = 'none';
  document.getElementById('tPreview').classList.add('active');
  document.getElementById('tCode').classList.remove('active');
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function copyShareLink() {
  navigator.clipboard.writeText(location.href).then(() => toast('🔗 Share link copied!'));
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

buildSidebar();
</script>
</body>
</html>`);
  } catch (e) {
    log.error("share preview error:", e.message);
    res.status(500).send("<h2>Error loading shared project.</h2>");
  }
});

module.exports = router;