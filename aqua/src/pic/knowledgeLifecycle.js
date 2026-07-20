/**
 * AQUA Knowledge Lifecycle — Persistent Intelligence Core (Phase 4)
 *
 * "Every piece of knowledge should follow a lifecycle. Nothing should
 * remain static forever." The brief's exact sequence, as a validated state
 * machine:
 *
 *   created → parsed → enriched → verified → linked → reasoned
 *          → retrieved → updated → versioned → archived → retired
 *
 * Rules (canTransition):
 *   • FORWARD movement is always legal, skips included — a content-hash
 *     cache hit legitimately jumps created → enriched in one step.
 *   • The LIVING LOOP: retrieved / reasoned / versioned may return to
 *     `updated` (new evidence arrived, consolidation touched it), which
 *     flows forward again through versioned. Knowledge improves in cycles.
 *   • `archived` is reachable from ANY active state (supersession, owner
 *     removal) and may revive to `updated` — archival is reversible.
 *   • `retired` is terminal and only reachable from `archived` — knowledge
 *     leaves the system in two deliberate steps, never one accident.
 *   • Self-transition = TOUCH: no new transition record, but lastAt and the
 *     per-state counters (meta.retrievals, meta.reasonings) advance — this
 *     is how retrieval frequency feeds consolidation's promote/stale logic
 *     without unbounded transition logs.
 *
 * State lives in picStore (subject-keyed, bounded transition history).
 * Nothing here reads or writes knowledge itself — only its lifecycle.
 * Pure rules + thin persistence; no I/O of its own, no model.
 */
import {
  picBucket, schedulePicSave, pushBounded, boundMap,
  MAX_SUBJECTS_PER_OWNER, MAX_TRANSITIONS_PER_SUBJ,
} from './picStore.js';

export const LIFECYCLE_STATES = Object.freeze([
  'created', 'parsed', 'enriched', 'verified', 'linked', 'reasoned',
  'retrieved', 'updated', 'versioned', 'archived', 'retired',
]);

const ORDER = new Map(LIFECYCLE_STATES.map((s, i) => [s, i]));

/** States allowed to fall back into the living `updated` loop. */
const LOOP_BACK = new Set(['retrieved', 'reasoned', 'versioned', 'verified', 'linked']);

/** States that may return to `verified` — promotion is re-verification. */
const REVERIFY = new Set(['linked', 'reasoned', 'retrieved', 'updated', 'versioned']);

/**
 * Pure transition rule. Exported so tests (and future autonomous phases)
 * can reason about legality without touching state.
 */
export function canTransition(from, to) {
  if (!ORDER.has(from) || !ORDER.has(to)) return false;
  if (from === 'retired') return false;                       // terminal
  if (from === to) return true;                               // touch
  if (to === 'retired') return from === 'archived';           // two-step exit
  if (to === 'archived') return true;                         // any active state may archive
  if (from === 'archived') return to === 'updated';           // revival
  if (to === 'created') return false;                         // birth happens once
  if (ORDER.get(to) > ORDER.get(from)) return true;           // forward, skips ok
  if (to === 'updated'  && LOOP_BACK.has(from)) return true;  // the living loop
  if (to === 'verified' && REVERIFY.has(from))  return true;  // promotion = re-verification
  return false;
}

function record(ownerId, subject) {
  const b = picBucket(ownerId);
  if (!b.lifecycle.has(subject)) {
    b.lifecycle.set(subject, {
      state: 'created',
      transitions: [{ to: 'created', at: Date.now(), reason: 'birth' }],
      meta: { retrievals: 0, reasonings: 0, updates: 0 },
    });
    boundMap(b.lifecycle, MAX_SUBJECTS_PER_OWNER);
  }
  return b.lifecycle.get(subject);
}

/**
 * Move a subject to `to`. Illegal transitions are REFUSED and reported —
 * never thrown: lifecycle bookkeeping must not sink the operation that
 * triggered it (same fail-open contract as enrichment).
 *
 * @returns {{ ok, state, refused? }}
 */
export function transition(ownerId, subject, to, { reason = null } = {}) {
  const rec = record(ownerId, subject);
  if (!canTransition(rec.state, to)) {
    return { ok: false, state: rec.state, refused: `${rec.state} → ${to} not allowed` };
  }
  const now = Date.now();
  if (rec.state !== to) {
    pushBounded(rec.transitions, { to, at: now, reason }, MAX_TRANSITIONS_PER_SUBJ);
    rec.state = to;
  }
  rec.lastAt = now;
  if (to === 'retrieved') rec.meta.retrievals += 1;
  if (to === 'reasoned')  rec.meta.reasonings += 1;
  if (to === 'updated')   rec.meta.updates    += 1;
  schedulePicSave();
  return { ok: true, state: rec.state };
}

/**
 * Advance a subject through several states in order, ignoring refusals of
 * states it already passed — the idempotent primitive ingest uses (a cache
 * hit re-ingest replays created→linked harmlessly).
 */
export function advanceThrough(ownerId, subject, states, { reason = null } = {}) {
  let last = null;
  for (const s of states) last = transition(ownerId, subject, s, { reason });
  return last;
}

export function getLifecycle(ownerId, subject) {
  return picBucket(ownerId).lifecycle.get(subject) ?? null;
}

export function subjectsInState(ownerId, state) {
  const out = [];
  for (const [subject, rec] of picBucket(ownerId).lifecycle) {
    if (rec.state === state) out.push({ subject, ...rec });
  }
  return out;
}

/** Derive the ingest-time lifecycle path from what a UKO actually went through. */
export function ingestStatesFor(uko) {
  const states = ['created'];
  const stages = uko?.processing?.stages ?? [];
  const ran = (prefix) => stages.some(s => s.ok && s.stage.startsWith(prefix));
  if (ran('parse') || uko?.processing?.cacheHit) states.push('parsed');
  if (stages.some(s => s.ok && s.stage.startsWith('enrich:')) || uko?.processing?.cacheHit) states.push('enriched');
  if (ran('enrich:evidence')) states.push('verified');   // grounded facts exist → evidence-verified
  return states;
}

export function lifecycleStats(ownerId) {
  const byState = {};
  for (const rec of picBucket(ownerId).lifecycle.values()) {
    byState[rec.state] = (byState[rec.state] ?? 0) + 1;
  }
  return { subjects: picBucket(ownerId).lifecycle.size, byState };
}
