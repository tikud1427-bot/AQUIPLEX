/**
 * AQUA Internal Intelligence Engine — Planner
 *
 * First stage of the internal pipeline (sits right after the existing
 * Phase 4 Execution Planner / Reasoning Strategy modules — does not
 * replace them).
 *
 * Decomposes a classified task into a structured, stage-based plan that
 * downstream agents (Reasoning Engine, Critic, Synthesizer) can consume.
 * Output is structured data, not prose — per spec, "Planner output should
 * be structured data rather than plain text so future agents can consume it."
 *
 * Deterministic: no LLM calls. For low-complexity requests (casual chat,
 * simple Q&A, memory recall) the heavy pipeline is skipped entirely —
 * `active: false` — so cost stays flat for the bulk of everyday traffic.
 */

import { getPipeline } from './pipelineRegistry.js';

/**
 * @param {{ taskType: string, complexity: 'low'|'medium'|'high', confidence?: number, userMessage?: string }} input
 * @returns {{
 *   taskType: string,
 *   complexity: string,
 *   active: boolean,
 *   pipeline: Array<{name: string, focus: string}>,
 *   rationale: string
 * }}
 */
export function createPlan({ taskType, complexity, confidence = 1.0 }) {
  const active = complexity !== 'low';

  if (!active) {
    return {
      taskType,
      complexity,
      active: false,
      pipeline: [],
      rationale: `Low-complexity task (${taskType}) — internal pipeline skipped to avoid unnecessary overhead.`,
    };
  }

  const pipeline = getPipeline(taskType);

  return {
    taskType,
    complexity,
    active: true,
    pipeline,
    rationale: `Task classified as "${taskType}" (complexity=${complexity}, confidence=${confidence.toFixed(2)}) — running ${pipeline.length}-stage pipeline.`,
  };
}
