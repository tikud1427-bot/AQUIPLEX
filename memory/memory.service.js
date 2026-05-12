"use strict";

/**
 * memory/memory.service.js — AQUIPLEX Memory Service
 *
 * Persists user memory to MongoDB via the Memory model.
 * Falls back to in-process Map if DB is unavailable (safe degradation).
 * All functions are async and never throw.
 */

const { createLogger } = require("../utils/logger");
const log = createLogger("MEMORY_SVC");

// ── Lazy-load Memory model (avoids circular require at boot) ──────────────────
let _Memory = null;
function _getModel() {
  if (_Memory) return _Memory;
  try {
    _Memory = require("../models/Memory");
    return _Memory;
  } catch (e) {
    log.warn(`Memory model unavailable: ${e.message}`);
    return null;
  }
}

// ── In-process fallback (survives only until restart) ─────────────────────────
const _fallback = new Map(); // userId → string

// ── getUserMemory ─────────────────────────────────────────────────────────────

/**
 * getUserMemory(userId, currentMessage) → string
 * Returns condensed memory string to inject into system prompt.
 * Fetches top long_term + short_term memories ranked by importance + recency.
 *
 * @param {string} userId
 * @param {string} [currentMessage]
 * @returns {Promise<string>}
 */
async function getUserMemory(userId, currentMessage) {
  if (!userId) return "";
  const Memory = _getModel();

  if (Memory) {
    try {
      const records = await Memory.find({
        userId,
        memoryType: { $in: ["long_term", "short_term"] },
      })
        .sort({ importance: -1, lastAccessed: -1 })
        .limit(20)
        .lean();

      if (!records.length) return "";

      const lines = records.map((r) => `- ${r.key}: ${r.value}`).join("\n");
      return `[Aqua remembers about you]\n${lines}`;
    } catch (e) {
      log.warn(`getUserMemory DB failed: ${e.message}`);
    }
  }

  return _fallback.get(String(userId)) || "";
}

// ── extractMemory ─────────────────────────────────────────────────────────────

/**
 * extractMemory(userId, message, aiCallFn)
 * Fire-and-forget — AI extracts key:value facts, upserts to MongoDB.
 *
 * @param {string}   userId
 * @param {string}   message
 * @param {Function} aiCallFn  — async (messages) → string
 * @returns {Promise<void>}
 */
async function extractMemory(userId, message, aiCallFn) {
  if (!userId || !message || typeof aiCallFn !== "function") return;

  try {
    const messages = [
      {
        role: "system",
        content:
          "Extract key facts about the user from this message. " +
          "Return ONLY a JSON array of objects: [{\"key\": \"fact_name\", \"value\": \"fact_value\", \"importance\": 0.0-1.0}]. " +
          "importance: 0.9 for name/profession/goals, 0.6 for preferences, 0.3 for one-off mentions. " +
          "If nothing notable, return empty array []. No explanation, no markdown.",
      },
      { role: "user", content: message.slice(0, 500) },
    ];

    const raw = await aiCallFn(messages);
    if (!raw || !raw.trim()) return;

    const match = raw.match(/\[[\s\S]*?\]/);
    if (!match) return;
    const facts = JSON.parse(match[0]);
    if (!Array.isArray(facts) || !facts.length) return;

    const Memory = _getModel();

    if (Memory) {
      const ops = facts
        .filter((f) => f.key && f.value)
        .map((f) => ({
          updateOne: {
            filter: { userId, key: String(f.key).slice(0, 100) },
            update: {
              $set: {
                value:        String(f.value).slice(0, 500),
                importance:   Math.min(1, Math.max(0, Number(f.importance) || 0.5)),
                lastAccessed: new Date(),
                memoryType:   "long_term",
              },
              $inc: { frequency: 1 },
              $setOnInsert: { userId },
            },
            upsert: true,
          },
        }));

      if (ops.length) {
        await Memory.bulkWrite(ops);
        log.info(`Memory upserted ${ops.length} fact(s) for user ${userId}`);
      }
    } else {
      const lines   = facts.map((f) => `- ${f.key}: ${f.value}`).join("\n");
      const prev    = _fallback.get(String(userId)) || "";
      const updated = [prev, lines].filter(Boolean).join("\n").slice(-2000);
      _fallback.set(String(userId), updated);
    }
  } catch (e) {
    log.warn(`extractMemory failed: ${e.message}`);
  }
}

// ── clearMemory ───────────────────────────────────────────────────────────────

async function clearMemory(userId) {
  if (!userId) return;
  const Memory = _getModel();
  if (Memory) {
    try {
      await Memory.deleteMany({ userId });
      log.info(`Memory cleared for user ${userId}`);
    } catch (e) {
      log.warn(`clearMemory DB failed: ${e.message}`);
    }
  }
  _fallback.delete(String(userId));
}

// ── getMemoryList ─────────────────────────────────────────────────────────────

/**
 * Returns array of memory entries for the /memory viewer page.
 */
async function getMemoryList(userId) {
  if (!userId) return [];
  const Memory = _getModel();
  if (!Memory) return [];
  try {
    const records = await Memory.find({ userId })
      .sort({ importance: -1, lastAccessed: -1 })
      .limit(50)
      .lean();
    return records.map((r) => ({
      id:         r._id,
      key:        r.key,
      value:      r.value,
      importance: r.importance,
      frequency:  r.frequency,
      updatedAt:  r.updatedAt,
    }));
  } catch (e) {
    log.warn(`getMemoryList failed: ${e.message}`);
    return [];
  }
}

// ── deleteMemoryEntry ─────────────────────────────────────────────────────────

async function deleteMemoryEntry(userId, memoryId) {
  if (!userId || !memoryId) return false;
  const Memory = _getModel();
  if (!Memory) return false;
  try {
    const result = await Memory.deleteOne({ _id: memoryId, userId });
    return result.deletedCount > 0;
  } catch (e) {
    log.warn(`deleteMemoryEntry failed: ${e.message}`);
    return false;
  }
}

// ── getProjectMemory — project-scoped preferences from brain ─────────────────

/**
 * getProjectMemory(userId, projectId)
 * Returns a concise context string combining user memory + project brain.
 */
async function getProjectMemory(userId, projectId) {
  const parts = [];

  // User-level memory
  const userMem = await getUserMemory(userId);
  if (userMem) parts.push(userMem);

  // Project brain context
  if (projectId) {
    try {
      const brain = require("../engine/project.brain");
      const ctx   = await brain.getBrainContext(projectId, { maxLength: 400 });
      if (ctx) parts.push(ctx);
    } catch (e) { /* non-fatal — brain may not exist yet */ }
  }

  return parts.join("\n\n");
}

/**
 * extractProjectPreferences(userId, projectId, message, aiCallFn)
 * Extracts project-specific coding preferences and stores in brain.
 * E.g. "I prefer React" → stored as project.framework = 'react'
 */
async function extractProjectPreferences(userId, projectId, message, aiCallFn) {
  if (!projectId || !message || typeof aiCallFn !== "function") return;

  try {
    const brain   = require("../engine/project.brain");
    const current = await brain.loadBrain(projectId);

    const messages = [
      {
        role: "system",
        content: "Extract any explicit coding/design preferences from this message. Return ONLY JSON: " +
                 '{"framework":"","fontPreference":"","colorPreference":"","otherPrefs":[]}\n' +
                 "Leave fields empty if not mentioned. No explanation.",
      },
      { role: "user", content: message.slice(0, 400) },
    ];

    const raw = await aiCallFn(messages).catch(() => null);
    if (!raw) return;

    const clean = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    const start = clean.indexOf("{");
    const end   = clean.lastIndexOf("}");
    if (start === -1 || end === -1) return;

    const prefs = JSON.parse(clean.slice(start, end + 1));

    let changed = false;
    if (prefs.framework && !current.framework) {
      current.framework = prefs.framework;
      changed = true;
    }
    if (prefs.fontPreference && !current.fontPrimary) {
      current.fontPrimary = prefs.fontPreference;
      changed = true;
    }
    if (prefs.colorPreference && !current.colorPalette?.length) {
      current.colorPalette = [prefs.colorPreference];
      changed = true;
    }
    if (prefs.otherPrefs?.length) {
      current.activeTasks = [...(current.activeTasks || []), ...prefs.otherPrefs].slice(0, 10);
      changed = true;
    }

    if (changed) await brain.saveBrain(current);
  } catch (e) {
    log.warn(`extractProjectPreferences failed: ${e.message}`);
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  getUserMemory,
  extractMemory,
  clearMemory,
  getMemoryList,
  deleteMemoryEntry,
  getProjectMemory,
  extractProjectPreferences,
};