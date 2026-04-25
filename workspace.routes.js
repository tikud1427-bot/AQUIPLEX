/**
 * workspace.routes.js — AQUIPLEX Production
 * Mount in index.js:
 *   const workspaceRoutes = require("./workspace.routes");
 *   app.use("/workspace", requireLogin, workspaceRoutes);
 *
 * And add the GET /workspace page route (see bottom of this file).
 */

"use strict";

const express   = require("express");
const router    = express.Router();
const mongoose  = require("mongoose");
const Workspace = require("./models/Workspace");
const Bundle    = require("./models/Bundle");
const svc       = require("./services/workspace.service");

// ─────────────────────────────────────────────────────────────────────────────
// Shared error handler
// ─────────────────────────────────────────────────────────────────────────────

function handleErr(res, err, fallbackStatus = 500) {
  console.error("[WS ROUTE]", err.message || err);
  const msg = err.message || "Internal server error";
  const status =
    msg.includes("not found")    ? 404 :
    msg.includes("Invalid")      ? 400 :
    msg.includes("Unauthorized")  ? 401 :
    msg.includes("already")      ? 409 :
    fallbackStatus;
  res.status(status).json({ error: msg, success: false });
}

function uid(req) {
  return req.session?.userId || req.user?._id || null;
}

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
// POST /workspace/add/:toolId  (backward compat)
// ─────────────────────────────────────────────────────────────────────────────

router.post("/add/:toolId", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.toolId))
      return res.status(400).json({ error: "Invalid tool ID" });

    let ws = await Workspace.findOne({ userId: uid(req) });
    if (!ws) ws = new Workspace({ userId: uid(req) });

    const toolIdStr = req.params.toolId;
    const exists    = (ws.tools || []).some((t) => t.toString() === toolIdStr);
    if (!exists) {
      ws.tools.push(new mongoose.Types.ObjectId(toolIdStr));
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

    const toolId = new mongoose.Types.ObjectId(req.params.toolId);
    await Workspace.updateOne({ userId: uid(req) }, { $pull: { tools: toolId } });
    res.json({ success: true });
  } catch (err) {
    handleErr(res, err);
  }
});

module.exports = router;

/*
 * ════════════════════════════════════════════════════════════════════
 * PASTE INTO index.js — replace existing /workspace GET + tool routes
 * ════════════════════════════════════════════════════════════════════
 *
 * const workspaceRoutes = require("./workspace.routes");
 *
 * app.get("/workspace", requireLogin, async (req, res) => {
 *   try {
 *     const Workspace = require("./models/Workspace");
 *     const Bundle    = require("./models/Bundle");
 *     let ws = await Workspace.findOne({ userId: req.session.userId })
 *               .populate("tools").lean();
 *     if (!ws) {
 *       ws = await new Workspace({ userId: req.session.userId }).save();
 *       ws = ws.toObject();
 *     }
 *     const bundles = await Bundle.find({ userId: req.session.userId })
 *                       .sort({ updatedAt: -1 }).lean();
 *     res.render("workspace", { workspace: ws, bundles, page: "workspace" });
 *   } catch (err) {
 *     console.error(err);
 *     res.status(500).send("Error loading workspace");
 *   }
 * });
 *
 * app.use("/workspace", requireLogin, workspaceRoutes);
 * ════════════════════════════════════════════════════════════════════
 */
