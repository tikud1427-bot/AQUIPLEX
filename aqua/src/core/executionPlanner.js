/**
 * AQUA Execution Planner (Phase 4)
 *
 * Sits right after classification. Decides:
 *   - complexity tier (low / medium / high) for this request
 *   - whether the task needs multi-step handling
 *   - a descriptive step breakdown (used for prompting/logging — this module
 *     does NOT itself make additional LLM calls or branch the pipeline)
 *
 * Downstream consumers:
 *   - reasoningStrategy.js  → picks prompting mode from complexity
 *   - contextOptimizer.js   → sizes the context budget from complexity
 *   - strategy.js / timeoutManager.js → bias provider order / timeout from complexity
 */

import { getEffectiveComplexity } from './classifier.js';

// Descriptive step templates for high-complexity task types.
// Purely informational — injected into logs / available to prompting later.
const STEP_TEMPLATES = {
  architecture: ['Clarify requirements & constraints', 'Outline component breakdown', 'Address scaling/failure modes', 'Assemble final design'],
  research:     ['Identify sub-questions', 'Gather relevant angles', 'Compare/contrast findings', 'Synthesize conclusion'],
  planning:     ['Define goal & success criteria', 'Break into phases/milestones', 'Sequence and prioritize', 'Flag risks/dependencies'],
  agent_task:   ['Identify required sub-tasks', 'Determine tool/context needs', 'Sequence execution', 'Compose final result'],
  analysis:     ['Identify what is being evaluated', 'Apply relevant criteria', 'Surface implications', 'Summarize findings'],
};

const DEFAULT_STEPS = ['Clarify scope', 'Work the problem', 'Check the result', 'Compose final answer'];

/**
 * Build an execution plan for a classified request.
 *
 * @param {string} taskType    - output of classifyTask()
 * @param {number} [confidence] - classifier confidence (0-1)
 * @returns {{ taskType: string, complexity: 'low'|'medium'|'high', multiStep: boolean, confidence: number, steps: string[] }}
 */
export function createExecutionPlan(taskType, confidence = 1.0) {
  // v2 (Phase 6): escalation rule extracted to classifier.js's
  // getEffectiveComplexity() — shared with the Adaptive Tool Orchestrator,
  // see that function's docstring. Resulting complexity value is identical
  // to the inline version this replaces.
  const complexity = getEffectiveComplexity(taskType, confidence);

  const multiStep = complexity === 'high';
  const steps = multiStep ? (STEP_TEMPLATES[taskType] ?? DEFAULT_STEPS) : [];

  return { taskType, complexity, multiStep, confidence, steps };
}
