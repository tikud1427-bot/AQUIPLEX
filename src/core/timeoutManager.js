/**
 * AQUA Timeout Manager
 *
 * ROOT FIX for Gemini cascade:
 * Previous router used TIMEOUT_MS = 8_000 for every provider and every task.
 * Gemini 2.5 Flash (with thinking) needs 20-65s for research/architecture.
 * 8s guaranteed Gemini always timed out → every request fell back to Groq.
 *
 * New behavior:
 * - Per-task base timeout (calibrated to Gemini 2.5 Flash worst-case)
 * - Per-provider multiplier (Groq is 2-3x faster → shorter budget)
 * - Prompt complexity scaling (longer prompt = more generation time)
 */

// Base timeouts in ms — calibrated so Gemini 2.5 Flash succeeds on first try
const BASE_TIMEOUTS = {
  // Instant responses
  conversation:      8_000,
  fast_chat:         8_000,
  memory:            8_000,
  personal_info:     8_000,

  // Short answers
  simple_qa:        10_000,
  opinion:          12_000,

  // Medium work
  brainstorming:    20_000,
  summarization:    25_000,
  creative_writing: 25_000,

  // Deep work (Gemini thinking enabled)
  debugging:        30_000,
  coding:           35_000,
  reasoning:        35_000,
  analysis:         40_000,
  planning:         42_000,

  // Heavy deep work — Gemini needs the runway
  file_analysis:    45_000,
  agent_task:       45_000,
  research:         55_000,
  architecture:     65_000,
};

const DEFAULT_TIMEOUT = 20_000;

/**
 * Provider multipliers.
 * Budgets are sized for Gemini. Groq completes same tasks 2-3x faster.
 * Giving Groq 65s for a fast_chat is wasteful and slows fallback on real failures.
 */
const PROVIDER_MULTIPLIERS = {
  gemini:     1.00,   // reference — budgets sized for Gemini
  groq:       0.35,   // very fast inference; keep budget tight
  openrouter: 0.65,   // varies; deepseek-v3 can be slow on complex prompts
};

/**
 * Prompt complexity multiplier.
 * Longer prompts → more context to process → longer generation.
 */
function complexityMultiplier(promptLength) {
  if (promptLength > 8_000) return 1.7;
  if (promptLength > 4_000) return 1.4;
  if (promptLength > 2_000) return 1.2;
  if (promptLength > 800)   return 1.1;
  return 1.0;
}

/**
 * Phase 4 complexity multiplier.
 * High-complexity plans (reflective reasoning, multi-step) get extra runway.
 * Default 'low' → multiplier 1.0 → identical output to pre-Phase-4 callers.
 */
const PLAN_COMPLEXITY_MULTIPLIERS = { low: 1.0, medium: 1.15, high: 1.35 };

/**
 * Compute timeout for a specific provider + task + prompt size combination.
 *
 * @param {string} taskType     - output of classifier
 * @param {string} provider     - 'gemini' | 'groq' | 'openrouter'
 * @param {number} promptLength - total char count of systemPrompt + all messages
 * @param {'low'|'medium'|'high'} [complexity] - Phase 4: from executionPlanner.js, defaults to 'low' (no-op)
 * @returns {number} timeout in ms
 */
export function getTimeout(taskType, provider = 'gemini', promptLength = 0, complexity = 'low') {
  const base     = BASE_TIMEOUTS[taskType] ?? DEFAULT_TIMEOUT;
  const provMul  = PROVIDER_MULTIPLIERS[provider] ?? 1.0;
  const compMul  = complexityMultiplier(promptLength);
  const planMul  = PLAN_COMPLEXITY_MULTIPLIERS[complexity] ?? 1.0;
  const result   = Math.round(base * provMul * compMul * planMul);

  // Hard floors: never give less than 5s (any provider) or 15s (Gemini complex tasks)
  const floor    = provider === 'gemini' && base > 20_000 ? 15_000 : 5_000;
  return Math.max(result, floor);
}

export { BASE_TIMEOUTS };
