/**
 * bundle.execute.route.js — AQUIPLEX Production
 *
 * ADD this router block to your existing bundle routes file.
 *
 * Mount point (already set up in index.js as /bundle):
 *   app.use("/bundle", requireLogin, bundleRouter);
 *
 * NEW ROUTE ADDED:
 *   POST /bundle/:id/execute   → detect intent, bridge to workspace project engine
 *
 * HOW TO INTEGRATE:
 *   1. Copy the route handler below into your existing routes/bundle.js  ← recommended
 *      OR require this file and merge: bundleRouter.use(require('./bundle.execute.route'));
 *   2. Ensure workspace.routes.js (project engine) is mounted at /workspace
 *   3. No schema changes required
 */

"use strict";

const express    = require("express");
const router     = express.Router();
const bundleExec = require("../controllers/bundleExecuteController"); // created below

// ── Bridge: detect intent + call workspace project engine ────────────────────
router.post("/:id/execute", bundleExec.executeBundle);

module.exports = router;