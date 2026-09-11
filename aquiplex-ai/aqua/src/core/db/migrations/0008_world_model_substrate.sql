-- E5 canonical World Model substrate.
-- Schema only; application writes are owned by worldModelRepository.js.
CREATE TABLE IF NOT EXISTS aqua_edges (
  edge_id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  from_entity_id uuid NOT NULL REFERENCES aqua_entities(entity_id),
  predicate text NOT NULL,
  to_entity_id uuid NOT NULL REFERENCES aqua_entities(entity_id),
  claim_id uuid NULL REFERENCES aqua_claims(claim_id),
  confidence real NOT NULL DEFAULT 0.5,
  state text NOT NULL DEFAULT 'active',
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aqua_edges_state_ck CHECK (state IN ('active','superseded','disputed','archived')),
  CONSTRAINT aqua_edges_distinct_ck CHECK (from_entity_id <> to_entity_id)
);
CREATE INDEX IF NOT EXISTS aqua_edges_owner_from_idx ON aqua_edges(owner_id, from_entity_id);
CREATE INDEX IF NOT EXISTS aqua_edges_owner_to_idx ON aqua_edges(owner_id, to_entity_id);

CREATE TABLE IF NOT EXISTS aqua_events (
  event_id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  event_type text NOT NULL,
  subject_entity_id uuid NULL REFERENCES aqua_entities(entity_id),
  claim_id uuid NULL REFERENCES aqua_claims(claim_id),
  occurred_at timestamptz NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS aqua_events_owner_time_idx ON aqua_events(owner_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS aqua_lifecycle_transitions (
  transition_id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  claim_id uuid NULL REFERENCES aqua_claims(claim_id),
  entity_id uuid NULL REFERENCES aqua_entities(entity_id),
  from_state text NOT NULL,
  to_state text NOT NULL,
  reason text NOT NULL,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aqua_lifecycle_target_ck CHECK (claim_id IS NOT NULL OR entity_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS aqua_lifecycle_owner_time_idx ON aqua_lifecycle_transitions(owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS aqua_revisions (
  revision_id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  target_kind text NOT NULL,
  target_id uuid NOT NULL,
  revision_kind text NOT NULL,
  previous_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  next_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS aqua_revisions_owner_target_idx ON aqua_revisions(owner_id, target_kind, target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS aqua_corrections (
  correction_id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  target_kind text NOT NULL,
  target_id uuid NOT NULL,
  instruction text NOT NULL,
  replacement jsonb NULL,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS aqua_corrections_owner_time_idx ON aqua_corrections(owner_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS aqua_entities_owner_entity_idx ON aqua_entities(owner_id, entity_id);

-- Structural owner isolation for entity-to-entity references.
ALTER TABLE aqua_claims ADD CONSTRAINT aqua_claims_subject_owner_fk
  FOREIGN KEY (owner_id, subject_entity_id) REFERENCES aqua_entities(owner_id, entity_id);

CREATE TABLE IF NOT EXISTS aqua_world_model_commits (
  commit_key text PRIMARY KEY,
  owner_id text NOT NULL,
  source_id uuid NOT NULL REFERENCES aqua_sources(source_id),
  segment_start integer NOT NULL,
  segment_end integer NOT NULL,
  extractor_version text NOT NULL,
  actor text NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS aqua_wm_commits_owner_idx ON aqua_world_model_commits(owner_id, committed_at DESC);

CREATE TABLE IF NOT EXISTS aqua_outbox (
  event_id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz NULL,
  last_error text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aqua_outbox_status_ck CHECK (status IN ('pending','processing','published','failed'))
);
CREATE INDEX IF NOT EXISTS aqua_outbox_pending_idx ON aqua_outbox(status, available_at);
CREATE INDEX IF NOT EXISTS aqua_outbox_owner_idx ON aqua_outbox(owner_id, created_at DESC);
