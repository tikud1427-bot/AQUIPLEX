/**
 * workspace.routes.js — AQUIPLEX Production
 *
 * Mount in index.js:
 *   const workspaceRoutes = require("./workspace.routes");
 *   app.use("/workspace", requireLogin, workspaceRoutes);
 *
 * The GET /workspace page render is handled here (see bottom).
 *
 * ROUTES:
 *   GET    /workspace                   → render EJS
 *   GET    /workspace/state             → { workspace, bundles }
 *   GET    /workspace/bundle/:bundleId  → { bundle }
 *   POST   /workspace/run/:bundleId     → start bundle
 *   POST   /workspace/step/:bundleId/:step → mark step complete
 *   POST   /workspace/pause/:bundleId   → pause
 *   POST   /workspace/resume/:bundleId  → resume
 *   POST   /workspace/pin/:bundleId     → pin
 *   POST   /workspace/unpin/:bundleId   → unpin
 *   POST   /workspace/memory            → update workspace memory
 *   POST   /workspace/add/:toolId       → add tool (compat)
 *   POST   /workspace/remove/:toolId    → remove tool (compat)
 *   DELETE /workspace/tools/:id         → remove tool (canonical)
 *
 * Bundle CRUD (DELETE /bundle/:id) lives in bundleController / routes/bundle.js
 */

"use strict";

const express   = require("express");
const router    = express.Router();
const mongoose  = require("mongoose");
const Workspace = require("./models/Workspace");
const Bundle    = require("./models/Bundle");
const svc       = require("./services/workspace.service");

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

/** Resolve userId from session or passport user object. */
function uid(req) {
  return req.session?.userId || req.user?._id || null;
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

    // Normalize workspaceMemory Map → plain object for EJS
    if (ws.workspaceMemory instanceof Map) {
      ws.workspaceMemory = Object.fromEntries(ws.workspaceMemory);
    }

    const bundles = await Bundle.find({ userId }).sort({ updatedAt: -1 }).lean();

    res.render("workspace", { workspace: ws, bundles, page: "workspace" });
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
    const data = await svc.completeStep(
      uid(req),
      req.params.bundleId,
      req.params.step,
      req.body || {}
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
// DELETE /workspace/tools/:id  ← CANONICAL route (fixes old /tool/:id)
// ─────────────────────────────────────────────────────────────────────────────

router.delete("/tools/:id", async (req, res) => {
  try {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    let ws = await Workspace.findOne({ userId });
    if (!ws) return res.status(404).json({ error: "Workspace not found" });

    ws.removeTool(req.params.id);
    await ws.save();

    res.json({ success: true });
  } catch (err) {
    handleErr(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/add/:toolId  (backward compat — keep for older clients)
// ─────────────────────────────────────────────────────────────────────────────

router.post("/add/:toolId", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.toolId))
      return res.status(400).json({ error: "Invalid tool ID" });

    let ws = await Workspace.findOne({ userId: uid(req) });
    if (!ws) ws = new Workspace({ userId: uid(req) });

    const toolIdStr = req.params.toolId;
    const exists    = (ws.tools || []).some(t => t.toolId && t.toolId.toString() === toolIdStr);
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
    if (!mongoose.Types.ObjectId.isValid(req.params.toolId))
      return res.status(400).json({ error: "Invalid tool ID" });

    let ws = await Workspace.findOne({ userId: uid(req) });
    if (ws) {
      ws.removeTool(req.params.toolId);
      await ws.save();
    }

    res.json({ success: true });
  } catch (err) {
    handleErr(res, err);
  }
});

module.exports = router;

/*
 * ══════════════════════════════════════════════════════════════════════
 * Mount in index.js (replace old /workspace routes):
 *
 *   const workspaceRoutes = require("./workspace.routes");
 *   app.use("/workspace", requireLogin, workspaceRoutes);
 *
 * This handles GET /workspace (page render) + all API routes.
 * ══════════════════════════════════════════════════════════════════════
 */
