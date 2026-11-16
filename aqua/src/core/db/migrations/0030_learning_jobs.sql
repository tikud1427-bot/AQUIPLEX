-- 0030 — durable post-turn learning (scalability Phase 3).
--
-- Every post-turn learning stage moves from the API process into worker jobs
-- (AQUA_POST_TURN_DURABLE). What the queue needed for that:
--
--   conversation_id,
--   source_ref        which conversation and which message keys the job
--                     learns from — REFERENCES, never a copy of the text: the
--                     worker reads the message from the conversation store, so
--                     a deleted conversation or a redaction is honoured by
--                     construction, and job rows hold no user content.
--   depends_on        idempotency keys this job must wait for (same owner):
--                     reflection runs only after the turn's ingest. A job is
--                     not claimable while a dependency is queued or running.
--   heartbeat_at      lease renewal for long jobs. A worker renews it while a
--                     job runs; recovery reclaims only jobs whose heartbeat is
--                     stale, so a slow job is never handed to a second worker.
--   started_at,
--   finished_at       timestamps for queue-wait and processing-time metrics.
--
-- aqua_deleted_owners: an account deletion is recorded HERE FIRST, before any
-- store is purged. Every per-owner persistence path and the worker check it,
-- so a job that was already running when the account was deleted cannot write
-- the user's data back.
--
-- Additive only.

ALTER TABLE aqua_jobs ADD COLUMN IF NOT EXISTS conversation_id text;
ALTER TABLE aqua_jobs ADD COLUMN IF NOT EXISTS source_ref     jsonb;
ALTER TABLE aqua_jobs ADD COLUMN IF NOT EXISTS depends_on     text[];
ALTER TABLE aqua_jobs ADD COLUMN IF NOT EXISTS heartbeat_at   timestamptz;
ALTER TABLE aqua_jobs ADD COLUMN IF NOT EXISTS started_at     timestamptz;
ALTER TABLE aqua_jobs ADD COLUMN IF NOT EXISTS finished_at    timestamptz;

-- Recovery scans running jobs by heartbeat.
CREATE INDEX IF NOT EXISTS aqua_jobs_running_heartbeat_ix
  ON aqua_jobs (heartbeat_at)
  WHERE state = 'running';

CREATE TABLE IF NOT EXISTS aqua_deleted_owners (
  owner_id    text        PRIMARY KEY,
  deleted_at  timestamptz NOT NULL DEFAULT now(),
  reason      text        NOT NULL DEFAULT 'account-deletion'
);
