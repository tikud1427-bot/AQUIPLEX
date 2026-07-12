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
  if (typeof confidence === 'number' && confidence < LOW_CONFIDENCE_THRESHOLD) {
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
