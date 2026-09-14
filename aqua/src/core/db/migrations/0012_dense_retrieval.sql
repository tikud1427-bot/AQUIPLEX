-- 0012 — E7 dense + lexical retrieval substrate
--
-- The canonical claim identity remains aqua_claims. This table is an index over
-- claims, not a second knowledge store: deleting/rebuilding it must never
-- change the world model. model_signature is mandatory so same-dimension model
-- swaps cannot silently corrupt retrieval.
--
-- Requires the production Postgres image/service to provide pgvector and the
-- btree_gin extension. This migration intentionally fails loudly when the
-- substrate is unavailable; silently falling back at migration time would
-- make the deployment report a dense lane that cannot exist.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS btree_gin;

CREATE TABLE IF NOT EXISTS aqua_embeddings (
  embedding_id   uuid PRIMARY KEY,
  owner_id       text NOT NULL,
  target_kind    text NOT NULL,
  target_id      uuid NOT NULL,
  model_signature text NOT NULL,
  vector         vector(768) NOT NULL,
  content_hash   text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT aqua_embeddings_kind_ck CHECK (target_kind IN ('claim')),
  CONSTRAINT aqua_embeddings_id_owner_uq UNIQUE (embedding_id, owner_id),
  CONSTRAINT aqua_embeddings_target_uq UNIQUE (owner_id, target_kind, target_id, model_signature),
  CONSTRAINT aqua_embeddings_claim_owner_fk FOREIGN KEY (target_id, owner_id)
    REFERENCES aqua_claims (claim_id, owner_id) ON DELETE CASCADE
);

-- Owner is first in every lookup index (L19). The ANN index is intentionally
-- deferred until owner-hash partitioning is introduced: pgvector HNSW accepts
-- vector operator classes, not a composite (owner_id, vector) key. Creating a
-- global HNSW index here would violate structural owner isolation. E7 PR-3
-- therefore has a real prerequisite rather than quietly weakening L19.
CREATE INDEX IF NOT EXISTS aqua_embeddings_owner_target_idx
  ON aqua_embeddings (owner_id, target_kind, target_id);
CREATE INDEX IF NOT EXISTS aqua_embeddings_owner_model_idx
  ON aqua_embeddings (owner_id, model_signature, updated_at DESC);
-- E7/PR-3: HNSW is added by the owner-partition migration once the table is
-- hash-partitioned. Until then dense reads use bounded exact cosine ordering.

-- E7 PR-2 lexical lane over the canonical claim text. btree_gin lets owner_id
-- participate in the same GIN index instead of creating a second unscoped text
-- index that could accidentally become a cross-owner retrieval path.
CREATE INDEX IF NOT EXISTS aqua_claims_lexical_idx
  ON aqua_claims USING gin (
    owner_id,
    to_tsvector('simple', coalesce(statement_text, ''))
  )
  WHERE state IN ('active','trusted');
