-- 0015 — belief ↔ canonical claim relationship index
--
-- E9 / PR-2. This table is provenance only: it is NOT a second knowledge store.
-- Mind remains the belief store; aqua_claims remains the canonical claim store.
-- The relationship is owner-scoped structurally.

ALTER TABLE aqua_claims
  ADD CONSTRAINT aqua_claims_owner_claim_uq UNIQUE (owner_id, claim_id);

CREATE TABLE IF NOT EXISTS aqua_belief_claims (
  owner_id       text        NOT NULL,
  belief_id      text        NOT NULL,
  dimension      text        NOT NULL,
  belief_key     text        NOT NULL,
  claim_id       uuid        NOT NULL,
  relation       text        NOT NULL DEFAULT 'supporting',
  weight         real        NOT NULL DEFAULT 1.0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (owner_id, belief_id, claim_id),
  FOREIGN KEY (owner_id, claim_id)
    REFERENCES aqua_claims(owner_id, claim_id)
    ON DELETE CASCADE,

  CONSTRAINT aqua_belief_claims_relation_ck
    CHECK (relation IN ('supporting','contradicting')),
  CONSTRAINT aqua_belief_claims_weight_ck
    CHECK (weight >= 0 AND weight <= 1)
);

CREATE INDEX IF NOT EXISTS aqua_belief_claims_owner_belief_idx
  ON aqua_belief_claims (owner_id, belief_id);

CREATE INDEX IF NOT EXISTS aqua_belief_claims_owner_claim_idx
  ON aqua_belief_claims (owner_id, claim_id);
