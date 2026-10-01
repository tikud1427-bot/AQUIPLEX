# AQUIPLEX Blueprint V2 — Implementation Status

Date: 2026-09-28

This working tree contains the first implementation pass against the remaining Blueprint V2 gaps that were concrete and safe to land without inventing unresolved product decisions.

## Implemented in this pass

### E1 / repository hygiene
- Removed stale `before-pr` / backup source snapshots that were making the hygiene guard red.
- Updated the hygiene test header to match the real guard.

### E11 / API surface consolidation foundation
- Added an exact `/v1` mount over the existing AQUA route tree.
- Kept `/api/aqua/v1` as a compatibility alias over the same router instance.
- Normalized `/v1` usage-meter path handling.
- Added `payload_too_large` to the closed API error taxonomy.
- Routed terminal 404/parser/unhandled router errors through the shared envelope helper.
- Added source-level contract tests proving one router implementation is mounted at both prefixes.

### E9 / Reflection V3 partial implementation
- Fixed the claim-reflection worker argument order so owner scoping reaches the canonical repository correctly.
- Added canonical Postgres revision-feed reading with legacy PIC fallback.
- Wired `/brain/changes` to the canonical-first feed.
- Hardened the Brain route guard for rejected async handlers.
- Added E9 claim-to-belief provenance linking after the existing Mind belief writer succeeds, with fail-open behaviour while Postgres is unavailable.
- Added deterministic episode clustering with owner isolation and bounded temporal cohesion.
- Added hard-gated pattern-inference proposals. These remain proposals because the Blueprint calls for `modality:inferred`, while the current live claim schema does not include that enum; the unresolved schema decision is intentionally not changed silently.
- Added semantic-duplicate consolidation as a write-free planner using an injected, eval-gated equivalence oracle; no unmeasured similarity threshold is invented.
- Added named revision-delta v2 and wired it into the existing reflection ledger so the revision voice receives named subjects and bounded before/after changes.

## Validation

Focused tests added/run in this pass are green, including:
- E9 claim-to-belief linking
- E9 episode clustering
- E9 pattern-inference gates
- E9 semantic-consolidation planner
- E9 named revision delta
- canonical revision feed
- reflection worker owner-first contract
- Brain revision-feed route wiring
- E11 `/v1` surface contracts
- repository hygiene

A larger focused E7/E8/graph/hygiene battery also passed previously in this implementation session.

## Environment limitation

The uploaded production environment file was not modified or copied into this package. The local extracted dependency tree is incomplete (several installed package directories are empty), and network access to restore npm dependencies is unavailable in this environment. Because of that, the real provider-backed E6 shadow evaluation could not be executed here; no new E6 quality number is claimed.

The Blueprint's own promotion gate remains the authoritative next measurement: run the prescribed repeated negation evaluation before promoting extraction changes. Do not lower the gate to make it pass.

## Still intentionally pending

The critical path remains E6 promotion -> E7 production dense retrieval -> E8 full slot-driven context -> E10 unification -> E12 operational hardening. E9 is only partially wired: the pure J3 planners are implemented, while the durable job producer/consumer path and the final schema decision for inferred claims still require completion and evaluation.
