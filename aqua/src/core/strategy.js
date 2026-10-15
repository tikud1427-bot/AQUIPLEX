/**
 * AQUA Provider Strategy
 *
 * Maps task type → provider order.
 *
 * fast_chat   → Groq first (lowest latency, handles casual conversation well)
 * coding      → Gemini first (best code quality)
 * architecture→ Gemini first (deepest reasoning)
 * research    → Gemini first (breadth + depth)
 * reasoning   → Gemini first (chain-of-thought strength)
 * creative    → Gemini first (creative quality)
 * file/agent  → Gemini first (multimodal + context)
 *
 * nvidia is LAST in every list: an additional provider/fallback (2026-10), not
 * a primary. Order here only decides the candidate set — router.js ranks by
 * score (quality prior × health), and its NVIDIA quality row is a preliminary,
 * unmeasured prior. AQUA_PROVIDER_PREFER (router.js) can put it first for a
 * controlled rollout.
 */

const STRATEGIES = {
  fast_chat:        ['groq',   'gemini', 'openrouter', 'nvidia'],
  coding:           ['gemini', 'groq',   'openrouter', 'nvidia'],
  architecture:     ['gemini', 'openrouter', 'groq', 'nvidia'],
  research:         ['gemini', 'openrouter', 'groq', 'nvidia'],
  reasoning:        ['gemini', 'groq',   'openrouter', 'nvidia'],
  creative_writing: ['gemini', 'groq',   'openrouter', 'nvidia'],
  file_analysis:    ['gemini', 'openrouter', 'groq', 'nvidia'],
  agent_task:       ['gemini', 'openrouter', 'groq', 'nvidia'],
};

const DEFAULT = ['groq', 'gemini', 'openrouter', 'nvidia'];

/**
 * @param {string} taskType
 * @param {'low'|'medium'|'high'} [complexity] - Phase 4: from executionPlanner.js
 * @returns {string[]} ranked provider order
 */
export function getProviderStrategy(taskType, complexity) {
  const order = STRATEGIES[taskType] ?? DEFAULT;

  // Phase 4: high-complexity plans always lead with the strongest reasoner,
  // even for task types not normally weighted toward Gemini.
  if (complexity === 'high' && order[0] !== 'gemini' && order.includes('gemini')) {
    return ['gemini', ...order.filter(p => p !== 'gemini')];
  }

  return order;
}
