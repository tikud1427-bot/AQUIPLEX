/**
 * AQUA Internal Intelligence Engine — Critic
 *
 * Third stage of the internal pipeline. Sits between the Reasoning Engine
 * and the Synthesizer.
 *
 * IMPORTANT — honest scope note:
 * A deterministic, no-LLM-call module cannot actually read and judge the
 * semantic content of a reasoning pass (that needs a model). What it CAN
 * do — and what this module does — is select the right rubric of risks
 * to watch for, based on task type, and turn that into a self-check
 * directive the provider model applies to its own answer before
 * finalizing. This is the deterministic scaffold the spec asks for
 * ("prepare a richer execution context without significantly increasing
 * inference cost"); it is built so a real critique pass (a second model
 * call that inspects the draft answer) can slot in later under the same
 * `reviewReasoning()` interface without changing callers.
 *
 * Risk categories drawn from spec section 3: missing requirements, logical
 * inconsistencies/contradictions, security risks, performance problems,
 * scalability issues, hallucination risk, weak assumptions, missing edge
 * cases, poor API design, potential bugs.
 */

const RISK_PROFILES = {
  coding:        ['Missing edge cases', 'Potential bugs', 'Poor API design', 'Security risks', 'Performance problems'],
  debugging:     ['Weak assumptions', 'Logical inconsistencies', 'Missing edge cases', 'Potential bugs'],
  architecture:  ['Scalability issues', 'Security risks', 'Performance problems', 'Missing requirements'],
  project_query: ['Logical inconsistencies', 'Missing requirements', 'Potential bugs'],
  research:      ['Hallucination risk', 'Weak assumptions', 'Logical inconsistencies'],
  planning:      ['Missing requirements', 'Weak assumptions', 'Logical inconsistencies'],
  analysis:      ['Weak assumptions', 'Logical inconsistencies', 'Hallucination risk'],
};

const DEFAULT_RISKS = ['Logical inconsistencies', 'Weak assumptions', 'Hallucination risk'];

/**
 * @param {{ active: boolean, taskType: string }} plan
 * @param {{ active: boolean }} reasoning
 * @returns {{ active: boolean, focusRisks?: string[], directive?: string }}
 */
export function reviewReasoning(plan, reasoning) {
  if (!plan?.active || !reasoning?.active) return { active: false };

  const focusRisks = getFocusRisks(plan.taskType);

  return {
    active: true,
    focusRisks,
    directive: `Before finalizing, self-check your answer against: ${focusRisks.join(', ')}.`,
  };
}

/**
 * Same rubric lookup reviewReasoning() uses internally, exposed directly.
 *
 * reviewReasoning() only returns a rubric when the internal pipeline is
 * active (plan.active && reasoning.active) — but verificationStrategy.js
 * gates verification independently (e.g. an 'architecture' taskType always
 * warrants verification regardless of the pipeline's own complexity-based
 * activation). A real post-generation verifier needs the rubric on its own
 * terms, not conditioned on a different module's gate. Exported here so it
 * stays the single source of truth for "which risks matter for this task
 * type" rather than a second copy of RISK_PROFILES living elsewhere.
 *
 * @param {string} taskType
 * @returns {string[]}
 */
export function getFocusRisks(taskType) {
  return RISK_PROFILES[taskType] ?? DEFAULT_RISKS;
}
