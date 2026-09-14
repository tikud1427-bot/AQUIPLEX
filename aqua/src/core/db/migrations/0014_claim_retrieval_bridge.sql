-- 0014 — canonical claim ↔ legacy retrieval identity bridge
--
-- This table is an IDENTITY INDEX, not a second knowledge store. The canonical
-- claim remains the only truth; retrieval_key is the legacy evidence-store
-- fact id needed to resolve a retrieval candidate back to the UI/context lane.
-- L8: one canonical claim, one explicit bridge. L19: owner is part of every key.
CREATE TABLE IF NOT EXISTS aqua_claim_retrieval_bridge (
  owner_id       text NOT NULL,
  claim_id       uuid NOT NULL,
  retrieval_key  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aqua_claim_retrieval_bridge_pk PRIMARY KEY (owner_id, claim_id),
  CONSTRAINT aqua_claim_retrieval_bridge_claim_fk
    FOREIGN KEY (claim_id, owner_id)
    REFERENCES aqua_claims (claim_id, owner_id) ON DELETE CASCADE,
  CONSTRAINT aqua_claim_retrieval_bridge_key_uq
    UNIQUE (owner_id, retrieval_key)
);
CREATE INDEX IF NOT EXISTS aqua_claim_retrieval_bridge_owner_key_idx
  ON aqua_claim_retrieval_bridge (owner_id, retrieval_key);
CREATE INDEX IF NOT EXISTS aqua_claim_retrieval_bridge_owner_claim_idx
  ON aqua_claim_retrieval_bridge (owner_id, claim_id);
