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
 *   - Bounded convergence loop (Phase 4 recursive self-review): a revision
 *     is fed back for re-critique until a pass returns clean or maxPasses
 *     hits. Default maxPasses=1 preserves the original single-pass
 *     behavior exactly; chat.js grants 2 for high-complexity or
 *     low-classifier-confidence turns (see confidenceEngine.js notes).
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
import { hasGroundedEvidence, isCapabilityRefusal } from './evidenceContext.js';

const PASS_SENTINEL =
  'VERIFICATION_PASSED — the draft was checked against the listed risks and no material issues were found; returning it unchanged.';

/**
 * Phase 0 (audit F1) — THE GROUNDING CONTRACT: the reviewer sees the same
 * evidence the drafter had. Without this clause a text-only critique model,
 * reviewing a grounded video/PDF/image answer under a "Hallucination risk"
 * rubric with no sight of the analyses, rationally concludes the draft is
 * fabricated and rewrites it into "I cannot watch videos" — the exact
 * overwrite bug this phase fixes.
 *
 * @param {string[]} focusRisks
 * @param {boolean}  grounded - evidence block accompanies the critique input
 * @returns {string} system prompt for the critique call
 */
function buildCritiquePrompt(focusRisks, grounded = false) {
  return [
    "You are AQUA's internal verification pass. You are shown a user's question and a draft answer someone already wrote for them.",
    '',
    ...(grounded ? [
      'The draft was written WITH the evidence context included below (file analyses, project context, search results, memory). Treat that evidence as ground truth available to the drafter:',
      '- Claims supported by the evidence context are grounded, NOT hallucinations.',
      '- File and media analyses in the evidence were already performed by the platform; the draft legitimately describes their contents.',
      '- NEVER replace the draft with a statement that files, videos, images, audio, or documents cannot be accessed, watched, viewed, read, or analyzed — the analyses are right there in the evidence.',
      '',
    ] : []),
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
 * @param {number} [input.maxPasses]    - Phase 4 recursive self-review: upper bound on
 *                                        critique passes. Default 1 = the original
 *                                        single-pass behavior, byte-identical. When >1,
 *                                        a revision is fed back for re-critique until a
 *                                        pass returns clean (converged) or the cap hits.
 *                                        chat.js grants 2 for high-complexity /
 *                                        low-classifier-confidence turns.
 * @param {object} [input.responseBudget] - Phase 6 execution profile budget, reused as-is
 *                                          so the critique call inherits the same response
 *                                          size ceiling rather than inventing a new one
 * @param {Function} [input.generate]   - injection point for tests; defaults to the real
 *                                        generateText() from providers/router.js
 * @returns {Promise<{
 *   ran: boolean,
 *   passed: boolean|null,     // final draft's last critique came back clean
 *   revised: boolean,         // any revision was applied across the loop
 *   converged: boolean,       // === passed; explicit for observability
 *   passes: number,           // critique calls completed
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
  maxPasses = 1,
  evidenceContext = '',           // Phase 0 (F1): grounding contract — see buildCritiquePrompt
  generate = generateText,
}) {
  const focusRisks = getFocusRisks(taskType);
  const grounded   = hasGroundedEvidence(evidenceContext);
  const critiquePrompt = buildCritiquePrompt(focusRisks, grounded);
  const evidenceBlock  = grounded
    ? `Evidence context available to the drafter (ground truth):\n${evidenceContext}\n\n`
    : '';

  // One context across all passes so attemptCount reflects the loop's total
  // provider usage; chat.js's main fallbackChain stays untouched (see below).
  const verifyCtx = createContext({
    conversationId,
    requestId: requestId ? `${requestId}-verify` : undefined,
  });

  const cap = Math.max(1, maxPasses);
  const start = Date.now();

  let current   = draftAnswer;
  let passes    = 0;
  let revised   = false;
  let passed    = false;
  let provider;

  // ── Convergence loop ──────────────────────────────────────────────────────
  // Invariant: `current` is always the best answer we are willing to ship.
  // Each iteration either (a) confirms it clean → converged, stop, or
  // (b) replaces it with a revision → re-critique if budget remains, or
  // (c) errors → fail open with `current` as-is. A broken verifier can
  // therefore never lose an accepted revision, let alone the original draft.
  let suppressedRefusals = 0;   // Phase 0 (F2 interplay): guarded revisions never count as `revised`

  while (passes < cap) {
    const critiqueMessages = [{
      role: 'user',
      content: `${evidenceBlock}Original user question:\n${userMessage}\n\nDraft answer to review:\n${current}`,
    }];

    let result;
    try {
      result = await generate(
        userMessage,        // classification fallback only — preTaskType below skips it
        critiquePrompt,
        critiqueMessages,
        verifyCtx,
        taskType,            // real taskType: keeps provider ranking domain-appropriate
        undefined,           // no Phase 4 execution plan bias for the critique call itself
        responseBudget,
      );
    } catch (err) {
      console.warn(`[VERIFICATION] Verifier pass ${passes + 1}/${cap} failed, passing ${revised ? 'latest revision' : 'draft'} through unchanged: ${err.message}`);
      return {
        ran: passes > 0,     // ≥1 completed pass means verification DID run
        passed: passes > 0 ? false : null,
        revised,
        converged: false,
        passes,
        agent: 'verification',
        finalAnswer: current,
        focusRisks,
        grounded,
        suppressedRefusals,
        provider,
        latencyMs: Date.now() - start,
        error: err.message,
        attemptCount: verifyCtx.attempts.length,
      };
    }

    passes  += 1;
    provider = result.provider ?? provider;
    const text = (result.text ?? '').trim();

    if (text.startsWith('VERIFICATION_PASSED')) {
      passed = true;
      break;                 // converged — current draft confirmed clean
    }

    // ── Phase 0 (audit F1/F5) — capability-deletion guard ─────────────────────
    // A verifier may correct facts; it may NEVER delete capability. On a
    // grounded turn (file/media analyses were in the drafter's prompt), a
    // revision claiming those files can't be accessed is by definition wrong
    // — discard it, keep the grounded draft, and stop the loop (a reviser
    // that just failed this badly has forfeited further passes this turn).
    // `revised` stays false for a first-pass guard hit, so the learning
    // ledger never books the malfunction as a legitimate revision (F2).
    if (grounded && isCapabilityRefusal(text)) {
      suppressedRefusals += 1;
      console.warn(`[VERIFICATION] capability-refusal revision SUPPRESSED on grounded turn (pass ${passes}/${cap}) — keeping ${revised ? 'latest revision' : 'draft'}`);
      break;
    }

    revised = true;
    current = text;          // revision becomes the draft under review
  }

  return {
    ran: true,
    passed,
    revised,
    converged: passed,
    passes,
    agent: 'verification',
    finalAnswer: current,
    focusRisks,
    grounded,
    suppressedRefusals,
    provider,
    latencyMs: Date.now() - start,
    attemptCount: verifyCtx.attempts.length,
  };
}

registerAgent('verification', {
  name: 'verification',
  description:
    "LLM-backed second pass. Checks a draft answer against the risk rubric critic.js selects for the task type, and returns a corrected replacement only when a specific, genuine issue is found. Fails open: any error in the verifier call returns the original draft unchanged, so a broken verifier can never break or worsen a response that would otherwise have succeeded.",
  run: runVerification,
});