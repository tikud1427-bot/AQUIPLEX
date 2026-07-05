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

const DEFAULT_BUDGET_TOKENS = 450;
const MIN_CONF_TO_SHOW = 0.45;

function conf(c) { return `${Math.round(c * 100)}%`; }

function line(parts) { return parts.filter(Boolean).join(' '); }

/**
 * Build the cognitive context block.
 * @returns {{ block: string, used: object }} block='' when nothing meets the bar.
 */
export function retrieveCognitiveContext(mind, { query = '', taskType = 'conversation', budgetTokens = DEFAULT_BUDGET_TOKENS } = {}) {
  if (!mind) return { block: '', used: {} };
  const used = { identity: 0, communication: 0, preferences: 0, knowledge: 0, goals: 0, working: 0, predictions: 0, graph: 0 };
  const sections = [];
  const q = (query || '').toLowerCase();

  // ── 1. Identity & personality (always relevant, tiny) ──────────────────────
  const identity = getBeliefs(mind, { dimension: DIMENSIONS.IDENTITY, minConfidence: MIN_CONF_TO_SHOW })
    .filter(b => b.status !== STATUS.ARCHIVED).slice(0, 4);
  if (identity.length) {
    const traits = identity.map(b => `${b.key.replace(/_/g, ' ')}${typeof b.value === 'string' && b.value !== 'true' ? `: ${b.value}` : ''} (${conf(b.confidence)})`);
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
    sections.push(`Preferences: ${prefLike.map(b => `${b.key.replace(/_/g, ' ')}=${JSON.stringify(b.value)} (${conf(b.confidence)})`).join('; ')}.`);
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

  // ── 5. Active goals — the "why" behind the ask ──────────────────────────────
  const goals = getActiveGoals(mind, 3);
  if (goals.length) {
    const gl = goals.map(g => line([
      `"${g.title}"`,
      g.status === GOAL_STATUS.BLOCKED ? '[BLOCKED]' : null,
      g.progress > 0 ? `(~${Math.round(g.progress * 100)}%)` : null,
    ]));
    sections.push(`Active goals: ${gl.join('; ')}.`);
    used.goals = goals.length;
  }

  // ── 6. Working memory — what's on their plate right now ────────────────────
  const w = mind.working;
  const focus = currentFocus(mind, 3).map(f => f.topic).filter(t => !t.startsWith('workspace:'));
  const wmBits = [];
  if (focus.length) wmBits.push(`focus: ${focus.join(', ')}`);
  if (w.blockers.length) wmBits.push(`blocked on: ${w.blockers.map(b => b.text).slice(-2).join('; ')}`);
  if (w.deadlines.length) wmBits.push(`deadline: ${w.deadlines[w.deadlines.length - 1].label}`);
  if (w.openQuestions.length) wmBits.push(`open question: ${w.openQuestions[w.openQuestions.length - 1].text}`);
  if (wmBits.length) {
    sections.push(`Current state: ${wmBits.join(' | ')}.`);
    used.working = wmBits.length;
  }

  // ── 7. Top prediction — anticipate, don't just react ───────────────────────
  const topPred = (mind.predictions || [])[0];
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
  const wrap = (ls) => [
    '--- COGNITIVE MODEL (inferred, confidence-weighted — not user-stated facts) ---',
    ...ls,
    'Use silently to adapt tone, depth and focus. Confidence <70% = treat as a hunch, never assert it back to the user.',
    '--- END COGNITIVE MODEL ---',
  ].join('\n');

  while (lines.length > 1 && estimateTokens(wrap(lines)) > budgetTokens) {
    lines.pop();
  }

  return { block: wrap(lines), used };
}
