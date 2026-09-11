-- 0010 — durable E6 segment commit ledger
--
-- The S9 idempotency key is (source_id, segment_range, extractor_version).
-- An in-memory Set is useful for a pure commit plan, but it cannot protect a
-- production process across restarts or two workers. This table makes the
-- key durable and owner-scoped.
CREATE TABLE IF NOT EXISTS aqua_understanding_commit_ledger (
  commit_id         uuid PRIMARY KEY,
  owner_id          text NOT NULL,
  source_id         uuid NOT NULL REFERENCES aqua_sources(source_id),
  segment_start     integer NOT NULL,
  segment_end       integer NOT NULL,
  extractor_version text NOT NULL,
  status            text NOT NULL DEFAULT 'committed',
  committed_at      timestamptz NOT NULL DEFAULT now(),
  actor             text NOT NULL,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT aqua_understanding_commit_ledger_range_ck CHECK (segment_end >= segment_start),
  CONSTRAINT aqua_understanding_commit_ledger_status_ck CHECK (status IN ('committed')),
  CONSTRAINT aqua_understanding_commit_ledger_key_uq
    UNIQUE (owner_id, source_id, segment_start, segment_end, extractor_version)
);

CREATE INDEX IF NOT EXISTS aqua_understanding_commit_ledger_owner_idx
  ON aqua_understanding_commit_ledger (owner_id, committed_at DESC);
CREATE INDEX IF NOT EXISTS aqua_understanding_commit_ledger_source_idx
  ON aqua_understanding_commit_ledger (owner_id, source_id, segment_start, segment_end);
