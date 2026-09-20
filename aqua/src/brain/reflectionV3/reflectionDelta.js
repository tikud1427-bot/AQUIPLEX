/**
 * AQUA Brain — E9 / PR-4 deterministic claim reflection delta planner.
 *
 * Turns a canonical-claim lifecycle transition into a small, auditable delta
 * for the existing claim→belief adapter. It does not write claims, beliefs,
 * or the outbox. Mutation remains the responsibility of the lifecycle caller.
 *
 * Supported lifecycle transitions:
 *   created      → supporting evidence
 *   corroborated → stronger supporting evidence
 *   contradicted → contradicting evidence
 *   superseded   → contradicting evidence against the superseded belief
 *   stale        → weak contradicting evidence (only when explicitly emitted)
 *
 * The planner never invents a belief. A relationship must already identify the
 * owner-scoped belief, and the adapter will refuse to plan a signal without a
 * current belief value.
 */

import { planClaimReflection } from './claimBeliefAdapter.js';

const TRANSITIONS = Object.freeze({
  created:      { relation: 'supporting',   multiplier: 1.0 },
  corroborated: { relation: 'supporting',   multiplier: 1.0 },
  contradicted: { relation: 'contradicting', multiplier: 1.0 },
  superseded:   { relation: 'contradicting', multiplier: 1.0 },
  stale:        { relation: 'contradicting', multiplier: 0.25 },
});

const clamp01 = n => Math.max(0, Math.min(1, Number(n) || 0));

export function classifyClaimTransition({ previousState = null, nextState = null, eventType = null } = {}) {
  const normalizedEvent = String(eventType ?? '').replace(/^claim\./, '');
  if (normalizedEvent && TRANSITIONS[normalizedEvent]) return normalizedEvent;
  if (nextState && TRANSITIONS[nextState]) return nextState;
  if (previousState === 'extracted' && nextState === 'superseded') return 'superseded';
  return null;
}

/**
 * Produce the structured delta for one claim lifecycle event.
 */
export function buildClaimReflectionDelta({
  eventType = null,
  previousState = null,
  nextState = null,
  claim = {},
} = {}) {
  const transition = classifyClaimTransition({ previousState, nextState, eventType });
  const policy = transition ? TRANSITIONS[transition] : null;
  const claimId = claim.claimId ?? claim.id ?? null;

  if (!claimId || !policy) {
    return {
      ok: false,
      claimId,
      transition,
      relation: null,
      multiplier: 0,
      reason: 'unsupported claim lifecycle transition',
    };
  }

  return {
    ok: true,
    claimId,
    transition,
    relation: policy.relation,
    multiplier: policy.multiplier,
    strength: +clamp01((Number(claim.confidence) || 0.5) * policy.multiplier).toFixed(4),
    reason: `claim lifecycle: ${transition}`,
  };
}

/**
 * Plan belief-engine signals for a batch of lifecycle deltas.
 * `relationships` and `beliefValues` remain owner-scoped inputs supplied by
 * the caller. No storage access and no mutation occur here.
 */
export function planReflectionDelta({
  claims = [],
  events = [],
  relationships = [],
  beliefValues = new Map(),
} = {}) {
  const eventByClaim = new Map();
  for (const event of events) {
    const id = event.claimId ?? event.id;
    if (!id) continue;
    const delta = buildClaimReflectionDelta({
      eventType: event.eventType,
      previousState: event.previousState,
      nextState: event.nextState,
      claim: claims.find(c => (c.claimId ?? c.id) === id) ?? event.claim ?? { claimId: id },
    });
    if (delta.ok) eventByClaim.set(id, delta);
  }

  const effectiveRelationships = relationships.map(rel => {
    const delta = eventByClaim.get(rel.claimId);
    if (!delta) return rel;
    return {
      ...rel,
      relation: delta.relation,
      weight: clamp01((Number(rel.weight) || 0) * delta.multiplier),
    };
  });

  return planClaimReflection({ claims, relationships: effectiveRelationships, beliefValues })
    .map(signal => {
      const delta = eventByClaim.get(signal.claimId);
      return delta ? { ...signal, strength: delta.strength, reflectionTransition: delta.transition, note: `${signal.note}; ${delta.reason}` } : signal;
    });
}
