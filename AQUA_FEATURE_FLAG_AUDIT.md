# Aqua Feature Flag Audit

**Date:** 2026-11-10 · **HEAD:** `839ea0d1` · Part of the [Production Intelligence Audit](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md).

## How to read this

- **Code default** = what the gate's *own read site* resolves to with the variable unset — verified by reading each site and, for the gates marked ✓, by an isolated probe that called the real enable-function (no `.env`, no DB).
- **Registry** = `aqua/src/core/flags.js` `GATES[].dflt`, which drives the `[FLAGS]` boot line and `flagReport()`.
- **Prod status** — no deployment evidence was available (no Render access, no `render.yaml`). The only documented production fact is "legacy read, no `DATABASE_URL`" (`DEMO_RUNBOOK.md`, 2026-10-28). So: **Default-on** = runs in prod unless Render overrides it; **Inert w/o DB** = cannot run in the documented prod config regardless of value; **Off** = off unless Render sets it; **U** = unknown. No flag below is claimed to be set or unset on Render.
- Gate values are matched as exact strings: for most gates `true`, `1`, `yes` all mean **off**.

## 1. Registry defects (verified)

> **Status 2026-11-10 (Sprint 1, uncommitted):**
> - **All corrected:** every row below, plus the case-sensitive `AQUA_SELF_ENTITY` / `AQUA_CANONICAL_IDS` / `AQUA_REL_EVOLVE` and the comma-list `AQUA_CORRECTION_PHRASES` / `AQUA_STORE_PG_READ`.
> - **New gate:** `AQUA_LOG_CONTENT`.
> - **New test:** `flagReadSiteParity.test.js` checks every gate against its real read site.
> - **New status model:** `featureStatus()` separates flag, dependencies and observed execution (off / inert / enabled / active / failing). It appears in a second boot line and in `/provider-health` `features`.
> - Production values remain unverified (D-5).

| Gate | Registry says | Read site actually does | Effect |
|---|---|---|---|
| `AQUA_GRAPH` | off (`=== 'on'`) | `String(env ?? 'on') !== 'off'` → **on** — `routes/chat.js:1323`, `routes/intelligence.js:161` | Task-graph runtime serves agent / multi-part high-complexity turns on `POST /chat`, and `POST /intelligence/orchestrate` is live. Boot line says off. |
| `AQUA_CIE` | off (`=== 'on'`) | `?? 'on'` `!== 'off'` → **on** — `cognition/index.js:50` | Cognitive plan, directive, draft monitor and verification escalation run on every turn. Boot line says off. |
| `AQUA_PROACTIVE` | on | on **and** `isConfigured()` (Postgres) — `brain/proactive/index.js:35` | Reports on; does nothing without a DB. |
| `ARTIFACTS_ENABLED` | *not registered* | `!== 'false'` → on — `routes/chat.js:243` | A behaviour gate outside the registry (registry test only scans `AQUA_*`). |

`flagRegistry.test.js` verifies names in both directions but not defaults, which is why these pass. Fix = assert `resolveGate(g, undefined)` equals the read site's behaviour (see [Roadmap R-2](AQUIPLEX_ENGINEERING_ROADMAP.md)).

## 2. Intelligence gates

Dependencies: **DB** = Postgres (`DATABASE_URL`, migrations); **EMB** = embedding provider key; **LLM** = provider keys; **BRAIN** = `AQUA_BRAIN` not `off`.

### 2a. Read path (context the answer sees)

| Name | Code default | Read site | Main consumers | Depends on | Prod status | When off / unavailable |
|---|---|---|---|---|---|---|
| `AQUA_CANONICAL_READ` | auto → `authoritative` **if DB**, else `legacy` | `brain/index.js:114` | `resolveReadMode` → `chat.js:561`, recall notes, CE `canonicalOnly` | DB, BRAIN | **Inert w/o DB → legacy** (probe ✓) | `off` = legacy rollback; DB unreachable → degraded legacy (logged) |
| `AQUA_CONTEXT_V2` | off ✓ | `brain/contextEngine/index.js:137` | `chat.js:660` (CE V2 assembler, query plan, sufficiency, "Not known") | BRAIN; canonical lanes need DB | Off | PIC floor only |
| `AQUA_RETRIEVAL_V3` | off | `contextEngine/index.js:141` | RRF fusion inside CE V2 | CONTEXT_V2 | Off | V2 scorer order |
| `AQUA_CROSS_ENCODER` | off | `chat.js:659`, `crossEncoderLocal.js` | rerank inside V3 | V3, local model | Off | no rerank |
| `AQUA_CANONICAL_RELEVANCE_GATE` | on | `contextEngine/index.js:145` | canonical lanes admit only on-question claims | CONTEXT_V2 + DB | Inert w/o DB | admits everything reached |
| `AQUA_WORLD_CORE` | on ✓ | `brain/index.js:1124` | current-world section in CE | CONTEXT_V2 + DB | Inert w/o DB | no world-core section |
| `AQUA_PIC` | on ✓ | `pic/core.js:68`, `memory/memoryEditor.js:43` | PIC floor retrieval (`chat.js:658`) | — | **Default-on** | empty knowledge block |
| `AQUA_EPISODIC_RECALL` | on ✓ | `memory/episodicRecall.js:53` | `chat.js:755` verbatim past messages | — | **Default-on** | no recall block |
| `AQUA_SEMANTIC_RECALL` | off | `memory/semanticRecall.js:64` | recall ranking beyond the 8k window | EMB + `AQUA_EMBEDDING_API_KEY` | Off | keyword ranking ([F-05](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-05)) |
| `AQUA_RECALL_FOLLOWUP_V2` | off | `memory/followUpRelevance.js:52` | recall follow-up selection | — | Off | legacy follow-ups |
| `AQUA_MIND_RELEVANCE` | off ✓ | `mind/mindRetriever.js:39` | question-scoped goals/blockers/deadlines/predictions (`:202-262`) | (EMB for meaning) | Off | broad block every turn ([F-06](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-06)) |
| `AQUA_EMBEDDINGS` | on | `embeddings/embeddingProvider.js:39`, `dedicatedEmbedder.js:34` | fact/file/canonical semantic scores | EMB key | Default-on (needs key) | keyword only |
| `AQUA_REVISION_VOICE` | `canonical` | `brain/index.js:878` | `revisionDirectiveForTurn` (`chat.js:816`) | DB + E6 commit for canonical; `=on` adds unevaluated legacy ledger voice | **Inert w/o DB** | '' |
| `AQUA_PROACTIVE` | on (needs DB) ✓ | `brain/proactive/index.js:35` | `proactiveDirectiveForTurn`, `/brain` routes, worker scan | DB | **Inert w/o DB** | '' |
| `AQUA_CIE` | **on** ✓ (registry wrong) | `cognition/index.js:50` | `cognitivePrepare`, `cognitiveKnowledgeRetrieve` broaden, `observeDraft` escalation | — | **Default-on** | pass-through |
| `AQUA_ANSWER_SCAFFOLD_GUARD` | on | `core/reasoningStrategy.js` | "stages are for thinking" sentence in directives | — | Default-on | previous directive text |
| `AQUA_GRAPH` | **on** ✓ (registry wrong) | `chat.js:1323`, `intelligence.js:161` | task-graph runtime (`/chat` only, not stream) | LLM | **Default-on** | single call |

### 2b. Write path (what Aqua learns)

| Name | Code default | Read site | Main consumers | Depends on | Prod status | When off / unavailable |
|---|---|---|---|---|---|---|
| `AQUA_BRAIN` | on (kill switch) | `brain/worldModel/schema.js:204` | every Brain function, `canonicalReadMode` | — | Default-on | all Brain features off |
| `AQUA_BRAIN_INGEST` | off ✓ | `brain/knowledgeExtraction/conversationIngest.js:76` | `runPostTurn` → `observeConversationTurn` (conversation → evidence store + graph) | BRAIN | Off | evidence lane holds file facts only |
| `AQUA_BRAIN_INGEST_FACTS` | off ✓ | `conversationIngest.js:86` | sentence facts from chat | BRAIN_INGEST | Off | entities only (when ingest on) |
| `AQUA_E6` | off ✓ | `brain/index.js:1211` | `runPostTurn` → `understandTurn` / `understanding.turn.v1` job | LLM; commit needs DB | Off | no LLM understanding |
| `AQUA_E6_COMMIT` (setting) | follows `AQUA_E6` | `brain/index.js:1589` | canonical claim commit | DB | Off | extraction without commit |
| `AQUA_E6_MINT`, `AQUA_E6_SINGLE_VALUED` (settings) | follow E6 / on | `brain/index.js` | entity minting; single-valued supersession | E6 | Off with E6 | — |
| `AQUA_E6_ACTOR_RETRY` | on | `brain/understanding/pipeline.js` | one retry when a named actor is missing | E6 | Off with E6 | no retry |
| `AQUA_E6_COMPOUND_RETRY` | off | `pipeline.js` | retry on unclaimed change clause | E6 | Off | — |
| `AQUA_SELF_ENTITY` | off | `brain/identity/selfEntity.js:66` | first-person resolution for E6/S6 | E6 | Off | first person unresolved |
| `AQUA_CLAIMS_SHADOW` | off | `core/claims/shadowMode.js` | claim parity projection after ingest | DB | Off / inert w/o DB | — |
| `AQUA_CLAIM_STRICT_PREDICATES` | off (`=== '1'`) | `core/claims/predicateRegistry.js` | predicate validation strictness | — | Off | lenient |
| `AQUA_CANONICAL_IDS` | off | `brain/worldModel/projection.js` | canonical entity ids in projection | — | Off | legacy ids |
| `AQUA_PROPAGATION` | off ✓ | `memory/propagation.js` | engine steps 4b/5b, Mind reconcile, evidence propagation, sweeper (`router.js:79`) | — | Off | fact changes do not reach Mind/graph/evidence ([Knowledge §4](AQUA_KNOWLEDGE_ARCHITECTURE_AUDIT.md)) |
| `AQUA_CORRECTION_PHRASES` | unset (list) | `memory/memoryConflictResolver.js:26` | extra correction phrases | — | U | built-in phrases |
| `AQUA_UUS` | off ✓ | `understanding/flags.js:27` | interview mode, observe-ingest, conversationIngest, Mind observers | — | Off | no Understanding UX |

### 2c. Reflection, twin, maintenance, reasoning

| Name | Code default | Read site | Consumers | Depends on | Prod status | When off |
|---|---|---|---|---|---|---|
| `AQUA_REFLECT_V2` | off ✓ | `brain/reflectionV2/index.js:54` | gates **apply** of `reflectWorldModel`; snapshot/diff still computed every 8 msgs ([F-18](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-18)) | BRAIN | Off (compute runs) | delta not applied |
| `AQUA_TWIN_V2` | off ✓ | `brain/digitalTwin/index.js:42` | `observeTwin` post-turn, `/brain` twin view | BRAIN | Off | skipped |
| `AQUA_CONSOLIDATE` | off ✓ | `pic/core.js:81` | `runPostTurn` consolidation every N turns | PIC | Off | — |
| `AQUA_REL_EVOLVE` | off | `reasoning/reasoningGraph.js:127` | relationship evolution | — | Off | — |
| `AQUA_GRAPH_STRICT_TYPES` | off (`'1'`) | `reasoning/typeRegistry.js` | reasoning-graph typing | — | Off | lenient |
| Reflection V3 / contradiction / consolidation workers | no flag — worker + DB | `core/jobs/workerRuntime.js` | durable jobs | DB | **Inert w/o DB** | — |

### 2d. Store and platform gates that affect intelligence

| Name | Code default | Read site | Effect | Prod status |
|---|---|---|---|---|
| `AQUA_STORE_PG` | off (`'shadow'`) | `core/storage/index.js:93` | shadow-write JSON stores to Postgres blobs | Inert w/o DB |
| `AQUA_STORE_PG_READ` | off | `core/storage/index.js` | read stores from Postgres | Inert w/o DB |
| `AQUA_DISABLE_MONGO_MIRROR` | off (`'1'` disables) | `core/mongoMirror.js` | durable copy of all JSON stores on Render | Default-on (mirror active) |
| `AQUA_MIRROR_ROLE` (setting) | writer on Render, reader elsewhere | `core/mongoMirror.js` | only the deployment writes the mirror | — |
| `AQUA_PARSE_WORKER` | on | `upload/boundedParse.js` | isolated parsing of uploads | Default-on |
| `AQUA_MIND_VIEW` | off (`'1'`) | `mind/mindRoutes.js:86` | debug Mind HTML view | Off |
| `AQUA_PROVIDER_LOG` | off (`'debug'`) | `providers/router.js`, `core/health.js` | provider debug logging | Off |

## 3. Observations

1. **The production configuration is undocumented and unverifiable from the repo.** The single most valuable 5-minute action is to copy Render's `[FLAGS]` boot line and `/api/aqua/provider-health` read-mode into the repo — after fixing §1, because today that boot line would say CIE and GRAPH are off when they are on.
2. **Two configurations, one product.** The founder's local `.env` sets 12 of these gates on and has a database; production (documented) has neither ([F-03](AQUIPLEX_PRODUCTION_INTELLIGENCE_AUDIT.md#f-03)). Every "it works on my machine" observation about understanding is about the other configuration.
3. **Default-off is the norm for everything that would change understanding quality** (E6, ingest, propagation, Mind relevance, semantic recall, CE V2), each for a documented reason (no measured benefit yet, provider cost, privacy of sending messages to an embedder). The roadmap treats each as a decision with evidence attached rather than a switch to flip ([Roadmap](AQUIPLEX_ENGINEERING_ROADMAP.md#decisions)).
4. **Exact-string matching is a trap.** `AQUA_E6=true` is off. `flagReport()` exposes the raw value; the boot line should too for any gate whose raw value is set but not one of its accepted strings.
