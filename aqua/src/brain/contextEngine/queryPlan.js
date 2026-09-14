/**
 * AQUA — Context Engine V3 query plan (E8/PR-2 + PR-4 foundation).
 *
 * Query understanding is deterministic policy. The existing question-shape
 * analyser tells us what kind of answer is wanted; this module turns that
 * into a bounded answer scaffold and a machine-checkable sufficiency contract.
 * It does not retrieve, call a model, or invent facts.
 */
import { analyseQuestion } from '../../pic/questionShape.js';

const SLOT = (id, kind, required, queries = []) => Object.freeze({
  id, kind, required, queries: Object.freeze([...queries]),
});

const TEMPLATES = Object.freeze({
  decision: [
    SLOT('goal', 'goal', true, ['goal', 'objective', 'what this is in service of']),
    SLOT('deadline', 'time', true, ['deadline', 'target date', 'due date']),
    SLOT('blockers', 'blocker', true, ['blocker', 'blocked by', 'unresolved']),
    SLOT('constraints', 'constraint', false, ['constraint', 'budget', 'capacity', 'commitment']),
    SLOT('risk_signals', 'risk', false, ['risk', 'reliability', 'quality concern']),
    SLOT('prior_plans', 'decision', false, ['previous decision', 'prior plan', 'last time']),
  ],
  planning: [
    SLOT('goal', 'goal', true, ['goal', 'objective', 'target']),
    SLOT('constraints', 'constraint', true, ['constraint', 'budget', 'capacity']),
    SLOT('dependencies', 'dependency', true, ['dependency', 'depends on', 'blocker']),
    SLOT('prior_plans', 'decision', false, ['previous decision', 'prior plan']),
    SLOT('deadline', 'time', false, ['deadline', 'target date']),
  ],
  analysis: [
    SLOT('subject_state', 'thing', true, ['current state', 'status', 'what is true']),
    SLOT('evidence', 'thing', true, ['evidence', 'supporting facts', 'data']),
    SLOT('changes', 'change', false, ['what changed', 'recent changes']),
    SLOT('constraints', 'constraint', false, ['constraints', 'limitations']),
  ],
  project_query: [
    SLOT('project', 'project', true, ['project', 'codebase', 'repository']),
    SLOT('current_state', 'thing', true, ['current state', 'status']),
    SLOT('relevant_files', 'document', false, ['files', 'documents', 'implementation']),
    SLOT('recent_changes', 'change', false, ['recent changes', 'latest changes']),
  ],
  file_analysis: [
    SLOT('document', 'document', true, ['document', 'file', 'attachment']),
    SLOT('evidence', 'thing', true, ['evidence', 'findings', 'relevant passages']),
    SLOT('changes', 'change', false, ['changes', 'differences']),
  ],
  research: [
    SLOT('question', 'thing', true, ['question', 'topic']),
    SLOT('evidence', 'thing', true, ['evidence', 'sources', 'findings']),
    SLOT('uncertainty', 'uncertainty', false, ['uncertainty', 'disagreement', 'limitations']),
  ],
  coding: [
    SLOT('task', 'thing', true, ['task', 'requested change']),
    SLOT('code_context', 'document', true, ['code', 'implementation', 'repository']),
    SLOT('constraints', 'constraint', false, ['constraints', 'compatibility', 'tests']),
  ],
  conversation: [
    SLOT('topic', 'thing', true, ['topic', 'subject']),
  ],
});

function normalizeTaskType(taskType) {
  const key = String(taskType ?? '').trim().toLowerCase();
  return TEMPLATES[key] ? key : 'conversation';
}

/** Build a bounded, explainable QueryPlan. */
export function buildQueryPlan(query, { taskType = 'conversation', maxSlots = 8 } = {}) {
  const shape = analyseQuestion(query);
  const normalized = normalizeTaskType(taskType);
  const slots = TEMPLATES[normalized].slice(0, Math.max(1, Math.min(8, Number(maxSlots) || 8)));
  return {
    version: 3,
    taskType: normalized,
    questionShape: shape,
    slots: slots.map(s => ({ ...s, status: 'unfilled', matches: [] })),
    requiredSlotIds: slots.filter(s => s.required).map(s => s.id),
  };
}

/**
 * A candidate can explicitly declare slotIds; otherwise kind is used as the
 * conservative typed fallback. No candidate text is interpreted as policy.
 */
export function matchCandidateToSlot(candidate, slot) {
  if (!candidate || !slot) return false;
  if (Array.isArray(candidate.slotIds) && candidate.slotIds.includes(slot.id)) return true;
  if (candidate.kind && String(candidate.kind) === String(slot.kind)) return true;
  if (slot.kind === 'thing' && ['fact', 'entity', 'event'].includes(candidate.kind)) return true;
  return false;
}

/** Fill plan metadata from already-retrieved candidates. */
export function fillQueryPlan(plan, candidates = []) {
  const slots = plan?.slots?.map(slot => {
    const matches = candidates.filter(c => matchCandidateToSlot(c, slot));
    return { ...slot, status: matches.length ? 'filled' : 'unfilled', matches };
  }) ?? [];
  return {
    ...plan,
    slots,
    requiredSlotIds: slots.filter(s => s.required).map(s => s.id),
  };
}

/** Three-state sufficiency outcome: sufficient, needs_round_two, unknown. */
export function assessSufficiency(plan) {
  const required = (plan?.slots ?? []).filter(s => s.required);
  if (!required.length) return { outcome: 'sufficient', missing: [], round: 1 };
  const missing = required.filter(s => s.status !== 'filled').map(s => s.id);
  if (!missing.length) return { outcome: 'sufficient', missing: [], round: 1 };
  const round = Number(plan?.round ?? 1);
  return round < 2
    ? { outcome: 'needs_round_two', missing, round }
    : { outcome: 'unknown', missing, round };
}

export function withRound(plan, round) {
  return { ...plan, round: Math.max(1, Math.min(2, Math.floor(Number(round) || 1))) };
}

export function slotTemplates() {
  return Object.fromEntries(Object.entries(TEMPLATES).map(([k, v]) => [k, v.map(x => ({ ...x }))]));
}
