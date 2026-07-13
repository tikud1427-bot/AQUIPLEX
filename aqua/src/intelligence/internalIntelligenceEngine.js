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
import { getAgent }        from './agentRegistry.js';
import { LOW_CONFIDENCE_THRESHOLD } from '../orchestrator/verificationStrategy.js';

/**
 * Whether this turn earns a REAL model reasoning pass (Phase 3) vs the
 * deterministic brief. Same gate the verification loop uses for a deep review:
 * high complexity, or a shaky classification. Deliberately conservative — the
 * pass is a pre-generation model call, so medium/low traffic never pays for it.
 */
function warrantsReasoningPass(complexity, confidence) {
  if (complexity === 'high') return true;
  if (typeof confidence === 'number' && confidence < LOW_CONFIDENCE_THRESHOLD) return true;
  return false;
}

/**
 * @param {{ taskType: string, complexity: string, confidence?: number, userMessage: string, requestId?: string, conversationId?: string }} input
 * @returns {Promise<{ plan: object, reasoning: object, critic: object, synthesis: object, reasoningPass: object }>}
 *
 * ASYNC as of Phase 3: when a turn warrants it (see warrantsReasoningPass) and
 * the 'reasoning' agent is registered, a real model reasoning pass runs and its
 * analysis is folded into the synthesized brief. Otherwise this is the exact
 * deterministic pipeline as before — no model call, no added latency. Fails
 * open: a failed/absent pass falls back to the deterministic brief.
 */
export async function runIntelligencePipeline({ taskType, complexity, confidence = 1.0, userMessage = '', requestId, conversationId }) {
  const plan      = createPlan({ taskType, complexity, confidence });
  const reasoning = runReasoning(plan, userMessage);
  const critic    = reviewReasoning(plan, reasoning);

  // Phase 3 — real reasoning pass, gated + fail-open.
  let reasoningPass = { ran: false };
  const reasoningAgent = getAgent('reasoning');
  if (plan.active && reasoningAgent && warrantsReasoningPass(complexity, confidence)) {
    reasoningPass = await reasoningAgent.run({
      userMessage, plan, reasoning, taskType, requestId, conversationId,
    });
  }

  const synthesis = synthesize({
    plan, reasoning, critic, taskType,
    analysis: reasoningPass.ran ? reasoningPass.analysis : '',
  });

  return { plan, reasoning, critic, synthesis, reasoningPass };
}
