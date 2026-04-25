/**
 * controllers/workspaceController.js — AQUIPLEX Production
 *
 * All workspace-related route handlers. Mount in routes/workspace.js.
 *
 * REST surface:
 *   GET  /workspace                     → render workspace page
 *   GET  /workspace/state               → JSON: { workspace, bundles }
 *   GET  /workspace/bundle/:id          → JSON: { bundle }
 *   POST /workspace/run/:id             → start bundle execution
 *   POST /workspace/pause/:id           → pause bundle
 *   POST /workspace/resume/:id          → resume bundle
 *   POST /workspace/step/:id/:stepIndex → mark step complete
 *   POST /workspace/pin/:id             → pin bundle
 *   POST /workspace/unpin/:id           → unpin bundle
 *   DELETE /workspace/tools/:id         → remove tool from workspace
 *
 * Bundle CRUD lives in bundleController / routes/bundle.js:
 *   DELETE /bundle/:id
 */

"use strict";

const Workspace = require("../models/Workspace");
const Bundle    = require("../models/Bundle");   // adjust path as needed

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load (or create) the workspace for the current user.
 * Throws if userId is missing.
 */
async function getOrCreateWorkspace(userId) {
  if (!userId) throw new Error("No userId on session");
  let ws = await Workspace.findOne({ userId });
  if (!ws) {
    ws = await Workspace.create({ userId });
  }
  return ws;
}

/**
 * Lightweight error responder.
 */
function apiError(res, msg, status = 500) {
  return res.status(status).json({ error: msg });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /workspace  — render EJS page
// ─────────────────────────────────────────────────────────────────────────────
exports.renderWorkspace = async (req, res) => {
  try {
    const userId = req.user._id;
    const ws     = await getOrCreateWorkspace(userId);

    // Populate tool snapshots (already embedded — no extra query needed)
    // Fetch bundles belonging to this user
    const bundles = await Bundle.find({ userId })
      .sort({ updatedAt: -1 })
      .lean();

    res.render("workspace", {
      workspace: ws.toObject({ getters: true }),
      bundles,
    });
  } catch (err) {
    console.error("[WS] renderWorkspace:", err);
    res.status(500).send("Workspace unavailable");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /workspace/state — hydrate frontend state on boot
// ─────────────────────────────────────────────────────────────────────────────
exports.getState = async (req, res) => {
  try {
    const userId  = req.user._id;
    const ws      = await getOrCreateWorkspace(userId);
    const bundles = await Bundle.find({ userId }).sort({ updatedAt: -1 }).lean();

    res.json({
      workspace: ws.toObject({ getters: true }),
      bundles,
    });
  } catch (err) {
    console.error("[WS] getState:", err);
    apiError(res, "Failed to load workspace state");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /workspace/bundle/:id — fetch single bundle (fresh)
// ─────────────────────────────────────────────────────────────────────────────
exports.getBundle = async (req, res) => {
  try {
    const bundle = await Bundle.findOne({
      _id:    req.params.id,
      userId: req.user._id,
    }).lean();

    if (!bundle) return apiError(res, "Bundle not found", 404);

    // Track last open
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
// POST /workspace/run/:id — start / restart bundle
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

    // Emit realtime event if socket.io is available
    if (req.app.get("io")) {
      req.app.get("io").emit("bundle:update", { bundleId: bundle._id });
    }

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

    if (req.app.get("io")) {
      req.app.get("io").emit("bundle:update", { bundleId: bundle._id });
    }

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

    if (req.app.get("io")) {
      req.app.get("io").emit("bundle:update", { bundleId: bundle._id });
    }

    res.json({ bundle: bundle.toObject(), workspace: ws.toObject({ getters: true }) });
  } catch (err) {
    console.error("[WS] resumeBundle:", err);
    apiError(res, "Failed to resume bundle");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/step/:id/:stepIndex — mark step complete
// ─────────────────────────────────────────────────────────────────────────────
exports.completeStep = async (req, res) => {
  try {
    const userId    = req.user._id;
    const stepIndex = parseInt(req.params.stepIndex, 10);
    if (isNaN(stepIndex) || stepIndex < 0) {
      return apiError(res, "Invalid stepIndex", 400);
    }

    const bundle = await Bundle.findOne({ _id: req.params.id, userId });
    if (!bundle) return apiError(res, "Bundle not found", 404);

    // Ensure progress array exists
    if (!Array.isArray(bundle.progress)) bundle.progress = [];

    const existing = bundle.progress.find((p) => p && p.step === stepIndex);
    if (existing) {
      existing.status      = "completed";
      existing.completedAt = new Date();
    } else {
      bundle.progress.push({
        step:        stepIndex,
        status:      "completed",
        completedAt: new Date(),
      });
    }

    // Advance currentStep
    bundle.currentStep = Math.max(bundle.currentStep || 0, stepIndex + 1);

    const totalSteps = (bundle.steps || []).length;
    const done       = bundle.progress.filter((p) => p && p.status === "completed").length;
    const allDone    = totalSteps > 0 && done >= totalSteps;

    if (allDone) {
      bundle.status = "completed";
    } else if (bundle.status !== "active") {
      bundle.status = "active";
    }

    // Build synthetic output entry
    const stepTitle = (bundle.steps && bundle.steps[stepIndex] && bundle.steps[stepIndex].title)
      || req.body.title
      || `Step ${stepIndex + 1}`;

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

    // Update workspace session + recent outputs
    const ws = await getOrCreateWorkspace(userId);
    ws.updateSession(bundle._id, {
      status:      allDone ? "completed" : "running",
      currentStep: bundle.currentStep,
    });
    if (allDone) ws.closeSession(bundle._id, "completed");

    ws.pushRecentOutput({
      bundleId:    bundle._id,
      bundleTitle: bundle.title,
      stepIndex,
      stepTitle,
      content:     outputEntry.content,
    });
    await ws.save();

    if (req.app.get("io")) {
      req.app.get("io").emit("bundle:update", { bundleId: bundle._id });
    }

    res.json({
      bundle:    bundle.toObject(),
      output:    outputEntry,
      workspace: ws.toObject({ getters: true }),
    });
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

    const alreadyPinned = ws.pinnedBundles.some((p) => p && p.toString() === id);
    if (!alreadyPinned) ws.pinnedBundles.push(id);
    await ws.save();

    res.json({ pinnedBundleIds: ws.pinnedBundles.map(String) });
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

    res.json({ pinnedBundleIds: ws.pinnedBundles.map(String) });
  } catch (err) {
    console.error("[WS] unpinBundle:", err);
    apiError(res, "Failed to unpin bundle");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /workspace/tools/:id  ← FIXED route (was /tool/:id)
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