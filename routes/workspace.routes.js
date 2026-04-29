/**
 * workspace.routes.js — AQUIPLEX Production (v4)
 *
 * CHANGELOG v4:
 * - GET  /workspace/projects          → list all user projects (with metadata)
 * - GET  /workspace/files/:projectId  → list project files (index.html always first)
 * - GET  /workspace/file/:projectId/:filename → serve file content as JSON for editor
 * - POST /workspace/save-file         → atomic file save
 * - POST /workspace/edit-file         → AI-powered file edit
 * - All existing routes preserved exactly
 */

"use strict";

const express   = require("express");
const router    = express.Router();
const mongoose  = require("mongoose");
const fs        = require("fs");
const path      = require("path");
const Workspace = require("../models/Workspace");
const Bundle    = require("../models/Bundle");
const svc       = require("../services/workspace.service");

// ── Mount Project Engine ──────────────────────────────────────────────────────
// IMPORTANT: mounted BEFORE param-based routes to prevent conflicts
const projectRoutes = require("./project.routes");
router.use("/project", projectRoutes);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function handleErr(res, err, fallbackStatus = 500) {
  console.error("[WS ROUTE]", err.message || err);
  const msg    = err.message || "Internal server error";
  const status =
    msg.includes("not found")    ? 404 :
    msg.includes("Invalid")      ? 400 :
    msg.includes("Unauthorized") ? 401 :
    msg.includes("already")      ? 409 :
    fallbackStatus;
  res.status(status).json({ error: msg, success: false });
}

function uid(req) {
  return (
    req.session?.userId          ||
    req.session?.user?._id       ||
    req.user?._id                ||
    req.user?.id                 ||
    null
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /workspace  — Render workspace page
// ─────────────────────────────────────────────────────────────────────────────

router.get("/", async (req, res) => {
  try {
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
      workspace:       ws,
      bundles,
      page:            "workspace",
      openProjectId:   null,
      openProjectName: null,
    });
  } catch (err) {
    console.error("[WS] render:", err);
    res.status(500).send("Workspace unavailable");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /workspace/state
// ─────────────────────────────────────────────────────────────────────────────

router.get("/state", async (req, res) => {
  try {
    const data = await svc.getWorkspaceState(uid(req));
    res.json(data);
  } catch (err) {
    handleErr(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /workspace/bundle/:bundleId
// ─────────────────────────────────────────────────────────────────────────────

router.get("/bundle/:bundleId", async (req, res) => {
  try {
    const data = await svc.getBundleState(uid(req), req.params.bundleId);
    res.json(data);
  } catch (err) {
    handleErr(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/run/:bundleId
// ─────────────────────────────────────────────────────────────────────────────

router.post("/run/:bundleId", async (req, res) => {
  try {
    const data = await svc.runBundle(uid(req), req.params.bundleId);
    res.json(data);
  } catch (err) {
    handleErr(res, err, 400);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/step/:bundleId/:step
// ─────────────────────────────────────────────────────────────────────────────

router.post("/step/:bundleId/:step", async (req, res) => {
  try {
    const payload = req.body || {};
    const data = await svc.completeStep(
      uid(req),
      req.params.bundleId,
      req.params.step,
      payload
    );
    res.json(data);
  } catch (err) {
    handleErr(res, err, 400);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/pause/:bundleId
// ─────────────────────────────────────────────────────────────────────────────

router.post("/pause/:bundleId", async (req, res) => {
  try {
    res.json(await svc.pauseBundle(uid(req), req.params.bundleId));
  } catch (err) {
    handleErr(res, err, 400);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/resume/:bundleId
// ─────────────────────────────────────────────────────────────────────────────

router.post("/resume/:bundleId", async (req, res) => {
  try {
    res.json(await svc.resumeBundle(uid(req), req.params.bundleId));
  } catch (err) {
    handleErr(res, err, 400);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/pin/:bundleId
// ─────────────────────────────────────────────────────────────────────────────

router.post("/pin/:bundleId", async (req, res) => {
  try {
    res.json(await svc.pinBundle(uid(req), req.params.bundleId));
  } catch (err) {
    handleErr(res, err, 400);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/unpin/:bundleId
// ─────────────────────────────────────────────────────────────────────────────

router.post("/unpin/:bundleId", async (req, res) => {
  try {
    res.json(await svc.unpinBundle(uid(req), req.params.bundleId));
  } catch (err) {
    handleErr(res, err, 400);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/memory
// ─────────────────────────────────────────────────────────────────────────────

router.post("/memory", async (req, res) => {
  try {
    res.json(await svc.updateWorkspaceMemory(uid(req), req.body || {}));
  } catch (err) {
    handleErr(res, err, 400);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /workspace/tools/:id
// ─────────────────────────────────────────────────────────────────────────────

router.delete("/tools/:id", async (req, res) => {
  try {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized", success: false });

    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid tool ID", success: false });
    }

    const ws = await Workspace.findOne({ userId });
    if (!ws) return res.status(404).json({ error: "Workspace not found", success: false });

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
  } catch (err) {
    handleErr(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/add/:toolId  (backward compat)
// ─────────────────────────────────────────────────────────────────────────────

router.post("/add/:toolId", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.toolId)) {
      return res.status(400).json({ error: "Invalid tool ID", success: false });
    }

    const userId = uid(req);
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
  } catch (err) {
    handleErr(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/remove/:toolId  (backward compat)
// ─────────────────────────────────────────────────────────────────────────────

router.post("/remove/:toolId", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.toolId)) {
      return res.status(400).json({ error: "Invalid tool ID", success: false });
    }

    const ws = await Workspace.findOne({ userId: uid(req) });
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
  } catch (err) {
    handleErr(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /workspace/projects
// List all saved projects for the authenticated user.
// Returns: { success, projects: [{ projectId, name, fileCount, updatedAt, createdAt }] }
// ─────────────────────────────────────────────────────────────────────────────

router.get("/projects", async (req, res) => {
  try {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized", success: false });
    const result = await svc.getProjectList(userId);
    res.json(result);
  } catch (err) {
    handleErr(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /workspace/files/:projectId
// List all files in a project. index.html is always first in the response.
// Returns: { success, projectId, name, files, fileData, updatedAt }
// ─────────────────────────────────────────────────────────────────────────────

router.get("/files/:projectId", async (req, res) => {
  try {
    const userId     = uid(req);
    const { projectId } = req.params;
    if (!projectId) return res.status(400).json({ success: false, error: "projectId required" });
    const result = await svc.getProjectFiles(userId, projectId);
    res.json(result);
  } catch (err) {
    handleErr(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /workspace/file/:projectId/:filename
// Fetch content of a single file for the code editor.
// Returns: { success, file: { content, fileName }, projectId }
// ─────────────────────────────────────────────────────────────────────────────

router.get("/file/:projectId/:filename", async (req, res) => {
  try {
    const userId             = uid(req);
    const { projectId, filename } = req.params;
    if (!projectId || !filename) {
      return res.status(400).json({ success: false, error: "projectId and filename required" });
    }
    const result = await svc.getProjectFile(userId, projectId, decodeURIComponent(filename));
    res.json({
      success:   true,
      file:      { content: result.content, fileName: result.fileName },
      projectId,
    });
  } catch (err) {
    handleErr(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/save-file
// Manually save file content (from the code editor).
// Body: { projectId, fileName, content }
// Returns: { success, projectId, fileName }
// ─────────────────────────────────────────────────────────────────────────────

router.post("/save-file", async (req, res) => {
  try {
    const userId = uid(req);
    const { projectId, fileName, content } = req.body || {};
    if (!projectId || !fileName) {
      return res.status(400).json({ success: false, error: "projectId and fileName required" });
    }
    if (content === undefined || content === null) {
      return res.status(400).json({ success: false, error: "content is required" });
    }
    const result = await svc.saveProjectFile(userId, projectId, fileName, content);
    res.json(result);
  } catch (err) {
    handleErr(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/edit-file
// AI-powered file edit via natural language instruction.
// Body: { projectId, fileName, instruction }
// Returns: { success, projectId, filename, updatedFiles }
// ─────────────────────────────────────────────────────────────────────────────

router.post("/edit-file", async (req, res) => {
  try {
    const userId = uid(req);
    const { projectId, fileName, instruction } = req.body || {};
    if (!projectId || !fileName || !instruction) {
      return res.status(400).json({ success: false, error: "projectId, fileName, and instruction required" });
    }
    const result = await svc.editProjectFile(userId, projectId, fileName, instruction);
    res.json(result);
  } catch (err) {
    handleErr(res, err);
  }
});

module.exports = router;
