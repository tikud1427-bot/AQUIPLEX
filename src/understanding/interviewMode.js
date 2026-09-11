/**
 * UUS U2 — interview mode.
 *
 * ONE PLACE where "the caller declared this is the intro conversation" turns
 * into pipeline behaviour. Kept out of chat.js because that file is already
 * 1400 lines and because a mode gate scattered across two endpoints drifts —
 * the POST and /stream handlers have already diverged once (`graphEligible`
 * exists in one and not the other, so the graph runtime never executes).
 *
 * WHAT THE MODE CHANGES
 * ---------------------
 * Exactly one thing: the task label and its confidence.
 *
 * That single change cascades correctly through machinery that already exists:
 *
 *   confidence 1.0  → above LOW_CONFIDENCE_THRESHOLD, so no verification pass
 *                     and no debate. Measured cost of the old path on interview
 *                     answers: 4 of 8 turns, up to 5 extra LLM calls,
 *                     1.5-16.7s, and a visible mid-stream answer REPLACE.
 *   task 'understanding_interview'
 *                   → its own prompt module (the interviewer persona)
 *                   → not 'research'/'planning', so the reasoning and planning
 *                     engines stay out of a getting-to-know-you chat
 *                   → not a search-eligible label, so "I currently work from
 *                     home" stops firing real web searches
 *                   → its own bucket in the learning ledger instead of
 *                     polluting the single 'simple_qa' bucket whose revision
 *                     rate already crossed the threshold that triggers more
 *                     verification
 *
 * WHAT IT DOES NOT CHANGE
 * -----------------------
 * Retrieval, memory, ingest, post-turn processing, storage — all identical. The
 * intro is a REAL conversation on the real pipeline, which is what makes "no
 * manual profile editing" true by construction rather than by policy.
 *
 * NOT A CLASSIFIER FIX
 * --------------------
 * `classifyTask` still scores ordinary first-person speech at 0.45 everywhere
 * else, and that remains a separate change with a far wider blast radius. This
 * module does not touch it. The difference is that here the caller already
 * knows the intent, so inferring it is the mistake — the interview declares
 * itself rather than being guessed at.
 */
import { uusEnabled } from './flags.js';

/** The mode string a client sends. */
export const UNDERSTANDING_MODE = 'understanding';

/** The task label the pipeline sees for an interview turn. */
export const UNDERSTANDING_TASK = 'understanding_interview';

/** Is this request an interview turn? Requires the flag — an unknown mode is ignored. */
export function isInterviewTurn(mode) {
  return uusEnabled() && String(mode ?? '') === UNDERSTANDING_MODE;
}

/**
 * Classify, unless the caller already declared the intent.
 *
 * @param {string|null} mode
 * @param {string} userMessage
 * @param {Function} classify   the real classifyTask, injected so this module
 *                              stays testable without importing the pipeline
 * @returns {{ task, confidence, labels }}
 */
export function classifyForMode(mode, userMessage, classify) {
  if (!isInterviewTurn(mode)) return classify(userMessage);
  return {
    task: UNDERSTANDING_TASK,
    // 1.0 is a claim about the CALLER's certainty of intent, not about the
    // answer's quality. The client said "this is the intro"; there is nothing
    // left to be uncertain about at this step.
    confidence: 1.0,
    labels: [UNDERSTANDING_TASK],
  };
}
