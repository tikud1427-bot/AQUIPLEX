/**
 * AQUA Internal Intelligence Engine — Reasoning Engine
 *
 * Second stage of the internal pipeline. Chooses a reasoning strategy
 * (from strategyRegistry.js) for the plan produced by planner.js and
 * attaches it to the plan's stages.
 *
 * Strategy selection is rule-based today (taskType → strategy, with one
 * lightweight comparative-language override). To register a brand new
 * strategy, add it in strategyRegistry.js and map a taskType to it below —
 * no other file needs to change.
 *
 * Deterministic: no LLM calls.
 */

import { getStrategy } from './strategyRegistry.js';

const TASK_TO_STRATEGY = {
  coding:            'coding',
  debugging:         'debugging',
  architecture:       'architectural',
  project_query:      'architectural',
  research:           'research',
  file_analysis:      'analytical',
  planning:           'planning',
  creative_writing:   'creative',
  brainstorming:      'creative',
  reasoning:          'mathematical',
  analysis:           'analytical',
  agent_task:         'analytical',
};

const DEFAULT_STRATEGY = 'analytical';

// Cuts across task types — a comparison can show up inside coding,
// research, or architecture requests alike.
const COMPARATIVE_PATTERN = /\b(vs\.?|versus|compare|comparison|difference between|trade.?off)\b/i;

function selectStrategyName(taskType, userMessage = '') {
  if (COMPARATIVE_PATTERN.test(userMessage)) return 'comparative';
  return TASK_TO_STRATEGY[taskType] ?? DEFAULT_STRATEGY;
}

/**
 * @param {{ active: boolean, taskType: string, pipeline: Array<{name,focus}> }} plan
 * @param {string} userMessage
 * @returns {{
 *   active: boolean,
 *   strategy?: string,
 *   checklist?: string[],
 *   directive?: string,
 *   stages?: Array<{name: string, focus: string}>
 * }}
 */
export function runReasoning(plan, userMessage = '') {
  if (!plan?.active) return { active: false };

  const strategyName = selectStrategyName(plan.taskType, userMessage);
  const strategy      = getStrategy(strategyName) ?? getStrategy(DEFAULT_STRATEGY);

  return {
    active:    true,
    strategy:  strategy.name,
    checklist: strategy.checklist,
    directive: strategy.directive,
    stages:    plan.pipeline,
  };
}
