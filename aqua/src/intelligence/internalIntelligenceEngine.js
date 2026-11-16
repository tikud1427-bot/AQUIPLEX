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
import { reviewDepth } from '../orchestrator/verificationStrategy.js';

/**
 * Whether this turn earns a REAL model reasoning pass (Phase 3) vs the
 * deterministic brief. Same gate the verification loop uses for a deep review
 * (verificationStrategy.reviewDepth): high complexity, or a shaky
 * classification that is long or sensitive. Deliberately conservative — the
 * pass is a pre-generation model call, so medium/low traffic never pays for it.
 */
function warrantsReasoningPass(complexity, confidence, tags, userMessage) {
  return reviewDepth({ complexity, confidence, tags, userMessage }).reasoningPass;
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
export async function runIntelligencePipeline({ taskType, complexity, confidence = 1.0, userMessage = '', reasoningMessage = null, requestId, conversationId, skipReasoningPass = false, costLedger = null, tags = [] }) {
  const plan      = createPlan({ taskType, complexity, confidence });
  const reasoning = runReasoning(plan, userMessage);
  const critic    = reviewReasoning(plan, reasoning);

  // Phase 3 — real reasoning pass, gated + fail-open.
  let reasoningPass = { ran: false };
  const reasoningAgent = getAgent('reasoning');
  if (skipReasoningPass) {
    // The caller already knows this turn's generation step will be replaced
    // wholesale (e.g. the Artifact Engine builds a file instead of prose), so
    // the pass's analysis would be produced and then discarded. Skipping saves
    // a full model call and its latency. The deterministic stages above still
    // run — they are pure and free.
    reasoningPass = { ran: false, skipped: true, reason: 'generation replaced by a specialist engine' };
  } else if (plan.active && reasoningAgent && warrantsReasoningPass(complexity, confidence, tags, userMessage)) {
    reasoningPass = await reasoningAgent.run({
      // 2026-11-16 (conversation recovery): the pass analyses the question as
      // the conversation resolved it ("Is it curable? (… means: pneumonia)"),
      // never a bare pronoun. Gating above still reads the literal message.
      userMessage: reasoningMessage ?? userMessage, plan, reasoning, taskType, requestId, conversationId, costLedger,
    });
  }

  const synthesis = synthesize({
    plan, reasoning, critic, taskType,
    analysis: reasoningPass.ran ? reasoningPass.analysis : '',
  });

  return { plan, reasoning, critic, synthesis, reasoningPass };
}
