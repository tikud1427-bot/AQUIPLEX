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

const LARGE_CODE_GENERATION_CHARS = 1200; // heuristic: long coding asks tend to mean multi-file/non-trivial output

/**
 * @param {{ taskType: string, complexity: string, tags: string[], userMessage: string }} input
 * @returns {{ enabled: boolean, reasons: string[], reason: string }}
 */
export function shouldVerify({ taskType, complexity, tags = [], userMessage = '' }) {
  const reasons = [];

  if (complexity === 'high') reasons.push('complexity is high');
  if (taskType === 'architecture') reasons.push('architecture request');
  if (tags.includes('security')) reasons.push('security request');
  if (tags.includes('financial')) reasons.push('financial reasoning');
  if (tags.includes('medical')) reasons.push('medical reasoning');
  if (taskType === 'coding' && userMessage.length > LARGE_CODE_GENERATION_CHARS) {
    reasons.push('large code generation');
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
