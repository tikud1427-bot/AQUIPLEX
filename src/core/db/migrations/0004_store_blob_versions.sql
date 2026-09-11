-- 0004 — optimistic concurrency for store blobs
--
-- E3's exit criterion is "two instances concurrent with zero data loss". As of
-- 0002 that is FALSE: two adapters each hold their own cache, and the second
-- INSERT ... ON CONFLICT DO UPDATE overwrites the first wholesale. Measured —
-- instance A writes, instance B writes, A's data is gone and both caches still
-- believe their own version.
--
-- That is the same last-writer-wins loss the Mongo mirror already warns about,
-- reproduced on the new substrate. Moving to Postgres without this would move
-- the bug, not fix it.
--
-- `version` is the guard: a write states the version it READ, and the UPDATE
-- only applies if the row still carries it. A stale write affects zero rows
-- and the caller is told, rather than silently winning.
--
-- Why not a lock: a per-store advisory lock would serialise every write to a
-- store across all instances, turning a 500ms debounce into a queue. Optimistic
-- versioning costs nothing when there is no conflict, which is the normal case.

ALTER TABLE aqua_store_blobs
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
