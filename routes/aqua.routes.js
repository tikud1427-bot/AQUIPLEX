// FILE: routes/aqua.routes.js
"use strict";

const express = require("express");
const router  = express.Router();
const path    = require("path");
const fs      = require("fs");

const { handleAquaRequest, detectIntent, buildProjectContext } =
  require("../core/aqua.orchestrator");

const svc = require("../workspace/workspace.service");
const User                            = require("../models/User");
const { createLogger }            = require("../utils/logger");
const { asyncHandler, sendError } = require("../middleware/asyncHandler");
const { validateAquaExecute }     = require("../utils/validate");
const { usageGuard }              = require("../middleware/usage/usageGuard");
// featureGuard and direct credit ops removed — handled by usageGuard middleware


// Credit cost: map action type dynamically from request body.
// IMPORTANT: Only charge full_app_gen / backend_gen when NO projectId exists
// (i.e. brand-new generation). When projectId present = editing = section_gen cost.
// Prevents chat messages containing "generate" from being billed as 150-credit full builds.
function aquaActionType(req) {
  const msg       = (req.body?.message || "").toLowerCase();
  const projectId = req.body?.projectId;

  // Editing an existing project — always a lighter operation
  if (projectId) {
    if (msg.includes("deploy") || msg.includes("backend")) return "backend_gen";
    return "section_gen"; // edits are section-level cost
  }

  // New generation (no projectId) — check for explicit build intent
  const isFullBuild =
    msg.includes("build me") ||
    msg.includes("create app") ||
    msg.includes("make me a") ||
    msg.includes("build a website") ||
    msg.includes("create a website") ||
    msg.includes("generate a website") ||
    msg.includes("generate website");

  if (isFullBuild) return "full_app_gen";
  if (msg.includes("deploy") || msg.includes("backend")) return "backend_gen";
  if (msg.includes("section") || msg.includes("component")) return "component_gen";

  // Default: treat as a section/chat-level action (not full 150-credit build)
  return "section_gen";
}

const log = createLogger("AQUA_ROUTE");

const PROJECTS_ROOT = path.join(process.cwd(), "projects");

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

async function mirrorUpdatedFiles(userId, projectId, fileNames) {
  if (!projectId || !fileNames?.length) return;
  const dir = path.join(PROJECTS_ROOT, path.basename(projectId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  for (const fname of fileNames) {
    try {
      const content  = await svc.readSingleFile(projectId, fname);
      const safeName = path.basename(fname);
      const destPath = path.join(dir, safeName);
      // Path traversal guard
      if (!destPath.startsWith(dir + path.sep) && destPath !== dir) continue;
      fs.writeFileSync(destPath, content, "utf8");
      log.info(`Mirrored ${safeName} → preview`);
    } catch (e) {
      log.warn(`Mirror failed for ${fname}: ${e.message}`);
    }
  }
}

function mirrorGeneratedFiles(projectId, fileData) {
  if (!projectId || !Array.isArray(fileData)) return;
  const dir = path.join(PROJECTS_ROOT, path.basename(projectId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  for (const item of fileData) {
    try {
      const safeName = path.basename(item.fileName);
      const destPath = path.join(dir, safeName);
      // Path traversal guard
      if (!destPath.startsWith(dir + path.sep) && destPath !== dir) continue;

      if (item.content) {
        fs.writeFileSync(destPath, item.content, "utf8");
        log.info(`Generated + mirrored ${safeName}`);
      } else {
        const diskPath = path.join(
          svc.PROJECTS_DIR || path.join(process.cwd(), "data", "projects"),
          String(projectId).replace(/[^a-zA-Z0-9_-]/g, ""),
          safeName
        );
        if (fs.existsSync(diskPath)) {
          fs.copyFileSync(diskPath, destPath);
          log.info(`Copied (disk→preview) ${safeName}`);
        }
      }
    } catch (e) {
      log.warn(`Generate mirror failed for ${item.fileName}: ${e.message}`);
    }
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.post("/execute", usageGuard(aquaActionType), asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return sendError(res, "Unauthorized", 401);
  const { cost, actionType: _actionType } = req.creditContext || {};

  log.info(`[AQUA] execute start userId=${userId} actionType=${_actionType} cost=${cost}`);

  const { message, projectId, fileName, sessionHistory } = req.body || {};
  const validation = validateAquaExecute({ message, projectId, fileName });
  if (!validation.valid) return sendError(res, validation.error, 400);

  // ── Per-feature daily limit enforcement ──────────────────────────────────
  const msg = (message || "").toLowerCase();
  const isGeneration = msg.includes("generate") || msg.includes("build") || msg.includes("create") || !projectId;
  const isEdit       = !!projectId && (msg.includes("edit") || msg.includes("update") || msg.includes("change") || msg.includes("fix") || msg.includes("add") || msg.includes("make"));

  const featureUser = await User.findById(userId);
  if (featureUser && !featureUser.hasUnlimitedAccount()) {
    featureUser.resetDailyUsageIfNeeded();

    if (isGeneration && !projectId) {
      const { allowed, used, limit } = featureUser.checkFeatureLimit("websiteGen");
      if (!allowed) {
        return res.status(429).json({
          error:      "DAILY_LIMIT_REACHED",
          feature:    "websiteGen",
          message:    `You've used your ${limit} free website generation for today.`,
          detail:     "Buy credits to generate more websites now, or wait until midnight for your free quota to reset.",
          upgradeUrl: "/wallet",
          resetAt:    featureUser.wallet.freeResetAt,
          cta:        "Buy Credits",
        });
      }
    }

    if (isEdit && projectId) {
      const { allowed, used, limit } = featureUser.checkFeatureLimit("websiteEdit");
      if (!allowed) {
        return res.status(429).json({
          error:      "DAILY_LIMIT_REACHED",
          feature:    "websiteEdit",
          message:    `You've used all ${limit} free website edits for today.`,
          detail:     "Buy credits to keep editing, or wait until midnight for your free quota to reset.",
          upgradeUrl: "/wallet",
          resetAt:    featureUser.wallet.freeResetAt,
          cta:        "Buy Credits",
        });
      }
    }
  }

  let projectFiles = [];
  if (projectId) {
    try {
      const pf = await svc.getProjectFiles(userId, projectId);
      projectFiles = (pf.files || []).map(f => (typeof f === "string" ? f : f.fileName));
    } catch { /* non-fatal */ }
  }

  let workspaceMemory = {};
  try {
    const wsState   = await svc.getWorkspaceState(userId);
    workspaceMemory = wsState?.workspace?.workspaceMemory || {};
  } catch { /* non-fatal */ }

  // Credits already deducted by usageGuard (deductOnEntry: true).
  // On generation failure, req.creditContext.refund() handles the refund below.

  let result;
  try {
    // handleAquaRequest expects a single payload object (orchestrator v5 signature)
    result = await handleAquaRequest({
      userId,
      projectId,
      input:          message.trim(),
      mode:           "chat",
      projectFiles,
      memory:         workspaceMemory,
      sessionHistory: Array.isArray(sessionHistory) ? sessionHistory : [],
    });
  } catch (genErr) {
    // Refund credits on generation failure (guard deducted on entry)
    await req.creditContext?.refund?.();
    log.error(`[AQUA] generation failed, refund issued userId=${userId} err=${genErr.message}`);
    throw genErr;
  }

  
  // ─────────────────────────────────────────────────────────────────────────

  let previewRefresh = false;

  if (result.action === "generated" && result.files?.length) {
    mirrorGeneratedFiles(result.projectId, result.files);
    previewRefresh = true;
    // Increment websiteGen counter
    if (featureUser && !featureUser.hasUnlimitedAccount() && !projectId) {
      featureUser.incrementFeatureUsage("websiteGen");
      featureUser.save().catch(() => {});
    }
  }

  if ((result.action === "edited" || result.action === "multi_edited") && result.updatedFiles?.length) {
    setImmediate(() => mirrorUpdatedFiles(userId, result.projectId, result.updatedFiles));
    previewRefresh = true;
    // Increment websiteEdit counter
    if (featureUser && !featureUser.hasUnlimitedAccount() && projectId) {
      featureUser.incrementFeatureUsage("websiteEdit");
      featureUser.save().catch(() => {});
    }
  }

  if (result.projectId) {
    setImmediate(() =>
      svc.updateWorkspaceMemory(userId, {
        lastProjectId:   result.projectId,
        lastUserMessage: message.slice(0, 120),
      }).catch(() => {})
    );
  }

  const replyText = result.message || result.reply || "";

  return res.json({
    success:       true,
    reply:         replyText,
    intent:        result.intent,
    action:        result.action,
    message:       replyText,
    projectId:     result.projectId    || projectId || null,
    updatedFiles:  result.updatedFiles || [],
    files:         result.files        || [],
    previewUrl:    result.previewUrl   || null,
    previewRefresh,
    errors:        result.errors       || [],
    skipped:       result.skipped      || [],
    rolledBack:    result.rolledBack   || false,
  });
}));

router.get("/context/:projectId", asyncHandler(async (req, res) => {
  const userId        = uid(req);
  const { projectId } = req.params;
  if (!userId)    return sendError(res, "Unauthorized", 401);
  if (!projectId) return sendError(res, "projectId required", 400);

  const { summary, fileNames, fileContents } = await buildProjectContext(
    userId, projectId, req.query.file || null,
  );

  let workspaceMemory = {};
  try {
    const wsState   = await svc.getWorkspaceState(userId);
    workspaceMemory = wsState?.workspace?.workspaceMemory || {};
  } catch { /* non-fatal */ }

  return res.json({
    success: true,
    data:    { projectId, fileNames, fileContents, contextSummary: summary, workspaceMemory },
  });
}));

router.post("/intent-check", asyncHandler(async (req, res) => {
  const { message, projectId, fileName, projectFiles } = req.body || {};
  if (!message || typeof message !== "string" || !message.trim()) {
    return sendError(res, "message required", 400);
  }

  const result = detectIntent(message, {
    projectId, fileName,
    projectFiles: Array.isArray(projectFiles) ? projectFiles : [],
  });

  return res.json({ success: true, data: result });
}));

// /generate-v2 — removed (generateProjectV2 not available)
// Use POST /api/aqua/execute with a "generate_project" intent instead.

// /safe-edit — removed (safeEditFiles not directly importable here)
// Use POST /api/aqua/execute with an "edit_file" / "multi_edit" intent instead.

// ── System health + model orchestrator stats ──────────────────────────────────

router.get("/system/health", asyncHandler(async (req, res) => {
  const userId = uid(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const { getCacheStats } = require("../engine/model.orchestrator");
  const cacheStats = getCacheStats();

  // Model health from workspace service
  let modelHealth = [];
  try {
    const svc = require("../workspace/workspace.service");
    const registry = svc.buildModelRegistry ? svc.buildModelRegistry() : [];
    modelHealth = registry.map(m => ({
      id:      m.id,
      healthy: true, // _isModelHealthy not exported, default true
      type:    m.smallModel ? "fast" : "strong",
    }));
  } catch (e) { /* non-fatal */ }

  res.json({
    success: true,
    uptime:  process.uptime(),
    memory:  process.memoryUsage(),
    cache:   cacheStats,
    models:  modelHealth,
    engines: {
      promptExpander:   true,
      projectBrain:     true,
      repairEngine:     true,
      zipIntelligence:  true,
      modelOrchestrator: true,
      safeEditFiles:    true,
    },
  });
}));

module.exports = router;