/**
 * AQUA Mind — Belief Engine (Layers 1–4, 11, 17, 18)
 * ─────────────────────────────────────────────────────────────────────────────
 * The only writer of mind.beliefs. All inference lands here as SIGNALS:
 *
 *   { dimension, key, value, strength, support, note, conversationId, source }
 *
 * Rules enforced here (and nowhere else, so they can't drift):
 *   • confidence via confidence.js — never set directly
 *   • contradiction lowers confidence and versions the old value into
 *     history — NEVER overwrites silently
 *   • locked beliefs (user-pinned) are immune to inference
 *   • every belief can explain itself from its evidence window (Layer 17)
 *   • user corrections (Layer 18) are explicit-source, high-confidence,
 *     and recorded as correction evidence
 */
import { createBelief, beliefKey, CAPS, DIMENSION_DYNAMICS, STATUS } from './mindSchema.js';
import { reinforce, contradict, fromExplicit, clamp01 } from './confidence.js';
import { touchMind } from './mindStore.js';

function valuesEqual(a, b) {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function pushEvidence(belief, entry) {
  belief.evidence.push(entry);
  if (belief.evidence.length > CAPS.EVIDENCE_WINDOW) {
    belief.evidence.splice(0, belief.evidence.length - CAPS.EVIDENCE_WINDOW);
  }
  belief.evidenceCount += 1;
  belief.lastEvidenceAt = entry.ts;
}

function versionValue(belief, reason) {
  belief.history.push({
    value: belief.value,
    confidence: belief.confidence,
    supersededAt: Date.now(),
    reason,
  });
  if (belief.history.length > CAPS.HISTORY_PER_ITEM) {
    belief.history.splice(0, belief.history.length - CAPS.HISTORY_PER_ITEM);
  }
}

/**
 * Apply one inference signal to the Mind.
 * support=true reinforces `value`; support=false is contradicting evidence
 * against the CURRENT value.
 *
 * Same-value signal   → reinforce confidence.
 * Different value     → contradiction of old + seed/strengthen new:
 *   old confidence drops; if the incoming value's implied confidence would
 *   now exceed the old, the belief flips value (old value → history).
 */
export function observeSignal(mind, signal) {
  if (!mind || !signal?.dimension || !signal?.key) return null;
  const {
    dimension, key, value, strength = 0.6, support = true,
    note = '', conversationId = null, source = 'inference',
  } = signal;

  const dyn = DIMENSION_DYNAMICS[dimension] ?? { changeRate: 0.1 };
  const bk  = beliefKey(dimension, key);
  let belief = mind.beliefs[bk];
  const now  = Date.now();
  const ev   = { ts: now, conversationId, signal: note || key, delta: 0, support };

  // New belief
  if (!belief) {
    if (!support) return null; // can't contradict what isn't believed
    belief = createBelief({
      dimension, key, value,
      confidence: clamp01(0.25 + dyn.changeRate * strength),
      source,
    });
    ev.delta = belief.confidence;
    pushEvidence(belief, ev);
    mind.beliefs[bk] = belief;
    touchMind(mind);
    return belief;
  }

  if (belief.privacy?.locked || belief.status === STATUS.LOCKED) return belief; // user-pinned

  const before = belief.confidence;

  if (support && valuesEqual(belief.value, value)) {
    belief.confidence = reinforce(before, dyn.changeRate, strength);
  } else if (!support) {
    belief.confidence = contradict(before, strength);
    belief.contradictions += 1;
  } else {
    // Supporting a DIFFERENT value = contradiction of current + challenger
    belief.confidence = contradict(before, strength);
    belief.contradictions += 1;
    const challenger = clamp01(0.25 + dyn.changeRate * strength);
    if (challenger > belief.confidence) {
      versionValue(belief, 'superseded_by_evidence');
      belief.value = value;
      belief.confidence = challenger;
    }
  }

  ev.delta = +(belief.confidence - before).toFixed(4);
  pushEvidence(belief, ev);
  belief.updatedAt = now;
  if (belief.status === STATUS.ARCHIVED && belief.confidence > 0.3) belief.status = STATUS.ACTIVE;
  touchMind(mind);
  return belief;
}

/** Batch helper — chat pipeline emits arrays of signals per turn. */
export function observeSignals(mind, signals = []) {
  const touched = [];
  for (const s of signals) {
    const b = observeSignal(mind, s);
    if (b) touched.push(b);
  }
  return touched;
}

// ── Layer 18 — user edits ─────────────────────────────────────────────────────

/** Explicit user correction: dominates inference, fully audited. */
export function correctBelief(mind, dimension, key, value, { note = 'user correction' } = {}) {
  const bk = beliefKey(dimension, key);
  let belief = mind.beliefs[bk];
  const now = Date.now();
  if (!belief) {
    belief = createBelief({ dimension, key, value, confidence: fromExplicit(0), source: 'correction' });
    mind.beliefs[bk] = belief;
  } else {
    if (!valuesEqual(belief.value, value)) versionValue(belief, 'user_correction');
    belief.value = value;
    belief.confidence = fromExplicit(belief.confidence);
    belief.privacy.source = 'correction';
    belief.status = STATUS.ACTIVE;
  }
  pushEvidence(belief, { ts: now, conversationId: null, signal: note, delta: 0, support: true, correction: true });
  belief.updatedAt = now;
  touchMind(mind);
  return belief;
}

export function lockBelief(mind, dimension, key, locked = true) {
  const belief = mind.beliefs[beliefKey(dimension, key)];
  if (!belief) return null;
  belief.privacy.locked = locked;
  belief.updatedAt = Date.now();
  touchMind(mind);
  return belief;
}

export function markTemporary(mind, dimension, key, temporary = true) {
  const belief = mind.beliefs[beliefKey(dimension, key)];
  if (!belief) return null;
  belief.privacy.temporary = temporary;
  touchMind(mind);
  return belief;
}

/** Delete part of the model. History goes too — the user owns the model. */
export function deleteBelief(mind, dimension, key) {
  const bk = beliefKey(dimension, key);
  if (!mind.beliefs[bk]) return false;
  delete mind.beliefs[bk];
  touchMind(mind);
  return true;
}

// ── Layer 17 — explainability ─────────────────────────────────────────────────

/** "Why do you believe X?" — grounded in the evidence window, no hand-waving. */
export function explainBelief(belief) {
  if (!belief) return null;
  const supports = belief.evidence.filter(e => e.support !== false);
  const contras  = belief.evidence.filter(e => e.support === false);
  const signals  = [...new Set(supports.map(e => e.signal))].slice(0, 5);
  const convs    = new Set(belief.evidence.map(e => e.conversationId).filter(Boolean));

  const parts = [];
  parts.push(
    `Believed because of ${belief.evidenceCount} observation${belief.evidenceCount === 1 ? '' : 's'}` +
    (convs.size ? ` across ${convs.size} conversation${convs.size === 1 ? '' : 's'}` : '') + '.'
  );
  if (signals.length) parts.push(`Strongest signals: ${signals.join('; ')}.`);
  if (belief.contradictions > 0) {
    parts.push(`${belief.contradictions} contradicting observation${belief.contradictions === 1 ? '' : 's'} lowered confidence — history preserved.`);
  }
  if (belief.history.length) {
    const prev = belief.history[belief.history.length - 1];
    parts.push(`Previously believed: ${JSON.stringify(prev.value)} (superseded ${new Date(prev.supersededAt).toISOString().slice(0, 10)}).`);
  }
  if (belief.privacy?.source === 'correction') parts.push('Set explicitly by the user.');

  return {
    dimension: belief.dimension,
    key: belief.key,
    value: belief.value,
    confidence: +belief.confidence.toFixed(3),
    evidenceCount: belief.evidenceCount,
    contradictions: belief.contradictions,
    explanation: parts.join(' '),
    recentEvidence: belief.evidence.slice(-5),
    _contraCount: contras.length,
  };
}

// ── Queries ───────────────────────────────────────────────────────────────────
export function getBeliefs(mind, { dimension = null, minConfidence = 0, status = STATUS.ACTIVE } = {}) {
  return Object.values(mind.beliefs)
    .filter(b => (!dimension || b.dimension === dimension)
              && b.confidence >= minConfidence
              && (!status || b.status === status || b.status === STATUS.LOCKED))
    .sort((a, b) => b.confidence - a.confidence);
}
