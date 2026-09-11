/**
 * AQUA Reasoning Feedback — Persistent Intelligence Core (Phase 4)
 *
 * "Every reasoning session should improve the system. Future reasoning
 * should benefit from previous reasoning." Two halves:
 *
 *   CAPTURE  recordReasoningSession() logs what a reasoning pass USED
 *            (fact ids, entity ids) and how it ENDED — the brief's exact
 *            outcome taxonomy: successful | failed | corrected | verified |
 *            unsupported — plus any confidence adjustment. Chat wires this
 *            from the verification pass (a verification that passes ⇒
 *            'verified'; a revision ⇒ 'corrected'); future autonomous
 *            phases call it directly.
 *
 *   FEEDBACK per-fact aggregates (ok / bad counters, EWMA-free by design —
 *            counts stay explainable) turn into a retrieval-time BOOST in
 *            [-0.10, +0.15]: facts that kept surviving review rank higher,
 *            facts that kept getting corrected rank lower. Bounded, decays
 *            by recency window, never a hard filter — feedback biases, it
 *            does not censor (that would let one bad review bury a true
 *            fact).
 *
 * Persisted through picStore (sessions ring + signals map). References only.
 */
import {
  picBucket, schedulePicSave, pushBounded, boundMap,
  MAX_SESSIONS_PER_OWNER, MAX_SIGNALS_PER_OWNER,
} from './picStore.js';

export const REASONING_OUTCOMES = Object.freeze([
  'successful', 'failed', 'corrected', 'verified', 'unsupported',
]);

const POSITIVE = new Set(['successful', 'verified']);
const NEGATIVE = new Set(['failed', 'corrected', 'unsupported']);

const SIGNAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;  // signals older than 30d stop biasing
const BOOST_MAX  =  0.15;
const BOOST_MIN  = -0.10;

/**
 * Record one reasoning session and fold its outcome into per-fact signals.
 *
 * @param {string} ownerId
 * @param {object} session
 * @param {string}   [session.requestId]
 * @param {string}   [session.query]
 * @param {string}    session.outcome        one of REASONING_OUTCOMES
 * @param {string[]} [session.usedFacts]     fact ids the reasoning consumed
 * @param {string[]} [session.usedEntities]  entity node ids
 * @param {number}   [session.confidence]    reviewer confidence, if any
 * @param {string}   [session.note]
 * @returns {object|null} the stored session, or null on a bad outcome
 */
export function recordReasoningSession(ownerId, session = {}) {
  if (!REASONING_OUTCOMES.includes(session.outcome)) return null;
  const b = picBucket(ownerId);
  const entry = {
    at: Date.now(),
    requestId: session.requestId ?? null,
    query: String(session.query ?? '').slice(0, 240),
    outcome: session.outcome,
    usedFacts:    (session.usedFacts    ?? []).slice(0, 50),
    usedEntities: (session.usedEntities ?? []).slice(0, 50),
    confidence: session.confidence ?? null,
    note: session.note ?? null,
  };
  pushBounded(b.sessions, entry, MAX_SESSIONS_PER_OWNER);

  const good = POSITIVE.has(entry.outcome);
  const bad  = NEGATIVE.has(entry.outcome);
  for (const factId of entry.usedFacts) {
    const sig = b.signals.get(factId) ?? { ok: 0, bad: 0, lastAt: 0 };
    if (good) sig.ok  += 1;
    if (bad)  sig.bad += 1;
    sig.lastAt = entry.at;
    b.signals.set(factId, sig);
  }
  boundMap(b.signals, MAX_SIGNALS_PER_OWNER);
  schedulePicSave();
  return entry;
}

/**
 * Retrieval-time bias for one fact, in [BOOST_MIN, BOOST_MAX].
 * (ok − bad) / (ok + bad + 2) — Laplace-smoothed so one review never
 * dominates — scaled to the band; zero outside the recency window.
 */
export function reasoningBoost(ownerId, factId) {
  const sig = picBucket(ownerId).signals.get(factId);
  if (!sig) return 0;
  if (Date.now() - sig.lastAt > SIGNAL_WINDOW_MS) return 0;
  const n = sig.ok + sig.bad;
  if (!n) return 0;
  const ratio = (sig.ok - sig.bad) / (n + 2);
  const boost = ratio >= 0 ? ratio * BOOST_MAX : ratio * -BOOST_MIN;
  return Math.round(Math.max(BOOST_MIN, Math.min(BOOST_MAX, boost)) * 1000) / 1000;
}

export function listSessions(ownerId, { limit = 20 } = {}) {
  return picBucket(ownerId).sessions.slice(-limit);
}

export function feedbackStats(ownerId) {
  const b = picBucket(ownerId);
  const byOutcome = {};
  for (const s of b.sessions) byOutcome[s.outcome] = (byOutcome[s.outcome] ?? 0) + 1;
  return { sessions: b.sessions.length, factsWithSignals: b.signals.size, byOutcome };
}

export const _feedbackBand = { BOOST_MIN, BOOST_MAX };
