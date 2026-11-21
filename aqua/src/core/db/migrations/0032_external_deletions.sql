-- 0032 — external-source deletion tombstones (G1-1 acceptance remediation).
--
-- A document-understanding job for an external resource can be RUNNING when
-- the resource or its whole source is deleted. The deletion transaction
-- (core/worldModel/sourceDeletion.js) takes a per-(owner, source) advisory
-- lock and writes a row here; the canonical commit
-- (worldModelRepository.commitUnderstanding) takes the same lock and refuses
-- to write knowledge for a ukoId covered by a deletion that happened at or
-- after the job was enqueued. See core/worldModel/externalDeletionGuard.js.
--
--   uko_prefix   the deleted scope: `ext_<source12>_` (whole source) or
--                `ext_<source12>_<item16>_` (one resource)
--   keep_uko_id  a resource update keeps its current version; NULL otherwise
--
-- Rows hold no user content (hashed tags only) and are removed with the owner
-- (worldModelRepository.purgeOwner). Additive only.

CREATE TABLE IF NOT EXISTS aqua_external_deletions (
  deletion_id  uuid        PRIMARY KEY,
  owner_id     text        NOT NULL,
  uko_prefix   text        NOT NULL,
  keep_uko_id  text        NULL,
  deleted_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS aqua_external_deletions_owner_ix
  ON aqua_external_deletions (owner_id, deleted_at);
