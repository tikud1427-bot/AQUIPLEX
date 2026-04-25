/**
 * routes/workspace.js — AQUIPLEX Production
 *
 * Mount in app.js:
 *   const workspaceRouter = require("./routes/workspace");
 *   app.use("/workspace", ensureAuth, workspaceRouter);
 *
 * Bundle DELETE lives in routes/bundle.js:
 *   router.delete("/:id", bundleController.deleteBundle);
 */

"use strict";

const express = require("express");
const router  = express.Router();
const ctrl    = require("../controllers/workspaceController");

// ── Page ─────────────────────────────────────────────────────────────────────
router.get("/",                   ctrl.renderWorkspace);

// ── State / data ─────────────────────────────────────────────────────────────
router.get("/state",              ctrl.getState);
router.get("/bundle/:id",         ctrl.getBundle);

// ── Execution ────────────────────────────────────────────────────────────────
router.post("/run/:id",           ctrl.runBundle);
router.post("/pause/:id",         ctrl.pauseBundle);
router.post("/resume/:id",        ctrl.resumeBundle);
router.post("/step/:id/:stepIndex", ctrl.completeStep);

// ── Pins ─────────────────────────────────────────────────────────────────────
router.post("/pin/:id",           ctrl.pinBundle);
router.post("/unpin/:id",         ctrl.unpinBundle);

// ── Tools — FIX: was /tool/:id, now REST-correct /tools/:id ──────────────────
router.delete("/tools/:id",       ctrl.removeTool);

module.exports = router;