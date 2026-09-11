/**
 * AQUA Internal Intelligence Engine — Strategy Registry
 *
 * Holds reasoning strategies that the Reasoning Engine selects between.
 * Plugin-style: registerStrategy() adds a new strategy without touching
 * any existing logic or dispatch code — satisfies the spec requirement
 * that "future strategies should be easy to register without changing
 * existing logic."
 *
 * Each strategy is plain data (checklist + directive string) — deterministic,
 * no LLM calls. Designed so a real multi-agent strategy (one that actually
 * runs its own reasoning pass) can register under the same name later
 * without changing the selection logic in reasoningEngine.js.
 */

const strategies = new Map();

/**
 * @param {string} name
 * @param {{ checklist: string[], directive: string }} definition
 */
export function registerStrategy(name, definition) {
  strategies.set(name, { name, ...definition });
}

/**
 * @param {string} name
 * @returns {{ name: string, checklist: string[], directive: string } | undefined}
 */
export function getStrategy(name) {
  return strategies.get(name);
}

export function listStrategies() {
  return [...strategies.keys()];
}

// ── Default strategies ──────────────────────────────────────────────────────

registerStrategy('analytical', {
  checklist: [
    'Identify what is being evaluated',
    'Apply relevant criteria',
    'Surface implications',
    'State a clear conclusion',
  ],
  directive: 'Reason analytically: identify what is being evaluated, apply the relevant criteria, then state a clear conclusion.',
});

registerStrategy('architectural', {
  checklist: [
    'Clarify requirements',
    'List components and interfaces',
    'Weigh tradeoffs',
    'Call out failure modes',
  ],
  directive: 'Reason like a systems architect: clarify requirements, define components and interfaces, weigh tradeoffs, and call out failure modes.',
});

registerStrategy('coding', {
  checklist: [
    'Confirm requirements and inputs/outputs',
    'Pick the right approach/data structures',
    'Watch for edge cases',
    'Check correctness before style',
  ],
  directive: 'Reason like an engineer: confirm requirements, choose the right approach, watch for edge cases, and verify correctness before polish.',
});

registerStrategy('research', {
  checklist: [
    'Decompose into sub-questions',
    'Weigh source credibility',
    'Cross-check conflicting claims',
    'Synthesize — do not just list',
  ],
  directive: 'Reason like a researcher: break the question down, weigh evidence quality, cross-check conflicts, and synthesize a real answer.',
});

registerStrategy('planning', {
  checklist: [
    'Define success criteria',
    'Surface dependencies and risks',
    'Sequence realistically',
    'Keep it actionable',
  ],
  directive: 'Reason like a planner: define success criteria, surface dependencies and risks, then sequence into something actionable.',
});

registerStrategy('debugging', {
  checklist: [
    'Reproduce/understand the symptom',
    'Generate ranked hypotheses',
    'Confirm root cause before fixing',
    'Check for regressions',
  ],
  directive: 'Reason like a debugger: understand the symptom, generate ranked hypotheses, confirm the root cause before proposing a fix.',
});

registerStrategy('creative', {
  checklist: [
    'Establish tone and audience',
    'Build around one clear core idea',
    'Avoid cliché defaults',
    'Keep voice consistent',
  ],
  directive: 'Reason like a writer: establish tone and audience, build around one clear idea, and keep the voice consistent throughout.',
});

registerStrategy('mathematical', {
  checklist: [
    'State assumptions explicitly',
    'Show the key steps',
    'Sanity-check the result',
    'Flag any approximations',
  ],
  directive: 'Reason mathematically: state assumptions explicitly, show the key steps, and sanity-check the result before presenting it.',
});

registerStrategy('comparative', {
  checklist: [
    'Define the comparison axes',
    'Be even-handed on both sides',
    'Surface what actually differs',
    'Avoid false equivalence',
  ],
  directive: 'Reason comparatively: define the axes of comparison up front, treat each side fairly, and be precise about what actually differs.',
});
