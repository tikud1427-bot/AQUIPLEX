"use strict";

/**
 * engine/model.orchestrator.js — AQUIPLEX MODEL ORCHESTRATION
 *
 * Intelligent model routing based on task type:
 *   - Fast models for: intent classification, memory extraction, summaries, titles
 *   - Strong models for: code generation, project generation, editing
 *   - Repair loops for: validation failures
 *   - Caching for: repeated/similar requests
 *
 * Task types:
 *   classify  → fastest available (low quality OK, just needs speed)
 *   summarize → fast model
 *   generate  → strongest available
 *   edit      → strong model with high determinism (low temp)
 *   repair    → strong model, focused prompt
 *   chat      → balanced model
 *   explain   → balanced model
 */

const crypto = require("crypto");
const { createLogger } = require("../utils/logger");

const log = createLogger("MODEL_ORCH");

// ─────────────────────────────────────────────────────────────────────────────
// RESPONSE CACHE (in-memory, keyed by hash of system+user prompt)
// TTL-based eviction. Good for repeated generation requests, summaries, etc.
// ─────────────────────────────────────────────────────────────────────────────

const _cache      = new Map();
const CACHE_TTL   = 5 * 60 * 1000;   // 5 minutes
const CACHE_MAX   = 200;              // max entries
const CACHE_TASKS = new Set(["classify", "summarize", "title"]);  // only cache cheap tasks

function _cacheKey(task, messages) {
  const str = task + JSON.stringify(messages.map(m => ({ r: m.role, c: (m.content || "").slice(0, 300) })));
  return crypto.createHash("sha1").update(str).digest("hex").slice(0, 16);
}

function _cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { _cache.delete(key); return null; }
  return entry.value;
}

function _cacheSet(key, value) {
  if (_cache.size >= CACHE_MAX) {
    const oldest = [..._cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) _cache.delete(oldest[0]);
  }
  _cache.set(key, { value, ts: Date.now() });
}

// ─────────────────────────────────────────────────────────────────────────────
// TASK PROFILES
// ─────────────────────────────────────────────────────────────────────────────

const TASK_PROFILES = {
  classify: {
    maxTokens:   150,
    temperature: 0.1,
    description: "Intent/type classification — speed over quality",
    preferFast:  true,
  },
  summarize: {
    maxTokens:   400,
    temperature: 0.3,
    description: "Content summarization",
    preferFast:  true,
  },
  title: {
    maxTokens:   50,
    temperature: 0.5,
    description: "Generate short title/label",
    preferFast:  true,
  },
  chat: {
    maxTokens:   1024,
    temperature: 0.7,
    description: "Conversational response",
    preferFast:  false,
  },
  explain: {
    maxTokens:   2048,
    temperature: 0.6,
    description: "Technical explanation",
    preferFast:  false,
  },
  expand: {
    maxTokens:   600,
    temperature: 0.7,
    description: "Prompt expansion / spec generation",
    preferFast:  true,
  },
  generate: {
    maxTokens:   8000,
    temperature: 0.7,
    description: "Full project generation — strongest model needed",
    preferFast:  false,
    preferStrong: true,
  },
  edit: {
    maxTokens:   4000,
    temperature: 0.3,
    description: "Precise file edit — high determinism",
    preferFast:  false,
    preferStrong: true,
  },
  repair: {
    maxTokens:   3000,
    temperature: 0.2,
    description: "Output repair — needs to follow instructions precisely",
    preferFast:  false,
    preferStrong: true,
  },
  memory: {
    maxTokens:   500,
    temperature: 0.2,
    description: "Memory extraction — structured output needed",
    preferFast:  true,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE FUNCTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * getTaskProfile(task) → { maxTokens, temperature, preferFast, preferStrong }
 */
function getTaskProfile(task) {
  return TASK_PROFILES[task] || TASK_PROFILES.chat;
}

/**
 * routeTask(task, messages, callAI) → string
 *
 * Routes a task to the appropriate model tier, with caching for fast tasks.
 *
 * @param {string}   task     - task type key from TASK_PROFILES
 * @param {Array}    messages - chat messages array
 * @param {Function} callAI   - async fn(messages, opts) → string
 * @returns {Promise<string>}
 */
async function routeTask(task, messages, callAI) {
  if (!callAI || typeof callAI !== "function") {
    throw new Error("routeTask: callAI function required");
  }

  const profile = getTaskProfile(task);

  // Check cache for cacheable tasks
  if (CACHE_TASKS.has(task)) {
    const key    = _cacheKey(task, messages);
    const cached = _cacheGet(key);
    if (cached) {
      log.info(`routeTask: cache HIT task=${task}`);
      return cached;
    }

    const result = await callAI(messages, {
      maxTokens:   profile.maxTokens,
      temperature: profile.temperature,
    });

    _cacheSet(key, result);
    log.info(`routeTask: cache MISS task=${task}, stored`);
    return result;
  }

  // Non-cached path
  log.info(`routeTask: task=${task} maxTokens=${profile.maxTokens} temp=${profile.temperature}`);
  return callAI(messages, {
    maxTokens:   profile.maxTokens,
    temperature: profile.temperature,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SPECIALIZED TASK HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * classifyIntent(prompt, callAI) → string
 * Fast intent classification using cheap model + caching.
 */
async function classifyIntent(prompt, callAI) {
  const messages = [
    {
      role: "system",
      content: "Classify this user request. Return ONLY one word: generate|edit|fix|explain|chat|search",
    },
    { role: "user", content: (prompt || "").slice(0, 300) },
  ];

  try {
    const result = await routeTask("classify", messages, callAI);
    const clean  = (result || "chat").trim().toLowerCase().split(/\s+/)[0];
    const valid  = ["generate", "edit", "fix", "explain", "chat", "search"];
    return valid.includes(clean) ? clean : "chat";
  } catch {
    return "chat";
  }
}

/**
 * generateProjectTitle(prompt, callAI) → string
 * Fast, cached project name generation.
 */
async function generateProjectTitle(prompt, callAI) {
  const messages = [
    {
      role: "system",
      content: "Generate a concise, catchy project name (2-4 words, title case). Return ONLY the name, nothing else.",
    },
    { role: "user", content: `Project request: ${(prompt || "").slice(0, 200)}` },
  ];

  try {
    const result = await routeTask("title", messages, callAI);
    return (result || "").replace(/['"]/g, "").trim().slice(0, 60) || "Untitled Project";
  } catch {
    return "Untitled Project";
  }
}

/**
 * summarizeForMemory(text, callAI) → string
 * Compress long content into memory-efficient summary.
 */
async function summarizeForMemory(text, callAI) {
  if (!text || text.length < 200) return text;

  const messages = [
    {
      role: "system",
      content: "Summarize this content concisely in 2-3 sentences. Focus on key technical decisions, preferences, and requirements.",
    },
    { role: "user", content: text.slice(0, 3000) },
  ];

  try {
    return await routeTask("summarize", messages, callAI);
  } catch {
    return text.slice(0, 500);
  }
}

/**
 * repairOutput(brokenOutput, originalPrompt, callAI) → string
 * Targeted repair of broken/incomplete AI output.
 */
async function repairOutput(brokenOutput, originalPrompt, issue, callAI) {
  const messages = [
    {
      role: "system",
      content: `You are a code repair specialist. Fix the specific issue in this output.
Issue: ${issue}
Rules:
- Fix ONLY the described issue
- Keep all working parts intact
- Return the COMPLETE fixed content
- No explanation, no fences, just the fixed content`,
    },
    {
      role: "user",
      content: `Original request: ${(originalPrompt || "").slice(0, 200)}

Output to repair:
${(brokenOutput || "").slice(0, 6000)}

Fix the issue: ${issue}`,
    },
  ];

  try {
    return await routeTask("repair", messages, callAI);
  } catch (e) {
    log.warn(`repairOutput failed: ${e.message}`);
    return brokenOutput; // return original if repair fails
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CACHE STATS
// ─────────────────────────────────────────────────────────────────────────────

function getCacheStats() {
  const now  = Date.now();
  const live = [..._cache.entries()].filter(([, e]) => now - e.ts <= CACHE_TTL);
  return {
    total:   _cache.size,
    live:    live.length,
    expired: _cache.size - live.length,
  };
}

function clearCache() {
  _cache.clear();
  log.info("Cache cleared");
}

module.exports = {
  routeTask,
  getTaskProfile,
  classifyIntent,
  generateProjectTitle,
  summarizeForMemory,
  repairOutput,
  getCacheStats,
  clearCache,
  TASK_PROFILES,
};
