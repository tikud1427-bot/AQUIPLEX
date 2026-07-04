/**
 * AQUA Response Validator v2 — Intent-Aware
 *
 * ROOT FIX: previous validator had MIN_LENGTH = 5.
 * User: "Reply with only the single letter A"
 * Model: "A"
 * Old validator: REJECTED (too_short)
 * New validator: ACCEPTED (brevity intent detected)
 *
 * New rules:
 * 1. Detect brevity intent in userMessage FIRST
 * 2. If brevity requested → skip all length checks (single chars are valid)
 * 3. Otherwise use task-aware minimum lengths (not a flat MIN_LENGTH)
 * 4. Still reject: empty, error strings, safety refusals, truncated heavy responses
 */

// ── Brevity intent — user explicitly asked for short output ───────────────────

const BREVITY_PATTERNS = [
  /\breply\s+(with\s+)?(only|just)\b/i,
  /\bonly\s+(reply|respond|output|return|say|answer|write)\b/i,
  /\bone\s+(word|letter|character|sentence|line)\b/i,
  /\byes\s+or\s+no\b/i,
  /\boutput\s+(only|just)\b/i,
  /\breturn\s+(only|just)\b/i,
  /\bsingle\s+(word|letter|digit|char|sentence|number)\b/i,
  /\bjust\s+(say|output|return|respond|write|answer|give\s+me)\b/i,
  /\bshort(est)?\s+possible\b/i,
  /\bin\s+one\s+(word|sentence|line|paragraph)\b/i,
  /\bbriefly\b/i,
  /\bin\s+a\s+word\b/i,
  /\bshort answer\b/i,
  /\bjust\s+the\s+(answer|result|value|number|letter)\b/i,
];

// ── Provider / system error strings — always reject ───────────────────────────

const ERROR_PATTERNS = [
  /^(null|undefined|false)$/i,
  /^error:/i,
  /^(api error|service error|provider error)/i,
  /^(gemini|groq|openrouter|deepseek|llama)\s+(error|api)\b/i,
  /^(500|502|503|504)[\s:]/,
];

// ── Safety refusals — reject, trigger fallback ────────────────────────────────
// (Another provider may answer the same question without refusing)

const SAFETY_PATTERNS = [
  /^I('m| am) not able to help with that/i,
  /^I cannot (assist|help) with that/i,
  /violates?\s+(my\s+)?(safety|content)\s+(guidelines?|polic(y|ies))/i,
  /against\s+(my\s+)?(terms|guidelines|policies)\b/i,
  /^I('m| am) sorry.*I (can't|cannot|won't|will not) (help|assist|provide)/i,
];

// ── Truncation signals — only checked for long-form tasks ─────────────────────

const TRUNCATION_PATTERNS = [
  /\.\.\.\s*$/,
  /\[continued\]/i,
  /\[truncated\]/i,
  /\bto\s+be\s+continued\b/i,
];

// ── Task-aware minimum lengths ────────────────────────────────────────────────

const TASK_MIN_LENGTH = {
  conversation:     1,
  memory:           1,
  personal_info:    1,
  simple_qa:        1,   // "Paris" is a valid answer to a capital question
  opinion:          5,
  brainstorming:    15,
  summarization:    10,
  debugging:        15,
  coding:           10,
  reasoning:        5,
  analysis:         15,
  planning:         15,
  research:         30,
  architecture:     50,
  creative_writing: 10,
  file_analysis:    10,
};

const DEFAULT_MIN_LENGTH = 5;

// ── Exports ───────────────────────────────────────────────────────────────────

/**
 * Validate model response with intent awareness.
 *
 * @param {string} text        - model output
 * @param {string} userMessage - original user message (intent detection)
 * @param {string} taskType    - from classifier
 * @returns {{ valid: boolean, reason: string }}
 */
export function validateResponse(text, userMessage = '', taskType = '') {
  // ── Empty ──────────────────────────────────────────────────────────────────
  if (!text || typeof text !== 'string')
    return { valid: false, reason: 'empty_response' };

  const t = text.trim();
  if (!t.length)
    return { valid: false, reason: 'empty_response' };

  // ── Safety refusals (reject before brevity check) ─────────────────────────
  for (const p of SAFETY_PATTERNS) {
    if (p.test(t)) return { valid: false, reason: 'safety_refusal' };
  }

  // ── Provider error strings ─────────────────────────────────────────────────
  for (const p of ERROR_PATTERNS) {
    if (p.test(t)) return { valid: false, reason: 'provider_error_string' };
  }

  // ── Brevity intent — bypass all length checks ──────────────────────────────
  const brevityRequested = BREVITY_PATTERNS.some(p => p.test(userMessage));
  if (brevityRequested) {
    return { valid: true, reason: 'brevity_intent_matched' };
  }

  // ── Task-aware minimum length ──────────────────────────────────────────────
  const minLen = TASK_MIN_LENGTH[taskType] ?? DEFAULT_MIN_LENGTH;
  if (t.length < minLen) {
    return { valid: false, reason: `too_short_for_${taskType || 'unknown'}` };
  }

  // ── Truncation check (only for heavy long-form tasks) ─────────────────────
  const heavyTasks = ['research', 'architecture', 'coding', 'analysis', 'planning', 'debugging'];
  if (heavyTasks.includes(taskType)) {
    for (const p of TRUNCATION_PATTERNS) {
      if (p.test(t)) return { valid: false, reason: 'truncated_response' };
    }
  }

  return { valid: true };
}
