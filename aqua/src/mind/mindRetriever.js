/**
 * AQUA Mind — Retrieval Intelligence (Layer 15)
 * ─────────────────────────────────────────────────────────────────────────────
 * The LLM no longer receives isolated memories — it receives an evolving
 * COGNITIVE STATE: who the user is, how to talk to them, what they're
 * working toward right now, and what they'll likely need next.
 *
 * Selection considers: current intent (task type + query tokens), active
 * goals, working memory, identity/preferences confidence, predictions,
 * graph proximity, recency, and confidence. Output is the SMALLEST block
 * with the highest relevance — quality over quantity, hard token budget.
 *
 * The block rides the existing memoryBlock slot in promptBuilder — appended
 * after formatFactsForPrompt() output. No promptBuilder change needed.
 */
import { DIMENSIONS, GOAL_STATUS, STATUS } from './mindSchema.js';
import { getBeliefs } from './beliefEngine.js';
import { getActiveGoals } from './goalTracker.js';
import { currentFocus } from './workingMemory.js';
import { neighborhood, SELF_KEY } from './relationshipGraph.js';
import { estimateTokens } from '../core/tokenManager.js';
import { isAspirationalRole, intentLabel, laterWordNote, reviewNote, UNCERTAIN_RULE } from '../memory/displayLabels.js';
import { contentTerms, isOverviewRequest } from '../pic/questionShape.js';
import { stem } from '../understanding/stateTransition.js';

// ── Question-aware selection of goals, deadlines and predictions (2026-11-05) ──
/**
 * Goals, the latest deadline, the latest open question and the top prediction
 * used to ride into every prompt, whatever was asked ("Where do I work now?"
 * carried the Atlas deadline and the promotion goal; Cloudflare Mistral run).
 * A planning, overview or goal question — or no question — still gets them
 * all; any other question gets only the items it shares a content word with.
 * Profile, identity and recall are not selected here and are untouched.
 * AQUA_MIND_RELEVANCE=off restores the previous selection (rollback).
 */
export function mindRelevanceEnabled() {
  return String(process.env.AQUA_MIND_RELEVANCE ?? 'on').toLowerCase() !== 'off';
}
const BROAD_CUE = /\b(?:focus|prioriti[sz]e|priorit(?:y|ies)|plan(?:s|ning)?|should\s+i|what(?:'s|\s+is)\s+next|next\s+steps?|on\s+my\s+plate|to-?do|this\s+(?:week|month|quarter|year)|today|tomorrow|advice|advise|recommend|suggest(?:ion)?s?|goals?|deadlines?|working\s+(?:on|toward)|busy|schedule|progress|catch\s+me\s+up|overview|summar(?:y|i[sz]e))\b/i;
export function questionScope(query) {
  const q = String(query ?? '').trim();
  if (!q) return { broad: true, terms: [] };
  return { broad: BROAD_CUE.test(q) || isOverviewRequest(q), terms: [...new Set(contentTerms(q).map(root))] };
}
const isAbout = (scope, text) => scope.broad || contentTerms(text).map(root).some(t => scope.terms.includes(t));
/**
 * The shared stem, with a noun's -ion folded onto its verb (2026-11-06):
 * "promotion" meets "get promoted", "migration" meets "migrating" — stem()
 * leaves "promotion" whole and turns "promoted" into "promot". Only when five
 * letters remain, so "nation", "station" keep their own identity. Used only to
 * decide that an item is about the question, so it can only keep more context.
 */
function root(t) {
  const s = stem(t);
  return /ions?$/.test(s) && s.replace(/ions?$/, '').length >= 5 ? s.replace(/ions?$/, '') : s;
}
const flatText = s => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const DEFAULT_BUDGET_TOKENS = 450;
const MIN_CONF_TO_SHOW = 0.45;

function conf(c) { return `${Math.round(c * 100)}%`; }

/**
 * How the model should hold a belief: something the user said, or something
 * observed about them. Until 2026-10-28 both read "(62%)", so an inferred
 * trait reached the answer model looking exactly like a stated fact.
 */
const STATED = new Set(['explicit', 'correction', 'user']);
function basis(b) {
  return STATED.has(b.privacy?.source) ? 'user said' : `inferred, ${conf(b.confidence)}`;
}

/** A goal stored as a role ("profession: billionaire") is not who the user is — never tell the model it is. */
const ROLE_KEYS = new Set(['profession', 'role', 'job_title']);
const usableBelief = b => b.reviewedAt || b.privacy?.source === 'correction' || !(ROLE_KEYS.has(b.key) && isAspirationalRole(b.value));

function line(parts) { return parts.filter(Boolean).join(' '); }

/**
 * Build the cognitive context block.
 * @returns {{ block: string, used: object }} block='' when nothing meets the bar.
 */
export function retrieveCognitiveContext(mind, { query = '', taskType = 'conversation', budgetTokens = DEFAULT_BUDGET_TOKENS, laterWords = [], retired = [] } = {}) {
  if (!mind) return { block: '', used: {} };
  // A belief holding a value the user has since changed (the fact store's
  // later word, passed by memory/engine.js) carries the same note as the
  // identity card and profile: "organization: Hartwell Bank (user said)" beside
  // "Company: Hartwell Bank (since changed — …)" was the prompt contradicting itself.
  const vnorm = s => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const noteFor = value => {
    const v = vnorm(value);
    if (v.length < 3) return '';
    const lw = laterWords.find(x => vnorm(x.value) === v);
    return laterWordNote(lw);
  };
  // No longer current in the fact store (ended, or replaced by a new value):
  // not shown as who the user is now. Its history lives in the profile.
  const retiredSet = new Set(retired.map(vnorm).filter(v => v.length >= 3));
  const isRetired = value => retiredSet.has(vnorm(value));
  const used = { identity: 0, communication: 0, preferences: 0, knowledge: 0, goals: 0, working: 0, predictions: 0, graph: 0 };
  const sections = [];
  const q = (query || '').toLowerCase();

  // ── 1. Identity & personality (always relevant, tiny) ──────────────────────
  const identity = getBeliefs(mind, { dimension: DIMENSIONS.IDENTITY, minConfidence: MIN_CONF_TO_SHOW })
    .filter(b => b.status !== STATUS.ARCHIVED && usableBelief(b) && !isRetired(b.value)).slice(0, 4);
  if (identity.length) {
    const traits = identity.map(b => `${b.key.replace(/_/g, ' ')}${typeof b.value === 'string' && b.value !== 'true' ? `: ${b.value}` : ''} (${basis(b)})${noteFor(b.value)}`);
    sections.push(`Identity: ${traits.join(', ')}.`);
    used.identity = identity.length;
  }

  // ── 2. Communication style → directly shapes the answer ────────────────────
  const comm = getBeliefs(mind, { dimension: DIMENSIONS.COMMUNICATION, minConfidence: 0.5 }).slice(0, 3);
  if (comm.length) {
    sections.push(`Communication: ${comm.map(b => `${b.key.replace(/_/g, ' ')}=${b.value}`).join(', ')}. Match this style.`);
    used.communication = comm.length;
  }

  // ── 3. Preferences & decision style, intent-weighted ───────────────────────
  const prefLike = [
    ...getBeliefs(mind, { dimension: DIMENSIONS.PREFERENCES, minConfidence: MIN_CONF_TO_SHOW }),
    ...getBeliefs(mind, { dimension: DIMENSIONS.DECISION,    minConfidence: 0.5 }),
  ]
    .filter(b => !isRetired(b.value))
    .map(b => {
      let score = b.confidence;
      const keyWords = b.key.replace('tech:', '').split(/[_:]/);
      if (keyWords.some(w => w.length > 2 && q.includes(w))) score += 0.5; // query mentions it
      if (String(b.value).length > 2 && q.includes(String(b.value).toLowerCase())) score += 0.3;
      return { b, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(x => x.b);
  if (prefLike.length) {
    sections.push(`Preferences: ${prefLike.map(b => `${b.key.replace(/_/g, ' ')}=${JSON.stringify(b.value)} (${basis(b)})${noteFor(b.value)}`).join('; ')}.`);
    used.preferences = prefLike.length;
  }

  // ── 4. Knowledge model → calibrate explanation depth (Layer 4 payoff) ──────
  if (['coding', 'debugging', 'architecture', 'project_query', 'research', 'analysis'].includes(taskType)) {
    const knowledge = getBeliefs(mind, { dimension: DIMENSIONS.KNOWLEDGE, minConfidence: 0.5 })
      .filter(b => {
        const term = b.key.replace('tech:', '');
        return q.includes(term) || b.confidence > 0.75;
      })
      .slice(0, 4);
    if (knowledge.length) {
      sections.push(`Known tech (skip basics): ${knowledge.map(b => b.key.replace('tech:', '')).join(', ')}.`);
      used.knowledge = knowledge.length;
    }
  }

  const relevance = mindRelevanceEnabled();
  const scope = relevance ? questionScope(query) : { broad: true, terms: [] };

  // ── 5. Active goals — the "why" behind the ask ──────────────────────────────
  const goals = relevance ? getActiveGoals(mind, 8).filter(g => isAbout(scope, g.title)).slice(0, 3) : getActiveGoals(mind, 3);
  if (goals.length) {
    // A goal the user has since changed carries their words beside it — the
    // title is what they first said, the note is the current word (goalTracker
    // laterWordOnGoals). The model is never left to treat the old plan as current.
    const gl = goals.map(g => line([
      `"${g.title}"`,
      g.status === GOAL_STATUS.BLOCKED ? '[BLOCKED]' : null,
      g.progress > 0 ? `(~${Math.round(g.progress * 100)}%)` : null,
      g.changedBy?.text ? `(since changed — they said: "${g.changedBy.text.slice(0, 120)}")` : null,
      // Something it names has since changed (memory/propagation.js): still open, not assumed either way.
      !g.changedBy?.text && g.review?.text ? reviewNote(g.review).trim() : null,
    ]));
    sections.push(`Active goals: ${gl.join('; ')}.`);
    used.goals = goals.length;
  }

  // ── 6. Working memory — what's on their plate right now ────────────────────
  const w = mind.working;
  // The same labels the Understanding page uses: classifier routing ids
  // ("simple_qa, personal_info") are not what the user is focused on, and the
  // model was told they were (2026-10-29, Lift v3 legacy replay).
  const focus = [...new Set(currentFocus(mind, 8).map(f => intentLabel(f.topic)).filter(Boolean))].slice(0, 3);
  const wmBits = [];
  if (focus.length) wmBits.push(`focus: ${focus.join(', ')}`);
  const reviewOf = x => reviewNote(x?.review);
  // The message being answered is recorded before the prompt is built: it is not its own open question.
  const asked = flatText(query);
  const blockers = relevance ? w.blockers.filter(b => isAbout(scope, b.text)) : w.blockers;
  const deadline = (relevance ? w.deadlines.filter(d => isAbout(scope, d.label)) : w.deadlines).at(-1);
  const openQ = (relevance ? w.openQuestions.filter(x => !(asked && flatText(x.text) && asked.includes(flatText(x.text))) && isAbout(scope, x.text)) : w.openQuestions).at(-1);
  if (blockers.length) wmBits.push(`blocked on: ${blockers.slice(-2).map(b => `${b.text}${reviewOf(b)}`).join('; ')}`);
  if (deadline) wmBits.push(`deadline: ${deadline.label}${reviewOf(deadline)}`);
  if (openQ) wmBits.push(`open question: ${openQ.text}`);
  if (wmBits.length) {
    sections.push(`Current state: ${wmBits.join(' | ')}.`);
    used.working = wmBits.length;
  }

  // ── 7. Top prediction — anticipate, don't just react ───────────────────────
  // Not a repeat of a goal or deadline listed above, and about the question.
  // A prediction is judged on its subject ("…: run a half marathon"), not its frame ("Likely working toward").
  const listed = [...goals.map(g => g.title), deadline?.label].filter(Boolean).map(flatText).filter(Boolean);
  const subjectOf = p => String(p.label ?? '').includes(':') ? String(p.label).split(':').slice(1).join(':') : String(p.label ?? '');
  const topPred = relevance
    ? (mind.predictions || []).find(p => p.probability >= 0.55 && !listed.some(t => flatText(p.label).includes(t)) && isAbout(scope, subjectOf(p)))
    : (mind.predictions || [])[0];
  if (topPred && topPred.probability >= 0.55) {
    sections.push(`Anticipated need: ${topPred.label} (p=${topPred.probability}).`);
    used.predictions = 1;
  }

  // ── 8. Graph context only when the query names an entity ───────────────────
  if (q.length > 3) {
    const hit = Object.values(mind.graph.nodes).find(n =>
      n.key !== SELF_KEY && n.label.length > 2 && q.includes(n.label.toLowerCase()));
    if (hit) {
      const nb = neighborhood(mind, hit.key, 1, 6);
      const rel = nb.edges.slice(0, 4).map(e => {
        const from = mind.graph.nodes[e.from]?.label ?? '?';
        const to   = mind.graph.nodes[e.to]?.label ?? '?';
        return `${from} —${e.type}→ ${to}`;
      });
      if (rel.length) {
        sections.push(`Related: ${rel.join('; ')}.`);
        used.graph = rel.length;
      }
    }
  }

  if (!sections.length) return { block: '', used };

  // ── Budget enforcement: drop lowest-priority sections from the end ─────────
  // Order above is already priority order (identity → graph); trim tail-first.
  let lines = [...sections];
  // A goal, deadline or blocker marked uncertain is the user's own, unresolved —
  // "use silently" must not stop the answer saying so when it matters (2026-11-05).
  const wrap = (ls) => [
    '--- COGNITIVE MODEL (inferred, confidence-weighted — not user-stated facts) ---',
    ...ls,
    'Use silently to adapt tone, depth and focus. Confidence <70% = treat as a hunch, never assert it back to the user.',
    ...(ls.some(l => /\((?:uncertain|may already be achieved)\b/.test(l)) ? [`Goals, deadlines and blockers above are the user's own words. ${UNCERTAIN_RULE}`] : []),
    '--- END COGNITIVE MODEL ---',
  ].join('\n');

  while (lines.length > 1 && estimateTokens(wrap(lines)) > budgetTokens) {
    lines.pop();
  }

  return { block: wrap(lines), used };
}
