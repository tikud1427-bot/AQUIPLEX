-- 0013 — E7 owner-hash partitioning + per-partition HNSW
--
-- Dense retrieval is an index over canonical claims. Partitioning is by owner
-- so every ANN search is structurally confined to one owner's partition (L19).
-- A single global HNSW index is deliberately forbidden: pgvector's ANN
-- operator class cannot make owner_id the leading part of the search key.
--
-- This migration replaces the unpartitioned 0012 table in-place. No canonical
-- claim data is changed; the derived embedding index can always be rebuilt.

CREATE EXTENSION IF NOT EXISTS vector;

DO $$
DECLARE
  i integer;
  part_name text;
BEGIN
  -- If 0012 has already been applied, move its rows into a partitioned table.
  IF to_regclass('public.aqua_embeddings') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_partitioned_table pt
       JOIN pg_class c ON c.oid = pt.partrelid
       WHERE c.relname = 'aqua_embeddings'
     ) THEN

    ALTER TABLE aqua_embeddings RENAME TO aqua_embeddings_unpartitioned_0012;

    CREATE TABLE aqua_embeddings (
      embedding_id    uuid NOT NULL,
      owner_id        text NOT NULL,
      target_kind     text NOT NULL,
      target_id       uuid NOT NULL,
      model_signature text NOT NULL,
      vector          vector(768) NOT NULL,
      content_hash    text NOT NULL,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT aqua_embeddings_partitioned_kind_ck
  CHECK (target_kind IN ('claim')),
CONSTRAINT aqua_embeddings_partitioned_pk
  PRIMARY KEY (embedding_id, owner_id),
CONSTRAINT aqua_embeddings_partitioned_target_uq
  UNIQUE (owner_id, target_kind, target_id, model_signature),
CONSTRAINT aqua_embeddings_partitioned_claim_owner_fk
  FOREIGN KEY (target_id, owner_id)
  REFERENCES aqua_claims (claim_id, owner_id) ON DELETE CASCADE
    ) PARTITION BY HASH (owner_id);

    FOR i IN 0..63 LOOP
      part_name := format('aqua_embeddings_p%02s', i);
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF aqua_embeddings
         FOR VALUES WITH (MODULUS 64, REMAINDER %s)',
        part_name, i
      );
      EXECUTE format(
        'CREATE INDEX %I ON %I USING hnsw (vector vector_cosine_ops)
         WITH (m = 16, ef_construction = 64)',
        part_name || '_hnsw', part_name
      );
      EXECUTE format(
        'CREATE INDEX %I ON %I (owner_id, model_signature, updated_at DESC)',
        part_name || '_owner_model_idx', part_name
      );
      EXECUTE format(
        'CREATE INDEX %I ON %I (owner_id, target_kind, target_id)',
        part_name || '_owner_target_idx', part_name
      );
    END LOOP;

    INSERT INTO aqua_embeddings
      (embedding_id, owner_id, target_kind, target_id, model_signature,
       vector, content_hash, created_at, updated_at)
    SELECT embedding_id, owner_id, target_kind, target_id, model_signature,
           vector, content_hash, created_at, updated_at
      FROM aqua_embeddings_unpartitioned_0012;

    DROP TABLE aqua_embeddings_unpartitioned_0012;
  END IF;
END $$;
