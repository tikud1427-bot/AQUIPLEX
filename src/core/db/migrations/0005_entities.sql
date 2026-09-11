-- 0005 — canonical entities
--
-- Blueprint Part 3, and Constitution L8: one thing, one node, one OPAQUE id.
--
-- WHY THIS IS THE FIRST E5 MIGRATION
-- Claims reference entities. Building claims first would mean either a
-- subject column with no referent or a nullable FK that never gets enforced.
--
-- WHY OPAQUE IDS, IN ONE LINE: the self entity is currently labelled with the
-- literal word "You", which has required special-casing in FIVE separate
-- places (write pass B, the lexical haystack, PIC lanes 1 and 2, revision
-- subjects). `canonical_label` here is display-only and is never a join key,
-- never in a haystack, never in a subject list. That class of bug becomes
-- unrepresentable rather than patched a sixth time.
--
-- NOTHING READS OR WRITES THESE TABLES YET. E5/PR-2 adds claims; the write
-- path is E5/PR-3 and later. This migration is the shape, nothing more.

CREATE TABLE IF NOT EXISTS aqua_entities (
  entity_id             uuid        PRIMARY KEY,
  owner_id              text        NOT NULL,
  type                  text        NOT NULL,
  canonical_label       text        NOT NULL,   -- DISPLAY ONLY. never a key.
  normalized_label      text        NOT NULL,
  confidence_resolution real        NOT NULL DEFAULT 0.5,
  mention_count         integer     NOT NULL DEFAULT 1,
  status                text        NOT NULL DEFAULT 'active',
  merged_into           uuid        NULL REFERENCES aqua_entities(entity_id),
  first_seen_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT aqua_entities_type_ck CHECK (type IN
    ('person','org','project','product','technology','place','document','concept','event','self')),
  CONSTRAINT aqua_entities_status_ck CHECK (status IN ('active','merged','dismissed')),
  -- A merged entity must say what it merged into, and an active one must not.
  -- Without this a merge can half-apply and the graph silently forks.
  CONSTRAINT aqua_entities_merge_ck CHECK (
    (status = 'merged' AND merged_into IS NOT NULL) OR
    (status <> 'merged' AND merged_into IS NULL))
);

-- Every index leads with owner_id (L19: per-owner isolation is STRUCTURAL,
-- not conventional) so partition pruning works and a cross-owner scan is not
-- merely discouraged but slow enough to notice.
CREATE INDEX IF NOT EXISTS aqua_entities_owner_norm_idx
  ON aqua_entities (owner_id, normalized_label);
CREATE INDEX IF NOT EXISTS aqua_entities_owner_type_seen_idx
  ON aqua_entities (owner_id, type, last_seen_at DESC);
-- One self entity per owner, enforced rather than assumed. Two would
-- reintroduce the ambiguity opaque ids exist to remove.
CREATE UNIQUE INDEX IF NOT EXISTS aqua_entities_one_self_idx
  ON aqua_entities (owner_id) WHERE type = 'self' AND status = 'active';

CREATE TABLE IF NOT EXISTS aqua_entity_aliases (
  alias_id      uuid        PRIMARY KEY,
  owner_id      text        NOT NULL,
  entity_id     uuid        NOT NULL REFERENCES aqua_entities(entity_id) ON DELETE CASCADE,
  surface_form  text        NOT NULL,
  normalized    text        NOT NULL,
  source_id     text        NULL,
  is_canonical  boolean     NOT NULL DEFAULT false,
  first_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS aqua_entity_aliases_owner_norm_idx
  ON aqua_entity_aliases (owner_id, normalized);
CREATE UNIQUE INDEX IF NOT EXISTS aqua_entity_aliases_unique_idx
  ON aqua_entity_aliases (owner_id, entity_id, normalized);

-- Merges are AUDITED and REVERSIBLE (L5: nothing is deleted, things are
-- superseded). Today a merge is unrecoverable; here the loser keeps its id,
-- old claims resolve forward through merged_into, and `reverted_at` makes the
-- undo a recorded event rather than a manual repair.
CREATE TABLE IF NOT EXISTS aqua_entity_merges (
  merge_id       uuid        PRIMARY KEY,
  owner_id       text        NOT NULL,
  from_entity_id uuid        NOT NULL,
  into_entity_id uuid        NOT NULL,
  reason         text        NOT NULL,
  confidence     real        NOT NULL,
  actor          text        NOT NULL,          -- L9: every write has an actor
  created_at     timestamptz NOT NULL DEFAULT now(),
  reverted_at    timestamptz NULL
);

CREATE INDEX IF NOT EXISTS aqua_entity_merges_owner_idx
  ON aqua_entity_merges (owner_id, created_at DESC);
