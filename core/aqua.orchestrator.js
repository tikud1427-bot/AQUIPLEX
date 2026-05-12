"use strict";

/**
 * core/aqua.orchestrator.js — AQUIPLEX V5 Central Intelligence Layer
 *
 * Architecture:
 *   routes → handleAquaRequest(payload) → mode gate → intent detection → engine dispatch → AquaResponse
 *
 * Canonical entry-point signature:
 *   handleAquaRequest({ userId, projectId, input, mode, projectFiles, memory, sessionHistory })
 *
 * Supported modes (outer gate, evaluated before intent):
 *   image      → ai.core (generateImage)
 *   web_search → ai.core (generateSearch)
 *   chat       → intent-based dispatch (default)
 *
 * Supported intents (resolved inside chat/default mode):
 *   chat             → ai.core (generateAI)
 *   explain          → ai.core (generateAI) + project context
 *   generate_project → workspace.service (generateProject)
 *   edit_file        → workspace.service (safeEditFiles) — single file
 *   multi_edit       → workspace.service (safeEditFiles) — multi file
 *   fix_bug          → workspace.service (safeEditFiles) — multi file
 *   add_feature      → workspace.service (safeEditFiles) — multi file
 *
 * Import paths (relative to /core/):
 *   ../workspace/workspace.service
 *   ../engine/ai.core
 *   ../memory/memory.service
 *   ../utils/logger
 */

const svc = require("../workspace/workspace.service");
const ai  = require("../engine/ai.core");
const { SMART_MODEL } = ai;
const mem = require("../memory/memory.service");
const { createLogger } = require("../utils/logger");
const modelOrch = require("../engine/model.orchestrator");

const log = createLogger("AQUA_ORCH_V5");

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const INTENTS = Object.freeze({
  GENERATE_PROJECT: "generate_project",
  EDIT_FILE:        "edit_file",
  MULTI_EDIT:       "multi_edit",
  FIX_BUG:          "fix_bug",
  ADD_FEATURE:      "add_feature",
  EXPLAIN:          "explain",
  CHAT:             "chat",
});

const MODES = Object.freeze({
  IMAGE:      "image",
  WEB_SEARCH: "web_search",
  CHAT:       "chat",           // default / intent-routed
});

// ─────────────────────────────────────────────────────────────────────────────
// INTENT DETECTION
// ─────────────────────────────────────────────────────────────────────────────

const INTENT_SIGNALS = {
  [INTENTS.GENERATE_PROJECT]: [
    /\b(build|create|generate|make|scaffold|bootstrap)\b.*\b(website|web app|site|page|landing|portfolio|dashboard|app|project)\b/i,
    /\b(website|web app|landing page)\b.*\b(for me|from scratch)\b/i,
    /^(build|create|make|generate)\s+\w/i,
  ],
  [INTENTS.FIX_BUG]: [
    /\b(fix|debug|broken|not working|error|bug|issue|crash|fail)\b/i,
    /\b(console error|uncaught|undefined is not|cannot read|null reference)\b/i,
  ],
  [INTENTS.ADD_FEATURE]: [
    /\b(add|implement|integrate|include|enable|support|plug in)\b.*\b(feature|functionality|system|login|auth|payment|api|form|modal|search|filter|dark mode|animation)\b/i,
    /\b(new (page|section|component|route|endpoint))\b/i,
  ],
  [INTENTS.EDIT_FILE]: [
    /\b(change|update|modify|edit|replace|rename|move|tweak|adjust|set)\b.*\b(color|font|text|style|css|button|header|footer|nav|background|layout|size|padding|margin|image|link)\b/i,
    /\b(make .+ (bigger|smaller|bold|italic|blue|red|green|white|black|center|left|right))\b/i,
  ],
  [INTENTS.MULTI_EDIT]: [
    /\b(refactor|restructure|reorganize|redesign|overhaul)\b/i,
    /\b(all files|every file|across the project|globally)\b/i,
    /\b(rename all|update all|change all)\b/i,
  ],
  [INTENTS.EXPLAIN]: [
    /\b(explain|what is|how does|why does|describe|tell me about|walk me through)\b/i,
    /\b(what's happening in|what does .+ do)\b/i,
  ],
};

/**
 * detectIntent
 * @param {string} message
 * @param {{ projectId?, fileName?, projectFiles? }} context
 * @returns {{ intent: string, confidence: number, targetFiles: string[] }}
 */
function detectIntent(message, context = {}) {
  const msg    = (message || "").trim();
  const scores = {};

  for (const [intent, patterns] of Object.entries(INTENT_SIGNALS)) {
    scores[intent] = 0;
    for (const re of patterns) {
      if (re.test(msg)) scores[intent] += 1;
    }
  }

  if (context.projectId && !context.fileName) {
    scores[INTENTS.MULTI_EDIT]       = (scores[INTENTS.MULTI_EDIT]       || 0) + 0.3;
    scores[INTENTS.GENERATE_PROJECT] = (scores[INTENTS.GENERATE_PROJECT] || 0) - 0.5;
  }
  if (context.fileName) {
    scores[INTENTS.EDIT_FILE] = (scores[INTENTS.EDIT_FILE] || 0) + 1.5;
  }

  const sorted              = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topIntent, topScore] = sorted[0];

  if (topScore <= 0) {
    return { intent: INTENTS.CHAT, confidence: 1.0, targetFiles: [] };
  }

  return {
    intent:      topIntent,
    confidence:  Math.min(topScore / 2, 1),
    targetFiles: inferTargetFiles(msg, context),
  };
}

function inferTargetFiles(message, context) {
  const files   = Array.isArray(context.projectFiles) ? context.projectFiles : [];
  const lower   = message.toLowerCase();
  const matched = new Set();

  for (const f of files) {
    if (lower.includes(f.toLowerCase())) matched.add(f);
  }

  if (!matched.size) {
    if (/\b(style|color|font|css|design|layout|theme|appearance)\b/.test(lower))
      files.filter(f => /\.css$/i.test(f)).forEach(f => matched.add(f));
    if (/\b(navbar|nav|menu|header|footer|sidebar)\b/.test(lower))
      files.filter(f => /\.(html|jsx|tsx|js)$/i.test(f)).forEach(f => matched.add(f));
    if (/\b(script|logic|function|api|backend|route)\b/.test(lower))
      files.filter(f => /\.js$/i.test(f)).forEach(f => matched.add(f));
    if (/\b(index|home|main|landing)\b/.test(lower))
      files.filter(f => /index\.(html|js|jsx)/i.test(f)).forEach(f => matched.add(f));
  }

  if (!matched.size && context.fileName) matched.add(context.fileName);
  return [...matched];
}

// ─────────────────────────────────────────────────────────────────────────────
// PROJECT CONTEXT BUILDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * buildProjectContext
 * @param {string} userId
 * @param {string} projectId
 * @param {string} [selectedFile]
 * @returns {Promise<{ summary: string, fileContents: object, fileNames: string[] }>}
 */
async function buildProjectContext(userId, projectId, selectedFile) {
  if (!projectId) return { summary: "", fileContents: {}, fileNames: [] };

  let filesResult;
  try {
    filesResult = await svc.getProjectFiles(userId, projectId);
  } catch (e) {
    log.warn(`buildProjectContext: getProjectFiles failed: ${e.message}`);
    return { summary: "", fileContents: {}, fileNames: [] };
  }

  const fileNames = (filesResult.files || []).map(f =>
    typeof f === "string" ? f : f.fileName
  );

  const fileContents  = {};
  const LOAD_PRIORITY = [selectedFile, "index.html", "style.css", "app.js", "main.js"].filter(Boolean);
  const toLoad        = [
    ...LOAD_PRIORITY,
    ...fileNames.filter(f => !LOAD_PRIORITY.includes(f)),
  ].slice(0, 5);

  for (const fname of toLoad) {
    try {
      const r = await svc.getProjectFile(userId, projectId, fname);
      fileContents[fname] = r.content;
    } catch { /* non-fatal */ }
  }

  const structureLines = fileNames
    .map(f => f === selectedFile ? `  ★ ${f}  ← SELECTED` : `  • ${f}`)
    .join("\n");

  const contentBlock = Object.entries(fileContents)
    .map(([name, content]) =>
      `\n${"─".repeat(60)}\nFILE: ${name}\n${"─".repeat(60)}\n${
        content.slice(0, 1500) + (content.length > 1500 ? "\n[...truncated]" : "")
      }`
    )
    .join("\n");

  const summary = [
    "PROJECT CONTEXT",
    "═".repeat(43),
    `Project ID : ${projectId}`,
    `Files (${fileNames.length}) :`,
    structureLines,
    "",
    "FILE CONTENTS (excerpt):",
    contentBlock,
    "═".repeat(43),
  ].join("\n").trim();

  return { summary, fileContents, fileNames };
}

// ─────────────────────────────────────────────────────────────────────────────
// AI FILE PLANNER
// ─────────────────────────────────────────────────────────────────────────────

async function aiDecideFilesToEdit(userId, projectId, instruction, fileNames) {
  if (!fileNames.length) return [];

  const messages = [
    {
      role:    "system",
      content: "You are a web developer assistant. Return ONLY a JSON array of filenames that need editing. No explanation.",
    },
    {
      role:    "user",
      content: `PROJECT FILES: ${fileNames.join(", ")}\nREQUEST: ${instruction}\n\nReturn ONLY a JSON array: ["file.html","file.css"]`,
    },
  ];

  try {
    const raw   = await ai.generateAI(messages, { temperature: 0.2, maxTokens: 200 });
    const match = (raw || "").match(/\[[\s\S]*?\]/);
    if (!match) return fileNames.slice(0, 2);
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed)
      ? parsed.filter(f => fileNames.includes(f))
      : fileNames.slice(0, 2);
  } catch {
    return fileNames.slice(0, 2);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MEMORY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve memory context string.
 * Prefers externally-provided `memory` (pre-fetched by caller) over a live fetch,
 * avoiding a redundant DB round-trip when routes already load memory.
 *
 * @param {string} userId
 * @param {string} currentMessage
 * @param {string|null} [externalMemory]  pre-fetched memory string from payload
 * @returns {Promise<string>}
 */
async function _resolveMemoryContext(userId, currentMessage, externalMemory, projectId) {
  if (externalMemory && typeof externalMemory === "string" && externalMemory.trim()) {
    return `${externalMemory.trim()}\n\n`;
  }
  try {
    // Use project-aware memory when projectId available
    if (projectId) {
      const memory = await mem.getProjectMemory(userId, projectId);
      if (memory) return `${memory}\n\n`;
    }
    const memory = await mem.getUserMemory(userId, currentMessage);
    if (!memory) return "";
    return `${memory}\n\n`;
  } catch {
    return "";
  }
}

function _extractMemoryAsync(userId, message) {
  if (!userId || !message) return;
  setImmediate(() => {
    mem.extractMemory(userId, message, async (messages) => {
      return ai.generateAI(messages, { temperature: 0.3, maxTokens: 500 });
    }).catch(() => {});
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function _noProjectError(intent) {
  return {
    intent,
    action:  "error",
    message: "No project is loaded. Open a project first.",
    errors:  ["projectId missing from context"],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ORCHESTRATOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * handleAquaRequest — canonical entry point for ALL AI interactions.
 *
 * @param {object} payload
 * @param {string}   payload.userId         authenticated user id
 * @param {string}   [payload.projectId]    active project id (if any)
 * @param {string}   payload.input          raw user message
 * @param {string}   [payload.mode]         "chat" | "image" | "web_search"  (default: "chat")
 * @param {string[]} [payload.projectFiles] file list pre-fetched by route (avoids extra DB call)
 * @param {string}   [payload.memory]       pre-fetched user memory string
 * @param {Array}    [payload.sessionHistory] prior messages [{ role, content }]
 *
 * @returns {Promise<AquaResponse>}  structured response — never throws
 *
 * AquaResponse shape:
 * {
 *   intent:        string,
 *   action:        string,        // "chat" | "explained" | "generated" | "edited" | "multi_edited" | "image" | "web_search" | "error"
 *   message:       string,        // human-readable reply or status
 *   errors:        string[],
 *   // optional fields depending on action:
 *   projectId?:    string,
 *   files?:        object[],
 *   updatedFiles?: string[],
 *   skipped?:      object[],
 *   rolledBack?:   boolean,
 *   previewUrl?:   string,
 *   imageUrl?:     string,
 *   sources?:      object[],
 * }
 */
async function handleAquaRequest({
  userId,
  projectId,
  input,
  mode         = MODES.CHAT,
  projectFiles = [],
  memory       = null,
  sessionHistory = [],
} = {}) {

  // ── Normalise inputs ───────────────────────────────────────────────────────
  const safeInput   = (input || "").trim();
  const safeMode    = (mode  || MODES.CHAT).toLowerCase();
  const safeHistory = Array.isArray(sessionHistory) ? sessionHistory : [];

  log.info(`handleAquaRequest: mode=${safeMode} user=${userId} project=${projectId || "none"} inputLen=${safeInput.length}`);

  // ── Shared context object (passed into intent helpers) ────────────────────
  const context = {
    projectId,
    projectFiles: Array.isArray(projectFiles) ? projectFiles : [],
    fileName:     null,
  };

  try {

    // ═══════════════════════════════════════════════════════════════════════
    // MODE GATE — evaluated BEFORE intent detection
    // ═══════════════════════════════════════════════════════════════════════

    // ── IMAGE ──────────────────────────────────────────────────────────────
    if (safeMode === MODES.IMAGE) {
      const imageUrl = await ai.generateImage(safeInput, { userId });
      return {
        intent:   MODES.IMAGE,
        action:   "image",
        message:  imageUrl ? "Image generated." : "Image generation failed — no provider returned a URL.",
        imageUrl: imageUrl || null,
        errors:   imageUrl ? [] : ["Image generation returned no URL"],
      };
    }

    // ── WEB SEARCH ─────────────────────────────────────────────────────────
    if (safeMode === MODES.WEB_SEARCH) {
      const memoryCtx = await _resolveMemoryContext(userId, safeInput, memory);

      const systemContent = [
        memoryCtx,
        "You are Aqua, an AI assistant with web search capability. Provide accurate, up-to-date answers with sources.",
      ].filter(Boolean).join("\n");

      const messages = [
        { role: "system", content: systemContent },
        ...safeHistory,
        { role: "user",   content: safeInput },
      ];

      const result  = await ai.generateSearch(messages, { userId, model: SMART_MODEL });
      const reply   = typeof result === "string" ? result : result?.message || "";
      const sources = Array.isArray(result?.sources) ? result.sources : [];

      _extractMemoryAsync(userId, safeInput);

      return {
        intent:  MODES.WEB_SEARCH,
        action:  "web_search",
        message: reply || "No results found.",
        sources,
        errors:  [],
      };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INTENT-BASED DISPATCH (mode === "chat" or unrecognised mode)
    // ═══════════════════════════════════════════════════════════════════════

    // Resolve memory ONCE here — used by all intents below
    const intentMemoryCtx = await _resolveMemoryContext(userId, safeInput, memory, projectId);

    const { intent, confidence, targetFiles } = detectIntent(safeInput, context);

    log.info(`intent=${intent} conf=${confidence.toFixed(2)} files=[${targetFiles.join(",")}] user=${userId}`);

    switch (intent) {

      // ── 1. GENERATE PROJECT ──────────────────────────────────────────────
      case INTENTS.GENERATE_PROJECT: {
        const { v4: uuidv4 } = require("uuid");
        const pid = projectId || uuidv4();

        // Prepend memory context so project generator knows user preferences
        const inputWithMemory = intentMemoryCtx
          ? `${intentMemoryCtx}\nUser request: ${safeInput}`
          : safeInput;

        try {
          await svc.createProject(userId, inputWithMemory, pid);
        } catch { /* may already exist */ }

        // ── PLANNER AGENT: generate architecture plan before code gen ────────
        let projectPlan = null;
        try {
          const plannerAgent = require("../engine/planner.agent");
          const graphEngine  = require("../engine/graph.engine");
          projectPlan = await plannerAgent.createProjectPlan(safeInput);
          await graphEngine.initArchitecture(pid, projectPlan).catch(() => {});
          if (projectPlan.pages?.length) {
            await graphEngine.updateFrontendPages(pid, projectPlan.pages).catch(() => {});
          }
          log.info(`[ORCH] Plan created for ${pid}: ${projectPlan.meta?.type}/${projectPlan.meta?.complexity}`);
        } catch (planErr) {
          log.warn(`[ORCH] Planner agent error (non-fatal): ${planErr.message}`);
        }

        const result = await svc.generateProject(userId, pid, inputWithMemory);

        // ── POST-GEN: update graphs for generated files ───────────────────────
        try {
          const graphEngine = require("../engine/graph.engine");
          const fileEntries = (result.fileData || result.files || []).map(f =>
            ({ fileName: f.fileName || f, content: f.content || "" })
          );
          if (fileEntries.length) {
            await graphEngine.updateGraphsForFiles(pid, fileEntries).catch(() => {});
          }
        } catch {}

        const skippedMsg = result.skipped?.length
          ? ` (${result.skipped.length} file(s) rejected by validator)`
          : "";

        _extractMemoryAsync(userId, safeInput);

        const qScore = result.qualityScore != null ? ` | Quality: ${result.qualityScore}/100` : "";
        const design  = result.designDirection ? ` | Design: ${result.designDirection.split(":")[0]}` : "";
        const repairs = result.repairs?.length  ? ` | ${result.repairs.length} auto-repairs applied` : "";
        const planNote = projectPlan ? ` | Plan: ${projectPlan.meta?.type}/${projectPlan.meta?.complexity}` : "";

        return {
          intent,
          action:       "generated",
          projectId:    result.projectId,
          files:        result.fileData || [],
          message:      `✅ Project generated with ${(result.fileData || result.files || []).length} file(s)${skippedMsg}${qScore}${design}${repairs}${planNote}. Open preview to see it.`,
          previewUrl:   `/workspace/project/${result.projectId}/preview`,
          errors:       result.skipped?.map(s => `${s.fileName}: ${s.errors?.join("; ")}`) || [],
          skipped:      result.skipped       || [],
          rolledBack:   false,
          qualityScore: result.qualityScore  ?? null,
          designDirection: result.designDirection || "",
          repairs:      result.repairs       || [],
          plan:         projectPlan,
        };
      }

      // ── 2. SINGLE FILE EDIT ──────────────────────────────────────────────
      case INTENTS.EDIT_FILE: {
        if (!projectId) return _noProjectError(intent);

        const fileName = targetFiles[0] || context.fileName;
        if (!fileName) {
          return {
            intent,
            action:  "error",
            message: "Could not determine which file to edit. Please specify (e.g. 'edit style.css').",
            errors:  ["No target file resolved"],
          };
        }

        const result = await svc.safeEditFiles(userId, projectId, [fileName], safeInput,
          intentMemoryCtx ? { contextSummary: intentMemoryCtx } : undefined);

        if (!result.success) {
          return {
            intent,
            action:     "error",
            message:    result.rolledBack
              ? `⚠️ Edit failed for ${fileName} — previous version restored. ${result.errors[0] || ""}`
              : `⚠️ Edit could not be applied to ${fileName}. ${result.errors[0] || ""}`,
            errors:     result.errors,
            projectId,
            rolledBack: result.rolledBack || false,
          };
        }

        return {
          intent,
          action:       "edited",
          projectId,
          updatedFiles: result.updatedFiles,
          message:      `✅ Edited ${result.updatedFiles.join(", ")}. Preview will refresh automatically.`,
          previewUrl:   `/workspace/project/${projectId}/preview`,
          errors:       [],
          skipped:      result.skipped   || [],
          rolledBack:   false,
        };
      }

      // ── 3. MULTI-FILE EDIT / ADD FEATURE / FIX BUG ───────────────────────
      case INTENTS.ADD_FEATURE:
      case INTENTS.FIX_BUG:
      case INTENTS.MULTI_EDIT: {
        if (!projectId) return _noProjectError(intent);

        const { summary, fileNames } = await buildProjectContext(userId, projectId, context.fileName);

        let candidates = targetFiles.length ? targetFiles : [];
        if (!candidates.length && fileNames.length) {
          candidates = await aiDecideFilesToEdit(userId, projectId, safeInput, fileNames);
        }
        if (!candidates.length) candidates = fileNames.slice(0, 3);

        // Inject Project Brain context for smarter edits
        let brainCtx = "";
        try {
          const brain = require("../engine/project.brain");
          brainCtx = await brain.getBrainContext(projectId, { maxLength: 500 });
        } catch (e) { /* non-fatal */ }

        const result = await svc.safeEditFiles(
          userId, projectId, candidates, safeInput,
          { contextSummary: [intentMemoryCtx, brainCtx, summary].filter(Boolean).join("\n") }
        );

        if (!result.success && result.rolledBack) {
          return {
            intent,
            action:     "error",
            message:    `⚠️ Edit failed — project files restored to previous state. ${result.errors[0] || ""}`,
            errors:     result.errors,
            projectId,
            rolledBack: true,
          };
        }

        const uniqueFiles  = [...new Set(result.updatedFiles)];
        const skippedCount = result.skipped?.length || 0;

        return {
          intent,
          action:       "multi_edited",
          projectId,
          updatedFiles: uniqueFiles,
          errors:       result.errors,
          message:      `✅ Modified ${uniqueFiles.length} file(s)` +
                        (skippedCount ? ` (${skippedCount} skipped)` : "") +
                        ". Preview refreshing.",
          previewUrl:   `/workspace/project/${projectId}/preview`,
          skipped:      result.skipped   || [],
          rolledBack:   result.rolledBack || false,
        };
      }

      // ── 4. EXPLAIN ───────────────────────────────────────────────────────
      case INTENTS.EXPLAIN: {
        const memoryCtx = await _resolveMemoryContext(userId, safeInput, memory, projectId);

        let contextSummary = "";
        if (projectId) {
          const ctx  = await buildProjectContext(userId, projectId, context.fileName);
          contextSummary = ctx.summary;
        }

        const systemContent = [
          memoryCtx,
          "You are Aqua, an expert web developer assistant. Explain clearly and concisely.",
          contextSummary ? `\n${contextSummary}` : "",
        ].filter(Boolean).join("\n");

        const messages = [
          { role: "system", content: systemContent },
          ...safeHistory,
          { role: "user",   content: safeInput },
        ];

        const reply = await ai.generateAI(messages, { temperature: 0.7, model: SMART_MODEL });
        _extractMemoryAsync(userId, safeInput);

        return {
          intent,
          action:  "explained",
          message: reply || "Here is the explanation.",
          errors:  [],
        };
      }

      // ── 5. CHAT (default) ────────────────────────────────────────────────
      default: {
        const memoryCtx = await _resolveMemoryContext(userId, safeInput, memory);

        const systemContent = [
          memoryCtx,
          "You are Aqua, an intelligent AI assistant built into the Aquiplex platform. Help users build, edit, and understand web projects.",
        ].filter(Boolean).join("\n");

        const messages = [
          { role: "system", content: systemContent },
          ...safeHistory,
          { role: "user",   content: safeInput },
        ];

        const reply = await ai.generateAI(messages, { temperature: 0.7, model: SMART_MODEL });
        _extractMemoryAsync(userId, safeInput);

        return {
          intent:  INTENTS.CHAT,
          action:  "chat",
          message: reply || "",
          errors:  [],
        };
      }
    }

  } catch (err) {
    log.error(`handleAquaRequest unhandled: ${err.message}`);
    return {
      intent:  "unknown",
      action:  "error",
      message: `Request failed: ${err.message}`,
      errors:  [err.message],
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  handleAquaRequest,
  detectIntent,
  buildProjectContext,
  aiDecideFilesToEdit,
  INTENTS,
  MODES,
};