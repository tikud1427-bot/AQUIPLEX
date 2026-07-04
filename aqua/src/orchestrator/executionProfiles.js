/**
 * AQUA Adaptive Tool Orchestrator — Execution Profiles
 *
 * Phase 6 spec, "Dynamic Execution Profiles" + "Response Budgeting".
 *
 * Each profile is a deterministic function of classifier.js's `taskType` —
 * the SAME taskType already used by executionPlanner.js (createExecutionPlan)
 * and reasoningStrategy.js (getReasoningStrategy) everywhere else in the
 * pipeline. Profile selection here never re-derives or second-guesses that
 * classification; it just maps the existing single winner to a capability
 * bundle + response budget. This is what "Keep orchestration deterministic"
 * means in practice — one classification, one consistent set of downstream
 * decisions, not two systems that could disagree.
 *
 * requiredCapabilities lists are taken directly from the spec's named
 * profile examples (Simple Question / Coding Request / Planning Request /
 * Research Request / Architecture Request / Debugging Request). taskTypes
 * the spec didn't name explicitly (memory_recall, project_query,
 * creative_writing, ...) are mapped to a sensibly-scoped profile below —
 * see PROFILE_BY_TASK_TYPE.
 *
 * Response budgets are deliberately coarse-grained (low/medium/high tiers
 * translated to token counts in one place) rather than hand-tuned per
 * profile, so the relative ordering the spec asks for (Simple QA: Fast/
 * Compact < Planning: Roadmap-focused < Coding/Debugging < Architecture:
 * Detailed/Structured ≈ Research: Comprehensive) is easy to verify by
 * inspection and easy to retune later without touching profile logic.
 */

// ── Budget tiers ─────────────────────────────────────────────────────────────

// Token ceilings are deliberately generous relative to what a normal,
// complete answer for that tier actually needs — they exist as a safety
// ceiling against runaway/degenerate generation, not a routine constraint.
// (See providers/*.js: when a response is cut off by hitting maxTokens,
// finishReason/finish_reason is checked and returned to the caller as a
// SUCCESSFUL truncated completion — router.js marks the provider healthy
// and hands the partial answer straight back rather than retrying, see
// Issue 1 — so an undersized ceiling here shows up immediately as visibly
// cut-off answers instead of a silent extra retry. That's exactly why
// these ceilings matter more now than when truncation was invisible.)
// Relative ordering reflects the spec's intent: Simple QA (Fast/Compact) <
// Roadmap/Standard < Detailed/Extended/Comprehensive.
//
// Issue 3 (2026-07): coding/debugging/project-analysis were sized at 2048
// and architecture at 3072 — comfortably below what a real "production-
// ready JWT auth system" or "multi-region architecture" answer needs,
// which is exactly what was driving those requests into the Issue 1
// truncation path in the first place. Floors below now match Issue 3's
// suggested minimums: Conversation 512–1024, Simple QA 1024–2048, Coding/
// Architecture/Debugging/Research/Project Analysis 4096+. 'extended' is a
// new tier (not a bump to 'standard') so creative_request/general_reasoning
// — which also use 'standard' but aren't named in Issue 3 — stay as they
// were; budgets stay adaptive per task type rather than one-size-fits-all.
const BUDGET_TIERS = {
  minimal: { reasoningDepth: 1, maxPromptTokens: 3_000,  maxResponseTokens: 1_024, maxContextTokens: 4_000,  label: 'Fast / Compact' },
  light:   { reasoningDepth: 2, maxPromptTokens: 5_000,  maxResponseTokens: 1_536, maxContextTokens: 7_000,  label: 'Light' },
  standard:{ reasoningDepth: 3, maxPromptTokens: 8_000,  maxResponseTokens: 2_048, maxContextTokens: 12_000, label: 'Standard' },
  roadmap: { reasoningDepth: 3, maxPromptTokens: 7_000,  maxResponseTokens: 2_048, maxContextTokens: 10_000, label: 'Roadmap focused' },
  extended:{ reasoningDepth: 4, maxPromptTokens: 9_000,  maxResponseTokens: 4_096, maxContextTokens: 14_000, label: 'Extended' },
  detailed:{ reasoningDepth: 4, maxPromptTokens: 9_000,  maxResponseTokens: 4_096, maxContextTokens: 14_000, label: 'Detailed / Structured' },
  comprehensive: { reasoningDepth: 4, maxPromptTokens: 10_000, maxResponseTokens: 4_096, maxContextTokens: 16_000, label: 'Comprehensive' },
};

// ── Profile definitions ───────────────────────────────────────────────────────

const PROFILES = {
  simple_question: {
    id: 'simple_question', label: 'Simple Question',
    description: 'Minimal pipeline — no planner, no project retrieval, no repository scan, no memory extraction, no critic.',
    requiredCapabilities: ['conversation_history', 'memory_retrieval'],
    budget: BUDGET_TIERS.minimal,
  },
  memory_request: {
    id: 'memory_request', label: 'Memory Request',
    description: 'User is recalling or updating stored facts — memory capabilities are the entire point of this request.',
    requiredCapabilities: ['conversation_history', 'memory_retrieval', 'long_term_memory_extraction'],
    budget: BUDGET_TIERS.minimal,
  },
  coding_request: {
    id: 'coding_request', label: 'Coding Request',
    description: 'Repository understanding, workspace retrieval, architecture planner, reasoning, critic, memory.',
    requiredCapabilities: [
      'conversation_history', 'memory_retrieval', 'long_term_memory_extraction',
      'workspace_analysis', 'repository_understanding', 'project_retrieval', 'file_intelligence',
      'reasoning_engine', 'planning_engine', 'critic', 'code_generation', 'tool_calling',
    ],
    budget: BUDGET_TIERS.extended, // Issue 3: was 'standard' (2048) — coding answers routinely need more room
  },
  planning_request: {
    id: 'planning_request', label: 'Planning Request',
    description: 'Planner, risk analysis, timeline generation, critic.',
    requiredCapabilities: ['conversation_history', 'memory_retrieval', 'planning_engine', 'reasoning_engine', 'critic'],
    budget: BUDGET_TIERS.roadmap,
  },
  research_request: {
    id: 'research_request', label: 'Research Request',
    description: 'Research planner, source planning, evidence strategy, critic.',
    requiredCapabilities: ['conversation_history', 'memory_retrieval', 'deep_research', 'web_search', 'reasoning_engine', 'critic'],
    budget: BUDGET_TIERS.comprehensive, // Issue 3 ("Research: 4096+"): already compliant, unchanged
  },
  architecture_request: {
    id: 'architecture_request', label: 'Architecture Request',
    description: 'Architecture planner, tradeoff analyzer, failure analysis, scalability evaluation.',
    requiredCapabilities: [
      'conversation_history', 'memory_retrieval', 'architecture_planning', 'planning_engine',
      'reasoning_engine', 'critic', 'verification',
    ],
    budget: BUDGET_TIERS.detailed, // Issue 3 ("Architecture: 4096+"): tier bumped from 3072 → 4096, see BUDGET_TIERS above
  },
  debugging_request: {
    id: 'debugging_request', label: 'Debugging Request',
    description: 'Debug strategy, hypothesis generation, root cause checklist, regression checklist.',
    requiredCapabilities: [
      'conversation_history', 'memory_retrieval', 'debugging', 'reasoning_engine', 'critic',
      'code_generation', 'workspace_analysis', 'repository_understanding', 'project_retrieval', 'file_intelligence',
    ],
    budget: BUDGET_TIERS.extended, // Issue 3: was 'standard' (2048) — debugging answers routinely need more room
  },
  project_query_request: {
    id: 'project_query_request', label: 'Project Query',
    description: 'Question about an attached workspace/file rather than new code or general research.',
    requiredCapabilities: [
      'conversation_history', 'memory_retrieval',
      'workspace_analysis', 'repository_understanding', 'project_retrieval', 'file_intelligence',
      'reasoning_engine',
    ],
    // Not 'light': classifier.js's COMPLEXITY_TIERS already flags taskType
    // 'project_query' as high-complexity (more reasoning room, longer
    // system prompt) — pairing that with a 'light' context budget here
    // would compound with the 0.82x high-complexity multiplier in
    // contextOptimizer.js and shrink context further than intended.
    // Issue 3 ("Project Analysis: 4096+"): 'extended', not 'standard' (2048)
    // — project-analysis answers routinely need more room than that.
    budget: BUDGET_TIERS.extended,
  },
  creative_request: {
    id: 'creative_request', label: 'Creative Request',
    description: 'Open-ended creative or brainstorming output — critic and verification stay off so they don\'t flatten the response.',
    requiredCapabilities: ['conversation_history', 'memory_retrieval', 'reasoning_engine'],
    budget: BUDGET_TIERS.standard,
  },
  general_reasoning: {
    id: 'general_reasoning', label: 'General Reasoning',
    description: 'Analysis, summarization, opinion, or step-by-step reasoning that is substantive but not project- or research-scale.',
    requiredCapabilities: ['conversation_history', 'memory_retrieval', 'reasoning_engine', 'critic'],
    // 'standard', not 'light': this profile covers 'analysis', which
    // classifier.js's COMPLEXITY_TIERS flags as high-complexity — same
    // compounding-shrink risk as project_query_request above, same fix.
    budget: BUDGET_TIERS.standard,
  },
};

// Exhaustive map over every taskType classifier.js can produce today
// (see WEIGHTS in src/core/classifier.js). Anything not listed falls back
// to 'general_reasoning' via selectProfile()'s default — kept exhaustive
// anyway so a missing mapping is a deliberate, visible choice rather than
// silently inherited.
const PROFILE_BY_TASK_TYPE = {
  conversation:      'simple_question',
  simple_qa:         'simple_question',
  opinion:           'general_reasoning',
  memory_recall:     'memory_request',
  memory_update:     'memory_request',
  personal_info:     'memory_request',
  coding:            'coding_request',
  debugging:         'debugging_request',
  architecture:      'architecture_request',
  planning:          'planning_request',
  research:          'research_request',
  reasoning:         'general_reasoning',
  analysis:          'general_reasoning',
  summarization:     'general_reasoning',
  creative_writing:  'creative_request',
  brainstorming:     'creative_request',
  file_analysis:     'project_query_request',
  project_query:     'project_query_request',
};

/**
 * @param {string} taskType  classifier.js's classifyTask(...).task
 * @returns {object} the selected profile definition
 */
export function selectProfile(taskType) {
  const id = PROFILE_BY_TASK_TYPE[taskType] || 'general_reasoning';
  return PROFILES[id];
}

export function getProfile(id) {
  return PROFILES[id];
}

export function listProfiles() {
  return Object.values(PROFILES);
}
