/**
 * E9 / PR-6 — durable reflection effect ledger carried with the Mind snapshot.
 *
 * The job queue is already idempotent at enqueue time, but a worker can crash
 * after applying a belief mutation and before acknowledging the job. The
 * ledger makes the belief-side effect idempotent too. It is persisted as part
 * of the same Mind snapshot, so the effect marker and belief mutation cross
 * the persistence boundary together.
 */

const MAX_REFLECTION_EFFECTS = 256;

function ensureLedger(mind) {
  if (!mind.reflectionLedger || typeof mind.reflectionLedger !== 'object') {
    mind.reflectionLedger = {};
  }
  return mind.reflectionLedger;
}

export const REFLECTION_LEDGER_MAX = MAX_REFLECTION_EFFECTS;

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

  const keys = Object.keys(ledger);
  if (keys.length > MAX_REFLECTION_EFFECTS) {
    keys.sort((a, b) => (Number(ledger[a]?.appliedAt) || 0) - (Number(ledger[b]?.appliedAt) || 0));
    for (const oldKey of keys.slice(0, keys.length - MAX_REFLECTION_EFFECTS)) delete ledger[oldKey];
  }

  return true;
}

