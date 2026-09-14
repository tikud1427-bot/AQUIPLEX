/**
 * E9 / PR-6 — durable reflection effect ledger carried with the Mind snapshot.
 *
 * The job queue is already idempotent at enqueue time, but a worker can crash
 * after applying a belief mutation and before acknowledging the job. The
 * ledger makes the belief-side effect idempotent too. It is persisted as part
 * of the same Mind snapshot, so the effect marker and belief mutation cross
 * the persistence boundary together.
 */

function ensureLedger(mind) {
  if (!mind.reflectionLedger || typeof mind.reflectionLedger !== 'object') {
    mind.reflectionLedger = {};
  }
  return mind.reflectionLedger;
}

export function reflectionEffectKey({ ownerId, outboxId, eventType, claimId } = {}) {
  if (!ownerId || !claimId) return null;
  if (outboxId !== undefined && outboxId !== null) return `${ownerId}:outbox:${outboxId}`;
  if (eventType) return `${ownerId}:claim:${claimId}:event:${eventType}`;
  return `${ownerId}:claim:${claimId}`;
}

export function hasReflectionEffect(mind, key) {
  if (!mind || !key) return false;
  return Object.prototype.hasOwnProperty.call(ensureLedger(mind), key);
}

export function markReflectionEffect(mind, key, metadata = {}) {
  if (!mind || !key) return false;
  const ledger = ensureLedger(mind);
  if (Object.prototype.hasOwnProperty.call(ledger, key)) return false;
  ledger[key] = { appliedAt: Date.now(), ...metadata };

  return true;
}

