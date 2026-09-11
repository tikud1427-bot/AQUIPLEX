-- 0009 — canonical identity bridge + structural owner isolation
--
-- E6/S6 produces stable AQUA identity keys (aq:<kind>:<slug>). The Postgres
-- world model uses opaque UUID primary keys for physical storage. identity_key
-- is the bridge: one stable identity per owner, while entity_id remains an
-- opaque database identifier for joins.
ALTER TABLE aqua_entities ADD COLUMN IF NOT EXISTS identity_key text;
CREATE UNIQUE INDEX IF NOT EXISTS aqua_entities_owner_identity_idx
  ON aqua_entities(owner_id, identity_key)
  WHERE identity_key IS NOT NULL;

-- Composite references need a matching owner+id uniqueness guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS aqua_claims_owner_claim_idx
  ON aqua_claims(owner_id, claim_id);

-- Cross-owner references must be impossible for the entity/claim substrate.
-- The constraints are NOT VALID so an existing deployment with historical
-- rows can be inspected/backfilled before validation; they still protect all
-- new writes immediately.
ALTER TABLE aqua_claims ADD CONSTRAINT aqua_claims_object_owner_fk
  FOREIGN KEY (owner_id, object_entity_id)
  REFERENCES aqua_entities(owner_id, entity_id)
  NOT VALID;

ALTER TABLE aqua_edges ADD CONSTRAINT aqua_edges_from_owner_fk
  FOREIGN KEY (owner_id, from_entity_id)
  REFERENCES aqua_entities(owner_id, entity_id)
  NOT VALID;
ALTER TABLE aqua_edges ADD CONSTRAINT aqua_edges_to_owner_fk
  FOREIGN KEY (owner_id, to_entity_id)
  REFERENCES aqua_entities(owner_id, entity_id)
  NOT VALID;
ALTER TABLE aqua_edges ADD CONSTRAINT aqua_edges_claim_owner_fk
  FOREIGN KEY (owner_id, claim_id)
  REFERENCES aqua_claims(owner_id, claim_id)
  NOT VALID;

ALTER TABLE aqua_events ADD CONSTRAINT aqua_events_subject_owner_fk
  FOREIGN KEY (owner_id, subject_entity_id)
  REFERENCES aqua_entities(owner_id, entity_id)
  NOT VALID;
ALTER TABLE aqua_events ADD CONSTRAINT aqua_events_claim_owner_fk
  FOREIGN KEY (owner_id, claim_id)
  REFERENCES aqua_claims(owner_id, claim_id)
  NOT VALID;

ALTER TABLE aqua_lifecycle_transitions ADD CONSTRAINT aqua_lifecycle_claim_owner_fk
  FOREIGN KEY (owner_id, claim_id)
  REFERENCES aqua_claims(owner_id, claim_id)
  NOT VALID;
ALTER TABLE aqua_lifecycle_transitions ADD CONSTRAINT aqua_lifecycle_entity_owner_fk
  FOREIGN KEY (owner_id, entity_id)
  REFERENCES aqua_entities(owner_id, entity_id)
  NOT VALID;
