/**
 * UUS U3 — file understanding → the Mind.
 *
 * THE DEFECT
 * ----------
 * `mindObserve` has exactly one caller: `memory/engine.js`, from the chat
 * pipeline. `files/fileEngine.js` and `routes/upload.js` contain ZERO `mind`
 * references. So uploading a README, a pitch deck or a resume fills the
 * evidence store, the graph and the PIC — and produces no beliefs, no goals,
 * no identity.
 *
 * Both the world-model card and the Understanding dashboard render Mind data.
 * "Do you have anything you'd like me to understand?" is in the brief, and
 * before this the honest answer was: it will read your file and understand
 * nothing you can see.
 *
 * WHAT THIS FILE IS
 * -----------------
 * A pure translator: UKO in, belief SIGNALS out. It never writes. The caller
 * hands the signals to `observeSignals`, which stays the one and only belief
 * writer — the same discipline the Digital Twin follows, and the reason there
 * is no second confidence system to reconcile.
 *
 * PROVENANCE STAYS HONEST
 * -----------------------
 * File-derived beliefs are `fact_bridge`, never `explicit`. The user did not
 * say it; a document implied it. On a screen whose whole job is trust, "you
 * told me this" and "I read this in your README" are different claims, and a
 * card that merges them is worse than one that shows less.
 *
 * THE HARD PART IS RESTRAINT
 * --------------------------
 * A codebase upload yields hundreds of entities. Writing all of them as
 * beliefs would bury three true things about a person under two hundred
 * package names — and the dashboard renders beliefs. So this file discards
 * far more than it keeps, and the thresholds below are the actual product
 * decision.
 */
import { DIMENSIONS } from '../mind/mindSchema.js';

/** A term must recur to count as something the person WORKS with. */
const MIN_ENTITY_COUNT = 2;

/** Ceilings per upload. A file is evidence about a person, not a personality. */
const MAX_TECH_BELIEFS = 8;
const MAX_TOPIC_BELIEFS = 5;
const MAX_GOAL_TITLES = 5;

/**
 * A document mentioning a technology is weaker evidence than a person saying
 * they use it, and it must stay weaker or a README would outrank its author.
 * 0.45 sits below the 0.5 the conversational tech observer uses and well below
 * the 0.9 an explicit statement earns.
 */
const FILE_SIGNAL_STRENGTH = 0.45;

/** Entity types that say something about the person, and how they map. */
const ENTITY_DIMENSION = Object.freeze({
  technology: DIMENSIONS.KNOWLEDGE,
  language:   DIMENSIONS.KNOWLEDGE,
  framework:  DIMENSIONS.KNOWLEDGE,
  tool:       DIMENSIONS.KNOWLEDGE,
});

/**
 * Entity types deliberately NOT bridged, and why — recorded so this list is
 * revisited on purpose rather than quietly extended:
 *
 *   person       → a name in a document is not a relationship. The graph
 *                  already holds it with real provenance; promoting it to a
 *                  belief would let a citation list become the user's
 *                  colleagues.
 *   org          → same. "AWS" appearing in a README is not an employer.
 *   date, money, → facts about the DOCUMENT, not about the reader.
 *   url, email
 */

const slug = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

const GOAL_CUES = /\b(?:goal|objective|mission|roadmap|milestone|target|aim|vision|okr|deliverable)s?\b/i;

/**
 * Belief signals implied by one UKO.
 *
 * @param {object} uko
 * @param {object} [opts]
 * @param {string} [opts.sourceLabel]  what to cite as the evidence note
 * @returns {Array<object>} signals for observeSignals — never written here
 */
export function toSignals(uko, { sourceLabel = null } = {}) {
  if (!uko || typeof uko !== 'object') return [];
  const note = sourceLabel
    ?? uko.structuredContent?.title
    ?? uko.sourceFile?.name
    ?? 'an uploaded file';
  const signals = [];

  // ── Technologies the document keeps coming back to ────────────────────────
  const tech = (uko.entities ?? [])
    .filter(e => e && ENTITY_DIMENSION[e.type] && Number(e.count ?? 0) >= MIN_ENTITY_COUNT)
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    .slice(0, MAX_TECH_BELIEFS);

  for (const e of tech) {
    const key = slug(e.value);
    if (!key) continue;
    signals.push({
      dimension: ENTITY_DIMENSION[e.type],
      key: `tech:${key}`,
      value: 'working_knowledge',
      strength: FILE_SIGNAL_STRENGTH,
      source: 'fact_bridge',
      note: `mentioned ${e.count}× in ${note}`,
    });
  }

  // ── What the document is ABOUT ────────────────────────────────────────────
  // Topics carry a weight from the enrichment pipeline; only the ones it was
  // reasonably sure of become beliefs.
  const topics = (uko.topics ?? [])
    .filter(t => t && t.topic && Number(t.weight ?? 0) >= 0.5)
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, MAX_TOPIC_BELIEFS);

  for (const t of topics) {
    const key = slug(t.topic);
    if (!key) continue;
    signals.push({
      dimension: DIMENSIONS.KNOWLEDGE,
      key: `domain:${key}`,
      value: 'familiar',
      // Scaled by the pipeline's own confidence rather than flattened to a
      // constant: a 0.9-weight topic really is better evidence than a 0.5 one,
      // and discarding that is throwing away the only calibration available.
      strength: Math.min(FILE_SIGNAL_STRENGTH, FILE_SIGNAL_STRENGTH * Number(t.weight)),
      source: 'fact_bridge',
      note: `a main topic of ${note}`,
    });
  }

  return signals;
}

/**
 * Goal titles implied by a UKO, for `trackGoals` — which owns goal identity,
 * merging and confidence. This only proposes text.
 *
 * Restricted to timeline events and facts that actually LOOK like goals. A
 * roadmap is full of intent; a CSV of sales figures is not, and mining every
 * sentence for a verb phrase produces goals nobody set.
 *
 * @returns {Array<string>}
 */
export function toGoalTitles(uko) {
  if (!uko || typeof uko !== 'object') return [];
  const out = [];

  for (const t of uko.timeline ?? []) {
    const event = String(t?.event ?? '').trim();
    if (event.length > 8 && GOAL_CUES.test(`${event} ${t?.source ?? ''}`)) out.push(event);
  }

  for (const f of uko.facts ?? []) {
    const text = String(f?.text ?? '').trim();
    if (text.length > 8 && text.length < 120 && GOAL_CUES.test(text)) out.push(text);
  }

  return [...new Set(out)].slice(0, MAX_GOAL_TITLES);
}

/**
 * Everything one UKO implies, in one call.
 * Still pure — the caller decides whether to write any of it.
 */
export function readUko(uko, opts = {}) {
  return { signals: toSignals(uko, opts), goalTitles: toGoalTitles(uko) };
}
