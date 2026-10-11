-- 0021 — revision voice watermark (2026-10-04).
--
-- The revision voice raises a canonical World Model change (a claim superseded
-- by the contradiction policy, or a dispute it could not settle) with the user
-- AT MOST ONCE. The watermark used to live in a per-process JSON file, so two
-- server processes could each raise the same revision, and a restart on a new
-- host forgot what had been said. Here it is one row per owner, advanced with
-- a compare-and-set (strictly forward on (surfaced_at, surfaced_transition_id))
-- so exactly one process wins a given revision.
--
-- Owner data: purged by worldModelRepository.purgeOwner.
CREATE TABLE IF NOT EXISTS aqua_revision_voice_state (
  owner_id               text        PRIMARY KEY,
  -- the newest lifecycle transition CONSIDERED (raised or judged not worth it)
  surfaced_at            timestamptz NOT NULL,
  surfaced_transition_id uuid        NOT NULL,
  -- the one actually raised last, for audit; NULL when the advance raised nothing
  raised_transition_id   uuid        NULL,
  raised_count           integer     NOT NULL DEFAULT 0,
  updated_at             timestamptz NOT NULL DEFAULT now()
);
