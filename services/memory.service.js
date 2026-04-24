/**
 * memory.service.js
 * 
 * Intelligent memory management for Aqua AI.
 * 
 * Replaces the original extractMemory() and getUserMemory() in index.js.
 * Drop-in compatible — index.js imports these two functions and nothing else
 * needs to change.
 * 
 * Architecture:
 *   extractMemory()   — async, non-blocking, called fire-and-forget
 *   getUserMemory()   — async, returns formatted string for AI context
 * 
 * Memory types:
 *   long_term   — stable facts (name, goal, profession). Max 50 per user.
 *   short_term  — recent context. Auto-expires via MongoDB TTL after 24h.
 *   session     — not persisted to DB (handled at route level if needed)
 */

const Memory = require("../models/Memory");

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const IMPORTANCE_THRESHOLD   = 0.55; // Don't store memories below this score
const MAX_LONG_TERM_MEMORIES = 50;   // Hard cap per user
const SHORT_TERM_TTL_HOURS   = 24;   // Short-term memories expire after 24h
const RETRIEVAL_LIMIT        = 15;   // Max memories returned to AI context

/**
 * Keys that are explicitly "stable" — always treated as long_term
 * even if the AI scores them lower.
 */
const LONG_TERM_KEYS = new Set([
  "name", "age", "location", "profession", "job", "occupation",
  "goal", "goals", "project", "projects", "language", "stack",
  "preference", "preferences", "interest", "interests", "skill", "skills",
  "company", "school", "university", "hobby", "hobbies",
]);

/**
 * Keys that are always short-term (contextual, not biographical)
 */
const SHORT_TERM_KEYS = new Set([
  "current_task", "current_topic", "last_question", "mood",
  "recent_error", "working_on",
]);

// ─── INTERNAL HELPERS ────────────────────────────────────────────────────────

/**
 * Determine memory type from key name.
 * Falls back to what the AI decided (aiType).
 */
function resolveMemoryType(key, aiType) {
  const normalizedKey = (key || "").toLowerCase().replace(/\s+/g, "_");

  if (LONG_TERM_KEYS.has(normalizedKey))  return "long_term";
  if (SHORT_TERM_KEYS.has(normalizedKey)) return "short_term";

  // Trust AI classification if it gave one
  if (aiType === "short_term" || aiType === "long_term") return aiType;

  return "long_term"; // Default to long_term when uncertain
}

/**
 * Build expiresAt date for short_term memories.
 */
function buildExpiresAt(memoryType) {
  if (memoryType !== "short_term") return null;

  const d = new Date();
  d.setHours(d.getHours() + SHORT_TERM_TTL_HOURS);
  return d;
}

/**
 * Merge incoming value with existing value intelligently.
 * Avoids blind overwrite — appends new info if it differs meaningfully.
 *
 * Example:
 *   existing: "build a SaaS platform"
 *   incoming: "build a SaaS platform with AI features"
 *   result:   "build a SaaS platform with AI features"  ← incoming is superset, use it
 *
 *   existing: "Python, JavaScript"
 *   incoming: "Rust"
 *   result:   "Python, JavaScript; Rust"  ← genuinely new, append
 */
function mergeValues(existingValue, incomingValue) {
  if (!existingValue) return incomingValue;
  if (!incomingValue) return existingValue;

  const ex = existingValue.trim().toLowerCase();
  const inc = incomingValue.trim().toLowerCase();

  // If incoming is a superset of existing (or same), use incoming
  if (inc.includes(ex) || ex === inc) return incomingValue.trim();

  // If existing is a superset of incoming, keep existing
  if (ex.includes(inc)) return existingValue.trim();

  // Genuinely different — append with semicolon separator
  return `${existingValue.trim()}; ${incomingValue.trim()}`;
}

/**
 * Prune lowest-importance long_term memories to enforce MAX_LONG_TERM_MEMORIES.
 * Only called when we're at or over the cap.
 */
async function pruneOldestMemories(userId) {
  try {
    const count = await Memory.countDocuments({ userId, memoryType: "long_term" });

    if (count < MAX_LONG_TERM_MEMORIES) return; // Still under cap, nothing to do

    // Find the N lowest-importance long_term memories and delete them
    const overflow = count - MAX_LONG_TERM_MEMORIES + 1; // +1 to make room for the new one
    const toDelete = await Memory.find({ userId, memoryType: "long_term" })
      .sort({ importance: 1, lastAccessed: 1 }) // least important + least recently used first
      .limit(overflow)
      .select("_id")
      .lean();

    if (toDelete.length > 0) {
      await Memory.deleteMany({ _id: { $in: toDelete.map((m) => m._id) } });
    }
  } catch (err) {
    console.warn("⚠️ [memory] pruneOldestMemories failed:", err.message);
  }
}

// ─── MAIN EXPORTS ─────────────────────────────────────────────────────────────

/**
 * extractMemory(userId, message, generateAI)
 * 
 * Extracts structured memories from a user message and upserts them to MongoDB.
 * 
 * Design decisions:
 * - Called fire-and-forget (no await) from the chat route — never blocks response
 * - Uses AI to score importance — only persists items above IMPORTANCE_THRESHOLD
 * - Merges values intelligently instead of overwriting
 * - NEVER deletes memories based on what's NOT in the current message
 *   (this was the original bug — a greeting would wipe all memories)
 * 
 * @param {string|ObjectId} userId
 * @param {string} message  - raw user message
 * @param {Function} generateAI - the generateAI() function from index.js (injected to avoid circular dep)
 */
async function extractMemory(userId, message, generateAI) {
  if (!userId || !message || !message.trim()) return;

  // Quick pre-filter: skip obvious non-informational messages
  const trimmed = message.trim().toLowerCase();
  const skipPhrases = [
    "hi", "hello", "hey", "thanks", "thank you", "ok", "okay",
    "yes", "no", "sure", "great", "cool", "nice", "lol", "haha",
  ];
  if (trimmed.length < 8 || skipPhrases.includes(trimmed)) return;

  try {
    const aiResponse = await generateAI([
      {
        role: "system",
        content: `You are a memory extraction engine for a personal AI assistant.

Your job: read the user's message and extract ONLY facts that are:
- Stable and personally meaningful (name, goals, profession, skills, preferences, projects)
- Useful for future conversations
- NOT generic filler, greetings, or temporary questions

For each extracted fact, provide:
- key: snake_case label (e.g. "name", "main_goal", "preferred_language")
- value: concise extracted fact (max 100 chars)
- importance: float 0.0-1.0 (how useful is this for future reference?)
  - 0.9-1.0: core identity facts (name, job, major goal)
  - 0.7-0.89: strong preferences, ongoing projects
  - 0.55-0.69: minor preferences, context clues
  - below 0.55: don't include
- memoryType: "long_term" for stable facts, "short_term" for current-session context

Return ONLY a valid JSON array. If nothing worth remembering: return [].

Examples of GOOD extractions:
  Input: "I'm building a SaaS called Aquiplex with my co-founder"
  Output: [{"key":"project","value":"building a SaaS called Aquiplex","importance":0.9,"memoryType":"long_term"},{"key":"work_style","value":"working with a co-founder","importance":0.6,"memoryType":"long_term"}]

Examples of BAD extractions (do NOT include these):
  - {"key":"question","value":"asked about AI"} ← too generic
  - {"key":"mood","value":"seems curious"} ← too vague

Return [] for: greetings, simple questions, random queries, code requests with no personal info.`,
      },
      {
        role: "user",
        content: message.slice(0, 500), // Cap input length for cost control
      },
    ]);

    // Parse AI response safely
    let extracted = [];
    try {
      const cleaned = (aiResponse || "").replace(/```json|```/g, "").trim();
      const match = cleaned.match(/\[[\s\S]*\]/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed)) extracted = parsed;
      }
    } catch (parseErr) {
      console.warn("⚠️ [memory] JSON parse failed:", parseErr.message);
      return;
    }

    if (extracted.length === 0) return;

    // Process each extracted memory
    for (const item of extracted) {
      // Validate structure
      if (!item.key || !item.value) continue;

      const importance = parseFloat(item.importance) || 0.5;

      // Skip low-importance memories
      if (importance < IMPORTANCE_THRESHOLD) continue;

      const memoryType = resolveMemoryType(item.key, item.memoryType);
      const expiresAt = buildExpiresAt(memoryType);

      try {
        // Check if this key already exists for this user
        const existing = await Memory.findOne({ userId, key: item.key }).lean();

        if (existing) {
          // MERGE — do not blindly overwrite
          const mergedValue = mergeValues(existing.value, item.value);
          const newImportance = Math.max(existing.importance, importance); // Keep highest
          const newFrequency = (existing.frequency || 1) + 1;

          await Memory.updateOne(
            { userId, key: item.key },
            {
              $set: {
                value: mergedValue,
                importance: newImportance,
                memoryType,               // Update type in case classification improved
                lastAccessed: new Date(),
                expiresAt,
              },
              $inc: { frequency: 1 },
            }
          );
        } else {
          // NEW memory — enforce cap before inserting long_term
          if (memoryType === "long_term") {
            await pruneOldestMemories(userId);
          }

          await Memory.create({
            userId,
            key: item.key,
            value: item.value,
            importance,
            frequency: 1,
            memoryType,
            lastAccessed: new Date(),
            expiresAt,
          });
        }
      } catch (upsertErr) {
        // Duplicate key race condition — safe to ignore
        if (upsertErr.code === 11000) return;
        console.warn(`⚠️ [memory] upsert failed for key "${item.key}":`, upsertErr.message);
      }
    }
  } catch (err) {
    // Silently swallow — memory failure must never crash the chat response
    console.warn("⚠️ [memory] extractMemory failed:", err.message);
  }
}

/**
 * getUserMemory(userId, currentMessage?)
 * 
 * Retrieves the most relevant memories for a user, formatted as a string
 * ready to inject into the AI system prompt.
 * 
 * Ranking formula:
 *   score = (importance * 0.5) + (recencyScore * 0.3) + (frequencyScore * 0.2)
 * 
 * Where:
 *   recencyScore  = 1.0 if accessed in last 1h, decays to 0 over 30 days
 *   frequencyScore = normalized frequency (capped at 10 references = 1.0)
 * 
 * @param {string|ObjectId} userId
 * @param {string} [currentMessage] - optional: used for relevance boost (future)
 * @returns {string} formatted memory block for AI context injection
 */
async function getUserMemory(userId, currentMessage = "") {
  if (!userId) return "";

  try {
    // Fetch all non-expired memories for this user
    const memories = await Memory.find({
      userId,
      $or: [
        { expiresAt: null },
        { expiresAt: { $gt: new Date() } },
      ],
    })
      .lean()
      .limit(100); // Safety cap — we'll rank and trim below

    if (!memories.length) return "";

    const now = Date.now();
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

    // Score each memory for relevance
    const scored = memories.map((m) => {
      // Recency score: 1.0 if accessed now, linearly decays to 0 over 30 days
      const ageMs = now - new Date(m.lastAccessed || m.updatedAt).getTime();
      const recencyScore = Math.max(0, 1 - ageMs / THIRTY_DAYS_MS);

      // Frequency score: normalize to 0–1, capped at 10 references
      const frequencyScore = Math.min(1, (m.frequency || 1) / 10);

      // Composite score
      const score =
        (m.importance || 0.5) * 0.5 +
        recencyScore * 0.3 +
        frequencyScore * 0.2;

      return { ...m, _score: score };
    });

    // Sort by composite score, take top N
    scored.sort((a, b) => b._score - a._score);
    const top = scored.slice(0, RETRIEVAL_LIMIT);

    // Separate long_term and short_term for clean formatting
    const longTerm  = top.filter((m) => m.memoryType !== "short_term");
    const shortTerm = top.filter((m) => m.memoryType === "short_term");

    const lines = [];

    if (longTerm.length > 0) {
      lines.push("📌 What I know about you:");
      longTerm.forEach((m) => {
        lines.push(`  • ${m.key}: ${m.value}`);
      });
    }

    if (shortTerm.length > 0) {
      lines.push("🕐 Recent context:");
      shortTerm.forEach((m) => {
        lines.push(`  • ${m.key}: ${m.value}`);
      });
    }

    return lines.join("\n");
  } catch (err) {
    console.warn("⚠️ [memory] getUserMemory failed:", err.message);
    return ""; // Graceful fallback — AI still works, just without memory
  }
}

module.exports = { extractMemory, getUserMemory };