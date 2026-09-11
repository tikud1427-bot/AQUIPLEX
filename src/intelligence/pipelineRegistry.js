/**
 * AQUA Internal Intelligence Engine — Pipeline Registry
 *
 * Maps a task type to a structured sequence of reasoning stages.
 * Pure data — no behavior. Consumed by planner.js.
 *
 * Adding a new pipeline = add one entry to PIPELINES. Nothing else
 * needs to change (planner.js falls back to DEFAULT_PIPELINE for any
 * taskType not listed here).
 */

export const PIPELINES = {
  coding: [
    { name: 'Understand',     focus: 'Clarify requirements, inputs/outputs, and constraints.' },
    { name: 'Architecture',   focus: 'Decide structure, modules, and data flow before writing code.' },
    { name: 'Implementation', focus: 'Work through the core logic and key code paths.' },
    { name: 'Self-review',    focus: 'Check for bugs, unclear logic, and missed edge cases.' },
    { name: 'Optimization',   focus: 'Look for unnecessary complexity or a cleaner approach.' },
    { name: 'Final',          focus: 'Compose the final implementation guidance.' },
  ],

  research: [
    { name: 'Question decomposition',   focus: 'Break the request into concrete sub-questions.' },
    { name: 'Evidence collection plan', focus: 'Identify what evidence would answer each sub-question.' },
    { name: 'Source validation',        focus: 'Weigh credibility and recency of evidence.' },
    { name: 'Conflict detection',       focus: 'Note where evidence or perspectives disagree.' },
    { name: 'Final report',             focus: 'Synthesize findings into a clear answer.' },
  ],

  debugging: [
    { name: 'Understand issue',      focus: 'Pin down symptoms and expected vs. actual behavior.' },
    { name: 'Hypothesis generation', focus: 'List plausible causes, ranked by likelihood.' },
    { name: 'Root cause analysis',   focus: 'Narrow to the most likely root cause with evidence.' },
    { name: 'Fix strategy',          focus: 'Decide the minimal correct fix.' },
    { name: 'Regression checklist',  focus: 'Note what else could break and should be checked.' },
    { name: 'Final solution',        focus: 'Compose the final fix and explanation.' },
  ],

  architecture: [
    { name: 'Requirements',       focus: 'Clarify functional and non-functional requirements.' },
    { name: 'Component design',   focus: 'Break the system into components and interfaces.' },
    { name: 'Tradeoffs',          focus: 'Surface the key design tradeoffs and why.' },
    { name: 'Failure modes',      focus: 'Identify how the system can fail and how to mitigate.' },
    { name: 'Scalability',        focus: 'Check the design holds up under growth and load.' },
    { name: 'Final architecture', focus: 'Compose the recommended design.' },
  ],

  planning: [
    { name: 'Goal',              focus: 'Define the goal and success criteria precisely.' },
    { name: 'Dependencies',      focus: 'Identify what this plan depends on.' },
    { name: 'Timeline',          focus: 'Sequence work into phases or a timeline.' },
    { name: 'Risk analysis',     focus: 'Surface risks and mitigations.' },
    { name: 'Execution roadmap', focus: 'Lay out the concrete roadmap.' },
    { name: 'Final plan',        focus: 'Compose the final plan.' },
  ],
};

// Generic fallback for task types without a dedicated pipeline
// (analysis, creative_writing, reasoning, brainstorming, project_query, etc.)
export const DEFAULT_PIPELINE = [
  { name: 'Understand', focus: 'Clarify what is actually being asked.' },
  { name: 'Approach',   focus: 'Decide the approach before answering.' },
  { name: 'Check',      focus: 'Check the approach for gaps or errors.' },
  { name: 'Final',      focus: 'Compose the final answer.' },
];

/**
 * @param {string} taskType
 * @returns {Array<{name: string, focus: string}>}
 */
export function getPipeline(taskType) {
  return PIPELINES[taskType] ?? DEFAULT_PIPELINE;
}
