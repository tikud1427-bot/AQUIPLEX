# AQUIPLEX — Deep Codebase Audit vs Technical Blueprint V2

Date: 2026-09-13
Audited runtime tree: `aqua/` (the ESM AQUA engine mounted by the platform at `/api/aqua`)
Blueprint: `AQUIPLEX_BLUEPRINT_V2.md`

## Executive verdict

The codebase is materially ahead of the blueprint's written "today" snapshot in the storage substrate and E7 retrieval work. The blueprint is therefore stale in several CURRENT/TARGET labels, although its architectural direction remains correct.

The most important finding is not missing architecture; it is **integration/cutover**. The canonical Postgres world-model substrate has now reached migrations 0008–0011, including edges, events, lifecycle transitions, revisions, corrections, transactional outbox, durable E6 commit ledger, and structural owner FKs. These are real schema/code assets, but most production reads/writes still remain on the legacy JSON/Mongo path.

## Runtime topology finding

There are two near-duplicate source trees: root `src/` and `aqua/src/`. The actual platform server dynamically mounts `aqua/router.js`, so `aqua/` is the runtime engine. The root `src/` is a stale duplicate/compatibility tree. This creates a high regression risk because tests and developers can modify/test the wrong copy.

Recommendation: make `aqua/` the single authoritative engine tree, then either retire the root `src/` copy or turn it into explicit compatibility shims. Do not continue feature development in both trees.

## Blueprint scorecard

| Area | Current assessment | Verdict |
|---|---|---|
| Architecture laws L1–L20 | Strong coverage in code/tests | GREEN |
| E2 Evaluation | Harness present and used | GREEN |
| E3 Storage substrate | Postgres + blob shadow + drift + versioning | GREEN/AMBER: cutover incomplete |
| E4 Jobs/Event Bus | Durable jobs + transactional outbox now exist | GREEN/AMBER: consumer fan-out/DLQ/ops incomplete |
| E5 World Model | Entities/claims/evidence/edges/events/revisions/corrections schema + repository | AMBER: population/cutover incomplete |
| E6 Understanding | Full pipeline + real Groq shadow eval | AMBER: promotion gate still blocked by negation |
| E7 Retrieval | Local semantic lane + RRF + graph lane + cross-encoder exist; Postgres dense substrate now added | AMBER: canonical PG dense wiring/HNSW/ablation/flag rollout incomplete |
| E8 Context V3 | `questionShape.js` + new bounded QueryPlan/scaffold foundation | AMBER/RED: slot retrieval loop and sufficiency integration not yet wired |
| E9 Reflection V3 | Pre-migration V2 reflection live | RED for V3 |
| E10 Store Unification | Not started as full cutover | RED |
| E11 API consolidation | Not started | RED |
| E12 Observability | Mostly ad hoc | RED |
| Agents | Deliberately not started | CORRECT — do not build yet |

## Critical findings

### P0 — Test/runtime packaging inconsistency

The root package is CommonJS while root `src/` and `eval/` contain ESM `.js` tests/modules. A direct root `npm test` therefore fails at module loading rather than exercising the intended test battery. The actual `aqua/` package is correctly ESM.

This should be fixed as a repository-layout issue, not by changing the runtime architecture. The authoritative `aqua/` test command should be the release gate until the duplicate tree is retired.

### P1 — Blueprint status is stale

The blueprint says 0008+ are TARGET/not migrated, but the current tree contains migrations 0008–0011 and a canonical `worldModelRepository.js` that writes edges/events/lifecycle/revisions/corrections and the transactional outbox. The blueprint should be re-baselined from the tree before the next planning cycle.

### P1 — E7 has real code beyond the blueprint snapshot

The current runtime contains:
- dense semantic candidate proposal logic;
- RRF fusion;
- graph reach;
- semantic keyspace correction;
- a bounded cross-encoder adapter and local Transformers.js implementation;
- E7 retrieval tests;
- a 2.5 MB dense retrieval fixture;
- E7 local cross-encoder smoke tooling.

The missing production substrate was canonical Postgres vector persistence and a compliant HNSW strategy. This audit begins that work.

### P1 — L13 dark flags existed

`AQUA_RETRIEVAL_V3` and `AQUA_CROSS_ENCODER` were read by runtime code but were not in the flag registry. That violated the blueprint's no-dark-stage rule. The registry now includes them and the related cross-encoder tuning settings; the registry census is updated and its tests pass.

### P1 — E7 HNSW vs L19 needs an explicit structural decision

A global pgvector HNSW index cannot put `owner_id` before the vector operator class. Creating one globally would conflict with the blueprint's strict structural owner-isolation law. The new dense migration therefore creates the owner-leading lookup indexes and deliberately defers HNSW until the embedding table is owner-hash-partitioned, at which point HNSW can be created per partition. This is preferable to silently violating L19.

### P2 — E8 needed a real scaffold

`questionShape.js` existed, but the slot system and sufficiency contract were absent. A pure `queryPlan.js` foundation is now present with:
- task-specific answer scaffolds;
- required/optional slots;
- typed candidate matching;
- bounded two-round sufficiency outcomes;
- honest `unknown` after the second round.

It is intentionally not yet wired as the production retrieval loop; doing so before E7 canonical retrieval is stable would violate the dependency ordering in the blueprint.

## Changes made in this audit

1. Added `src/core/db/migrations/0012_dense_retrieval.sql`.
   - pgvector + btree_gin extensions;
   - owner-scoped canonical embedding index;
   - model signature + content hash;
   - structural FK from embedding target to canonical claim;
   - owner-leading lookup indexes;
   - canonical claim lexical GIN lane;
   - explicit HNSW deferral until owner partitioning preserves L19.
2. Added `src/core/worldModel/embeddingRepository.js`.
   - strict vector validation;
   - model-stamped upsert;
   - owner-scoped dense scoring;
   - bounded top-k;
   - derived-index removal;
   - embedding count.
3. Added `src/core/worldModel/embeddingRepository.test.js`.
4. Added `src/brain/contextEngine/queryPlan.js`.
5. Added `src/brain/tests/queryPlan.test.js`.
6. Added missing E7-related flag registry entries and updated census tests.
7. Expanded `/brain` route flag reporting to expose all registered gates while preserving existing boolean keys.
8. Mirrored the above changes into the duplicate root `src/` tree only to prevent immediate divergence while the single-source cleanup is pending.

## Verification performed

Targeted tests after the changes:

- E7 retrieval V3: **7/7 pass**
- E7 cross-encoder adapter: **4/4 pass**
- E7 semantic keyspace tests: **6/6 pass**
- E7 Postgres dense substrate: **3/3 pass**
- E8 QueryPlan: **4/4 pass**
- Flag registry: **5/5 pass**

The full suite cannot currently be treated as a clean baseline because the supplied archive's dependency installation was incomplete in the audit runtime. The broad AQUA engine run reached 1,934 tests with 1,710 passing before dependency/module failures; those failures included missing/broken installed packages such as `uuid`, `@google/genai`, `openai`, and `adm-zip`. They are environment/install failures, not evidence that 224 application assertions are wrong.

## Next implementation order

1. Finish E6 measurement first: run the prescribed repeated negation evaluation and only then promote E6 if the declared gate is actually met.
2. Complete E7 canonical PG retrieval bridge: map authoritative claim ids to the retrieval candidate identity without inventing a second identity key.
3. Owner-partition the embedding table and add per-partition HNSW; then run true dense/lexical/graph/structured ablations.
4. Wire E8 QueryPlan into a two-round slot retrieval loop and sufficiency gate.
5. Begin E9 V3 reflection only after E5/E6/E7/E8 have real canonical data flowing.
6. Only after World-Model Lift and re-explanation metrics show improvement: E10/E11/E12 and later agents.

## Explicitly not recommended now

- Do not build autonomous agents.
- Do not add more model providers merely for feature breadth.
- Do not create another memory/knowledge store.
- Do not make the LLM responsible for lifecycle/policy decisions.
- Do not globally enable E6/E7/E8 from this audit without their declared evaluation gates.
