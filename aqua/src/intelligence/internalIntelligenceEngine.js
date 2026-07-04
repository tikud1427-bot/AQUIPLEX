/**
 * AQUA Internal Intelligence Engine — Orchestrator
 *
 * Single entry point chat.js calls. Runs the four deterministic stages
 * in sequence:
 *
 *   Planner → Reasoning Engine → Critic → Synthesizer
 *
 * Sits between the existing Phase 4 Execution Planner / Reasoning
 * Strategy modules and promptBuilder.js. Does not replace or modify
 * either of those — it adds a deeper, structured layer on top, and
 * degrades to a no-op for low-complexity requests (see planner.js) so
 * casual chat keeps its current low token cost exactly as before.
 *
 * ── Future roadmap compatibility (spec section 10) ──────────────────────
 * Each stage is a separate module with a narrow interface, so the
 * upgrades below can land without redesigning this orchestrator:
 *   - True multi-agent execution   → swap a stage's deterministic fn for
 *                                    one that calls agentRegistry.js agents
 *   - Parallel reasoning           → runReasoning() can fan out to
 *                                    multiple strategies and merge results
 *   - Self-reflection loops        → critic.js can loop reviewReasoning()
 *                                    against a draft answer
 *   - Tool / web / repo agents     → register via agentRegistry.js,
 *                                    invoked from a new pipeline stage
 *   - Verification / eval models   → slot in as a 5th stage after Critic
 * None of these require changing chat.js's call site below.
 */

import { createPlan }      from './planner.js';
import { runReasoning }    from './reasoningEngine.js';
import { reviewReasoning } from './critic.js';
import { synthesize }      from './synthesizer.js';

/**
 * @param {{ taskType: string, complexity: string, confidence?: number, userMessage: string }} input
 * @returns {{ plan: object, reasoning: object, critic: object, synthesis: object }}
 */
export function runIntelligencePipeline({ taskType, complexity, confidence = 1.0, userMessage = '' }) {
  const plan      = createPlan({ taskType, complexity, confidence });
  const reasoning = runReasoning(plan, userMessage);
  const critic    = reviewReasoning(plan, reasoning);
  const synthesis = synthesize({ plan, reasoning, critic, taskType });

  return { plan, reasoning, critic, synthesis };
}
