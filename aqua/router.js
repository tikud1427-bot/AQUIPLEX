/**
 * AQUA Engine Router
 *
 * Single mount point for the entire AQUA AI engine inside the AQUIPLEX
 * platform. The platform (CommonJS index.js) loads this ESM module via
 * dynamic import() and mounts it at /api/aqua behind requireLogin.
 *
 * Route map (all relative to /api/aqua):
 *   /chat              — chat + /chat/stream (SSE)
 *   /provider-health   — provider health probes
 *   /project           — workspace / repository intelligence + patch editing
 *   /conversations     — conversation history (per-user scoped)
 *   /memory            — long-term memory management
 *   /upload            — universal upload (files, archives, media)
 *   /artifacts         — Universal Artifact Engine (generated files: list/download/manage)
 *
 * User identity: the platform sets req.aquaUserId (from the session) before
 * this router runs. Routes read it to scope conversations and memory.
 */
import express from "express";

import chatRoute          from "./src/routes/chat.js";
import healthRoute        from "./src/routes/health.js";
import projectRoute       from "./src/routes/project.js";
import conversationsRoute from "./src/routes/conversations.js";
import memoryRoute        from "./src/routes/memory.js";
import uploadRoute        from "./src/routes/upload.js";
import artifactsRoute     from "./src/routes/artifacts.js";
import mindRoute          from "./src/mind/mindRoutes.js";
import { runStartupValidation } from "./src/core/startupValidation.js";
import { migrateLegacyMemory }  from "./src/memory/migrate.js";
import { migrateIdentity }      from "./src/memory/identityMigration.js";

// ── One-time unification migration ──────────────────────────────────────────
// Legacy conversation-scoped facts (.aqua-memory.json) → unified owner-scoped
// Mind store (.aqua-mind.json). Idempotent: source archived after success.
migrateLegacyMemory();

// ── One-time identity repair ─────────────────────────────────────────────────
// Fold any legacy `custom_trait` blobs into canonical identity fields (or
// de-collide them into per-value custom keys). Idempotent: minds are flagged.
migrateIdentity();

// Validate model registry + provider keys once at mount. Never throws —
// misconfigured providers are disabled with a warning, engine still mounts.
runStartupValidation();

const router = express.Router();

router.use("/chat",            chatRoute);
router.use("/provider-health", healthRoute);
router.use("/project",         projectRoute);
router.use("/conversations",   conversationsRoute);
router.use("/memory",          memoryRoute);
router.use("/upload",          uploadRoute);
router.use("/artifacts",       artifactsRoute); // Universal Artifact Engine (P1)
router.use("/mind",            mindRoute);   // persistent cognitive model (Mind layer)

// JSON 404 for unknown engine routes (never fall through to platform HTML 404)
router.use((req, res) => {
  res.status(404).json({ success: false, error: `Not found: ${req.method} /api/aqua${req.path}` });
});

// JSON error handler — same contract the AQUA frontend expects
router.use((err, req, res, _next) => {
  const status = err.status ?? err.statusCode ?? 500;
  if (err.type === "entity.too.large" || status === 413) {
    return res.status(413).json({
      success: false,
      error: "Upload too large. The request body limit is 50 MB — try a smaller archive, or remove build artifacts (node_modules, dist) before zipping.",
    });
  }
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ success: false, error: "Invalid request body (malformed JSON)." });
  }
  console.error(`[AQUA] Unhandled error ${req.method} ${req.path}:`, err.stack ?? err.message);
  res.status(status).json({ success: false, error: err.message ?? "Internal server error" });
});

export default router;
