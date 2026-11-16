-- 0027 — per-owner change counter (scalability Phase 2c).
--
-- Phase 2b loaded an owner per request with a versions query over every one of
-- the owner's partition rows: 19.6 ms p50 at 2,052 rows, growing with the
-- owner's data. This table holds ONE counter per owner, bumped by the database
-- itself on every insert, update or delete of that owner's rows — so every
-- writer (any instance, any tool, a migration) moves it, with no application
-- code able to forget to. A request whose counter has not moved since it last
-- loaded the owner skips the versions query: one primary-key lookup.
--
-- Global partitions (owner_id = '') never bump: that row would be the
-- contention point the instance aggregates exist to avoid.
--
-- Additive. Rollback = DROP TRIGGER; the application falls back to the full
-- versions query whenever the counter is absent.

CREATE TABLE IF NOT EXISTS aqua_owner_versions (
  owner_id    text        PRIMARY KEY,
  version     bigint      NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION aqua_bump_owner_version() RETURNS trigger AS $$
DECLARE
  o text;
BEGIN
  o := CASE WHEN TG_OP = 'DELETE' THEN OLD.owner_id ELSE NEW.owner_id END;
  IF o <> '' THEN
    INSERT INTO aqua_owner_versions AS v (owner_id, version, updated_at)
    VALUES (o, 1, now())
    ON CONFLICT (owner_id) DO UPDATE SET version = v.version + 1, updated_at = now();
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS aqua_store_partitions_owner_version ON aqua_store_partitions;
CREATE TRIGGER aqua_store_partitions_owner_version
  AFTER INSERT OR UPDATE OR DELETE ON aqua_store_partitions
  FOR EACH ROW EXECUTE FUNCTION aqua_bump_owner_version();
