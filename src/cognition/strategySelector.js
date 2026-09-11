/**
 * AQUA Cognitive Intelligence Engine — Strategy Selector (CIE Phase 1)
 *
 * ADAPTIVE STRATEGIES: "Select reasoning styles dynamically. Never use one
 * reasoning strategy for everything." The spec's full style set is here:
 *
 *   fast · analytical · evidence_first · temporal · cross_file · code ·
 *   scientific · mathematical · creative · comparative · architectural ·
 *   legal · research
 *
 * BOUNDARY vs strategyRegistry.js (deliberate, not accidental):
 *   strategyRegistry = per-task PROMPT CHECKLISTS consumed by the Internal
 *     Intelligence Engine's reasoningEngine.js. Unchanged, still owns its
 *     lane.
 *   This module = the EXECUTIVE posture of a turn: how deep to reason, how
 *     hard to demand evidence, how much verification/uncertainty to expect.
 *     Where a cognitive style has a registry counterpart, `linkedStrategy`
 *     REFERENCES it instead of redefining its checklist — composition, no
 *     duplication.
 *
 * Selection order:
 *   1. language hints from questionModel (legal beats scientific beats … —
 *      cue order there IS the priority order)
 *   2. taskType mapping
 *   3. complexity adjustment (a hard task never gets 'fast')
 *   4. learned prior from cognitiveStore — sample-gated + margin-gated, so
 *      an empty store behaves byte-identically to no learning at all
 *
 * Deterministic given (input, store state). No LLM calls.
 */

import { getStrategyPrior, getStrategyStats } from './cognitiveStore.js';

/** How many reflected turns a (task, style) needs before its stats can steer. */
export const PRIOR_SAMPLE_GATE = 8;
/** A learned style must beat the rule-selected one by this much to override. */
export const PRIOR_MARGIN = 0.12;

// ── Style definitions ────────────────────────────────────────────────────────
// depth:            shallow | standard | deep     (reasoning depth expectation)
// evidencePosture:  none | prefer | require       (grounding expectation)
// verifyBias:       0 | 1                          (1 = plan ENCOURAGES review;
//                                                  never downgrades the
//                                                  orchestrator's decision)
// uncertainty:      allow | express | quantify
// directive:        ≤ ~150 chars, composed into the reasoning plan directive

export const COGNITIVE_STYLES = {
  fast: {
    id: 'fast', label: 'Fast', depth: 'shallow', evidencePosture: 'none', verifyBias: 0, uncertainty: 'allow',
    directive: '', // casual traffic stays byte-light — no extra prompt text
  },
  analytical: {
    id: 'analytical', label: 'Analytical', depth: 'standard', evidencePosture: 'prefer', verifyBias: 0, uncertainty: 'express',
    directive: 'Break the problem into parts, apply clear criteria, and state a definite conclusion.',
    linkedStrategy: 'analytical',
  },
  evidence_first: {
    id: 'evidence_first', label: 'Evidence-first', depth: 'deep', evidencePosture: 'require', verifyBias: 1, uncertainty: 'express',
    directive: 'Lead with what the provided context actually supports; separate evidence from inference.',
  },
  temporal: {
    id: 'temporal', label: 'Temporal', depth: 'standard', evidencePosture: 'prefer', verifyBias: 0, uncertainty: 'express',
    directive: 'Order events explicitly and keep before/after relationships straight.',
  },
  cross_file: {
    id: 'cross_file', label: 'Cross-file', depth: 'deep', evidencePosture: 'require', verifyBias: 1, uncertainty: 'express',
    directive: 'Connect information across the provided files; name which file supports each point.',
  },
  code: {
    id: 'code', label: 'Code', depth: 'standard', evidencePosture: 'prefer', verifyBias: 0, uncertainty: 'allow',
    directive: 'Confirm requirements, mind edge cases, and check correctness before style.',
    linkedStrategy: 'coding',
  },
  scientific: {
    id: 'scientific', label: 'Scientific', depth: 'deep', evidencePosture: 'require', verifyBias: 1, uncertainty: 'quantify',
    directive: 'Distinguish established findings from hypotheses; note the strength of the evidence.',
  },
  mathematical: {
    id: 'mathematical', label: 'Mathematical', depth: 'standard', evidencePosture: 'none', verifyBias: 1, uncertainty: 'express',
    directive: 'State assumptions, show the key steps, and sanity-check the result.',
    linkedStrategy: 'mathematical',
  },
  creative: {
    id: 'creative', label: 'Creative', depth: 'standard', evidencePosture: 'none', verifyBias: 0, uncertainty: 'allow',
    directive: 'Commit to one clear idea and keep the voice consistent.',
    linkedStrategy: 'creative',
  },
  comparative: {
    id: 'comparative', label: 'Comparative', depth: 'standard', evidencePosture: 'prefer', verifyBias: 0, uncertainty: 'express',
    directive: 'Define the comparison axes up front and be precise about what actually differs.',
    linkedStrategy: 'comparative',
  },
  architectural: {
    id: 'architectural', label: 'Architectural', depth: 'deep', evidencePosture: 'prefer', verifyBias: 1, uncertainty: 'express',
    directive: 'Reason about components, interfaces, tradeoffs, and failure modes.',
    linkedStrategy: 'architectural',
  },
  legal: {
    id: 'legal', label: 'Legal', depth: 'deep', evidencePosture: 'require', verifyBias: 1, uncertainty: 'quantify',
    directive: 'Stay precise about what is stated versus interpreted; flag jurisdiction-dependent points.',
  },
  research: {
    id: 'research', label: 'Research', depth: 'deep', evidencePosture: 'prefer', verifyBias: 0, uncertainty: 'express',
    directive: 'Decompose into sub-questions, weigh evidence quality, and synthesize rather than list.',
    linkedStrategy: 'research',
  },
};

// taskType → default style (hints override; complexity adjusts after).
const TASK_TO_STYLE = {
  coding: 'code', debugging: 'code',
  architecture: 'architectural', project_query: 'architectural',
  research: 'research', agent_task: 'research',
  file_analysis: 'evidence_first',
  analysis: 'analytical', planning: 'analytical', reasoning: 'analytical',
  creative_writing: 'creative', brainstorming: 'creative',
  conversation: 'fast', simple_qa: 'fast', opinion: 'fast', summarization: 'fast',
  memory_recall: 'fast', memory_update: 'fast', personal_info: 'fast',
};

/**
 * @param {object} input
 * @param {string} input.taskType
 * @param {'low'|'medium'|'high'} input.complexity
 * @param {object} input.question        assessQuestion() output
 * @returns {{ style: object, source: 'hint'|'task'|'complexity'|'learned', reason: string }}
 */
export function selectCognitiveStyle({ taskType, complexity, question }) {
  let styleId = null;
  let source  = 'task';
  let reason  = '';

  // 1. Language hints win — cue order in questionModel is priority order.
  const hint = question?.styleHints?.[0];
  if (hint && COGNITIVE_STYLES[hint]) {
    styleId = hint;
    source  = 'hint';
    reason  = `question language signals '${hint}'`;
  } else {
    styleId = TASK_TO_STYLE[taskType] ?? 'analytical';
    reason  = `default for taskType '${taskType}'`;
  }

  // 2. Complexity adjustment — a hard task never reasons shallow.
  if (complexity === 'high' && styleId === 'fast') {
    styleId = 'analytical';
    source  = 'complexity';
    reason  = 'high complexity — fast style promoted to analytical';
  }

  // 3. Learned prior (sample- and margin-gated; empty store = pure rules).
  const prior = getStrategyPrior(taskType, { minSamples: PRIOR_SAMPLE_GATE });
  if (prior && prior.styleId !== styleId && COGNITIVE_STYLES[prior.styleId]) {
    const currentStats = getStrategyStats(taskType, styleId);
    const currentEff   = currentStats?.effectivenessEwma ?? 0.7; // neutral baseline
    const evidenceSafe = !(question?.needs?.evidence && COGNITIVE_STYLES[prior.styleId].evidencePosture === 'none');
    if (evidenceSafe && prior.effectiveness >= currentEff + PRIOR_MARGIN) {
      styleId = prior.styleId;
      source  = 'learned';
      reason  = `learned: '${prior.styleId}' effectiveness ${prior.effectiveness.toFixed(2)} over ${prior.samples} turns beats '${reason}'`;
    }
  }

  return { style: COGNITIVE_STYLES[styleId], source, reason };
}

/** Effective reasoning depth once complexity is factored in. */
export function resolveDepth(style, complexity) {
  let depth = style.depth;
  if (complexity === 'high' && depth === 'standard') depth = 'deep';
  if (complexity === 'low' && depth === 'deep') depth = 'standard'; // low-tier turns never pay deep cost
  return depth;
}

export function listCognitiveStyles() {
  return Object.keys(COGNITIVE_STYLES);
}
