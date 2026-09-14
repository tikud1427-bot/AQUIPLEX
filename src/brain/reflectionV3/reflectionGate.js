/**
 * AQUA Brain — E9 / PR-9 reflection lifecycle gate.
 *
 * Pure gate for the deterministic parts of the claim -> reflection lifecycle.
 * It intentionally does not pretend to prove PostgreSQL transactionality; the
 * database-backed seams remain covered by their focused integration tests.
 * This gate proves the policy contract that must hold across those seams:
 * every supported lifecycle event maps to exactly one deterministic effect,
 * duplicate delivery is harmless, recovery decisions are stable, and an
 * owner cannot inherit another owner's effect key.
 */
import { buildClaimReflectionDelta } from './reflectionDelta.js';
import { reflectionEffectKey } from './reflectionIdempotency.js';
import { reconciliationDecision } from './reflectionReconciliation.js';

export const E9_LIFECYCLE_EVENTS = Object.freeze([
  'created', 'corroborated', 'contradicted', 'superseded', 'stale',
]);

export function evaluateReflectionLifecycle() {
  const checks = [];

  for (const eventType of E9_LIFECYCLE_EVENTS) {
    const delta = buildClaimReflectionDelta({
      eventType,
      claim: { claimId: `claim:${eventType}`, confidence: 0.8 },
    });
    checks.push({
      id: `event:${eventType}`,
      ok: delta.ok && delta.transition === eventType && delta.strength >= 0 && delta.strength <= 1,
      detail: delta,
    });
  }

  const ownerA = reflectionEffectKey({ ownerId: 'owner:a', outboxId: 17, claimId: 'c1' });
  const ownerB = reflectionEffectKey({ ownerId: 'owner:b', outboxId: 17, claimId: 'c1' });
  checks.push({ id: 'owner-isolation', ok: ownerA !== ownerB, detail: { ownerA, ownerB } });

  const duplicateA = reflectionEffectKey({ ownerId: 'owner:a', outboxId: 17, claimId: 'c1' });
  const duplicateB = reflectionEffectKey({ ownerId: 'owner:a', outboxId: 17, claimId: 'c1' });
  checks.push({ id: 'deterministic-idempotency-key', ok: duplicateA === duplicateB, detail: { key: duplicateA } });

  const recoveryCases = [
    ['queued', 'in-flight'],
    ['running', 'in-flight'],
    ['done', 'requeue-done'],
    ['dead', 'requeue-dead'],
    [null, 'missing-job'],
  ];
  for (const [state, expected] of recoveryCases) {
    const actual = reconciliationDecision({ eventType: 'claim.created', jobState: state, hasEffect: false });
    checks.push({ id: `recovery:${state ?? 'missing'}`, ok: actual === expected, detail: { state, actual, expected } });
  }

  const applied = reconciliationDecision({ eventType: 'claim.created', jobState: 'done', hasEffect: true });
  checks.push({ id: 'applied-is-terminal', ok: applied === 'applied', detail: applied });

  const unsupported = buildClaimReflectionDelta({ eventType: 'unknown', claim: { claimId: 'c-unknown', confidence: 1 } });
  checks.push({ id: 'unsupported-event-refused', ok: unsupported.ok === false, detail: unsupported });

  const passed = checks.filter(c => c.ok).length;
  return {
    schemaVersion: 1,
    total: checks.length,
    passed,
    failed: checks.length - passed,
    passRate: checks.length ? passed / checks.length : 0,
    complete: checks.every(c => c.ok),
    checks,
  };
}
