-- 0009 — transactional outbox
-- E5/E4 bridge: durable delivery of world-model changes.
-- The row is written in the same transaction as the domain mutation.

CREATE TABLE IF NOT EXISTS aqua_outbox (
  outbox_id      bigserial PRIMARY KEY,
  owner_id       text NOT NULL,
  event_type     text NOT NULL,
  aggregate_kind text NOT NULL,
  aggregate_id   uuid NOT NULL,
  payload        jsonb NOT NULL,
  actor          text NOT NULL,
  state          text NOT NULL DEFAULT 'pending',
  attempts       integer NOT NULL DEFAULT 0,
  available_at   timestamptz NOT NULL DEFAULT now(),
  claimed_at     timestamptz NULL,
  claimed_by     text NULL,
  last_error     text NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz NULL,
  CONSTRAINT aqua_outbox_state_ck CHECK (state IN ('pending','processing','published','dead'))
);

CREATE INDEX IF NOT EXISTS aqua_outbox_pending_idx
  ON aqua_outbox (available_at, outbox_id) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS aqua_outbox_owner_idx
  ON aqua_outbox (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS aqua_outbox_aggregate_idx
  ON aqua_outbox (owner_id, aggregate_kind, aggregate_id, created_at DESC);
