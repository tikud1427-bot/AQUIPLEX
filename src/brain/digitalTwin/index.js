/**
 * AQUA Brain — Digital Twin Orchestrator (Brain V1 / B6)
 *
 * Observes a turn, emits the six missing pattern signals through the Mind's
 * ONE belief writer, and exposes a twin view where every inference carries the
 * three things the brief requires: confidence, supporting evidence, and last
 * verified.
 *
 * WHY IT GOES THROUGH beliefEngine.observeSignal
 * ----------------------------------------------
 * The Mind already implements the hard parts of a digital twin — confidence
 * reinforce/contradict math, bounded evidence windows, value versioning when a
 * challenger wins, per-dimension decay, the `established` promotion gate, user
 * locks and corrections, privacy/retention. Writing beliefs directly would
 * bypass every one of those and create a second, weaker twin. So B6 adds
 * PATTERNS, not plumbing: new signals into the existing writer.
 *
 * The consequence is that the six new patterns decay, get contradicted,
 * version their values and get promoted exactly like the seven that were
 * already there — with no changes to mindSchema.js or beliefEngine.js.
 *
 * CONTRACT
 *   • NEVER FABRICATED. Signals require concrete textual triggers; the twin
 *     view reports only inferences past the evidence+confidence bar.
 *   • DERIVED. lastVerified and confidenceTrend are computed from each
 *     belief's own evidence window — no new store, nothing to purge.
 *   • FAIL-OPEN. Observation failures never affect the turn.
 *   • OFF BY DEFAULT. AQUA_TWIN_V2=on enables observation; the read side
 *     (twinView) works regardless, since it only reads what already exists.
 */
import { inferTwinSignals } from './patternInferrer.js';
import { TWIN_PATTERNS, TWIN_PATTERN_KEYS, describeInference, meetsInferenceBar } from './twinSchema.js';
import { beliefKey } from '../../mind/mindSchema.js';
import { brainEnabled } from '../worldModel/schema.js';

const metrics = {
  turns: 0, signalsEmitted: 0, beliefsTouched: 0, skipped: 0, errors: 0, lastDurationMs: 0,
};

/** Observation is opt-in on top of the read-side switch. */
export function twinV2Enabled() {
  return brainEnabled() && String(process.env.AQUA_TWIN_V2 ?? '').toLowerCase() === 'on';
}

/**
 * Observe one turn and update the twin.
 *
 * @param {object} deps - { getMind, observeSignals }
 * @param {object} args - { ownerId, userMessage, conversationId, at? }
 * @returns {{ ok, signals, touched, skipped? }}
 */
export function observeTwinTurn(deps, { ownerId, userMessage = '', conversationId = null, at = Date.now() } = {}) {
  if (!twinV2Enabled()) { metrics.skipped += 1; return { ok: false, skipped: 'disabled' }; }
  if (!ownerId) { metrics.skipped += 1; return { ok: false, skipped: 'missing-owner' }; }

  const started = Date.now();
  try {
    const signals = inferTwinSignals({ userMessage, at, conversationId });
    if (!signals.length) { metrics.turns += 1; return { ok: true, signals: 0, touched: 0 }; }

    const mind = deps.getMind(ownerId);
    // THE one writer — never a direct belief mutation.
    const touched = deps.observeSignals(mind, signals) ?? [];

    metrics.turns += 1;
    metrics.signalsEmitted += signals.length;
    metrics.beliefsTouched += touched.length;
    metrics.lastDurationMs = Date.now() - started;

    if (signals.length) {
      console.log(`[BRAIN] Twin observed owner=${ownerId} signals=${signals.length} beliefs=${touched.length} in ${metrics.lastDurationMs}ms`);
    }
    return { ok: true, signals: signals.length, touched: touched.length };
  } catch (err) {
    metrics.errors += 1;
    console.warn(`[BRAIN] Twin observation failed (fail-open): ${err?.message ?? err}`);
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/**
 * The twin view: every inferred pattern AQUA is willing to stand behind.
 *
 * Only patterns past the anti-fabrication bar are reported. Below-bar beliefs
 * still exist and still accumulate evidence — they are simply not presented as
 * knowledge about the user. Set `includeTentative` to see them (with the flag
 * set) for debugging or a "still learning" surface.
 *
 * @param {object} deps - { peekMind }
 * @param {string} ownerId
 * @param {object} [opts] - { includeTentative=false, patterns=null }
 * @returns {{ inferences: Array, tentative: number, patternsCovered: number }}
 */
export function twinView(deps, ownerId, { includeTentative = false, patterns = null } = {}) {
  const mind = deps.peekMind?.(ownerId) ?? null;
  if (!mind?.beliefs) return { inferences: [], tentative: 0, patternsCovered: 0 };

  const wanted = patterns ?? TWIN_PATTERN_KEYS;
  const inferences = [];
  let tentative = 0;

  for (const patternKey of wanted) {
    const spec = TWIN_PATTERNS[patternKey];
    if (!spec) continue;
    const belief = mind.beliefs[beliefKey(spec.dimension, patternKey)];
    if (!belief) continue;

    const passes = meetsInferenceBar(belief);
    if (!passes) {
      tentative += 1;
      if (!includeTentative) continue;
    }
    const described = describeInference(patternKey, belief);
    inferences.push(passes ? described : { ...described, tentative: true });
  }

  inferences.sort((a, b) => b.confidence - a.confidence);
  return { inferences, tentative, patternsCovered: inferences.filter(i => !i.tentative).length };
}

export function twinMetrics() {
  return { ...metrics, enabled: twinV2Enabled(), patterns: TWIN_PATTERN_KEYS.length };
}
