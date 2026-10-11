-- 0018 — E10 migration audit + checkpoints
--
-- Store unification moves owners from the legacy evidence store into canonical
-- claims. Every run is recorded PER OWNER, so a run can be audited, resumed
-- from its checkpoint, re-run safely (idempotent), and rolled back (claims the
-- run wrote are archived, never deleted — L5). Owner-scoped like every other
-- table (L19) and purged with the account (G4).
CREATE TABLE IF NOT EXISTS aqua_migration_runs (
  run_id       text        NOT NULL,
  owner_id     text        NOT NULL,
  migration    text        NOT NULL,                 -- 'e10-legacy-facts'
  mode         text        NOT NULL,                 -- dry-run | apply | rollback
  status       text        NOT NULL,                 -- running | done | failed | rolled_back
  actor        text        NOT NULL,                 -- L9: who ran it
  before_report jsonb      NOT NULL DEFAULT '{}'::jsonb,
  after_report  jsonb      NOT NULL DEFAULT '{}'::jsonb,
  result       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  error        text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  PRIMARY KEY (owner_id, run_id, migration),
  CONSTRAINT aqua_migration_runs_mode_ck CHECK (mode IN ('dry-run', 'apply', 'rollback')),
  CONSTRAINT aqua_migration_runs_status_ck CHECK (status IN ('running', 'done', 'failed', 'rolled_back'))
);

CREATE INDEX IF NOT EXISTS aqua_migration_runs_run_idx
  ON aqua_migration_runs (run_id, migration, status);
