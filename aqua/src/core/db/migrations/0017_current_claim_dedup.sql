-- 0017 — the exact-duplicate guard applies to CURRENT claims only
--
-- 0006 made (owner, subject, predicate, statement_norm) unique across EVERY
-- state. Once claims could be superseded by a changed value (registry-declared
-- cardinality, 2026-10-04), that index made a RETURN to an old value
-- impossible to record: "I live in Berlin" → "I moved to Paris" → "I live in
-- Berlin" collided with the superseded Berlin row and the commit failed.
--
-- Two identical CURRENT claims are still one claim with two pieces of evidence
-- (the guard's original purpose, unchanged). A superseded or archived row is
-- history: it stays exactly as it was (L5) and no longer blocks the present
-- from saying the same words again.
DROP INDEX IF EXISTS aqua_claims_dedup_idx;

CREATE UNIQUE INDEX IF NOT EXISTS aqua_claims_dedup_current_idx
  ON aqua_claims (owner_id, subject_entity_id, predicate, statement_norm)
  WHERE state NOT IN ('superseded', 'archived');

-- The same columns stay indexed for every state: the statement lookups in the
-- writers and the inferred-pattern path still need them, history included.
CREATE INDEX IF NOT EXISTS aqua_claims_statement_lookup_idx
  ON aqua_claims (owner_id, subject_entity_id, predicate, statement_norm);
