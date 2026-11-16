-- 0029 — one designated owner per periodic scheduler (scalability Phase 3 prep).
--
-- Every worker ran the stale-job reap, the consolidation scan and the proactive
-- scan on its own timer. Their enqueues deduplicate, so that was safe, but it
-- was not single ownership. A lease row per scheduler: a holder renews it well
-- inside its TTL; another process may take it only once it has expired (the
-- holder died) or was released (graceful shutdown).
--
-- A table, not pg_advisory_lock: session-level advisory locks do not survive a
-- transaction-pooling connection pooler (PgBouncer, the Cloud SQL connector in
-- transaction mode), which Phase 5 will put in front of Cloud SQL.

CREATE TABLE IF NOT EXISTS aqua_scheduler_leases (
  name        text        PRIMARY KEY,
  holder      text        NOT NULL,
  expires_at  timestamptz NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  renewed_at  timestamptz NOT NULL DEFAULT now()
);
