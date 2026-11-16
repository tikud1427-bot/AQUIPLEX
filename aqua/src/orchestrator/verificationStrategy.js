/**
 * AQUA Adaptive Tool Orchestrator — Verification Strategy
 *
 * Phase 6 spec, "Verification Strategy": do NOT perform expensive
 * second-pass reasoning for every request. Only enable verification if
 * complexity is high, risk is high, or the request is architecture,
 * security, financial, medical, or large-code-generation in nature.
 *
 * This module only decides WHETHER verification is warranted — it never
 * performs verification itself. The actual second pass is intentionally
 * left unimplemented ("Design this so a future LLM-based verification pass
 * can be plugged in without changing the architecture"): the plug-in seam
 * already exists in src/intelligence/agentRegistry.js, which today has zero
 * agents registered. toolOrchestrator.js checks getAgent('verification')
 * when this strategy says verification is enabled; while no such agent is
 * registered, that's a no-op, which is exactly the spec's "otherwise skip
 * verification" — so this stays a pure decision function with zero added
 * LLM calls until a future phase registers a real verification agent.
 */

import { LEARNED_REVISION_RATE, LEARNED_LOW_CONFIDENCE } from '../intelligence/learningLedger.js';
import { isDecisionForm } from '../brain/contextEngine/queryPlan.js';   // pure regex; one decision detector, shared with CE V2

const LARGE_CODE_GENERATION_CHARS = 1200; // heuristic: long coding asks tend to mean multi-file/non-trivial output

/**
 * Phase 12 ("Low confidence should automatically trigger deeper reasoning"):
 * below this classifier confidence, the classification itself is shaky —
 * task routing, provider ranking, and the intelligence pipeline were all
 * keyed off an uncertain read of the request, so the answer earns a
 * verification pass it wouldn't otherwise get. Exported so chat.js uses the
 * SAME cut point when deciding to grant the verification loop a second pass.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.5;

/**
 * Cost-aware review depth (2026-11-12, unified-intelligence Stage 1).
 *
 * WHAT WAS WRONG. `classifyTask` can only return confidence < 0.5 from its
 * zero-score fallback (the scored path is `0.5 + gap/top*0.5`, never below
 * 0.5). So "low classification confidence" in practice meant "no regex
 * matched", not "this request is risky or hard". Measured on 24 ordinary
 * messages, 9 hit it, including "Who wrote Hamlet?", "What is 17 times 23?"
 * and "Where does Ana work?". Each paid a pre-answer reasoning pass plus a
 * two-pass debate panel: up to 6 model calls for one simple question, and an
 * answer replaced mid-read by an unconfirmed revision.
 *
 * WHAT THIS DOES. A low score keeps its review only when there is a second
 * reason to distrust the read: the message is long (≥ 120 chars, the same split
 * the classifier uses for simple_qa vs research) or it carries a sensitive
 * domain tag (security / financial / medical). High complexity and the existing
 * risk tags still trigger review exactly as before. No answer is ever labelled
 * verified by this change; it only decides whether review runs.
 *
 * ROLLBACK. AQUA_COST_AWARE_REVIEW=off restores the previous policy exactly.
 */
export const SHORT_FALLBACK_CHARS = 120;
const SENSITIVE_TAGS = Object.freeze(['security', 'financial', 'medical']);

/** ON unless AQUA_COST_AWARE_REVIEW is 'off' (any case — a rollback switch must not be case-fragile). */
export function costAwareReviewEnabled(env = process.env) {
  return String(env.AQUA_COST_AWARE_REVIEW ?? '').trim().toLowerCase() !== 'off';
}

/**
 * The ONE place that decides how much review a turn's classification earns.
 * Used by shouldVerify (verification on/off), the reasoning pass gate and the
 * debate-vs-single-critic choice, so the three can no longer disagree.
 *
 * @returns {{ policy: 'cost_aware'|'legacy', lowConfidence: boolean, deepReview: boolean, reasoningPass: boolean }}
 */
export function reviewDepth({ complexity, confidence, tags = [], userMessage = '', env = process.env } = {}) {
  const belowThreshold = typeof confidence === 'number' && confidence < LOW_CONFIDENCE_THRESHOLD;
  const legacy = !costAwareReviewEnabled(env);
  const sensitive = (tags ?? []).some((t) => SENSITIVE_TAGS.includes(t));
  const longMessage = String(userMessage ?? '').length >= SHORT_FALLBACK_CHARS;
  const lowConfidence = legacy ? belowThreshold : belowThreshold && (longMessage || sensitive);
  const deep = complexity === 'high' || lowConfidence;
  // A decision ("Should I hire another developer?", "...or stay?") is the one
  // short fallback shape the policy table says deserves structured reasoning:
  // it keeps the single pre-answer reasoning pass, not the review panel. Only
  // turns this policy would otherwise strip, so it never adds a call the
  // previous policy did not make.
  const decision = !legacy && belowThreshold && !lowConfidence && isDecisionForm(userMessage);
  return { policy: legacy ? 'legacy' : 'cost_aware', lowConfidence, deepReview: deep, reasoningPass: deep || decision, decision };
}

/**
 * @param {{
 *   taskType: string, complexity: string, tags: string[], userMessage: string,
 *   confidence?: number,
 *   history?: { sampleSize:number, revisionRate:number, avgConfidence:number|null } | null
 * }} input
 * @returns {{ enabled: boolean, reasons: string[], reason: string }}
 */
export function shouldVerify({ taskType, complexity, tags = [], userMessage = '', confidence, history = null }) {
  const reasons = [];

  if (complexity === 'high') reasons.push('complexity is high');
  if (taskType === 'architecture') reasons.push('architecture request');
  if (tags.includes('security')) reasons.push('security request');
  if (tags.includes('financial')) reasons.push('financial reasoning');
  if (tags.includes('medical')) reasons.push('medical reasoning');
  if (taskType === 'coding' && userMessage.length > LARGE_CODE_GENERATION_CHARS) {
    reasons.push('large code generation');
  }
  // Optional param: existing callers that don't pass confidence keep the
  // exact decision surface they had before this line existed.
  if (reviewDepth({ complexity, confidence, tags, userMessage }).lowConfidence) {
    reasons.push('low classification confidence');
  }
  // Phase 11 (learning ledger): `history` comes from getTaskStats(), which is
  // null until the sample gate is met — so a cold ledger changes nothing.
  // Thresholds live in learningLedger.js next to the aggregation they read.
  if (history) {
    if (history.revisionRate >= LEARNED_REVISION_RATE) {
      reasons.push(`learned: task type historically revision-prone (${Math.round(history.revisionRate * 100)}% over ${history.sampleSize} turns)`);
    } else if (typeof history.avgConfidence === 'number' && history.avgConfidence < LEARNED_LOW_CONFIDENCE) {
      reasons.push(`learned: task type historically low-confidence (${history.avgConfidence.toFixed(2)} over ${history.sampleSize} turns)`);
    }
  }

  // "Risk is high" — not its own independent signal but a label for the
  // case where multiple sensitive-domain tags stack on one request, which
  // is strictly riskier than any one of them alone.
  const sensitiveTagCount = ['security', 'financial', 'medical'].filter((t) => tags.includes(t)).length;
  if (sensitiveTagCount >= 2) reasons.push('risk is high (multiple sensitive domains)');

  const enabled = reasons.length > 0;
  return {
    enabled,
    reasons,
    reason: enabled
      ? reasons.join('; ')
      : 'No high-complexity/high-risk signal present — verification skipped to avoid unnecessary second-pass reasoning.',
  };
}

/**
 * The ONE truthful verdict on a verification/debate result (P0 2026-10-12).
 *
 * `ran`/`passed` alone could not say what happened: a pass-2 timeout after a
 * clean-looking pass 1 came back `ran:true, passed:false`; a panel cut off by
 * its budget surfaced as "unparseable"; and the UI badged a turn "verified"
 * whenever verification was merely WARRANTED. A delivered answer is
 * `verified` only when a review pass completed and confirmed it.
 *
 *   not_requested        no review was warranted
 *   unavailable          warranted, but no reviewer ran (none registered)
 *   failed               attempted, no pass completed (timeout, provider error,
 *                        truncated or unparseable reviewer output)
 *   incomplete           ≥1 pass completed but the review did not finish
 *                        (later pass errored; reviewer output malformed,
 *                        truncated, or a revision discarded by a guard)
 *   verified             a completed pass confirmed the delivered answer
 *   revised_unconfirmed  the answer was revised; no pass confirmed the revision
 *   issues_unresolved    the review found issues that were not fixed
 *   disputed             a panel minority objected; not escalated, not confirmed
 *   inconclusive         part of the panel went silent; nobody objected
 */
export const VERIFICATION_STATUSES = Object.freeze([
  'not_requested', 'unavailable', 'failed', 'incomplete', 'verified',
  'revised_unconfirmed', 'issues_unresolved', 'disputed', 'inconclusive',
]);

export function verificationStatus(v = {}, { warranted = false } = {}) {
  if (!v || !v.ran) {
    if (v?.error) return 'failed';
    return warranted ? 'unavailable' : 'not_requested';
  }
  if (v.passed) return 'verified';
  if (v.error) return v.revised ? 'revised_unconfirmed' : 'incomplete';
  if (v.inconclusive) return 'inconclusive';
  if (v.revised) return 'revised_unconfirmed';
  // suppressedWithdrawals (D-02, 2026-11-16): a reviewer tried to replace the
  // answer with a clarification / "no information" it could not justify — the
  // draft shipped, unconfirmed.
  if (v.suppressedMalformed || v.suppressedRefusals || v.suppressedTruncated || v.suppressedWithdrawals) return 'incomplete';
  if (v.agent === 'debate' && v.converged && (v.disagreements?.length ?? 0) > 0) return 'disputed';
  return 'issues_unresolved';
}
