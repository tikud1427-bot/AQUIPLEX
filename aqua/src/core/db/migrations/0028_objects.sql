-- 0028 — immutable binary objects (scalability Phase 2c).
--
-- Artifact files were written to the local disk of whichever instance created
-- them, and never mirrored: another instance could not serve them, and a Render
-- redeploy lost them (audit S3). With AQUA_STORE_PARTITIONS=artifacts:on they
-- go through core/storage/objectStore.js. This table is that store's Postgres
-- backend: shared by every instance and testable today. The production target
-- is Google Cloud Storage (Phase 4); the object-store seam does not change.
--
-- Objects are WRITE-ONCE: a key is never overwritten (a new artifact version
-- is a new key), so concurrent writers cannot conflict. Deletion is by owner +
-- key prefix (artifact deletion, account purge).

CREATE TABLE IF NOT EXISTS aqua_objects (
  object_key  text        PRIMARY KEY,
  owner_id    text        NOT NULL,
  sha256      text        NOT NULL,
  size        integer     NOT NULL,
  data        bytea       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS aqua_objects_owner_idx ON aqua_objects (owner_id, object_key);
