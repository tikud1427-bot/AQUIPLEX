-- 0022 — the current-claim guard includes the OBJECT (S8's exact identity)
--
-- 0017 kept the 0006 key (owner, subject, predicate, statement_norm) for
-- CURRENT claims. Every claim of a segment is stored with that segment's
-- sentence as statement_norm, so two different facts from ONE sentence with
-- the same subject and predicate collided: "Tidepool's backend is written in
-- Go on Postgres" → uses→Go, uses→Postgres. The second INSERT raised, the
-- whole understanding transaction rolled back, the durable job retried five
-- times and dead-lettered, and every fact in the turn was lost — the launch
-- date and budget said in the same sentence included (found 2026-10-05
-- validating start:production with real Groq extraction; job 2690).
--
-- S8 already says these are two claims ("uses → Postgres + uses → Redis: both
-- true", claimDedup.js exactKey = subject, predicate, object, polarity; plus
-- modality in sameClaim). The index now enforces exactly that identity, so an
-- identical current claim is still one claim, and distinct facts can coexist.
--
-- Each claim fills exactly one object form; the others are NULL. A plain
-- multi-column unique index treats NULLs as distinct and would never fire, so
-- each object column is COALESCEd to a typed sentinel (immutable on every
-- Postgres version, unlike NULLS NOT DISTINCT, PG15+).
DROP INDEX IF EXISTS aqua_claims_dedup_current_idx;

CREATE UNIQUE INDEX IF NOT EXISTS aqua_claims_dedup_current_idx
  ON aqua_claims (
    owner_id, subject_entity_id, predicate, statement_norm, polarity, modality,
    COALESCE(object_entity_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(object_literal, ''),
    COALESCE(object_quantity, 'NaN'::numeric),
    COALESCE(object_unit, ''),
    COALESCE(object_time_from, '-infinity'::timestamptz),
    COALESCE(object_time_to, '-infinity'::timestamptz))
  WHERE state NOT IN ('superseded', 'archived');
