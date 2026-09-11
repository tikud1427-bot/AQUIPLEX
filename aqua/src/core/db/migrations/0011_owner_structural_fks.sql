-- 0011 — structural owner isolation for the complete canonical World Model
--
-- E5/L19: owner isolation must be structural, not merely a convention in
-- repository code. 0008 made the new graph tables owner-safe, but the
-- pre-existing source/claim/evidence tables still had single-column FKs.
-- That left a cross-owner reference representable at the database layer.
--
-- The composite keys below are additive. Existing primary keys remain intact;
-- the new UNIQUE constraints provide the referenced (id, owner_id) key needed
-- by composite foreign keys.

ALTER TABLE aqua_sources
  ADD CONSTRAINT aqua_sources_id_owner_uq UNIQUE (source_id, owner_id);

ALTER TABLE aqua_evidence
  ADD CONSTRAINT aqua_evidence_id_owner_uq UNIQUE (evidence_id, owner_id);

-- Claims may only point at entities owned by the same owner.
ALTER TABLE aqua_claims
  ADD CONSTRAINT aqua_claims_subject_owner_fk
    FOREIGN KEY (subject_entity_id, owner_id)
    REFERENCES aqua_entities (entity_id, owner_id);

ALTER TABLE aqua_claims
  ADD CONSTRAINT aqua_claims_object_owner_fk
    FOREIGN KEY (object_entity_id, owner_id)
    REFERENCES aqua_entities (entity_id, owner_id);

ALTER TABLE aqua_claims
  ADD CONSTRAINT aqua_claims_superseded_owner_fk
    FOREIGN KEY (superseded_by, owner_id)
    REFERENCES aqua_claims (claim_id, owner_id);

-- Evidence may only cite a source owned by the same owner.
ALTER TABLE aqua_evidence
  ADD CONSTRAINT aqua_evidence_source_owner_fk
    FOREIGN KEY (source_id, owner_id)
    REFERENCES aqua_sources (source_id, owner_id);

-- Claim/evidence links must be same-owner on BOTH sides.
ALTER TABLE aqua_claim_evidence
  ADD CONSTRAINT aqua_claim_evidence_claim_owner_fk
    FOREIGN KEY (claim_id, owner_id)
    REFERENCES aqua_claims (claim_id, owner_id);

ALTER TABLE aqua_claim_evidence
  ADD CONSTRAINT aqua_claim_evidence_evidence_owner_fk
    FOREIGN KEY (evidence_id, owner_id)
    REFERENCES aqua_evidence (evidence_id, owner_id);

-- Entity aliases are also canonical owner-scoped data, so an alias cannot
-- point across an owner boundary.
ALTER TABLE aqua_entity_aliases
  ADD CONSTRAINT aqua_entity_aliases_entity_owner_fk
    FOREIGN KEY (entity_id, owner_id)
    REFERENCES aqua_entities (entity_id, owner_id);

-- The durable E6/S9 ledger is owner-scoped too. A ledger row must not be able
-- to name another owner's source.
ALTER TABLE aqua_understanding_commit_ledger
  ADD CONSTRAINT aqua_understanding_ledger_source_owner_fk
    FOREIGN KEY (source_id, owner_id)
    REFERENCES aqua_sources (source_id, owner_id);
