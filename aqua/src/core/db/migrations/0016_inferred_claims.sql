-- 0016 — Reflection V3 inferred claims
--
-- E9 / PR-5. Patterns are claims, but they are not user-authored facts. They
-- carry modality=inferred, a reflection actor/extractor, and a lower source
-- confidence ceiling. Their evidence still has to be real spans from the
-- claims that caused the inference.

ALTER TABLE aqua_claims DROP CONSTRAINT IF EXISTS aqua_claims_modality_ck;
ALTER TABLE aqua_claims
  ADD CONSTRAINT aqua_claims_modality_ck CHECK (modality IN
    ('fact','intent','hypothetical','question','quote','inferred'));

ALTER TABLE aqua_sources DROP CONSTRAINT IF EXISTS aqua_sources_kind_ck;
ALTER TABLE aqua_sources
  ADD CONSTRAINT aqua_sources_kind_ck CHECK (kind IN
    ('conversation','document','repository','web','user_correction','import','reflection'));

CREATE INDEX IF NOT EXISTS aqua_claims_owner_modality_idx
  ON aqua_claims (owner_id, modality, state, updated_at DESC);
