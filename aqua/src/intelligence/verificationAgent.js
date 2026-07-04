/**
 * AQUA Internal Intelligence Engine — Verification Agent
 *
 * The real second pass that closes the loop the rest of the codebase
 * already designed for and explicitly deferred:
 *
 *   - critic.js (pre-generation) only ever picked a risk rubric and
 *     handed the FIRST-pass model a self-check directive baked into its
 *     own prompt. Its own header comment: "A deterministic, no-LLM-call
 *     module cannot actually read and judge the semantic content of a
 *     reasoning pass (that needs a model) ... built so a real critique
 *     pass (a second model call that inspects the draft answer) can slot
 *     in later under the same reviewReasoning() interface."
 *   - orchestrator/verificationStrategy.js only ever decided WHETHER
 *     verification is warranted. Its own header comment: "the plug-in
 *     seam already exists in src/intelligence/agentRegistry.js, which
 *     today has zero agents registered."
 *   - agentRegistry.js has stood empty, waiting for exactly this.
 *
 * This module is that agent. It registers itself under the name
 * 'verification' on import (side effect, same pattern
 * orchestrator/capabilities.js already uses for capability definitions).
 * chat.js calls it AFTER the main answer is generated — orchestrate()
 * itself stays pure/synchronous/no-I/O exactly as documented; it only
 * ever reports agentAvailable, it never invokes run().
 *
 * Design choices:
 *   - Reuses generateText() end-to-end (provider ranking, health
 *     tracking, full fallback chain, timeout budgeting) instead of
 *     calling a provider directly — no duplicate retry/fallback logic.
 *   - preTaskType is the REAL taskType (not a generic one) so provider
 *     ranking for the critique call still favors whichever provider is
 *     actually strong at that domain (e.g. Gemini for architecture).
 *   - The "no issues" response is a long, distinctive sentinel rather
 *     than a short token like "OK". generateText()'s validator applies
 *     task-aware minimum lengths (architecture: 50 chars) to WHATEVER
 *     text comes back, since it has no notion of "this is a verdict, not
 *     an answer" — a short sentinel would get rejected as too_short and
 *     burn through the entire fallback chain for no reason.
 *   - Fails open: any error (provider exhausted, network failure, etc.)
 *     returns the original draft untouched. Verification can only ever
 *     replace a draft for a found issue — it can never turn a working
 *     response into a failed request.
 */

import { generateText }    from '../providers/router.js';
import { createContext }   from '../core/observability.js';
import { getFocusRisks }   from './critic.js';
import { registerAgent }   from './agentRegistry.js';

const PASS_SENTINEL =
  'VERIFICATION_PASSED — the draft was checked against the listed risks and no material issues were found; returning it unchanged.';

/**
 * @param {string[]} focusRisks
 * @returns {string} system prompt for the critique call
 */
function buildCritiquePrompt(focusRisks) {
  return [
    "You are AQUA's internal verification pass. You are shown a user's question and a draft answer someone already wrote for them.",
    '',
    `Check the draft ONLY against these specific risks: ${focusRisks.join(', ')}.`,
    '',
    `If none of these specific risks are actually present, respond with EXACTLY this line and nothing else:\n"${PASS_SENTINEL}"`,
    '',
    'If one of these specific risks IS genuinely present, respond with the complete corrected replacement answer only — no preamble, no explanation of what changed, no meta-commentary about the review. Your response must be ready to send to the user exactly as-is, as a full replacement for the draft.',
    '',
    'Be conservative: only replace the draft for a real, specific problem tied to the listed risks. Do not rewrite for style, tone, or phrasing preferences.',
  ].join('\n');
}

/**
 * Run the real verification pass on a draft answer.
 *
 * @param {object} input
 * @param {string} input.userMessage    - original user question
 * @param {string} input.draftAnswer    - the first-pass generated answer
 * @param {string} input.taskType       - classifier.js taskType (single source of truth)
 * @param {string} [input.requestId]
 * @param {string} [input.conversationId]
 * @param {object} [input.responseBudget] - Phase 6 execution profile budget, reused as-is
 *                                          so the critique call inherits the same response
 *                                          size ceiling rather than inventing a new one
 * @param {Function} [input.generate]   - injection point for tests; defaults to the real
 *                                        generateText() from providers/router.js
 * @returns {Promise<{
 *   ran: boolean,
 *   passed: boolean|null,
 *   revised: boolean,
 *   finalAnswer: string,
 *   focusRisks: string[],
 *   provider?: string,
 *   latencyMs?: number,
 *   attemptCount?: number,
 *   error?: string
 * }>}
 */
export async function runVerification({
  userMessage,
  draftAnswer,
  taskType,
  requestId,
  conversationId,
  responseBudget,
  generate = generateText,
}) {
  const focusRisks = getFocusRisks(taskType);
  const critiquePrompt = buildCritiquePrompt(focusRisks);
  const critiqueMessages = [{
    role: 'user',
    content: `Original user question:\n${userMessage}\n\nDraft answer to review:\n${draftAnswer}`,
  }];

  // Separate context so this call's provider attempts/fallback chain don't
  // mix into the main generation's ctx.attempts array — chat.js's response
  // fallbackChain should describe how the ANSWER was produced, not the
  // verification pass on top of it.
  const verifyCtx = createContext({
    conversationId,
    requestId: requestId ? `${requestId}-verify` : undefined,
  });

  const start = Date.now();
  try {
    const result = await generate(
      userMessage,        // classification fallback only — preTaskType below skips it
      critiquePrompt,
      critiqueMessages,
      verifyCtx,
      taskType,            // real taskType: keeps provider ranking domain-appropriate
      undefined,           // no Phase 4 execution plan bias for the critique call itself
      responseBudget,
    );

    const text = (result.text ?? '').trim();
    const passed = text.startsWith('VERIFICATION_PASSED');

    return {
      ran: true,
      passed,
      revised: !passed,
      finalAnswer: passed ? draftAnswer : text,
      focusRisks,
      provider: result.provider,
      latencyMs: Date.now() - start,
      attemptCount: verifyCtx.attempts.length,
    };
  } catch (err) {
    console.warn(`[VERIFICATION] Verifier call failed, passing draft through unchanged: ${err.message}`);
    return {
      ran: false,
      passed: null,
      revised: false,
      finalAnswer: draftAnswer,
      focusRisks,
      error: err.message,
      attemptCount: verifyCtx.attempts.length,
    };
  }
}

registerAgent('verification', {
  name: 'verification',
  description:
    "LLM-backed second pass. Checks a draft answer against the risk rubric critic.js selects for the task type, and returns a corrected replacement only when a specific, genuine issue is found. Fails open: any error in the verifier call returns the original draft unchanged, so a broken verifier can never break or worsen a response that would otherwise have succeeded.",
  run: runVerification,
});
