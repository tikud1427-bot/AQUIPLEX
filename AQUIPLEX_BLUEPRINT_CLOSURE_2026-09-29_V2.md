# AQUIPLEX — Blueprint V2 Closure Report

Date: 2026-09-29
Source of truth: `AQUIPLEX_BLUEPRINT_V2(8).md` plus the uploaded codebase tree.

## Product loop closed at code level

Aqua now has an explicit end-to-end code path for:

`user turn → durable understanding job → schema-constrained claim commit → transactional outbox → embedding/reflection work → canonical World Model retrieval → Context Engine V3 assembly → reasoning/verification → user outcome/correction → next-turn model state`

This implements the blueprint's core requirement that Aqua continuously build, maintain, and apply an evolving model of the user's world.

## Work completed in this pass

### E1 — Platform Safety
- Removed the remaining `before-pr` snapshot files.
- Repository hygiene guard passes.
- Existing prompt-injection fencing and parser safety work preserved.

### E5 — Canonical World Model / Store substrate
- Added canonical async read model over entities, claims, relationships, observations, events, and derived timeline/world statistics.
- Exposed canonical reads through the Brain facade and brain routes behind `AQUA_CANONICAL_READ`.
- Preserved owner scoping, derived confidence, provenance refs, bounded reads, and fail-open semantics.

### E7 — Retrieval V3
- Canonical claim semantic retrieval now prefers PostgreSQL claim embeddings.
- Canonical claim ids are bridged to the existing retrieval keyspace without string identity matching.
- Async Context Engine retrieval now combines canonical lexical, structured, dense, and graph lanes.
- Existing RRF/cross-encoder machinery remains the ranking layer.

### E8 — Context Engine V3
- Added a bounded, deterministic QueryPlan/slot template system.
- Added the three-state sufficiency contract: `sufficient`, `needs_round_two`, `unknown`.
- Added an async production retrieval seam with a maximum of two rounds.
- Required unknowns remain unknown rather than being guessed.

### E9 — Reflection V3
- Canonical inferred-pattern persistence is now implemented.
- Inferred patterns require independent evidence, use `modality='inferred'`, are confidence-capped, and carry provenance.
- Reflection worker can load canonical claims and write inferred pattern claims through the canonical repository.
- Added idempotency protection for repeated pattern writes.

### E12 — Operations / cost visibility
- Provider adapters return normalized usage metadata.
- Provider router records usage into the active turn ledger.
- Chat POST and stream paths create one turn ledger and commit one aggregate cost record.
- Prometheus exposition includes request, provider, memory, E6, cost, durable queue, and DLQ metrics.
- Costs remain `null` when provider/model price data is unknown; the system never reports a false zero.

### E11 — API consolidation
- `/v1` is an alias over the same AQUA route implementation.
- Shared response/error envelope and one route implementation are protected by contract tests.

## Schema now present

The repository contains canonical migrations through:

- `0008_world_model.sql`
- `0009_transactional_outbox.sql`
- `0010_understanding_commit_ledger.sql`
- `0011_owner_structural_fks.sql`
- `0012_dense_retrieval.sql`
- `0013_owner_partition_hnsw.sql`
- `0014_claim_retrieval_bridge.sql`
- `0015_belief_claims.sql`
- `0016_inferred_claims.sql`

These extend the earlier substrate with graph/event/lifecycle/revision/correction, durable outbox and commit ledger, structural owner isolation, pgvector retrieval, retrieval bridging, belief write-back, and inferred-claim support.

## Validation performed

### Passing source-level / focused gates
- `production-loop-doctor`: 12/12 static checks passed.
- Repository hygiene: 4/4 tests passed.
- QueryPlan / E8 contract: 4/4.
- Canonical World Model retrieval contract: 5/5.
- E7 embedding repository: 3/3.
- E9 contradiction policy: 7/7.
- E9 claim→belief adapter: 5/5.
- E9 pattern inference: 2/2.
- E9 reflection delta: 6/6.
- E9 revision feed: 3/3.
- E9 reflection outbox/worker contract: 8/8 + 3/3 + 2/2.
- E11 API surface: 3/3.
- E12 cost accounting: 6/6.
- Flag registry: 8/8 across 3 suites.
- Modified source files pass `node --check`.

### Full battery limitation

A full `npm test` was attempted. It reached 2,086 tests / 262 suites, but the local dependency installation was incomplete after `npm ci` timed out; package directories existed without package payloads (for example `pg-mem`, `uuid`, and other dependencies), producing dependency-resolution failures. The full-battery result therefore must not be treated as a code-quality score.

## Explicit deployment gates that remain human/environment dependent

These are not silently marked complete:

1. **E6 promotion gate:** the blueprint requires negation accuracy ≥0.95. Existing shadow evidence in the blueprint is below that gate. Code remains promotion-gated.
2. **Live Postgres migration/health:** code has the migrations, but this sandbox did not verify a real production database connection.
3. **Embedding backfill:** real production owners still need the embedding worker/backfill to populate claim vectors.
4. **E10 retirement:** JSON/Mongo retirement must follow the blueprint's measured dual-write → drift → read flip → stop old writes → archive protocol.
5. **E12 external exporters:** Prometheus exposition is built in-process. External OTel/error-tracking/Redis services require their corresponding production endpoints/credentials before they can be enabled safely.
6. **Longitudinal product proof:** World-Model Lift, re-explanation-rate trend, correction latency, and long-horizon assistance improvement require real user data and repeated evaluation.

## Environment note

The uploaded production `.env` contains live third-party credentials. They were inspected for feature configuration but are not copied into this bundle. Because the uploaded file exposes credentials, the safest production action is to rotate any credential that has been shared outside the intended secret store.

## PR closure interpretation

There is no `.git` metadata in the uploaded archive, so actual remote GitHub PR creation/merge/closure cannot be performed from this artifact. The implementation itself is packaged below as a source tree plus a unified diff against the uploaded baseline. The status in this report refers to code-level implementation, not remote PR state.
