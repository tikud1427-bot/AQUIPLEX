"use strict";

const Workspace = require("../models/Workspace");
const Bundle    = require("../models/Bundle");
const {
  createProject,
  generateProject,
  getProjectList,
  getProjectFiles,
  getProjectFile,
  saveProjectFile,
  editProjectFile,
} = require("../services/workspace.service");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getOrCreateWorkspace(userId) {
  if (!userId) throw new Error("No userId on session");
  let ws = await Workspace.findOne({ userId });
  if (!ws) ws = await Workspace.create({ userId });
  return ws;
}

function apiError(res, msg, status = 500) {
  return res.status(status).json({ error: msg });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /workspace  — render EJS page
// ─────────────────────────────────────────────────────────────────────────────
exports.renderWorkspace = async (req, res) => {
  try {
    const userId  = req.user._id;
    const ws      = await Workspace.findOne({ userId }).lean();
    const bundles = await Bundle.find({ userId }).sort({ updatedAt: -1 }).lean();
    res.render("workspace", {
      page:      "workspace",
      workspace: ws || null,
      bundles:   bundles || [],
    });
  } catch (err) {
    console.error("[WS] renderWorkspace:", err);
    res.status(500).send("Error loading workspace");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /workspace/state
// ─────────────────────────────────────────────────────────────────────────────
exports.getState = async (req, res) => {
  try {
    const userId  = req.user._id;
    const ws      = await getOrCreateWorkspace(userId);
    const bundles = await Bundle.find({ userId }).sort({ updatedAt: -1 }).lean();
    res.json({ workspace: ws.toObject({ getters: true }), bundles });
  } catch (err) {
    console.error("[WS] getState:", err);
    apiError(res, "Failed to load workspace state");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /workspace/bundle/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.getBundle = async (req, res) => {
  try {
    const bundle = await Bundle.findOne({ _id: req.params.id, userId: req.user._id }).lean();
    if (!bundle) return apiError(res, "Bundle not found", 404);
    const ws = await getOrCreateWorkspace(req.user._id);
    ws.lastOpenBundleId = bundle._id;
    await ws.save();
    res.json({ bundle });
  } catch (err) {
    console.error("[WS] getBundle:", err);
    apiError(res, "Failed to fetch bundle");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/run/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.runBundle = async (req, res) => {
  try {
    const userId = req.user._id;
    const bundle = await Bundle.findOne({ _id: req.params.id, userId });
    if (!bundle) return apiError(res, "Bundle not found", 404);
    bundle.status      = "active";
    bundle.currentStep = bundle.currentStep || 0;
    await bundle.save();
    const ws = await getOrCreateWorkspace(userId);
    ws.openSession(bundle._id, (bundle.steps || []).length);
    ws.lastOpenBundleId = bundle._id;
    await ws.save();
    if (req.app.get("io")) req.app.get("io").emit("bundle:update", { bundleId: bundle._id });
    res.json({ bundle: bundle.toObject(), workspace: ws.toObject({ getters: true }) });
  } catch (err) {
    console.error("[WS] runBundle:", err);
    apiError(res, "Failed to run bundle");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/pause/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.pauseBundle = async (req, res) => {
  try {
    const userId = req.user._id;
    const bundle = await Bundle.findOne({ _id: req.params.id, userId });
    if (!bundle) return apiError(res, "Bundle not found", 404);
    bundle.status = "paused";
    await bundle.save();
    const ws = await getOrCreateWorkspace(userId);
    ws.updateSession(bundle._id, { status: "paused" });
    await ws.save();
    if (req.app.get("io")) req.app.get("io").emit("bundle:update", { bundleId: bundle._id });
    res.json({ bundle: bundle.toObject() });
  } catch (err) {
    console.error("[WS] pauseBundle:", err);
    apiError(res, "Failed to pause bundle");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/resume/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.resumeBundle = async (req, res) => {
  try {
    const userId = req.user._id;
    const bundle = await Bundle.findOne({ _id: req.params.id, userId });
    if (!bundle) return apiError(res, "Bundle not found", 404);
    bundle.status = "active";
    await bundle.save();
    const ws = await getOrCreateWorkspace(userId);
    ws.updateSession(bundle._id, { status: "running" });
    await ws.save();
    if (req.app.get("io")) req.app.get("io").emit("bundle:update", { bundleId: bundle._id });
    res.json({ bundle: bundle.toObject(), workspace: ws.toObject({ getters: true }) });
  } catch (err) {
    console.error("[WS] resumeBundle:", err);
    apiError(res, "Failed to resume bundle");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/step/:id/:stepIndex
// ─────────────────────────────────────────────────────────────────────────────
exports.completeStep = async (req, res) => {
  try {
    const userId    = req.user._id;
    const stepIndex = parseInt(req.params.stepIndex, 10);
    if (isNaN(stepIndex) || stepIndex < 0) return apiError(res, "Invalid stepIndex", 400);

    const bundle = await Bundle.findOne({ _id: req.params.id, userId });
    if (!bundle) return apiError(res, "Bundle not found", 404);

    if (!Array.isArray(bundle.progress)) bundle.progress = [];
    const existing = bundle.progress.find((p) => p && p.step === stepIndex);
    if (existing) {
      existing.status      = "completed";
      existing.completedAt = new Date();
    } else {
      bundle.progress.push({ step: stepIndex, status: "completed", completedAt: new Date() });
    }

    bundle.currentStep = Math.max(bundle.currentStep || 0, stepIndex + 1);
    const totalSteps   = (bundle.steps || []).length;
    const done         = bundle.progress.filter((p) => p && p.status === "completed").length;
    const allDone      = totalSteps > 0 && done >= totalSteps;

    bundle.status = allDone ? "completed" : "active";

    const stepTitle  = (bundle.steps?.[stepIndex]?.title) || req.body.title || `Step ${stepIndex + 1}`;
    const outputEntry = {
      stepIndex,
      stepTitle,
      content:         `Step "${stepTitle}" completed.`,
      confidenceScore: null,
      durationMs:      null,
      keyInsights:     [],
    };

    if (!Array.isArray(bundle.outputs)) bundle.outputs = [];
    const existingOut = bundle.outputs.findIndex((o) => o && o.stepIndex === stepIndex);
    if (existingOut >= 0) bundle.outputs[existingOut] = outputEntry;
    else bundle.outputs.push(outputEntry);

    bundle.markModified("progress");
    bundle.markModified("outputs");
    await bundle.save();

    const ws = await getOrCreateWorkspace(userId);
    ws.updateSession(bundle._id, { status: allDone ? "completed" : "running", currentStep: bundle.currentStep });
    if (allDone) ws.closeSession(bundle._id, "completed");
    ws.pushRecentOutput({ bundleId: bundle._id, bundleTitle: bundle.title, stepIndex, stepTitle, content: outputEntry.content });
    await ws.save();

    if (req.app.get("io")) req.app.get("io").emit("bundle:update", { bundleId: bundle._id });
    res.json({ bundle: bundle.toObject(), output: outputEntry, workspace: ws.toObject({ getters: true }) });
  } catch (err) {
    console.error("[WS] completeStep:", err);
    apiError(res, "Failed to complete step");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/pin/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.pinBundle = async (req, res) => {
  try {
    const ws = await getOrCreateWorkspace(req.user._id);
    const id = req.params.id;
    if (!ws.pinnedBundles.some((p) => p && p.toString() === id)) ws.pinnedBundles.push(id);
    await ws.save();
    res.json({ success: true, pinnedBundleIds: ws.pinnedBundles.map(String) });
  } catch (err) {
    console.error("[WS] pinBundle:", err);
    apiError(res, "Failed to pin bundle");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/unpin/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.unpinBundle = async (req, res) => {
  try {
    const ws = await getOrCreateWorkspace(req.user._id);
    ws.pinnedBundles = ws.pinnedBundles.filter((p) => p && p.toString() !== req.params.id);
    await ws.save();
    res.json({ success: true, pinnedBundleIds: ws.pinnedBundles.map(String) });
  } catch (err) {
    console.error("[WS] unpinBundle:", err);
    apiError(res, "Failed to unpin bundle");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /workspace/tools/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.removeTool = async (req, res) => {
  try {
    const ws = await getOrCreateWorkspace(req.user._id);
    ws.removeTool(req.params.id);
    await ws.save();
    res.json({ ok: true });
  } catch (err) {
    console.error("[WS] removeTool:", err);
    apiError(res, "Failed to remove tool");
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// PROJECT / CODE GENERATION ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// GET /workspace/projects  — list all projects for user
// ─────────────────────────────────────────────────────────────────────────────
exports.listProjects = async (req, res) => {
  try {
    const projects = await getProjectList(req.user._id);
    res.json({ success: true, projects });
  } catch (err) {
    console.error("[WS] listProjects:", err);
    apiError(res, "Failed to list projects");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/projects  — create a blank project
// ─────────────────────────────────────────────────────────────────────────────
exports.createNewProject = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return apiError(res, "Project name required", 400);
    const project = await createProject({ userId: req.user._id, name });
    res.json({ success: true, project });
  } catch (err) {
    console.error("[WS] createNewProject:", err);
    apiError(res, "Failed to create project");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/generate  — AI generate project files
// ─────────────────────────────────────────────────────────────────────────────
exports.generateProjectFiles = async (req, res) => {
  try {
    const { prompt, name } = req.body;
    if (!prompt) return apiError(res, "Prompt required", 400);

    const projectName = name || prompt.slice(0, 60);
    const project     = await createProject({ userId: req.user._id, name: projectName });
    const result      = await generateProject({ userId: req.user._id, projectId: project._id || project.id, prompt });

    res.json({ success: true, project, files: result.files || [] });
  } catch (err) {
    console.error("[WS] generateProjectFiles:", err);
    apiError(res, "Generation failed: " + err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /workspace/files/:projectId  — list files in a project
// ─────────────────────────────────────────────────────────────────────────────
exports.listFiles = async (req, res) => {
  try {
    const files = await getProjectFiles({ userId: req.user._id, projectId: req.params.projectId });
    res.json({ success: true, files });
  } catch (err) {
    console.error("[WS] listFiles:", err);
    apiError(res, "Failed to list files");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /workspace/file/:projectId/:fileName  — get file content
// ─────────────────────────────────────────────────────────────────────────────
exports.getFile = async (req, res) => {
  try {
    const { projectId, fileName } = req.params;
    const file = await getProjectFile({ userId: req.user._id, projectId, fileName });
    res.json({ success: true, file });
  } catch (err) {
    console.error("[WS] getFile:", err);
    apiError(res, "Failed to get file");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/save-file  — overwrite file content
// ─────────────────────────────────────────────────────────────────────────────
exports.saveFile = async (req, res) => {
  try {
    const { projectId, fileName, content } = req.body;
    if (!projectId || !fileName) return apiError(res, "projectId and fileName required", 400);
    const result = await saveProjectFile({ userId: req.user._id, projectId, fileName, content: content || "" });
    res.json({ success: true, result });
  } catch (err) {
    console.error("[WS] saveFile:", err);
    apiError(res, "Failed to save file");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/edit-file  — AI-powered edit
// ─────────────────────────────────────────────────────────────────────────────
exports.editFile = async (req, res) => {
  try {
    const { projectId, fileName, instruction } = req.body;
    if (!projectId || !fileName || !instruction) {
      return apiError(res, "projectId, fileName, and instruction required", 400);
    }
    const result = await editProjectFile({ userId: req.user._id, projectId, fileName, instruction });
    res.json({ success: true, result });
  } catch (err) {
    console.error("[WS] editFile:", err);
    apiError(res, "AI edit failed: " + err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /workspace/project/:projectId/:fileName  — serve raw file for iframe preview
// ─────────────────────────────────────────────────────────────────────────────
exports.serveFile = async (req, res) => {
  try {
    const { projectId, fileName } = req.params;
    const file = await getProjectFile({ userId: req.user._id, projectId, fileName });
    const ext  = fileName.split(".").pop().toLowerCase();
    const mime = ext === "html" ? "text/html"
               : ext === "css"  ? "text/css"
               : ext === "js"   ? "application/javascript"
               : ext === "json" ? "application/json"
               : "text/plain";
    res.setHeader("Content-Type", mime);
    res.send(file.content || "");
  } catch (err) {
    console.error("[WS] serveFile:", err);
    res.status(404).send("File not found");
  }
};
