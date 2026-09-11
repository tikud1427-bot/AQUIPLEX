-- 0008 — world model: edges, events, lifecycle transitions, revisions, corrections
--
-- Blueprint E5, continuing the substrate 0005 (entities) and 0006 (claims)
-- shipped. D2 still holds: the claim is the only atom. Nothing here is a
-- second knowledge representation — every table below either PROJECTS from
-- claims (edges, events) or records something that happened TO a claim,
-- entity, edge or event (lifecycle_transitions, revisions, corrections).
--
-- NOTHING READS OR WRITES THESE TABLES YET. This is the shape, the same
-- discipline 0005 and 0006 used before PR-3 added the claim repository.
-- A test asserts that (see worldModelSchema.test.js).
--
-- PURGE, for whichever PR adds the writer: aqua_edges and aqua_events are
-- self-referencing (superseded_by). An owner-scoped purge should, for that
-- owner, UPDATE both tables to superseded_by=NULL, state='active' BEFORE
-- deleting the five tables — 'active' only because aqua_*_superseded_ck
-- requires state and superseded_by to agree even on a row about to be
-- deleted, not because the row's state matters after that. This avoids
-- leaning on same-statement deferred foreign-key checking — real Postgres
-- permits that, but it is not a behaviour a purge routine should depend on.
-- worldModelSchema.test.js's purge test does this and documents why.
--
-- WHY THIS IS ONE MIGRATION AND NOT FIVE
-- The five tables are one substrate delivered together, the same choice
-- 0006 made bundling claims with its sources/evidence/claim_evidence side
-- tables — none of the five is independently useful without the others
-- (an edge with nowhere to record its lifecycle history is half a feature).
--
-- CROSS-OWNER FOREIGN KEYS (new here, not retrofitted onto 0005/0006)
-- `claimRepository.js` refuses a cross-owner write in APPLICATION code
-- (`attachEvidence`'s "cross-owner link refused"). That is correct for a
-- repository that exists, but PR-1/PR-2's entities and claims tables ship
-- with no writer, and every writer that will ever touch this migration's
-- five tables does not exist yet either — there is no repository around to
-- do the refusing. So owner isolation for the new foreign keys below is
-- STRUCTURAL: a composite (id, owner_id) foreign key means a cross-owner
-- reference is not merely un-called, it is un-insertable, before a single
-- line of application code exists to get it wrong.
--
-- Postgres requires the referenced columns to carry a unique constraint.
-- `entity_id`/`claim_id` are already primary keys (unique on their own), so
-- these two ALTERs add the (id, owner_id) uniqueness the new composite FKs
-- need — additive, non-breaking, and forward-only: 0005/0006's CREATE TABLE
-- statements are untouched.
ALTER TABLE aqua_entities
  ADD CONSTRAINT aqua_entities_id_owner_uq UNIQUE (entity_id, owner_id);

ALTER TABLE aqua_claims
  ADD CONSTRAINT aqua_claims_id_owner_uq UNIQUE (claim_id, owner_id);

-- ── edges ────────────────────────────────────────────────────────────────────
--
-- A typed, directed relationship between two entities. NOT a second place
-- relationships live — it is a queryable INDEX over the entity↔entity claims
-- that already exist, which is why `claim_id` is NOT NULL rather than an
-- optional evidence link: an edge with no claim behind it would be exactly
-- the "free-floating edge with no provenance" the architecture forbids.
--
-- `predicate` is deliberately a plain text column with no CHECK, matching
-- 0006's own `aqua_claims.predicate` — the vocabulary is governed by
-- `predicateRegistry.js` at the application layer (controlled but open), and
-- a second enforcement point in the schema would be a second place the rule
-- could drift from the registry.
CREATE TABLE IF NOT EXISTS aqua_edges (
  edge_id        uuid        PRIMARY KEY,
  owner_id       text        NOT NULL,

  from_entity_id uuid        NOT NULL,
  to_entity_id   uuid        NOT NULL,
  predicate      text        NOT NULL,

  -- The claim this edge projects. Mandatory: an edge IS a materialised
  -- entity-to-entity claim, not a new fact — evidence lives on the claim.
  claim_id       uuid        NOT NULL,

  state          text        NOT NULL DEFAULT 'active',
  superseded_by  uuid        NULL,

  -- When the relationship held in the WORLD, mirroring 0006's valid_from/
  -- valid_to. Denormalised from the source claim (rather than joined every
  -- read) because graph traversal is the hot path this table exists to
  -- serve — the claim row remains the source of truth for the same window.
  valid_from     timestamptz NULL,
  valid_to       timestamptz NULL,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT aqua_edges_id_owner_uq UNIQUE (edge_id, owner_id),

  CONSTRAINT aqua_edges_state_ck CHECK (state IN
    ('extracted','active','trusted','disputed','stale','superseded','archived')),
  -- Mirrors 0006_claims.sql's superseded constraint exactly, including the
  -- redundant second branch — kept for the same reason: it costs nothing and
  -- states the intent symmetrically, and removing the whole thing (not just
  -- the redundant half) is what the schema test actually exercises.
  CONSTRAINT aqua_edges_superseded_ck CHECK (
    (state = 'superseded' AND superseded_by IS NOT NULL) OR
    (state <> 'superseded' AND superseded_by IS NULL)),
  CONSTRAINT aqua_edges_validity_ck CHECK (
    valid_from IS NULL OR valid_to IS NULL OR valid_to >= valid_from),
  -- No seed predicate in predicateRegistry.js is reflexive (a person cannot
  -- report_to themselves), so a self-loop is corruption, not a rare fact.
  CONSTRAINT aqua_edges_no_self_loop_ck CHECK (from_entity_id <> to_entity_id),

  -- Structural cross-owner prevention (L19) — see header.
  CONSTRAINT aqua_edges_from_entity_fk FOREIGN KEY (from_entity_id, owner_id)
    REFERENCES aqua_entities (entity_id, owner_id),
  CONSTRAINT aqua_edges_to_entity_fk FOREIGN KEY (to_entity_id, owner_id)
    REFERENCES aqua_entities (entity_id, owner_id),
  CONSTRAINT aqua_edges_claim_fk FOREIGN KEY (claim_id, owner_id)
    REFERENCES aqua_claims (claim_id, owner_id),
  CONSTRAINT aqua_edges_superseded_by_fk FOREIGN KEY (superseded_by, owner_id)
    REFERENCES aqua_edges (edge_id, owner_id)
);

-- Traverse from an entity, in either direction. The two hottest graph
-- queries: "what does X point to" and "what points to X".
CREATE INDEX IF NOT EXISTS aqua_edges_owner_from_idx
  ON aqua_edges (owner_id, from_entity_id, state);
CREATE INDEX IF NOT EXISTS aqua_edges_owner_to_idx
  ON aqua_edges (owner_id, to_entity_id, state);
-- "every edge of this type" — per-predicate traversal.
CREATE INDEX IF NOT EXISTS aqua_edges_owner_predicate_idx
  ON aqua_edges (owner_id, predicate, state);
-- Which claim(s) an owner's edges came from — provenance lookups, and the
-- path a future re-projection uses to find edges derived from one claim.
CREATE INDEX IF NOT EXISTS aqua_edges_owner_claim_idx
  ON aqua_edges (owner_id, claim_id);

-- ── events ───────────────────────────────────────────────────────────────────
--
-- Something that happened in the user's world, with a time. NOT the E4
-- transactional outbox event (`aqua_jobs` and its future outbox sibling) —
-- that is durable delivery; this is domain history. The two are deliberately
-- unrelated tables so neither migration can be mistaken for the other's job.
--
-- THREE TIMESTAMPS, same reasoning as 0006's claims:
--   occurred_at/occurred_to  when it happened in the WORLD (a point, or a
--                            range for something with duration)
--   asserted_at              when it was SAID/recorded — conflating this
--                            with occurred_at is the exact bug 0006 fixed
--                            for claims (superseded recall 20%)
CREATE TABLE IF NOT EXISTS aqua_events (
  event_id          uuid        PRIMARY KEY,
  owner_id          text        NOT NULL,

  event_type        text        NOT NULL,
  statement_text    text        NOT NULL,  -- the user's own words, as 0006 requires of claims

  -- The entity this event chiefly concerns, if any. Single and nullable —
  -- an event involving several entities is representable as several events
  -- sharing evidence, or awaits a junction table the day a real caller needs
  -- one; inventing that table unused would be exactly what PR-1 refused to
  -- do for claims ("no code" until something calls it).
  subject_entity_id uuid        NULL,
  claim_id          uuid        NOT NULL,

  occurred_at       timestamptz NULL,
  occurred_to       timestamptz NULL,
  asserted_at       timestamptz NOT NULL DEFAULT now(),
  time_precision    text        NOT NULL DEFAULT 'none',

  state             text        NOT NULL DEFAULT 'active',
  superseded_by     uuid        NULL,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT aqua_events_id_owner_uq UNIQUE (event_id, owner_id),

  CONSTRAINT aqua_events_state_ck CHECK (state IN
    ('extracted','active','trusted','disputed','stale','superseded','archived')),
  CONSTRAINT aqua_events_superseded_ck CHECK (
    (state = 'superseded' AND superseded_by IS NOT NULL) OR
    (state <> 'superseded' AND superseded_by IS NULL)),
  CONSTRAINT aqua_events_precision_ck CHECK (time_precision IN
    ('exact','day','month','quarter','year','relative','none')),
  -- An end with no start is not a range, it is a missing start. Requiring
  -- occurred_at whenever occurred_to is set is what makes this a genuine
  -- validity check rather than one that silently no-ops on half its inputs.
  CONSTRAINT aqua_events_range_ck CHECK (
    occurred_to IS NULL OR (occurred_at IS NOT NULL AND occurred_to >= occurred_at)),

  CONSTRAINT aqua_events_subject_entity_fk FOREIGN KEY (subject_entity_id, owner_id)
    REFERENCES aqua_entities (entity_id, owner_id),
  CONSTRAINT aqua_events_claim_fk FOREIGN KEY (claim_id, owner_id)
    REFERENCES aqua_claims (claim_id, owner_id),
  CONSTRAINT aqua_events_superseded_by_fk FOREIGN KEY (superseded_by, owner_id)
    REFERENCES aqua_events (event_id, owner_id)
);

-- The timeline query: "what happened, in order" — the reason this table
-- exists rather than leaving events implicit in claims.
CREATE INDEX IF NOT EXISTS aqua_events_owner_occurred_idx
  ON aqua_events (owner_id, occurred_at DESC);
-- "everything that happened involving X, in order".
CREATE INDEX IF NOT EXISTS aqua_events_owner_subject_idx
  ON aqua_events (owner_id, subject_entity_id, occurred_at DESC);
-- "every event of this kind" — e.g. every 'deadline', every 'meeting'.
CREATE INDEX IF NOT EXISTS aqua_events_owner_type_idx
  ON aqua_events (owner_id, event_type, occurred_at DESC);
-- Operational: what recently changed state (disputed, superseded, ...).
CREATE INDEX IF NOT EXISTS aqua_events_owner_state_idx
  ON aqua_events (owner_id, state, updated_at DESC);

-- ── lifecycle_transitions ────────────────────────────────────────────────────
--
-- The append-only log of every state change to a claim, entity, edge or
-- event. The mutable `state`/`status` column stays on the row it describes
-- (0005's aqua_entities.status, 0006's aqua_claims.state, and the two above);
-- this table is what makes that mutation NOT a silent overwrite — "do not
-- make lifecycle state mutable without preserving the transition history".
--
-- `target_kind` is a CLOSED set on purpose, unlike an open vocabulary such as
-- `predicate`: it names which STRUCTURAL table a transition belongs to, the
-- same distinction `reasoning/typeRegistry.js` draws between its closed
-- structural edge classes and its open user-world ones. Adding a fifth kind
-- is a deliberate schema change, not something a caller should be able to
-- invent by typo.
--
-- `target_id` carries no foreign key. It is polymorphic — a claim, entity,
-- edge or event id depending on `target_kind` — and Postgres has no native
-- foreign key that can point at "whichever of four tables `target_kind`
-- names". That is a standard, accepted trade-off for a polymorphic log
-- table, enforced at the application layer once a writer exists (E5/PR-N),
-- not a gap specific to this migration.
CREATE TABLE IF NOT EXISTS aqua_lifecycle_transitions (
  transition_id  uuid        PRIMARY KEY,
  owner_id       text        NOT NULL,

  target_kind    text        NOT NULL,
  target_id      uuid        NOT NULL,

  -- NULL only for a target's very first transition (nothing to come FROM).
  from_state     text        NULL,
  to_state       text        NOT NULL,
  reason         text        NOT NULL,
  actor          text        NOT NULL,  -- L9: every write has an actor

  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT aqua_lifecycle_transitions_kind_ck CHECK (target_kind IN
    ('claim','entity','edge','event')),
  -- The union of every state/status vocabulary a target_kind can carry:
  -- claims/edges/events use 0006's 7-state set; entities use 0005's
  -- active/merged/dismissed. One CHECK across the union rather than a
  -- per-kind constraint, because a per-kind rule needs a trigger to express
  -- and this table has no writer yet to justify that cost.
  CONSTRAINT aqua_lifecycle_transitions_from_ck CHECK (from_state IS NULL OR from_state IN
    ('extracted','active','trusted','disputed','stale','superseded','archived','merged','dismissed')),
  CONSTRAINT aqua_lifecycle_transitions_to_ck CHECK (to_state IN
    ('extracted','active','trusted','disputed','stale','superseded','archived','merged','dismissed')),
  -- A transition that does not change anything is not a transition.
  CONSTRAINT aqua_lifecycle_transitions_change_ck CHECK (from_state IS NULL OR from_state <> to_state)
);

-- "the history of this thing" — the whole reason the table exists.
CREATE INDEX IF NOT EXISTS aqua_lifecycle_transitions_owner_target_idx
  ON aqua_lifecycle_transitions (owner_id, target_kind, target_id, created_at DESC);
-- Operational: "what recently became disputed / superseded / archived".
CREATE INDEX IF NOT EXISTS aqua_lifecycle_transitions_owner_to_idx
  ON aqua_lifecycle_transitions (owner_id, to_state, created_at DESC);
-- The audit/activity feed an operator actually reads.
CREATE INDEX IF NOT EXISTS aqua_lifecycle_transitions_owner_created_idx
  ON aqua_lifecycle_transitions (owner_id, created_at DESC);

-- ── revisions ────────────────────────────────────────────────────────────────
--
-- L1 — understanding is a diff. Every meaningful world-model change must be
-- answerable as "what changed", not merely overwritten. `before`/`after` are
-- the CHANGED fields only, not a full-row snapshot — L7, derive don't store:
-- storing the whole row twice per edit would make this table an unbounded
-- copy of the tables it describes rather than a diff of them. That
-- discipline is an application-layer contract (there is no writer yet to
-- enforce it against), documented here so the first writer inherits it
-- rather than re-deciding it.
--
-- `change_kind` excludes 'delete' deliberately — L5: nothing is deleted,
-- things are superseded or merged. A revision records THAT kind of change
-- like any other, it does not need a kind that contradicts the constitution.
CREATE TABLE IF NOT EXISTS aqua_revisions (
  revision_id  uuid        PRIMARY KEY,
  owner_id     text        NOT NULL,

  target_kind  text        NOT NULL,
  target_id    uuid        NOT NULL,   -- polymorphic; see lifecycle_transitions

  change_kind  text        NOT NULL,
  before       jsonb       NULL,       -- the changed fields only; NULL for 'create'
  after        jsonb       NULL,       -- the changed fields only; never NULL

  reason       text        NOT NULL,
  actor        text        NOT NULL,   -- who
  source       text        NULL,       -- what produced it (extractor, correction, merge, ...)

  -- Reversibility is a stated PROPERTY of the revision, not a mechanism: the
  -- actual undo is a NEW revision (before/after swapped), the same pattern
  -- 0005's aqua_entity_merges uses for `reverted_at` — an undo is a recorded
  -- event, never a rewrite of what happened.
  reversible   boolean     NOT NULL DEFAULT true,
  reverted_at  timestamptz NULL,

  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT aqua_revisions_kind_ck CHECK (target_kind IN
    ('claim','entity','edge','event')),
  CONSTRAINT aqua_revisions_change_ck CHECK (change_kind IN
    ('create','update','supersede','merge')),
  -- A 'create' has nothing to diff FROM; every other change must show it.
  CONSTRAINT aqua_revisions_before_ck CHECK (
    (change_kind = 'create' AND before IS NULL) OR
    (change_kind <> 'create' AND before IS NOT NULL)),
  -- Every revision must show what changed TO — the "what changed?" answer
  -- this table exists to make possible.
  CONSTRAINT aqua_revisions_after_ck CHECK (after IS NOT NULL)
);

-- "what changed for this thing, in order" — the L1 query.
CREATE INDEX IF NOT EXISTS aqua_revisions_owner_target_idx
  ON aqua_revisions (owner_id, target_kind, target_id, created_at DESC);
-- Audit by who made the change.
CREATE INDEX IF NOT EXISTS aqua_revisions_owner_actor_idx
  ON aqua_revisions (owner_id, actor, created_at DESC);
-- The recent-changes feed.
CREATE INDEX IF NOT EXISTS aqua_revisions_owner_created_idx
  ON aqua_revisions (owner_id, created_at DESC);

-- ── corrections ──────────────────────────────────────────────────────────────
--
-- The primary product signal: the user saying AQUA is wrong. Shape is the
-- one specified — correction_id, owner_id, target_kind, target_id, action,
-- before, after, created_at — plus `actor`, which the shape's own paragraph
-- demands even though the column list above it does not spell it out:
-- "Corrections MUST be attributable" is not satisfiable without one.
--
-- `action` is NOT destructive-only ('correct' and 'rename' both produce an
-- `after`; only 'remove'/'dismiss' do not) — the requirement that a
-- correction must be able to fix a value, not only delete it.
--
-- This is a legacy-named-differently sibling of `understanding/corrections.js`,
-- which is the Mind's belief/goal/fact correction router (action vocabulary
-- correct/remove/keep) — a different subsystem with a different vocabulary,
-- not a second implementation of this one. The two do not share storage and
-- are not expected to converge inside this PR's scope.
CREATE TABLE IF NOT EXISTS aqua_corrections (
  correction_id  uuid        PRIMARY KEY,
  owner_id       text        NOT NULL,

  target_kind    text        NOT NULL,
  target_id      uuid        NOT NULL,   -- polymorphic; see lifecycle_transitions

  action         text        NOT NULL,
  before         jsonb       NOT NULL,   -- what the user is correcting — never optional
  after          jsonb       NULL,       -- the corrected value; NULL for remove/dismiss

  actor          text        NOT NULL,   -- attributable, per the requirement above

  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT aqua_corrections_kind_ck CHECK (target_kind IN
    ('claim','entity','edge','event')),
  CONSTRAINT aqua_corrections_action_ck CHECK (action IN
    ('correct','remove','dismiss','rename')),
  CONSTRAINT aqua_corrections_after_ck CHECK (
    (action IN ('remove','dismiss') AND after IS NULL) OR
    (action IN ('correct','rename') AND after IS NOT NULL))
);

-- "every correction ever applied to this thing" — audit/revision trail.
CREATE INDEX IF NOT EXISTS aqua_corrections_owner_target_idx
  ON aqua_corrections (owner_id, target_kind, target_id, created_at DESC);
-- The product-signal feed: corrections as they arrive.
CREATE INDEX IF NOT EXISTS aqua_corrections_owner_created_idx
  ON aqua_corrections (owner_id, created_at DESC);
