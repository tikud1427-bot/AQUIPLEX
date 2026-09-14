-- 0015 — canonical claim ↔ Mind belief support bridge
--
-- E9 / PR-2. A belief remains owned by the Mind JSON store; canonical claims
-- remain the only durable world-model atoms. This table is an EXPLANATION
-- INDEX between them, not a second belief or claim store.
--
-- A belief may be supported by many claims and a claim may support/contradict
-- many beliefs. The relationship is explicit so reflection can answer:
--   "which canonical claims caused this belief to strengthen/weaken?"
-- without copying claim content into Mind or making labels into join keys.
--
-- owner_id is part of every key and the claim FK is composite. A cross-owner
-- claim reference is therefore structurally uninsertable.
CREATE TABLE IF NOT EXISTS aqua_belief_claims (
  owner_id       text NOT NULL,
  belief_id      uuid NOT NULL,
  dimension      text NOT NULL,
  belief_key     text NOT NULL,
  claim_id       uuid NOT NULL,
  relation       text NOT NULL DEFAULT 'supporting',
  weight         real NOT NULL DEFAULT 1.0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT aqua_belief_claims_pk PRIMARY KEY (owner_id, belief_id, claim_id),
  CONSTRAINT aqua_belief_claims_claim_fk FOREIGN KEY (claim_id, owner_id)
    REFERENCES aqua_claims (claim_id, owner_id) ON DELETE CASCADE,
  CONSTRAINT aqua_belief_claims_relation_ck CHECK
    (relation IN ('supporting','contradicting')),
  CONSTRAINT aqua_belief_claims_weight_ck CHECK
    (weight >= 0 AND weight <= 1),
  CONSTRAINT aqua_belief_claims_key_ck CHECK
    (dimension <> '' AND belief_key <> '')
);

CREATE INDEX IF NOT EXISTS aqua_belief_claims_owner_belief_idx
  ON aqua_belief_claims (owner_id, belief_id, relation);
CREATE INDEX IF NOT EXISTS aqua_belief_claims_owner_key_idx
  ON aqua_belief_claims (owner_id, dimension, belief_key, relation);
CREATE INDEX IF NOT EXISTS aqua_belief_claims_owner_claim_idx
  ON aqua_belief_claims (owner_id, claim_id, relation);
