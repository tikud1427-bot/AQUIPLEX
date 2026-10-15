-- 0023 — proactive interventions (Phase 4, 2026-10-06).
--
-- WORLD MODEL → CHANGE → TRIGGER → POLICY → INTERVENTION → RESPONSE → LEARNING.
--
-- An intervention is an OPERATIONAL record (like a job), never knowledge: it
-- holds no fact of its own. Every reason it fired is a canonical claim, linked
-- through aqua_intervention_evidence with a composite (claim_id, owner_id) FK,
-- so owner isolation is structural and a purged claim takes its links with it.
-- Deterministic code (src/brain/proactive/policy.js) decides whether one fires;
-- this table records the decision, its trace, delivery and the user's response.
--
-- Idempotent: (owner_id, idempotency_key) is unique — the key is the trigger
-- type + subject + a fingerprint of the evidence claims, so re-evaluating an
-- unchanged world writes nothing. Nothing is deleted except by account purge
-- (proactive/repository.js purgeOwner, registered in accountPurge).

CREATE TABLE IF NOT EXISTS aqua_interventions (
  intervention_id   uuid        PRIMARY KEY,
  owner_id          text        NOT NULL,
  trigger_type      text        NOT NULL,
  subject_entity_id uuid        NULL,
  cooldown_key      text        NOT NULL,
  idempotency_key   text        NOT NULL,
  status            text        NOT NULL DEFAULT 'proposed',
  delivery_status   text        NOT NULL DEFAULT 'pending',
  severity          text        NOT NULL,
  urgency           real        NOT NULL,
  reason            text        NOT NULL,
  message           text        NOT NULL,
  world_state       jsonb       NOT NULL,   -- the state that justified it (refs + values)
  confidence        jsonb       NOT NULL,   -- components: evidence, relevance, urgency, benefit
  decision          jsonb       NOT NULL,   -- the full policy trace
  proposed_action   jsonb       NULL,       -- Phase 5: a bounded plan, never executed without approval
  user_response     text        NULL,
  outcome           jsonb       NULL,
  deliver_after     timestamptz NULL,       -- quiet hours defer delivery, never the decision
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  delivered_at      timestamptz NULL,
  responded_at      timestamptz NULL,
  CONSTRAINT aqua_interventions_id_owner_uq UNIQUE (intervention_id, owner_id),
  CONSTRAINT aqua_interventions_idem_uq UNIQUE (owner_id, idempotency_key),
  CONSTRAINT aqua_interventions_status_ck CHECK (status IN
    ('proposed','suppressed','delivered','accepted','dismissed','corrected','snoozed','expired')),
  CONSTRAINT aqua_interventions_delivery_ck CHECK (delivery_status IN ('pending','deferred','delivered','not_delivered')),
  CONSTRAINT aqua_interventions_severity_ck CHECK (severity IN ('low','medium','high')),
  CONSTRAINT aqua_interventions_response_ck CHECK (user_response IS NULL OR user_response IN
    ('accepted','dismissed','corrected','snoozed')),
  CONSTRAINT aqua_interventions_subject_owner_fk FOREIGN KEY (subject_entity_id, owner_id)
    REFERENCES aqua_entities (entity_id, owner_id)
);

CREATE INDEX IF NOT EXISTS aqua_interventions_owner_status_idx
  ON aqua_interventions (owner_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS aqua_interventions_cooldown_idx
  ON aqua_interventions (owner_id, cooldown_key, created_at DESC);

CREATE TABLE IF NOT EXISTS aqua_intervention_evidence (
  owner_id        text NOT NULL,
  intervention_id uuid NOT NULL,
  claim_id        uuid NOT NULL,
  role            text NOT NULL DEFAULT 'evidence',
  PRIMARY KEY (intervention_id, claim_id),
  CONSTRAINT aqua_intervention_evidence_iv_owner_fk FOREIGN KEY (intervention_id, owner_id)
    REFERENCES aqua_interventions (intervention_id, owner_id) ON DELETE CASCADE,
  CONSTRAINT aqua_intervention_evidence_claim_owner_fk FOREIGN KEY (claim_id, owner_id)
    REFERENCES aqua_claims (claim_id, owner_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS aqua_intervention_evidence_claim_idx
  ON aqua_intervention_evidence (owner_id, claim_id);

-- User preferences for interruptions. Settings, not knowledge (L20 is about
-- facts of the user's world; when Aqua may interrupt is a control the user owns).
CREATE TABLE IF NOT EXISTS aqua_proactive_prefs (
  owner_id         text        PRIMARY KEY,
  enabled          boolean     NOT NULL DEFAULT true,
  min_severity     text        NOT NULL DEFAULT 'medium',
  max_per_day      integer     NOT NULL DEFAULT 3,
  quiet_start_min  integer     NULL,      -- minutes after local midnight
  quiet_end_min    integer     NULL,
  tz_offset_min    integer     NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aqua_proactive_prefs_sev_ck CHECK (min_severity IN ('low','medium','high')),
  CONSTRAINT aqua_proactive_prefs_cap_ck CHECK (max_per_day BETWEEN 0 AND 20),
  CONSTRAINT aqua_proactive_prefs_quiet_ck CHECK (
    (quiet_start_min IS NULL AND quiet_end_min IS NULL) OR
    (quiet_start_min BETWEEN 0 AND 1439 AND quiet_end_min BETWEEN 0 AND 1439))
);
