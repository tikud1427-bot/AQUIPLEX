/**
 * AQUA Context Optimizer (Phase 4)
 *
 * Two jobs, both additive to the existing tokenManager.js flow:
 *
 *   1. computeContextBudget() — shrink the history token budget for
 *      higher-complexity requests, since those carry a longer system
 *      prompt (reasoning directive + task module) and need more headroom
 *      left over for the response itself.
 *
 *   2. optimizeContext() — light, lossless cleanup pass on an already
 *      -selected message window: drops empty turns and collapses exact
 *      consecutive duplicates. Never reorders or rewrites content.
 */

import { estimateTokens } from './tokenManager.js';

const BUDGET_MULTIPLIERS = { low: 1.0, medium: 0.92, high: 0.82 };
const MIN_BUDGET = 4_000;

/**
 * @param {'low'|'medium'|'high'} complexity
 * @param {number} [baseMax] - default history budget (matches tokenManager default)
 * @returns {number} adjusted token budget for buildContextWindow()
 */
export function computeContextBudget(complexity, baseMax = 12_000) {
  const mul = BUDGET_MULTIPLIERS[complexity] ?? 1.0;
  return Math.max(MIN_BUDGET, Math.round(baseMax * mul));
}

/**
 * @param {Array<{role: string, content: string}>} messages
 * @returns {{ messages: Array, stats: { kept: number, dropped: number, tokensBefore: number, tokensAfter: number } }}
 */
export function optimizeContext(messages) {
  const tokensBefore = messages.reduce((s, m) => s + estimateTokens(m?.content ?? ''), 0);
  const cleaned = [];

  for (const m of messages) {
    if (!m?.content || !m.content.trim()) continue;
    const prev = cleaned[cleaned.length - 1];
    if (prev && prev.role === m.role && prev.content === m.content) continue; // exact dupe
    cleaned.push(m);
  }

  const tokensAfter = cleaned.reduce((s, m) => s + estimateTokens(m.content ?? ''), 0);

  return {
    messages: cleaned,
    stats: {
      kept: cleaned.length,
      dropped: messages.length - cleaned.length,
      tokensBefore,
      tokensAfter,
    },
  };
}
