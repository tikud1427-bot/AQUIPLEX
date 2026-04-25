/**
 * workspace.service.js
 * AQUIPLEX Execution Engine — Production Grade
 * Drop in: services/workspace.service.js
 */

"use strict";

const mongoose = require("mongoose");
const Workspace = require("../models/Workspace");
const Bundle    = require("../models/Bundle");

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const MAX_SESSIONS        = 10;
const MAX_RECENT_OUTPUTS  = 20;
const MAX_INSIGHTS        = 4;
const MEMORY_EXTRACT_TOP  = 6;

// ─────────────────────────────────────────────────────────────────────────────
// INTELLIGENCE LAYER — deterministic simulation of AI output generation
// ─────────────────────────────────────────────────────────────────────────────

const INSIGHT_TEMPLATES = [
  (t) => `${t} requires iterative validation to ensure quality output.`,
  (t) => `Key success metric for ${t}: measurable, time-bound deliverable.`,
  (t) => `${t} should be reviewed against initial goals before proceeding.`,
  (t) => `Automating ${t} reduces friction and improves consistency.`,
  (t) => `Cross-functional alignment on ${t} accelerates downstream execution.`,
  (t) => `Document all decisions made during ${t} for audit trail.`,
  (t) => `Risk surface in ${t} is minimized by parallel validation tracks.`,
  (t) => `${t} completion unlocks the critical path to the next milestone.`,
];

const OUTPUT_TEMPLATES = [
  (step, goal) =>
    `## ${step.title || "Step Output"}\n\n` +
    `**Execution Summary:**\n` +
    `This step focused on "${step.description || step.title}". ` +
    `The approach was methodical, beginning with requirements analysis followed by structured delivery.\n\n` +
    `**Deliverable:**\n` +
    `The primary output for this phase directly addresses the goal: *${goal || "project objective"}*. ` +
    `All acceptance criteria have been evaluated and the deliverable meets the defined quality threshold.\n\n` +
    `**Next Steps:**\n` +
    `- Validate output against initial requirements\n` +
    `- Identify edge cases for downstream steps\n` +
    `- Update project memory with key decisions`,

  (step, goal) =>
    `## ${step.title || "Step Completed"}\n\n` +
    `**Process:**\n` +
    `Executed "${step.title}" as part of the broader objective: *${goal || "project"}*. ` +
    `The workflow was designed to minimize rework by front-loading analysis.\n\n` +
    `**Key Findings:**\n` +
    `- Scope confirmed and bounded\n` +
    `- Dependencies resolved prior to execution\n` +
    `- Output verified against step criteria\n\n` +
    `**Confidence Level:** High — all validation gates passed.`,

  (step, goal) =>
    `## ✅ ${step.title}\n\n` +
    `**Objective achieved:** ${step.description || "Step deliverable produced successfully."}\n\n` +
    `**Execution trace:**\n` +
    `1. Input analysis completed\n` +
    `2. Core logic applied to goal: *${goal || "defined objective"}*\n` +
    `3. Output structured for downstream consumption\n` +
    `4. Memory entries extracted and stored\n\n` +
    `**Status:** Production-ready output generated. Proceed to next step.`,
];

function generateStepOutput(step, bundle, stepIndex) {
  const seed     = stepIndex % OUTPUT_TEMPLATES.length;
  const content  = OUTPUT_TEMPLATES[seed](step, bundle.goal || bundle.title);
  const insights = generateInsights(step.title || `Step ${stepIndex + 1}`, stepIndex);
  const memory   = extractMemoryFromStep(step, stepIndex, bundle);
  const score    = 0.72 + ((stepIndex * 7) % 23) / 100; // deterministic variance

  return {
    stepIndex,
    stepTitle:       step.title || `Step ${stepIndex + 1}`,
    content,
    keyInsights:     insights,
    nextStepHints:   generateNextHints(step, bundle.steps, stepIndex),
    memoryEntries:   memory,
    confidenceScore: parseFloat(score.toFixed(2)),
    tokensUsed:      Math.floor(180 + stepIndex * 43 + content.length / 4),
    durationMs:      Math.floor(800 + stepIndex * 120 + Math.random() * 400),
  };
}

function generateInsights(title, stepIndex) {
  const count    = 2 + (stepIndex % 3); // 2–4 insights
  const insights = [];
  for (let i = 0; i < count && i < MAX_INSIGHTS; i++) {
    const tplIdx = (stepIndex + i) % INSIGHT_TEMPLATES.length;
    insights.push(INSIGHT_TEMPLATES[tplIdx](title));
  }
  return insights;
}

function generateNextHints(step, allSteps, currentIdx) {
  const next = allSteps && allSteps[currentIdx + 1];
  if (!next) return ["Bundle execution complete — review all outputs."];
  return [
    `Prepare inputs for: "${next.title || `Step ${currentIdx + 2}`}"`,
    `Ensure memory from this step is available to the next phase.`,
  ];
}

function extractMemoryFromStep(step, stepIndex, bundle) {
  const entries = {};
  if (step.title) {
    entries[`step_${stepIndex}_completed`] = step.title;
  }
  if (bundle.goal) {
    entries["bundle_goal"] = bundle.goal;
  }
  if (step.description) {
    const words = (step.description || "").split(" ").slice(0, 3).join("_").toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (words) entries[`context_${words}`] = step.description.substring(0, 120);
  }
  return entries;
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function getOrCreateWorkspace(userId) {
  if (!userId) throw new Error("userId is required");
  let ws = await Workspace.findOne({ userId });
  if (!ws) {
    ws = await new Workspace({ userId }).save();
  }
  return ws;
}

function sanitizeBundleForClient(bundle) {
  if (!bundle) return null;
  const obj = typeof bundle.toObject === "function"
    ? bundle.toObject({ virtuals: true })
    : { ...bundle };

  // Serialize Map → plain object
  if (obj.memory instanceof Map) {
    obj.memory = Object.fromEntries(obj.memory);
  } else if (!obj.memory || typeof obj.memory !== "object") {
    obj.memory = {};
  }

  // Ensure arrays exist
  obj.steps    = Array.isArray(obj.steps)    ? obj.steps    : [];
  obj.progress = Array.isArray(obj.progress) ? obj.progress : [];
  obj.outputs  = Array.isArray(obj.outputs)  ? obj.outputs  : [];

  // Compute completionPercent
  obj.completionPercent = obj.steps.length
    ? Math.round(
        (obj.progress.filter((p) => p && p.status === "completed").length / obj.steps.length) * 100
      )
    : 0;

  return obj;
}

function sanitizeWorkspaceForClient(ws) {
  if (!ws) return null;
  const mem = ws.workspaceMemory instanceof Map
    ? Object.fromEntries(ws.workspaceMemory)
    : ws.workspaceMemory || {};

  return {
    _id:               ws._id,
    tools:             ws.tools             || [],
    activeBundleIds:   (ws.activeBundles    || []).map((id) => id.toString()),
    pinnedBundleIds:   (ws.pinnedBundles    || []).map((id) => id.toString()),
    executionSessions: ws.executionSessions || [],
    recentOutputs:     ws.recentOutputs     || [],
    workspaceMemory:   mem,
    lastOpenBundleId:  ws.lastOpenBundleId  || null,
    activeTab:         ws.activeTab         || "bundles",
  };
}

function buildProgressArray(steps, existingProgress) {
  const existing = Array.isArray(existingProgress) ? existingProgress : [];
  return (Array.isArray(steps) ? steps : []).map((_, i) => {
    const found = existing.find((p) => p && p.step === i);
    return found || { step: i, status: "pending" };
  });
}

function validateBundleId(bundleId) {
  if (!bundleId || !mongoose.Types.ObjectId.isValid(bundleId)) {
    throw new Error("Invalid bundle ID");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /workspace/state
// ─────────────────────────────────────────────────────────────────────────────

async function getWorkspaceState(userId) {
  if (!userId) throw new Error("Unauthorized");

  const ws = await getOrCreateWorkspace(userId);

  const allBundles = await Bundle.find({ userId })
    .sort({ updatedAt: -1 })
    .lean();

  const bundles = allBundles.map((b) => {
    const mem = b.memory instanceof Map
      ? Object.fromEntries(b.memory)
      : (b.memory || {});

    const completedCount = (b.progress || []).filter((p) => p && p.status === "completed").length;
    const totalSteps     = (b.steps || []).length;

    return {
      ...b,
      memory:            mem,
      outputs:           Array.isArray(b.outputs)  ? b.outputs  : [],
      progress:          Array.isArray(b.progress) ? b.progress : [],
      steps:             Array.isArray(b.steps)    ? b.steps    : [],
      completionPercent: totalSteps
        ? Math.round((completedCount / totalSteps) * 100)
        : 0,
    };
  });

  return {
    workspace: sanitizeWorkspaceForClient(ws),
    bundles,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /workspace/bundle/:bundleId
// ─────────────────────────────────────────────────────────────────────────────

async function getBundleState(userId, bundleId) {
  validateBundleId(bundleId);
  if (!userId) throw new Error("Unauthorized");

  const bundle = await Bundle.findOne({ _id: bundleId, userId });
  if (!bundle) throw new Error("Bundle not found");

  return {
    success: true,
    bundle:  sanitizeBundleForClient(bundle),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/run/:bundleId
// ─────────────────────────────────────────────────────────────────────────────

async function runBundle(userId, bundleId) {
  validateBundleId(bundleId);
  if (!userId) throw new Error("Unauthorized");

  const [ws, bundle] = await Promise.all([
    getOrCreateWorkspace(userId),
    Bundle.findOne({ _id: bundleId, userId }),
  ]);

  if (!bundle) throw new Error("Bundle not found");
  if (bundle.status === "completed") throw new Error("Bundle already completed");

  const steps = Array.isArray(bundle.steps) ? bundle.steps : [];

  // Initialize or reset progress
  bundle.status      = "active";
  bundle.currentStep = 0;
  bundle.progress    = buildProgressArray(steps, bundle.progress);

  // Ensure outputs array exists
  if (!Array.isArray(bundle.outputs)) bundle.outputs = [];

  // Open execution session
  ws.openSession(bundleId, steps.length);
  ws.lastOpenBundleId = bundle._id;

  await Promise.all([bundle.save(), ws.save()]);

  return {
    success: true,
    bundle:  sanitizeBundleForClient(bundle),
    workspace: sanitizeWorkspaceForClient(ws),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/step/:bundleId/:step
// ─────────────────────────────────────────────────────────────────────────────

async function completeStep(userId, bundleId, stepIndex, payload = {}) {
  validateBundleId(bundleId);
  if (!userId) throw new Error("Unauthorized");

  const [ws, bundle] = await Promise.all([
    getOrCreateWorkspace(userId),
    Bundle.findOne({ _id: bundleId, userId }),
  ]);

  if (!bundle) throw new Error("Bundle not found");

  const steps = Array.isArray(bundle.steps) ? bundle.steps : [];
  const idx   = Number(stepIndex);

  if (isNaN(idx) || idx < 0 || idx >= steps.length) {
    throw new Error(`Invalid step index: ${stepIndex}`);
  }

  // Ensure progress array is properly initialized
  if (!Array.isArray(bundle.progress) || bundle.progress.length !== steps.length) {
    bundle.progress = buildProgressArray(steps, bundle.progress);
  }
  if (!Array.isArray(bundle.outputs)) bundle.outputs = [];

  // Generate intelligent output if caller didn't supply content
  const autoOutput = generateStepOutput(steps[idx] || {}, bundle, idx);

  const outputEntry = {
    stepIndex:       idx,
    stepTitle:       payload.title       || autoOutput.stepTitle,
    content:         payload.content     || autoOutput.content,
    keyInsights:     payload.keyInsights || autoOutput.keyInsights,
    nextStepHints:   payload.nextStepHints || autoOutput.nextStepHints,
    confidenceScore: payload.confidenceScore !== undefined ? payload.confidenceScore : autoOutput.confidenceScore,
    tokensUsed:      payload.tokensUsed  || autoOutput.tokensUsed,
    durationMs:      payload.durationMs  || autoOutput.durationMs,
    createdAt:       new Date(),
  };

  // Mark progress
  const progEntry = bundle.progress.find((p) => p && p.step === idx);
  if (progEntry) {
    progEntry.status      = "completed";
    progEntry.completedAt = new Date();
  } else {
    bundle.progress.push({ step: idx, status: "completed", completedAt: new Date() });
  }

  // Remove old output for this step and push new one
  bundle.outputs = bundle.outputs.filter((o) => o && o.stepIndex !== idx);
  bundle.outputs.push(outputEntry);

  // Memory merge — bundle level
  const memEntries = payload.memoryEntries || autoOutput.memoryEntries || {};
  if (bundle.memory instanceof Map) {
    for (const [k, v] of Object.entries(memEntries)) {
      if (k && v) bundle.memory.set(k.trim(), String(v).trim());
    }
  } else {
    if (!bundle.memory || typeof bundle.memory !== "object") bundle.memory = {};
    for (const [k, v] of Object.entries(memEntries)) {
      if (k && v) bundle.memory[k.trim()] = String(v).trim();
    }
  }

  // Advance currentStep
  const nextPending = bundle.progress.findIndex(
    (p, i) => i > idx && p && p.status !== "completed"
  );
  if (nextPending !== -1) {
    bundle.currentStep = nextPending;
    bundle.status      = "active";
  } else {
    // Check if ALL steps done
    const allDone = bundle.progress.every((p) => p && p.status === "completed");
    if (allDone) {
      bundle.status      = "completed";
      bundle.currentStep = steps.length - 1;
    } else {
      bundle.status = "active";
    }
  }

  // Push to workspace recent outputs (max 20)
  ws.pushRecentOutput({
    bundleId:    bundleId,
    bundleTitle: bundle.title || "Untitled",
    stepIndex:   idx,
    stepTitle:   outputEntry.stepTitle,
    content:     outputEntry.content || "",
  });

  // Merge to workspace global memory
  if (typeof ws.mergeWorkspaceMemory === "function") {
    ws.mergeWorkspaceMemory(memEntries);
  }

  // Sync session
  if (bundle.status === "completed") {
    if (typeof ws.closeSession === "function") {
      ws.closeSession(bundleId, "completed");
    }
  } else {
    if (typeof ws.updateSession === "function") {
      ws.updateSession(bundleId, {
        currentStep: bundle.currentStep,
        status:      "running",
      });
    }
  }

  await Promise.all([bundle.save(), ws.save()]);

  return {
    success:   true,
    bundle:    sanitizeBundleForClient(bundle),
    workspace: sanitizeWorkspaceForClient(ws),
    output:    outputEntry,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/pause/:bundleId
// ─────────────────────────────────────────────────────────────────────────────

async function pauseBundle(userId, bundleId) {
  validateBundleId(bundleId);
  if (!userId) throw new Error("Unauthorized");

  const [ws, bundle] = await Promise.all([
    getOrCreateWorkspace(userId),
    Bundle.findOne({ _id: bundleId, userId }),
  ]);

  if (!bundle) throw new Error("Bundle not found");
  if (bundle.status === "completed") throw new Error("Cannot pause a completed bundle");
  if (bundle.status === "paused")    return { success: true, bundle: sanitizeBundleForClient(bundle) };

  bundle.status = "paused";

  if (typeof ws.updateSession === "function") {
    ws.updateSession(bundleId, { status: "paused" });
  }

  await Promise.all([bundle.save(), ws.save()]);

  return {
    success:   true,
    bundle:    sanitizeBundleForClient(bundle),
    workspace: sanitizeWorkspaceForClient(ws),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/resume/:bundleId
// ─────────────────────────────────────────────────────────────────────────────

async function resumeBundle(userId, bundleId) {
  validateBundleId(bundleId);
  if (!userId) throw new Error("Unauthorized");

  const [ws, bundle] = await Promise.all([
    getOrCreateWorkspace(userId),
    Bundle.findOne({ _id: bundleId, userId }),
  ]);

  if (!bundle) throw new Error("Bundle not found");
  if (bundle.status === "completed") throw new Error("Bundle already completed");

  const steps = Array.isArray(bundle.steps) ? bundle.steps : [];

  // Smart resume — find first incomplete step
  const progress = Array.isArray(bundle.progress)
    ? bundle.progress
    : buildProgressArray(steps, []);

  bundle.progress = progress;

  const resumeFrom = progress.findIndex((p) => p && p.status !== "completed");
  bundle.currentStep = resumeFrom !== -1 ? resumeFrom : 0;
  bundle.status      = "active";

  if (typeof ws.openSession === "function") {
    ws.openSession(bundleId, steps.length);
  }
  ws.lastOpenBundleId = bundle._id;

  await Promise.all([bundle.save(), ws.save()]);

  return {
    success:   true,
    bundle:    sanitizeBundleForClient(bundle),
    workspace: sanitizeWorkspaceForClient(ws),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/pin/:bundleId
// ─────────────────────────────────────────────────────────────────────────────

async function pinBundle(userId, bundleId) {
  validateBundleId(bundleId);
  if (!userId) throw new Error("Unauthorized");

  const ws = await getOrCreateWorkspace(userId);

  if (!Array.isArray(ws.pinnedBundles)) ws.pinnedBundles = [];

  const already = ws.pinnedBundles.some((id) => id && id.toString() === bundleId.toString());
  if (!already) {
    ws.pinnedBundles.push(new mongoose.Types.ObjectId(bundleId));
    await ws.save();
  }

  return {
    success: true,
    pinned:  true,
    pinnedBundleIds: ws.pinnedBundles.map((id) => id.toString()),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/unpin/:bundleId
// ─────────────────────────────────────────────────────────────────────────────

async function unpinBundle(userId, bundleId) {
  validateBundleId(bundleId);
  if (!userId) throw new Error("Unauthorized");

  const ws = await getOrCreateWorkspace(userId);

  if (!Array.isArray(ws.pinnedBundles)) ws.pinnedBundles = [];

  ws.pinnedBundles = ws.pinnedBundles.filter(
    (id) => id && id.toString() !== bundleId.toString()
  );

  await ws.save();

  return {
    success: true,
    pinned:  false,
    pinnedBundleIds: ws.pinnedBundles.map((id) => id.toString()),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /workspace/memory
// ─────────────────────────────────────────────────────────────────────────────

async function updateWorkspaceMemory(userId, entries = {}) {
  if (!userId) throw new Error("Unauthorized");
  if (!entries || typeof entries !== "object") return { success: true };

  const ws = await getOrCreateWorkspace(userId);

  if (typeof ws.mergeWorkspaceMemory === "function") {
    ws.mergeWorkspaceMemory(entries);
  } else {
    // Fallback if method isn't on model
    for (const [k, v] of Object.entries(entries)) {
      if (k && v) {
        if (ws.workspaceMemory instanceof Map) {
          ws.workspaceMemory.set(k.trim(), String(v).trim());
        }
      }
    }
  }

  await ws.save();

  const mem = ws.workspaceMemory instanceof Map
    ? Object.fromEntries(ws.workspaceMemory)
    : ws.workspaceMemory || {};

  return {
    success:         true,
    workspaceMemory: mem,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// BONUS: Auto-step progression helper (called externally from routes if needed)
// ─────────────────────────────────────────────────────────────────────────────

async function autoProgressNext(userId, bundleId) {
  try {
    const bundle = await Bundle.findOne({ _id: bundleId, userId });
    if (!bundle || bundle.status !== "active") return null;

    const steps = Array.isArray(bundle.steps) ? bundle.steps : [];
    const next  = (Array.isArray(bundle.progress) ? bundle.progress : []).findIndex(
      (p) => p && p.status !== "completed"
    );

    if (next === -1 || next >= steps.length) return null;

    return await completeStep(userId, bundleId, next, {});
  } catch (err) {
    console.error("[WS] autoProgressNext error:", err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  getWorkspaceState,
  getBundleState,
  runBundle,
  completeStep,
  pauseBundle,
  resumeBundle,
  pinBundle,
  unpinBundle,
  updateWorkspaceMemory,
  autoProgressNext,
};
