-- 0020 — per-process metric snapshots (E12, 2026-10-04)
--
-- The HTTP server and the cognition worker(s) are separate processes; each
-- keeps its counters in memory, so the server's /metrics never saw what the
-- worker did (extraction tokens, job spans, reported errors). Each worker now
-- upserts a snapshot of its counters here on an interval; /metrics reads every
-- row fresher than a cutoff and labels it by process. Works for any number of
-- workers, survives restarts (a dead process ages out), and doubles as a
-- worker heartbeat.
--
-- OPERATIONAL, NOT OWNER DATA: counters only — no owner ids, no content (the
-- snapshot is built from the allowlisted telemetry/cost aggregates). Like
-- aqua_schema_info and aqua_drift_runs it is not owner-scoped and is not part
-- of account purge, because nothing in it belongs to an owner.
CREATE TABLE IF NOT EXISTS aqua_process_metrics (
  process_id   text        PRIMARY KEY,      -- pid@host
  role         text        NOT NULL,         -- worker | server
  started_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  snapshot     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT aqua_process_metrics_role_ck CHECK (role IN ('worker', 'server'))
);

CREATE INDEX IF NOT EXISTS aqua_process_metrics_fresh_idx
  ON aqua_process_metrics (role, updated_at DESC);
