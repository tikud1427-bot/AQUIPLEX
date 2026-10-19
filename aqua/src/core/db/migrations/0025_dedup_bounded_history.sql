-- 0025 — bounded S8 history (2026-10-18).
--
-- S8 (brain/understanding/claimDedup.js) loaded EVERY non-archived claim of the
-- incoming predicates on every segment: linear in history, 0.54 s per segment
-- with 20,000 claims in one (subject, predicate) bucket. The bounded history
-- (worldModelRepository.findClaimsForDedup, AQUA_S8_HISTORY=bounded) reads only
-- the newest N current claims per (entity, predicate) bucket plus exact-identity
-- matches. These indexes make both reads proportional to N, not to the bucket.
--
-- Additive only: no table, column or constraint changes. Rollback = DROP INDEX
-- (and AQUA_S8_HISTORY=full). Plain CREATE INDEX (the migrator runs each file in
-- a transaction): takes a brief write lock on aqua_claims while it builds.

-- Newest current claims of a SUBJECT, per predicate (rules keyed on the subject).
CREATE INDEX IF NOT EXISTS aqua_claims_subject_recent_idx
  ON aqua_claims (owner_id, subject_entity_id, predicate, asserted_at DESC, claim_id)
  WHERE state NOT IN ('superseded', 'archived');

-- Newest current claims naming an entity as OBJECT, per predicate (one-per-object
-- relations; blocker relations that name the resolved thing).
CREATE INDEX IF NOT EXISTS aqua_claims_object_recent_idx
  ON aqua_claims (owner_id, object_entity_id, predicate, asserted_at DESC, claim_id)
  WHERE object_entity_id IS NOT NULL AND state NOT IN ('superseded', 'archived');

-- Exact identity of a literal value, any non-archived state (corroboration and
-- "return to an old value" need superseded claims too).
CREATE INDEX IF NOT EXISTS aqua_claims_exact_literal_idx
  ON aqua_claims (owner_id, subject_entity_id, predicate, lower(btrim(object_literal)))
  WHERE state <> 'archived';
