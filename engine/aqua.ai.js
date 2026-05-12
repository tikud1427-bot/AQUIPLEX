"use strict";

/**
 * engine/aqua.ai.js — AQUIPLEX AI Engine
 *
 * Wraps Anthropic claude API calls.
 * All functions are async and never throw — errors return empty/null.
 */

const { createLogger } = require("../utils/logger");
const log = createLogger("AQUA_AI");

// ── Client init ───────────────────────────────────────────────────────────────

let _anthropic = null;

function _getClient() {
  if (_anthropic) return _anthropic;
  try {
    const Anthropic = require("@anthropic-ai/sdk");
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return _anthropic;
  } catch (e) {
    log.error(`Anthropic SDK init failed: ${e.message}`);
    return null;
  }
}

const DEFAULT_MODEL     = process.env.AQUA_MODEL     || "claude-opus-4-5";
const DEFAULT_MAX_TOKENS = parseInt(process.env.AQUA_MAX_TOKENS || "4096", 10);

// ── generateChatReply ─────────────────────────────────────────────────────────

/**
 * generateChatReply(messages, opts) → string
 * @param {Array<{role: string, content: string}>} messages
 * @param {{ temperature?: number, maxTokens?: number }} opts
 * @returns {Promise<string>}
 */
async function generateChatReply(messages, opts = {}) {
  const client = _getClient();
  if (!client) return "AI service unavailable. Please check your API key configuration.";

  // Split system message out — Anthropic API requires it separately
  let systemPrompt = "";
  const userMessages = [];

  for (const m of messages) {
    if (m.role === "system") {
      systemPrompt += (systemPrompt ? "\n" : "") + m.content;
    } else {
      userMessages.push({ role: m.role, content: m.content });
    }
  }

  // Ensure alternating roles (Anthropic requirement)
  const cleaned = [];
  for (const m of userMessages) {
    if (cleaned.length > 0 && cleaned[cleaned.length - 1].role === m.role) {
      cleaned[cleaned.length - 1].content += "\n" + m.content;
    } else {
      cleaned.push({ ...m });
    }
  }

  // Must start with user
  if (!cleaned.length || cleaned[0].role !== "user") {
    cleaned.unshift({ role: "user", content: "Hello" });
  }

  try {
    const response = await client.messages.create({
      model:      opts.model      || DEFAULT_MODEL,
      max_tokens: opts.maxTokens  || DEFAULT_MAX_TOKENS,
      system:     systemPrompt    || undefined,
      messages:   cleaned,
      temperature: opts.temperature ?? 0.7,
    });

    return response.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("") || "";
  } catch (e) {
    log.error(`generateChatReply failed: ${e.message}`);
    return "I encountered an error generating a response. Please try again.";
  }
}

// ── generateWebSearchReply ────────────────────────────────────────────────────

/**
 * generateWebSearchReply(messages, opts) → { message: string, sources: [] }
 * Falls back to plain chat reply if search not configured.
 */
async function generateWebSearchReply(messages, opts = {}) {
  try {
    const reply = await generateChatReply(messages, opts);
    return { message: reply, sources: [] };
  } catch (e) {
    log.error(`generateWebSearchReply failed: ${e.message}`);
    return { message: "Web search unavailable.", sources: [] };
  }
}

// ── generateImage ─────────────────────────────────────────────────────────────

/**
 * generateImage(prompt, opts) → string | null
 * Returns image URL or null on failure.
 */
async function generateImage(prompt, opts = {}) {
  // Image generation not supported by Anthropic API directly.
  // Extend this to call DALL-E / Stability AI if needed.
  log.warn("generateImage called but no image provider configured.");
  return null;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { generateChatReply, generateWebSearchReply, generateImage };
