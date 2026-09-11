/**
 * UUS U5 — the world-model card.
 *
 * "Here's what I understand about you" — the moment the whole brief is written
 * around. Not "setup complete".
 *
 * THE ONE RULE THIS FILE ENFORCES
 * -------------------------------
 * An empty section is DROPPED, never rendered as "unknown" or padded with a
 * placeholder. Three true sentences beat nine hedged ones, and on a screen
 * whose only job is to earn trust, a line the user reads as wrong costs more
 * than the eight correct lines beside it earn.
 *
 * Which is also why nothing below a confidence floor reaches the card. A guess
 * shown as a fact is the failure mode; a guess left out costs nothing, because
 * understanding keeps growing from ordinary conversation afterwards.
 *
 * PURE
 * ----
 * No store imports, no formatting decisions that belong to the UI. It returns
 * ordered sections of plain strings; the card decides how they look. That
 * keeps this testable without a browser — which matters, because a browser has
 * not been available in any session of this sprint.
 */
import { COVERAGE_DIMENSIONS, confidenceLabel } from './coverage.js';

/**
 * Below this, a belief is a guess. Guesses do not go on the trust card — they
 * become follow-up questions instead, which is what the confidence machinery
 * was built for in the first place.
 */
export const CARD_CONFIDENCE_FLOOR = 0.4;

const active = (b) => b && b.status !== 'archived' && Number(b.confidence ?? 0) >= CARD_CONFIDENCE_FLOOR;

/** "tech:typescript" → "typescript"; "message_style" → "message style". */
function humanKey(key) {
  return String(key ?? '')
    .replace(/^(tech|domain):/, '')
    .replace(/_/g, ' ')
    .trim();
}

/** A belief as one readable line. */
function line(b) {
  const v = b.value;
  if (v === true) return humanKey(b.key);
  if (v === false || v == null) return null;
  const text = typeof v === 'object' ? Object.values(v).join(', ') : String(v);
  return text.trim() || null;
}

/** Values only, deduped, order preserved. */
function linesFrom(beliefs, { limit = 6 } = {}) {
  const seen = new Set();
  const out = [];
  for (const b of beliefs.filter(active).sort((a, c) => (c.confidence ?? 0) - (a.confidence ?? 0))) {
    const t = line(b);
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ text: t, ref: `belief:${b.dimension}:${b.key}`, confidence: +Number(b.confidence ?? 0).toFixed(3) });
    if (out.length >= limit) break;
  }
  return out;
}

const avg = (items) => (items.length
  ? items.reduce((s, i) => s + (Number(i.confidence) || 0), 0) / items.length
  : 0);

/**
 * Section order is the order a PERSON would want to read, not the internal
 * dimension order: who you are, what you are building, what you are aiming at,
 * how you want to be helped. The last of those is what makes the next
 * conversation better, so it earns a place ahead of trivia.
 */
const SECTION_PLAN = [
  { id: 'you', label: 'You', dimensions: ['identity'], limit: 4 },
  { id: 'working_on', label: 'Working on', kind: 'projects', limit: 4 },
  { id: 'aiming_at', label: 'Aiming at', kind: 'goals', limit: 4 },
  { id: 'how_to_help', label: 'How you like to work', dimensions: ['communication', 'preferences'], limit: 4 },
  { id: 'knows', label: 'Already knows', dimensions: ['knowledge'], limit: 6 },
  { id: 'how_you_think', label: 'How you think', dimensions: ['personality', 'behavior', 'decision'], limit: 3 },
];

/**
 * Build the card.
 *
 * @param {object} args
 * @param {object} args.beliefsByDimension
 * @param {Array}  args.goals
 * @param {Array}  args.projects   [{ id, label }] from the graph
 * @param {Array}  args.sources    [{ kind, count }]
 * @param {number} args.score      the ONE server-side understanding score
 * @returns {{ headline, sections, score, confidence, sources, isThin }}
 */
export function buildCard({
  beliefsByDimension = {}, goals = [], projects = [], sources = [], score = 0,
} = {}) {
  const byDim = beliefsByDimension ?? {};
  const goalList = (Array.isArray(goals) ? goals : Object.values(goals ?? {}))
    .filter(g => g && (g.status === 'active' || g.status === 'blocked'));

  const sections = [];

  for (const plan of SECTION_PLAN) {
    let items = [];

    if (plan.kind === 'projects') {
      // A project may come from the graph (a document named it) or from the
      // Mind (the user said it). Both are real; they differ in how they are
      // corrected, so each carries its OWN ref rather than being stamped with
      // an entity id it may not have. Falling back to `entity:` keeps every
      // existing caller byte-identical.
      items = (projects ?? [])
        .filter(p => p?.label)
        .slice(0, plan.limit)
        .map(p => ({
          text: String(p.label),
          ref: p.ref ?? `entity:${p.id}`,
          confidence: typeof p.confidence === 'number' ? +p.confidence.toFixed(3) : 0.8,
        }));
    } else if (plan.kind === 'goals') {
      items = goalList
        .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
        .slice(0, plan.limit)
        .map(g => ({ text: String(g.title), ref: `goal:${g.id}`, confidence: +Number(g.confidence ?? 0).toFixed(3) }));
    } else {
      const pool = (plan.dimensions ?? []).flatMap(d => byDim[d] ?? []);
      items = linesFrom(pool, { limit: plan.limit });
    }

    // The rule. An empty section does not appear.
    if (!items.length) continue;

    const confidence = plan.kind === 'projects' ? 0.8 : avg(items);
    sections.push({
      id: plan.id,
      label: plan.label,
      items,
      confidence: +confidence.toFixed(3),
      confidenceLabel: confidenceLabel(confidence),
    });
  }

  return {
    // Second person, present tense, no exclamation. The card should sound like
    // someone repeating back what they heard, not like software congratulating
    // itself on a completed step.
    headline: "Here's what I understand so far",
    sections,
    score,
    confidence: confidenceLabel(score / 100),
    sources: (sources ?? []).filter(s => s?.count > 0),
    // A thin card is a real outcome — someone answered two questions and
    // stopped. The UI needs to know so it can say something honest instead of
    // presenting three lines as a finished portrait.
    isThin: sections.length < 3,
  };
}

/** Every dimension the card can draw from, for tests and callers. */
export const CARD_DIMENSIONS = Object.freeze(COVERAGE_DIMENSIONS);
