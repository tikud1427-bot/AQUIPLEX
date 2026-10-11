-- 0024 — bounded action runs (Phase 5, 2026-10-06).
--
-- WORLD MODEL → REASONING → PLAN → APPROVAL → EXECUTION → OUTCOME → LEARNING.
--
-- One row per proposed plan (src/brain/actions/planner.js). A run moves only
-- forward through compare-and-set transitions:
--   proposed → approved → running → succeeded | failed
--   proposed → rejected | expired          running → (retry) running
-- Nothing executes without status 'approved' set by the OWNER (approval seam).
-- Every transition also writes a record row to aqua_outbox (the audit trail;
-- no second audit table). Effects on the World Model go only through the
-- canonical correction path (worldModelRepository.correctClaim, actor 'user',
-- correction id = run id → idempotent). Purged with the owner (actions/repository.js).
CREATE TABLE IF NOT EXISTS aqua_action_runs (
  run_id           uuid        PRIMARY KEY,
  owner_id         text        NOT NULL,
  intervention_id  uuid        NULL,
  kind             text        NOT NULL,
  title            text        NOT NULL,
  plan             jsonb       NOT NULL,     -- steps, budget, timeout, dry-run preview, evidence ids
  status           text        NOT NULL DEFAULT 'proposed',
  idempotency_key  text        NOT NULL,
  approval         jsonb       NULL,         -- { by, at, choice }
  result           jsonb       NULL,         -- per-step outputs (the outcome evidence)
  error            text        NULL,
  attempts         integer     NOT NULL DEFAULT 0,
  max_attempts     integer     NOT NULL DEFAULT 3,
  step_budget      integer     NOT NULL DEFAULT 3,
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  approved_at      timestamptz NULL,
  started_at       timestamptz NULL,
  finished_at      timestamptz NULL,
  CONSTRAINT aqua_action_runs_idem_uq UNIQUE (owner_id, idempotency_key),
  CONSTRAINT aqua_action_runs_kind_ck CHECK (kind IN ('draft_message','create_reminder','resolve_contradiction')),
  CONSTRAINT aqua_action_runs_status_ck CHECK (status IN
    ('proposed','approved','rejected','running','succeeded','failed','expired')),
  CONSTRAINT aqua_action_runs_budget_ck CHECK (step_budget BETWEEN 1 AND 3 AND max_attempts BETWEEN 1 AND 5),
  -- Interventions are never deleted except by account purge, which removes
  -- this owner's runs first (actions/repository.js purgeOwner).
  CONSTRAINT aqua_action_runs_iv_owner_fk FOREIGN KEY (intervention_id, owner_id)
    REFERENCES aqua_interventions (intervention_id, owner_id)
);
CREATE INDEX IF NOT EXISTS aqua_action_runs_owner_status_idx ON aqua_action_runs (owner_id, status, created_at DESC);
