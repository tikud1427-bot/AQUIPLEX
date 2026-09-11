-- 0003 — drift run history
--
-- E3's read paths do not flip until drift has been zero for a week. That claim
-- needs evidence, and evidence needs a record: a log line scrolls away, and
-- "I think it's been fine" is not a migration criterion.
--
-- One row per drift check. Deliberately small — counts and a verdict, not the
-- diff itself. A drift job that stored what differed would be storing a second
-- copy of the data it is checking.

CREATE TABLE IF NOT EXISTS aqua_drift_runs (
  id            bigserial   PRIMARY KEY,
  ran_at        timestamptz NOT NULL DEFAULT now(),
  stores        integer     NOT NULL,   -- how many store files were compared
  matched       integer     NOT NULL,
  mismatched    integer     NOT NULL,   -- present both sides, different checksum
  missing_shadow integer    NOT NULL,   -- in JSON, absent from Postgres
  missing_primary integer   NOT NULL,   -- in Postgres, absent from JSON
  clean         boolean     NOT NULL,
  duration_ms   integer     NOT NULL
);

CREATE INDEX IF NOT EXISTS aqua_drift_runs_ran_at_idx
  ON aqua_drift_runs (ran_at DESC);
