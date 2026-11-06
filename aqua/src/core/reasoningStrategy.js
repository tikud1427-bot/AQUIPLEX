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
  if (complexity === 'medium') return { mode: 'stepwise',   directive: scaffoldGuardEnabled() ? STEPWISE_GUARDED : DIRECTIVES.stepwise };
  return { mode: 'direct', directive: '' };
}

/**
 * The reasoning is asked for; the template is not (2026-11-05). With the
 * synthesizer's stage line ("Understand → Approach → Check → Final") beside it,
 * "Show the key reasoning" came back as a reply laid out under those stage
 * names (Cloudflare Mistral run, HEAD q04/q05/q11). Reasoning and structure the
 * content needs stay; labelled stages do not. AQUA_ANSWER_SCAFFOLD_GUARD=off
 * restores the previous directive byte for byte.
 */
export function scaffoldGuardEnabled() {
  return String(process.env.AQUA_ANSWER_SCAFFOLD_GUARD ?? 'on').toLowerCase() !== 'off';
}
const STEPWISE_GUARDED = 'Work through this step-by-step before giving your final answer. Show the key reasoning, not just the conclusion — in plain sentences, or in the structure the content itself needs, not as a template of labelled stages.';
