/**
 * Every transactional-outbox event type, and what it is FOR (2026-10-04).
 *
 * The outbox serves two purposes, and before this registry nothing said which
 * row was which: 264 `entity.created`, 181 `edge.created` and 30
 * `world-model.lifecycle` rows sat `pending` forever on a live database —
 * looking like unfinished work — and claim transitions to `disputed` / `stale`
 * were emitted as the generic lifecycle type, so the reflection consumer that
 * handles `claim.contradicted` / `claim.stale` never saw them (J2 could not
 * weaken a belief whose claim was disputed).
 *
 *   dispatch  a consumer EXISTS (reflectionOutbox → durable jobs). Written as
 *             `pending`; retried, dead-lettered, replayable.
 *   record    the L1 DELTA LOG — "every write to the world model emits a delta".
 *             The row is the record; nothing acts on it (edges/entities/events
 *             are already materialised in the same transaction). Written as
 *             `published` so nothing looks pending that never will be.
 *
 * An event type that is not listed here is REFUSED at write time
 * (worldModelRepository.outbox): an unclassified type is exactly how orphans
 * appear. Adding a consumer = move the type to `dispatch` AND handle it in
 * reflectionOutbox.js (outboxEvents.test.js checks both directions).
 */
export const OUTBOX_EVENTS = Object.freeze({
  // dispatch — consumed by reflectionOutbox.dispatchPendingClaimReflections
  'claim.created': 'dispatch',
  'claim.corroborated': 'dispatch',
  'claim.contradicted': 'dispatch',
  'claim.superseded': 'dispatch',
  'claim.stale': 'dispatch',
  'claim.contradiction.detected': 'dispatch',
  'claim.embedding.requested': 'dispatch',
  // record — the L1 delta log
  'entity.created': 'record',
  'entity.observed': 'record',
  'edge.created': 'record',
  'event.created': 'record',
  'world-model.lifecycle': 'record',
  'world-model.correction': 'record',
  'world-model.revision': 'record',
  // J3 consolidation (2026-10-04): audit of a duplicate archived into its survivor.
  'world-model.consolidation': 'record',
  // Phase 4 (2026-10-06): a recorded proactive decision, and the user's response.
  'proactive.intervention': 'record',
  'proactive.response': 'record',
  // Phase 5 (2026-10-06): the bounded-action audit trail, one row per transition.
  'action.proposed': 'record',
  'action.approved': 'record',
  'action.rejected': 'record',
  'action.running': 'record',
  'action.succeeded': 'record',
  'action.failed': 'record',
  'action.expired': 'record',
});

export const dispatchEventTypes = () => Object.keys(OUTBOX_EVENTS).filter(t => OUTBOX_EVENTS[t] === 'dispatch');
export const recordEventTypes = () => Object.keys(OUTBOX_EVENTS).filter(t => OUTBOX_EVENTS[t] === 'record');

/** Role of an event type, or throws — an unclassified type would be an orphan. */
export function outboxRole(eventType) {
  const role = OUTBOX_EVENTS[eventType];
  if (!role) throw new Error(`outbox event type "${eventType}" is not registered in outboxEvents.js — classify it (dispatch or record)`);
  return role;
}

/** Claim lifecycle → the event the reflection consumer understands. */
export function claimTransitionEvent(toState) {
  return { superseded: 'claim.superseded', disputed: 'claim.contradicted', stale: 'claim.stale' }[toState] ?? 'world-model.lifecycle';
}
