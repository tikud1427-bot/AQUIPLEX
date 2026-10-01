# AQUIPLEX — Next Blueprint Closure Slice

Date: 2026-09-29
Baseline: aquiplex-ai.tar(20260929-141013).gz

## Implemented

### E8 / PIC temporal currency hardening
- Present-state verbs now imply `currency=current` when no explicit time cue is present.
- Includes `employ/employs/employed`, work, live, based, located, pay/pays/paying.
- Explicit past auxiliaries still win, so `did/was/were/had` remains retrospective.
- Added regression coverage for current employer questions and superseded employer claims.

### E7 canonical structured retrieval
- Structured canonical claim lookup now matches named entity ids in either the subject or object position.
- This closes the object-entity retrieval hole for relations such as `works_at(user, Intercom)` when the user asks `Do I work at Intercom?`.
- Added a static contract test enforcing the subject-or-object lookup shape.

## Validation

Passing:
- `src/pic/tests/questionShape.test.js` — 23/23
- `src/pic/tests/relevanceGate.test.js` — 17/17
- `src/brain/tests/canonicalWorldModelRetrievalContract.test.js` — 6/6
- combined slice — 46/46
- `scripts/production-loop-doctor.mjs` — 12/12 static checks

Full dependency-backed suite was not rerun because the uploaded baseline's `node_modules` is incomplete and a fresh `npm ci` timed out in this environment. No passing/failing claim is made from that incomplete install.

## Remaining external gates

- E6 provider-backed promotion measurement remains a runtime/eval gate; no flag was flipped because the documented negation threshold still requires fresh repeated measurement.
- Live Postgres migration/drift verification and production worker uptime were not available in this sandbox.
- Longitudinal World-Model Lift / re-explanation-rate evidence requires real user traffic and remains an operational proof, not a source-level claim.

## Packaging rules

- `node_modules` excluded.
- `.env` and credential-bearing files excluded from the archive.
- No new dependency or new environment variable was introduced by this slice.
