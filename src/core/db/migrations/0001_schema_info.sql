-- 0001 — schema provenance
--
-- The first migration exists so the runner has something real to apply and so
-- a fresh database can say where its schema came from. It creates no product
-- table: E3/PR-4 adds the blob store, and the claim tables belong to E5.
--
-- Deliberately NOT here: `CREATE EXTENSION vector`. The dev compose uses a
-- pgvector image so the extension is available, but creating it needs
-- privileges a managed provider may not grant to the app role. It belongs in
-- the migration that first needs a vector column, where a failure is
-- self-explanatory.

CREATE TABLE IF NOT EXISTS aqua_schema_info (
  key         text PRIMARY KEY,
  value       text        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO aqua_schema_info (key, value)
VALUES ('initialised_by', 'E3/PR-2 migration runner')
ON CONFLICT (key) DO NOTHING;
