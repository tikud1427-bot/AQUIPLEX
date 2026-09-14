/**
 * AQUA Brain — E9 / PR-3 claim → belief reflection adapter.
 *
 * This module is the only bridge between canonical-claim state changes and
 * Mind belief mutation. It deliberately does NOT write mind.beliefs itself.
 * Every delta becomes a normal Belief Engine signal and therefore inherits
 * the existing confidence math, locked-belief rule, evidence window and
 * history semantics.
 *
 * Claim content is never copied into Mind. The bridge contributes provenance
 * (claim id) and a bounded strength; the belief engine remains the single
 * writer.
 */

import { observeSignal, observeSignals } from '../../mind/beliefEngine.js';
import { getMind } from '../../mind/mindStore.js';
import { beliefsForClaim } from '../../core/mind/beliefClaimRepository.js';

const clamp01 = n => Math.max(0, Math.min(1, Number(n) || 0));

/**
 * Convert one claim↔belief relationship into a belief-engine signal.
 *
 * Supporting claims reinforce the existing belief value. Contradicting claims
 * lower confidence in the current value. A contradiction can never create a
 * new belief because the Belief Engine intentionally ignores negative signals
 * for absent beliefs.
 */
export function claimRelationshipToSignal({
  relationship,
  claim = {},
  conversationId = null,
} = {}) {
  if (!relationship?.dimension || !relationship?.beliefKey || !relationship?.claimId) {
    return null;
  }

  const supporting = relationship.relation !== 'contradicting';
  const claimConfidence = Number.isFinite(Number(claim.confidence))
    ? clamp01(claim.confidence)
    : 0.5;
  const relationshipWeight = clamp01(relationship.weight ?? 1);

  return {
    dimension: relationship.dimension,
    key: relationship.beliefKey,
    // For a supporting signal the current belief value is intentionally
    // resolved at application time. A claim relationship must not smuggle a
    // copied value into Mind.
    value: relationship.currentBeliefValue,
    strength: Number(clamp01(claimConfidence * relationshipWeight).toFixed(4)),
    support: supporting,
    note: `canonical claim ${relationship.claimId} ${relationship.relation ?? 'supporting'}`,
    conversationId,
    source: 'canonical_claim_reflection',
    claimId: relationship.claimId,
    explicit: false,
  };
}

/**
 * Pure planner: turn affected claims + their bridge relationships into
 * signals. It requires current belief values to be supplied by the caller;
 * this keeps it free of storage and makes the policy independently testable.
 */
export function planClaimReflection({ claims = [], relationships = [], beliefValues = new Map() } = {}) {
  const byClaim = new Map(claims.map(c => [c.claimId ?? c.id, c]));
  const signals = [];

  for (const rel of relationships) {
    const claim = byClaim.get(rel.claimId);
    if (!claim) continue;

    const value = beliefValues.get(`${rel.dimension}:${rel.beliefKey}`);
    const signal = claimRelationshipToSignal({
      relationship: { ...rel, currentBeliefValue: value },
      claim,
    });

    // A supporting relationship without an existing belief is not allowed to
    // manufacture one from claim metadata. The existing belief must exist.
    if (signal && value !== undefined) signals.push(signal);
  }

  return signals;
}

/**
 * Apply claim reflection for one owner.
 *
 * `affectedClaims` is supplied by the claim lifecycle caller; this function
 * never scans another owner and never treats the claims table as a belief
 * store. The bridge is read-only with respect to claims.
 *
 * Returns an audit-friendly report. Failures are reported rather than
 * swallowed, but no partial "success" is claimed.
 */
export async function reflectClaimsToBeliefs({
  ownerId,
  affectedClaims = [],
  conversationId = null,
  deps = {},
} = {}) {
  if (!ownerId) return { ok: false, ownerId: null, signals: 0, touched: 0, reason: 'no owner' };

  const readRelationships = deps.beliefsForClaim ?? beliefsForClaim;
  const load = deps.getMind ?? getMind;
  const apply = deps.observeSignals ?? observeSignals;

  const mind = load(ownerId);
  if (!mind) return { ok: false, ownerId, signals: 0, touched: 0, reason: 'mind unavailable' };

  const relationships = [];
  for (const claim of affectedClaims) {
    const claimId = claim.claimId ?? claim.id;
    if (!claimId) continue;
    const rows = await readRelationships({ ownerId, claimId });
    for (const row of rows) relationships.push({ ...row, claimId });
  }

  const beliefValues = new Map();
  for (const b of Object.values(mind.beliefs ?? {})) {
    beliefValues.set(`${b.dimension}:${b.key}`, b.value);
  }

  const signals = planClaimReflection({
    claims: affectedClaims,
    relationships,
    beliefValues,
  }).map(s => ({ ...s, conversationId }));

  const touched = signals.length ? apply(mind, signals) : [];
  return {
    ok: true,
    ownerId,
    claims: affectedClaims.length,
    relationships: relationships.length,
    signals: signals.length,
    touched: touched.length,
    claimIds: [...new Set(signals.map(s => s.claimId))],
  };
}

/**
 * Single-signal helper used by lifecycle code and tests.
 */
export function applyClaimSignal(mind, signal) {
  return observeSignal(mind, signal);
}
