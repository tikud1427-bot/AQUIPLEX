-- E4/PR-3 — durable job queue
--
-- The in-memory registry (E4/PR-1, PR-4) tracks work and drains it on SIGTERM,
-- and everything it holds still dies with the process. A deploy that overruns
-- its grace period, an OOM kill, a crashed node: the work is gone and nothing
-- can say what was lost. This table is where a job survives the process that
-- created it.
--
-- WHY EACH COLUMN EXISTS
--
--   idempotency_key  UNIQUE. The same event enqueued twice is ONE row. Without
--                    it, a retry at the caller becomes a duplicate at the
--                    worker, and post-turn work is read-modify-write (G2).
--
--   owner_id         Carries E4/PR-4's guarantee into the durable queue. Two
--                    jobs for one owner must not run at once, and the claim
--                    query below enforces it in SQL rather than hoping the
--                    workers agree.
--
--   priority         Lower runs first. A revision the user is waiting on should
--                    not queue behind a nightly consolidation.
--
--   run_after        Backoff lives here, not in a sleeping worker. A worker
--                    that sleeps to honour a retry is a worker not doing other
--                    work, and it forgets on restart.
--
--   attempts /
--   max_attempts     The DLQ boundary. A job that has failed its budget stops
--                    being retried and starts being evidence.
--
--   state            queued -> running -> done | dead. NOTHING IS DELETED
--                    (L5): a dead job is the only record that the work was
--                    asked for and never happened, and deleting it turns a
--                    reportable failure into an absence.
--
--   last_error       Why it is dead. A DLQ without reasons is a list of
--                    regrets.

CREATE TABLE IF NOT EXISTS aqua_jobs (
  job_id           BIGSERIAL     PRIMARY KEY,
  owner_id         TEXT          NOT NULL,
  kind             TEXT          NOT NULL,
  payload          JSONB         NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key  TEXT          NOT NULL,
  priority         INTEGER       NOT NULL DEFAULT 100,
  state            TEXT          NOT NULL DEFAULT 'queued',
  attempts         INTEGER       NOT NULL DEFAULT 0,
  max_attempts     INTEGER       NOT NULL DEFAULT 5,
  run_after        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  last_error       TEXT,
  claimed_by       TEXT,
  claimed_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT aqua_jobs_state_ck
    CHECK (state IN ('queued', 'running', 'done', 'dead')),
  CONSTRAINT aqua_jobs_attempts_ck
    CHECK (attempts >= 0 AND max_attempts > 0)
);

-- One row per logical job. The enqueue path relies on this for its ON CONFLICT.
CREATE UNIQUE INDEX IF NOT EXISTS aqua_jobs_idem_uq
  ON aqua_jobs (owner_id, idempotency_key);

-- The claim query's index: ready work, best priority first, oldest first.
-- Partial on 'queued' because done and dead rows accumulate and must not be
-- scanned to find the next job.
CREATE INDEX IF NOT EXISTS aqua_jobs_ready_ix
  ON aqua_jobs (priority, run_after, job_id)
  WHERE state = 'queued';

-- Answers "is this owner already running something" in the claim query.
CREATE INDEX IF NOT EXISTS aqua_jobs_running_owner_ix
  ON aqua_jobs (owner_id)
  WHERE state = 'running';

-- The DLQ view an operator actually reads.
CREATE INDEX IF NOT EXISTS aqua_jobs_dead_ix
  ON aqua_jobs (updated_at DESC)
  WHERE state = 'dead';
