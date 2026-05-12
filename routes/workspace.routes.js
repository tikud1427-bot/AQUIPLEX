// FILE: routes/workspace.routes.js
"use strict";

const express   = require("express");
const router    = express.Router();
const mongoose  = require("mongoose");
const fs        = require("fs");
const path      = require("path");

const Workspace = require("../models/Workspace");
const Bundle    = require("../models/Bundle");

const svc       = require("../workspace/workspace.service");
const { createLogger }                        = require("../utils/logger");
const { asyncHandler, sendError, sendSuccess } = require("../middleware/asyncHandler");
const { validateSaveFile, validateEditFile }  = require("../utils/validate");


const log = createLogger("WS_ROUTE");

// ── Mirror helper ─────────────────────────────────────────────────────────────

const PROJECTS_ROOT = path.join(process.cwd(), "projects");

const ALLOWED_MIRROR_EXTENSIONS = new Set([
  ".html", ".htm", ".css", ".js", ".mjs", ".cjs",
  ".ts", ".json", ".svg", ".md", ".txt",
  ".png", ".jpg", ".jpeg", ".gif", ".ico",
  ".woff", ".woff2", ".ttf",
]);

function mirrorSingleFile(projectId, fileName, content) {
  try {
    const safe = path.basename(projectId);
    if (!safe || safe !== projectId) return;
    const ext = path.extname(fileName).toLowerCase();
    if (!ALLOWED_MIRROR_EXTENSIONS.has(ext)) return;
    const safeName = path.basename(fileName);
    if (!safeName) return;
    const dir      = path.join(PROJECTS_ROOT, safe);
    const destPath = path.join(dir, safeName);
    // Path traversal guard
    if (!destPath.startsWith(path.resolve(dir) + path.sep)) return;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(destPath, content, "utf8");
    log.info(`Mirrored ${safeName} → ${dir}`);
  } catch (e) {
    log.warn(`mirrorSingleFile failed: ${e.message}`);
  }
}

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

// ── Routes ────────────────────────────────────────────────────────────────────

router.get("/", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return res.redirect("/login");

  let ws = await Workspace.findOne({ userId }).populate("tools").lean();
  if (!ws) {
    ws = await new Workspace({ userId }).save();
    ws = ws.toObject ? ws.toObject() : ws;
  }
  if (ws.workspaceMemory instanceof Map) {
    ws.workspaceMemory = Object.fromEntries(ws.workspaceMemory);
  }

  const bundles = await Bundle.find({ userId }).sort({ updatedAt: -1 }).lean();
  res.render("workspace", {
    workspace: ws, bundles, page: "workspace",
    openProjectId: null, openProjectName: null,
  });
}));

router.get("/state", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);
  res.json(await svc.getWorkspaceState(userId));
}));

router.get("/bundle/:bundleId", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);
  res.json(await svc.getBundleState(userId, req.params.bundleId));
}));

router.post("/run/:bundleId", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);
  res.json(await svc.runBundle(userId, req.params.bundleId));
}));

router.post("/step/:bundleId/:step", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);
  res.json(await svc.completeStep(userId, req.params.bundleId, req.params.step, req.body || {}));
}));

router.post("/pause/:bundleId", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);
  res.json(await svc.pauseBundle(userId, req.params.bundleId));
}));

router.post("/resume/:bundleId", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);
  res.json(await svc.resumeBundle(userId, req.params.bundleId));
}));

router.post("/pin/:bundleId", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);
  res.json(await svc.pinBundle(userId, req.params.bundleId));
}));

router.post("/unpin/:bundleId", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);
  res.json(await svc.unpinBundle(userId, req.params.bundleId));
}));

router.post("/memory", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);
  res.json(await svc.updateWorkspaceMemory(userId, req.body || {}));
}));

router.delete("/tools/:id", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return sendError(res, "Invalid tool ID", 400);

  const ws = await Workspace.findOne({ userId });
  if (!ws) return sendError(res, "Workspace not found", 404);

  if (typeof ws.removeTool === "function") {
    ws.removeTool(req.params.id);
  } else {
    ws.tools = (ws.tools || []).filter(t => {
      const tid = t.toolId || t._id || t;
      return tid && tid.toString() !== req.params.id;
    });
  }
  await ws.save();
  res.json({ success: true });
}));

router.post("/add/:toolId", asyncHandler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.toolId)) return sendError(res, "Invalid tool ID", 400);

  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);

  let ws = await Workspace.findOne({ userId });
  if (!ws) ws = new Workspace({ userId });

  const toolIdStr = req.params.toolId;
  const exists    = (ws.tools || []).some(t => {
    const tid = t.toolId || t._id || t;
    return tid && tid.toString() === toolIdStr;
  });

  if (!exists) {
    ws.tools.push({ toolId: new mongoose.Types.ObjectId(toolIdStr) });
    await ws.save();
  }
  res.json({ success: true });
}));

router.post("/remove/:toolId", asyncHandler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.toolId)) return sendError(res, "Invalid tool ID", 400);

  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);

  const ws = await Workspace.findOne({ userId });
  if (ws) {
    if (typeof ws.removeTool === "function") {
      ws.removeTool(req.params.toolId);
    } else {
      ws.tools = (ws.tools || []).filter(t => {
        const tid = t.toolId || t._id || t;
        return tid && tid.toString() !== req.params.toolId;
      });
    }
    await ws.save();
  }
  res.json({ success: true });
}));

router.get("/projects", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);
  res.json(await svc.getProjectList(userId));
}));

router.get("/files/:projectId", asyncHandler(async (req, res) => {
  const userId      = uid(req);
  const { projectId } = req.params;
  if (!userId)    return sendError(res, "Unauthorized", 401);
  if (!projectId) return sendError(res, "projectId required", 400);
  res.json(await svc.getProjectFiles(userId, projectId));
}));

router.get("/file/:projectId/:filename", asyncHandler(async (req, res) => {
  const userId              = uid(req);
  const { projectId, filename } = req.params;
  if (!userId)              return sendError(res, "Unauthorized", 401);
  if (!projectId || !filename) return sendError(res, "projectId and filename required", 400);
  const result = await svc.getProjectFile(userId, projectId, decodeURIComponent(filename));
  res.json({
    success: true,
    data: { file: { content: result.content, fileName: result.fileName }, projectId },
  });
}));

router.post("/save-file", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);
  const { projectId, fileName, content } = req.body || {};
  const v = validateSaveFile({ projectId, fileName, content });
  if (!v.valid) return sendError(res, v.error, 400);

  const result = await svc.saveProjectFile(userId, projectId, fileName, content);
  mirrorSingleFile(projectId, fileName, content);
  res.json({ success: true, data: result });
}));

router.post("/edit-file", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);

  

  // ─────────────────────────────────────────────────────────────────────────

  const { projectId, fileName, instruction } = req.body || {};
  const v = validateEditFile({ projectId, fileName, instruction });
  if (!v.valid) return sendError(res, v.error, 400);

  const result = await svc.editProjectFile(userId, projectId, fileName, instruction);

  // Mirror updated files to disk BEFORE sending response.
  // Previously used setImmediate (fire-and-forget) which caused blank previews:
  // the client refreshed the iframe before files were written to disk.
  if (Array.isArray(result.updatedFiles) && result.updatedFiles.length > 0) {
    for (const updatedFileName of result.updatedFiles) {
      try {
        const content = await svc.readSingleFile(projectId, updatedFileName);
        mirrorSingleFile(projectId, updatedFileName, content);
      } catch (e) {
        log.warn(`Mirror read failed for ${updatedFileName}: ${e.message}`);
      }
    }
  }

  res.json({ success: true, data: result });
}));

module.exports = router;