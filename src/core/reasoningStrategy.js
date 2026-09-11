/**
 * AQUA Reasoning Strategy (Phase 4)
 *
 * Translates an execution plan's complexity tier into a concrete prompting
 * mode + directive string. The directive is injected into the system prompt
 * by promptBuilder.js — this module makes the decision, it doesn't touch
 * the prompt itself.
 *
 *   low    → direct     (no directive — current v3 behavior, untouched)
 *   medium → stepwise    (ask for visible step-by-step reasoning)
 *   high   → reflective  (ask for draft → self-check → refined answer)
 */

const DIRECTIVES = {
  stepwise:   'Work through this step-by-step before giving your final answer. Show the key reasoning, not just the conclusion.',
  reflective: 'Draft your initial approach, briefly check it for gaps or errors, then give a refined final answer. Keep the check concise.',
};

/**
 * @param {string} taskType
 * @param {'low'|'medium'|'high'} complexity - from createExecutionPlan()
 * @returns {{ mode: 'direct'|'stepwise'|'reflective', directive: string }}
 */
export function getReasoningStrategy(taskType, complexity) {
  if (complexity === 'high')   return { mode: 'reflective', directive: DIRECTIVES.reflective };
  if (complexity === 'medium') return { mode: 'stepwise',   directive: DIRECTIVES.stepwise };
  return { mode: 'direct', directive: '' };
}
