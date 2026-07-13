/**
 * AQUA Internal Intelligence Engine — Reasoning Agent (Phase 3)
 * ─────────────────────────────────────────────────────────────────────────────
 * The real reasoning pass the codebase was explicitly built to accept and
 * deferred. Until now the "Internal Intelligence Engine" was four deterministic
 * stages that only SELECTED prompt strings (a pipeline template, a strategy
 * directive, a risk rubric) — no stage actually reasoned. reasoningEngine.js's
 * own header: strategies are "plain data ... designed so a real multi-agent
 * strategy (one that actually runs its own reasoning pass) can register under
 * the same name later." planner.js documents the same seam. This module is that
 * pass.
 *
 * It registers itself as the 'reasoning' agent on import (side effect, exactly
 * like verificationAgent.js registers 'verification'). internalIntelligence-
 * Engine.js invokes it ONLY when a turn is worth the extra model call (high
 * complexity or shaky classification — the same gate that already grants
 * verification a second pass). For everything else the deterministic brief is
 * used unchanged, so casual + medium traffic keeps today's cost and latency.
 *
 * What it produces: a compact, structured analysis of the ACTUAL question,
 * worked through the plan's real pipeline stages (from pipelineRegistry.js) —
 * assumptions, the key decision, risks/edge cases, and a recommended approach.
 * That analysis is folded into the intelligence brief (synthesizer.js) and
 * injected into the system prompt, so the MAIN generation answers WITH a real
 * deliberation step in front of it instead of a template checklist.
 *
 * Design choices (mirror verificationAgent.js so behavior is predictable):
 *   - Reuses generateText() end-to-end — provider ranking, health, full
 *     fallback chain, timeout budget — never calls a provider directly.
 *   - preTaskType is the REAL taskType so ranking still favors the provider
 *     strong at that domain (e.g. Gemini for architecture).
 *   - Its own scratch context (`${requestId}-reason`) so the main turn's
 *     fallbackChain / diagnostics are untouched.
 *   - Bounded output (responseBudget) — this is a THINKING step, not the answer;
 *     it must not balloon latency.
 *   - Fails open: any error (provider exhausted, timeout, empty) returns
 *     { ran:false } and the pipeline falls back to the deterministic brief.
 *     A broken reasoning pass can never turn a working turn into a failed one.
 *   - `generate` is injectable for offline tests (same hook verificationAgent
 *     exposes).
 */
import { generateText }  from '../providers/router.js';
import { createContext } from '../core/observability.js';
import { registerAgent } from './agentRegistry.js';

// Bounded thinking budget — enough for a real analysis, not a full answer.
const REASONING_BUDGET = { maxResponseTokens: 1024 };

/**
 * Build the analysis-elicitation system prompt from the real plan.
 * @param {object} plan       planner.js output ({ taskType, pipeline: [{name,focus}] })
 * @param {object} reasoning  reasoningEngine.js output ({ strategy, directive })
 * @returns {string}
 */
function buildReasoningPrompt(plan, reasoning) {
  const stages = (plan?.pipeline ?? [])
    .map((s, i) => `${i + 1}. ${s.name} — ${s.focus}`)
    .join('\n');

  return [
    "You are AQUA's internal reasoning pass. You are shown a user's request. Do NOT answer it — a separate step writes the final answer. Your job is to think it through first and hand that thinking to the answering step.",
    '',
    reasoning?.directive ? `Approach: ${reasoning.directive}` : '',
    stages ? `Work through these stages, briefly, against THIS specific request (not generically):\n${stages}` : '',
    '',
    'Produce a tight analysis (no preamble, no restating the question) covering:',
    '- Assumptions you are making and any ambiguity worth flagging',
    '- The core decision or crux the answer hinges on',
    '- Concrete risks, edge cases, or failure modes to get right',
    '- The recommended approach, in a sentence or two',
    '',
    'Be specific and concise. This is a scratchpad for the answering step, not the deliverable — bullet points are fine. Do not write the final answer.',
  ].filter(Boolean).join('\n');
}

/**
 * Run a real reasoning pass on a request.
 *
 * @param {object} input
 * @param {string} input.userMessage
 * @param {object} input.plan            planner.js output for this turn
 * @param {object} input.reasoning       reasoningEngine.js output for this turn
 * @param {string} input.taskType
 * @param {string} [input.requestId]
 * @param {string} [input.conversationId]
 * @param {object} [input.responseBudget] optional override of REASONING_BUDGET
 * @param {Function} [input.generate]     test injection; defaults to generateText
 * @returns {Promise<{ ran: boolean, analysis?: string, provider?: string, latencyMs?: number, attemptCount?: number, error?: string }>}
 */
export async function runReasoningPass({
  userMessage,
  plan,
  reasoning,
  taskType,
  requestId,
  conversationId,
  responseBudget = REASONING_BUDGET,
  generate = generateText,
}) {
  const start = Date.now();
  const systemPrompt = buildReasoningPrompt(plan, reasoning);
  const messages = [{ role: 'user', content: `User request:\n${userMessage}` }];

  const reasonCtx = createContext({
    conversationId,
    requestId: requestId ? `${requestId}-reason` : undefined,
  });

  try {
    const result = await generate(
      userMessage,
      systemPrompt,
      messages,
      reasonCtx,
      taskType,       // real taskType → domain-appropriate provider ranking
      undefined,      // no execution-plan bias for the thinking call itself
      responseBudget,
    );

    const analysis = (result?.text ?? '').trim();
    if (!analysis) {
      return { ran: false, error: 'empty_analysis', latencyMs: Date.now() - start };
    }

    return {
      ran: true,
      analysis,
      provider: result.provider,
      latencyMs: Date.now() - start,
      attemptCount: result.fallbackChain?.length ?? 1,
    };
  } catch (err) {
    // Fail open — the pipeline falls back to the deterministic brief.
    console.warn(`[REASONING] pass failed, falling back to deterministic brief: ${err.message}`);
    return { ran: false, error: err.message, latencyMs: Date.now() - start };
  }
}

// ── Register as the 'reasoning' agent (side effect on import) ─────────────────
registerAgent('reasoning', {
  name: 'reasoning',
  description: 'Real pre-generation reasoning pass: analyzes the request through the plan stages before the answer is written. Gated to high-complexity / low-confidence turns.',
  run: runReasoningPass,
});
