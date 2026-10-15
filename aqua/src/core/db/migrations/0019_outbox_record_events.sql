-- 0019 — record-only outbox events are not pending work
--
-- entity.created, entity.observed, edge.created, event.created and the
-- world-model.* types are the L1 delta log: nothing consumes them (their rows
-- are materialised in the same transaction), yet they were written `pending`
-- and stayed pending forever, looking like unfinished processing. From this
-- release the writer marks them published at insert (core/worldModel/
-- outboxEvents.js). This settles rows written before it. Nothing is deleted;
-- the rows remain the delta log.
UPDATE aqua_outbox
   SET state = 'published',
       published_at = COALESCE(published_at, created_at),
       last_error = COALESCE(last_error, 'record-only event: no consumer by design (0019)')
 WHERE state = 'pending'
   AND event_type IN ('entity.created', 'entity.observed', 'edge.created', 'event.created',
                      'world-model.lifecycle', 'world-model.correction', 'world-model.revision');
