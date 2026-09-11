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
 */

const STRATEGIES = {
  fast_chat:        ['groq',   'gemini', 'openrouter'],
  coding:           ['gemini', 'groq',   'openrouter'],
  architecture:     ['gemini', 'openrouter', 'groq'],
  research:         ['gemini', 'openrouter', 'groq'],
  reasoning:        ['gemini', 'groq',   'openrouter'],
  creative_writing: ['gemini', 'groq',   'openrouter'],
  file_analysis:    ['gemini', 'openrouter', 'groq'],
  agent_task:       ['gemini', 'openrouter', 'groq'],
};

const DEFAULT = ['groq', 'gemini', 'openrouter'];

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
