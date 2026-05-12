"use strict";

const express = require("express");
const router  = express.Router();

// POST /api/aqua/execute  ← frontend expects this exact path
router.use("/aqua",     require("./aqua.routes"));

// POST /api/projects/generate, GET /api/projects/:id/preview, etc.
// FIXED: removed duplicate /api/workspace mount — workspace.routes already
// mounted at /workspace in index.js. Double-mounting caused route conflicts.
router.use("/projects", require("./project.routes"));

module.exports = router;