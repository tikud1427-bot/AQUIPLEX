-- 0002 — the store blob table
--
-- One row per STORE FILE, not per owner.
--
-- The blueprint's E3/PR-4 line says "one row per owner/store". It cannot be
-- that yet, and the reason is worth recording rather than quietly diverging:
-- E3/PR-3 keyed the storage seam by PATH so that all 19 consumers were left
-- untouched, and a store path carries no owner — every owner already lives in
-- one file. Splitting by owner means changing what the stores THEMSELVES hold,
-- which is E5's claim schema, not a substrate swap.
--
-- So this table reproduces today's shape faithfully: whole-store blobs, one
-- row each. That is deliberately NOT an improvement — the point of E3 is to
-- move the substrate without changing the data, and a per-owner split here
-- would be the second risky thing the epic's ordering forbids.

CREATE TABLE IF NOT EXISTS aqua_store_blobs (
  store_key   text        PRIMARY KEY,   -- basename of the store file, e.g. .aqua-evidence.json
  data        text        NOT NULL,      -- the serialised store, exactly as the file holds it
  bytes       integer     NOT NULL,
  checksum    text        NOT NULL,      -- lets the PR-6 drift job compare without re-reading both
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS aqua_store_blobs_updated_at_idx
  ON aqua_store_blobs (updated_at DESC);
