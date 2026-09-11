-- 0006 — claims, the atom
--
-- Blueprint D2. Everything AQUA believes is one of these.
--
-- THE FIVE NON-NEGOTIABLE PROPERTIES, and what each one fixes:
--
--   polarity   The current lane stores "Priya no longer works at Aquiplex" as
--              member_of(Priya, Aquiplex). Negation that INVERTS meaning is
--              worse than no extraction. Measured: negation recall 20%, and
--              every captured one is stored positively.
--   modality   "I want to hire a designer" is an INTENT. "What if we moved to
--              Bangalore?" is a HYPOTHETICAL. Storing all three as fact is how
--              an assistant becomes confidently wrong about someone's life.
--   three times valid_from/valid_to = when the WORLD was this way.
--              asserted_at = when it was SAID. They differ constantly
--              ("I moved to Bangalore last year"), and conflating them is why
--              retrieval currently returns the OLD employer for "where do I
--              work" — measured at 20% on the superseded category.
--   evidence   Mandatory, enforced below. A claim with no span is a
--              hallucination with a database row.
--   subject    An entity id, never a string (L8).
--
-- WHY `owner_id` LEADS EVERY INDEX
-- L19, and E3/PR-10's finding. The blob substrate rewrites every owner's data
-- when one owner changes — 6 MB and 858 ms at 5,000 owners. Claims are
-- per-row and per-owner from the first migration, so that never happens here.

CREATE TABLE IF NOT EXISTS aqua_claims (
  claim_id          uuid        PRIMARY KEY,
  owner_id          text        NOT NULL,

  subject_entity_id uuid        NOT NULL REFERENCES aqua_entities(entity_id),
  predicate         text        NOT NULL,

  -- Exactly one object form. A claim with two objects means two claims; a
  -- claim with none is not a claim.
  object_entity_id  uuid        NULL REFERENCES aqua_entities(entity_id),
  object_literal    text        NULL,
  object_quantity   numeric     NULL,
  object_unit       text        NULL,
  object_time_from  timestamptz NULL,
  object_time_to    timestamptz NULL,

  polarity          text        NOT NULL DEFAULT 'asserted',
  modality          text        NOT NULL DEFAULT 'fact',

  valid_from        timestamptz NULL,           -- when the WORLD was this way
  valid_to          timestamptz NULL,
  asserted_at       timestamptz NOT NULL,       -- when it was SAID
  time_precision    text        NOT NULL DEFAULT 'none',

  state             text        NOT NULL DEFAULT 'extracted',
  superseded_by     uuid        NULL REFERENCES aqua_claims(claim_id),

  -- D4: uncertainty is a VECTOR, never one number. `overall` is DERIVED and
  -- deliberately absent — L7, derive don't store.
  confidence_extraction    real NOT NULL DEFAULT 0.5,
  confidence_source        real NOT NULL DEFAULT 0.5,
  confidence_corroboration real NOT NULL DEFAULT 0.0,

  extractor         text        NOT NULL,
  extractor_version text        NOT NULL,
  actor             text        NOT NULL,       -- L9

  statement_text    text        NOT NULL,       -- the user's OWN words, always
  statement_norm    text        NOT NULL,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT aqua_claims_polarity_ck CHECK (polarity IN ('asserted','negated')),
  CONSTRAINT aqua_claims_modality_ck CHECK (modality IN
    ('fact','intent','hypothetical','question','quote')),
  CONSTRAINT aqua_claims_state_ck CHECK (state IN
    ('extracted','active','trusted','disputed','stale','superseded','archived')),
  CONSTRAINT aqua_claims_precision_ck CHECK (time_precision IN
    ('exact','day','month','quarter','year','relative','none')),
  -- EXACTLY ONE object form. Enforced in the schema rather than in code,
  -- because a code-level rule holds only until the second writer.
  CONSTRAINT aqua_claims_one_object_ck CHECK (
    (object_entity_id IS NOT NULL)::int +
    (object_literal   IS NOT NULL)::int +
    (object_quantity  IS NOT NULL)::int +
    (object_time_from IS NOT NULL)::int = 1),
  -- A superseded claim must name its successor, and a live one must not.
  --
  -- The second branch is REDUNDANT in practice — measured while checking bite:
  -- weakening it alone changes nothing, because a superseded row already fails
  -- the first branch. It is kept because it states the intent symmetrically
  -- and costs nothing, and removing the whole constraint DOES fail a test.
  CONSTRAINT aqua_claims_superseded_ck CHECK (
    (state = 'superseded' AND superseded_by IS NOT NULL) OR
    (state <> 'superseded' AND superseded_by IS NULL)),
  CONSTRAINT aqua_claims_validity_ck CHECK (
    valid_from IS NULL OR valid_to IS NULL OR valid_to >= valid_from)
);

-- "everything about X" — the hottest query in the system.
CREATE INDEX IF NOT EXISTS aqua_claims_owner_subject_idx
  ON aqua_claims (owner_id, subject_entity_id, state);
CREATE INDEX IF NOT EXISTS aqua_claims_owner_predicate_idx
  ON aqua_claims (owner_id, predicate, object_entity_id);
CREATE INDEX IF NOT EXISTS aqua_claims_owner_state_idx
  ON aqua_claims (owner_id, state, updated_at DESC);
-- Temporal queries. This index is what makes "where do I work NOW" a QUERY
-- rather than a ranking accident.
CREATE INDEX IF NOT EXISTS aqua_claims_owner_validity_idx
  ON aqua_claims (owner_id, valid_from, valid_to);
-- Exact-duplicate guard. Two identical claims are one claim with two pieces
-- of evidence, which is what makes corroboration mean anything.
CREATE UNIQUE INDEX IF NOT EXISTS aqua_claims_dedup_idx
  ON aqua_claims (owner_id, subject_entity_id, predicate, statement_norm);

-- ── evidence ────────────────────────────────────────────────────────────────
--
-- `sources` is separate from evidence so TRUST is revisable at the ORIGIN:
-- when a source turns out to be unreliable, one row changes and every claim it
-- fed is re-scored. Today trust is baked per-fact and unrevisable.

CREATE TABLE IF NOT EXISTS aqua_sources (
  source_id    uuid        PRIMARY KEY,
  owner_id     text        NOT NULL,
  kind         text        NOT NULL,
  external_ref text        NULL,
  title        text        NULL,
  trust_tier   real        NOT NULL,            -- L10: trust flows downhill
  content_hash text        NULL,
  ingested_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT aqua_sources_kind_ck CHECK (kind IN
    ('conversation','document','repository','web','user_correction','import'))
);

CREATE INDEX IF NOT EXISTS aqua_sources_owner_kind_idx
  ON aqua_sources (owner_id, kind, ingested_at DESC);

CREATE TABLE IF NOT EXISTS aqua_evidence (
  evidence_id  uuid        PRIMARY KEY,
  owner_id     text        NOT NULL,
  source_id    uuid        NOT NULL REFERENCES aqua_sources(source_id),
  locator      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  quote        text        NOT NULL,            -- VERBATIM span, mandatory
  checksum     text        NOT NULL,
  extracted_at timestamptz NOT NULL DEFAULT now(),

  -- `quote <> ''` rather than `length(quote) > 0`: identical semantics, and it
  -- avoids a function the test simulator does not implement. Choosing the
  -- portable form is better than shimming the simulator — a constraint that
  -- only exists in production is a constraint nobody tests.
  CONSTRAINT aqua_evidence_quote_ck CHECK (quote <> '')
);

CREATE INDEX IF NOT EXISTS aqua_evidence_owner_source_idx
  ON aqua_evidence (owner_id, source_id);

-- Many-to-many, because CORROBORATION lives here. Six conversations asserting
-- the same thing is ONE claim with six evidence rows — which is exactly what
-- consolidation already produces, but queryable.
--
-- `role` includes 'contradicting' on purpose: a claim that SURVIVED a
-- contradiction is stronger than one that never faced one, and we have to be
-- able to show the user the disagreement rather than only a flag.
CREATE TABLE IF NOT EXISTS aqua_claim_evidence (
  owner_id    text        NOT NULL,
  claim_id    uuid        NOT NULL REFERENCES aqua_claims(claim_id) ON DELETE CASCADE,
  evidence_id uuid        NOT NULL REFERENCES aqua_evidence(evidence_id) ON DELETE CASCADE,
  role        text        NOT NULL DEFAULT 'primary',
  added_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (owner_id, claim_id, evidence_id),
  CONSTRAINT aqua_claim_evidence_role_ck CHECK (role IN
    ('primary','corroborating','contradicting'))
);

CREATE INDEX IF NOT EXISTS aqua_claim_evidence_claim_idx
  ON aqua_claim_evidence (owner_id, claim_id);
