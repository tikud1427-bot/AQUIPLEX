-- 0026 — owner-partitioned store rows (scalability Phase 2a, 2026-11-13).
--
-- aqua_store_blobs (0002) holds ONE ROW PER STORE FILE: every owner in one
-- value, rewritten whole when any owner changes. Measured at 5,000 owners: 6 MB
-- and 858 ms per write (E3_SCALING_FINDING.md). This table holds one row per
-- (store, partition). A partition is one top-level entry of a store: an owner's
-- mind, one conversation, one workspace, one vector namespace. One owner's
-- update writes that owner's rows and nothing else.
--
-- WHY EACH COLUMN EXISTS
--   store_key      the store file's basename (.aqua-mind.json). Same key as
--                  aqua_store_blobs, so the two can be reconciled row against blob.
--   partition_key  "<section>:<key>" (o:user:42, owners:user:42, cache:<hash>),
--                  or "~rest" for whatever of the file is not a partitioned map
--                  (envelope metadata, global aggregates). Defined in
--                  src/core/storage/partitionLayout.js.
--   owner_id       whose data this is. '' means not owner data (a global section).
--                  Every owner-scoped read and every purge filters on it. A write
--                  may never move a row to a different owner (enforced in SQL by
--                  the partitioned store's UPDATE predicate).
--   ordinal        the partition's position in the source file at migration
--                  time, so reassembly reproduces the original key order. NULL
--                  for partitions created afterwards (sorted last, by key).
--   data           the partition's JSON text, byte-exact. NULL iff tombstoned.
--                  text rather than jsonb: jsonb reorders keys and drops
--                  duplicates, and the rollback path must reproduce the source.
--   version        optimistic concurrency. Every write states the version it
--                  read; an UPDATE that finds another version changes nothing
--                  and the writer is told (PartitionConflictError).
--   deleted_at     tombstone. A deleted partition keeps its row (data NULL) and
--                  its version keeps counting, so a writer holding a version from
--                  before the deletion fails its CAS instead of resurrecting the
--                  data, and a writer that never read the row fails the insert.
--                  Re-creating deleted data must state the tombstone's version.
--   updated_by     the instance that wrote last (diagnostics only, never trusted).
--
-- Additive only. Nothing reads or writes this table until a store is cut over
-- (Phase 2b, behind a per-store flag). Rollback = stop using it; DROP is optional.

CREATE TABLE IF NOT EXISTS aqua_store_partitions (
  store_key      text        NOT NULL,
  partition_key  text        NOT NULL,
  owner_id       text        NOT NULL,
  ordinal        bigint,
  data           text,
  bytes          integer     NOT NULL DEFAULT 0,
  checksum       text,
  version        bigint      NOT NULL,
  deleted_at     timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     text,
  PRIMARY KEY (store_key, partition_key),
  CONSTRAINT aqua_store_partitions_tombstone_ck
    CHECK ((deleted_at IS NULL) = (data IS NOT NULL)),
  CONSTRAINT aqua_store_partitions_version_ck
    CHECK (version >= 1)
);

-- An owner's rows across every store, in one index range: the unit-of-work load
-- (loadOwner), the version refresh (ownerVersions) and the account purge.
CREATE INDEX IF NOT EXISTS aqua_store_partitions_owner_idx
  ON aqua_store_partitions (owner_id, store_key);

-- What changed recently, per store: reconciliation and cross-instance polling.
CREATE INDEX IF NOT EXISTS aqua_store_partitions_changed_idx
  ON aqua_store_partitions (store_key, updated_at DESC);

-- One row per migration or reconcile run. The evidence that a cutover was
-- checked, and against which source bytes.
CREATE TABLE IF NOT EXISTS aqua_store_partition_runs (
  run_id           bigserial   PRIMARY KEY,
  store_key        text        NOT NULL,
  kind             text        NOT NULL,   -- 'migrate' | 'reconcile' | 'export'
  mode             text        NOT NULL,   -- 'dry-run' | 'apply'
  source           text        NOT NULL,   -- 'json-file' | 'pg-blob' | 'partitions'
  source_checksum  text,
  source_bytes     integer,
  partitions       integer     NOT NULL DEFAULT 0,
  inserted         integer     NOT NULL DEFAULT 0,
  identical        integer     NOT NULL DEFAULT 0,
  conflicting      integer     NOT NULL DEFAULT 0,
  clean            boolean,
  report           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  CONSTRAINT aqua_store_partition_runs_kind_ck CHECK (kind IN ('migrate', 'reconcile', 'export')),
  CONSTRAINT aqua_store_partition_runs_mode_ck CHECK (mode IN ('dry-run', 'apply'))
);

CREATE INDEX IF NOT EXISTS aqua_store_partition_runs_store_idx
  ON aqua_store_partition_runs (store_key, started_at DESC);
