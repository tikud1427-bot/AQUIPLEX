/**
 * AQUA — Context Engine V3 query plan (E8/PR-2 + PR-4 foundation).
 *
 * Query understanding is deterministic policy. The existing question-shape
 * analyser tells us what kind of answer is wanted; this module turns that
 * into a bounded answer scaffold and a machine-checkable sufficiency contract.
 * It does not retrieve, call a model, or invent facts.
 */
import { analyseQuestion } from '../../pic/questionShape.js';

/**
 * A slot is defined STRUCTURALLY by the canonical predicates that fill it
 * (E8, 2026-10-07). Before this, slots were filled by candidate `kind`
 * ('blocker', 'goal', ...) — a kind no World-Model candidate ever has, since
 * every canonical claim arrives as kind 'fact' — or by round two stamping the
 * slot id onto whatever a TEXT search for "<question> blocker" returned. So
 * "the blockers slot is filled" meant "some text matched the word blocker",
 * not "Aqua knows a blocker". With predicates, a slot is filled exactly when a
 * current claim of that predicate is in the candidate set — code decides (L3),
 * and the decision is checkable.
 *
 * Slots with no predicate (constraints, risk) keep the old typed/lexical
 * behaviour; no predicate is invented to fill them.
 */
const SLOT = (id, kind, required, queries = [], predicates = []) => Object.freeze({
  id, kind, required, queries: Object.freeze([...queries]), predicates: Object.freeze([...predicates]),
});

/** Canonical predicates per slot meaning. One table, shared by every template. */
const P = Object.freeze({
  goal:         ['plans_to', 'builds'],
  deadline:     ['deadline_for'],
  blockers:     ['blocks', 'blocked_by'],
  dependencies: ['depends_on', 'blocked_by', 'blocks'],
  prior:        ['decided', 'rejected'],
  state:        ['has_status', 'task_owner'],
  project:      ['builds', 'owns'],
});

const TEMPLATES = Object.freeze({
  decision: [
    SLOT('goal', 'goal', true, ['goal', 'objective', 'what this is in service of'], P.goal),
    SLOT('deadline', 'time', true, ['deadline', 'target date', 'due date'], P.deadline),
    SLOT('blockers', 'blocker', true, ['blocker', 'blocked by', 'unresolved'], P.blockers),
    SLOT('constraints', 'constraint', false, ['constraint', 'budget', 'capacity', 'commitment']),
    SLOT('risk_signals', 'risk', false, ['risk', 'reliability', 'quality concern']),
    SLOT('prior_plans', 'decision', false, ['previous decision', 'prior plan', 'last time'], P.prior),
  ],
  planning: [
    SLOT('goal', 'goal', true, ['goal', 'objective', 'target'], P.goal),
    SLOT('constraints', 'constraint', true, ['constraint', 'budget', 'capacity']),
    SLOT('dependencies', 'dependency', true, ['dependency', 'depends on', 'blocker'], P.dependencies),
    SLOT('prior_plans', 'decision', false, ['previous decision', 'prior plan'], P.prior),
    SLOT('deadline', 'time', false, ['deadline', 'target date'], P.deadline),
  ],
  analysis: [
    SLOT('subject_state', 'thing', true, ['current state', 'status', 'what is true']),
    SLOT('evidence', 'thing', true, ['evidence', 'supporting facts', 'data']),
    SLOT('changes', 'change', false, ['what changed', 'recent changes']),
    SLOT('constraints', 'constraint', false, ['constraints', 'limitations']),
  ],
  project_query: [
    SLOT('project', 'project', true, ['project', 'codebase', 'repository'], P.project),
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

/**
 * Decision-shaped questions, read from the question's FORM.
 *
 * The chat classifier labels "Should I launch this week?" and "What should I
 * focus on next?" as `simple_qa`, which fell through to the one-slot
 * `conversation` template — so the blueprint's own flagship question never got
 * a goal, deadline or blocker slot. The form is deterministic and cheap to
 * read; this only UPGRADES a generic label, it never overrides a specific one
 * (planning, coding, ...).
 */
const DECISION_FORM = /^\s*(should|shall)\s+(i|we)\b|\bwhat\s+should\s+(i|we)\s+(do|focus|prioriti[sz]e|work|tackle|start)\b|\b(what'?s|what is)\s+(my|our)\s+(next\s+step|priority|top\s+priority)\b|\bwhere\s+should\s+(i|we)\s+(focus|start)\b/i;
const GENERIC = new Set(['', 'conversation', 'simple_qa', 'general', 'chat', 'qa']);

export function isDecisionForm(query) {
  return DECISION_FORM.test(String(query ?? ''));
}

function normalizeTaskType(taskType, query = '') {
  const key = String(taskType ?? '').trim().toLowerCase();
  if (GENERIC.has(key) && isDecisionForm(query)) return 'decision';
  return TEMPLATES[key] ? key : 'conversation';
}

/** Build a bounded, explainable QueryPlan. */
export function buildQueryPlan(query, { taskType = 'conversation', maxSlots = 8 } = {}) {
  const shape = analyseQuestion(query);
  const normalized = normalizeTaskType(taskType, query);
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
  // A canonical claim fills a slot by its predicate. Producers stamp slotIds
  // only after the same predicate check (e8Pipeline round two, the canonical
  // slot lane), so a text hit cannot claim a predicate-defined slot.
  if (candidate.predicate && (slot.predicates ?? []).includes(String(candidate.predicate))) return true;
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

/** Every canonical predicate any slot of this plan is defined by (bounded). */
export function slotPredicates(plan, { requiredOnly = false } = {}) {
  const out = new Set();
  for (const slot of plan?.slots ?? []) {
    if (requiredOnly && !slot.required) continue;
    for (const p of slot.predicates ?? []) out.add(p);
  }
  return [...out].slice(0, 16);
}

export function slotTemplates() {
  return Object.fromEntries(Object.entries(TEMPLATES).map(([k, v]) => [k, v.map(x => ({ ...x }))]));
}
