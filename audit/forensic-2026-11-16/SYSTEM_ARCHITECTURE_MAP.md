# AQUIPLEX — System Architecture Map (as executed)

Audit date: 2026-11-16 · Branch `main` @ `d3e3d6bd` plus the uncommitted working tree · Investigation only: no source file was changed.

Evidence levels used in all ten reports:

| Level | Meaning |
|---|---|
| **REPRODUCED** | Executed in isolation in this audit (scratch data dir, no DB/Mongo env, no provider calls). The output is quoted. |
| **SOURCE-CONFIRMED** | Read in the executed code path, with the call chain traced. Not executed. |
| **CONFIG-INDICATED** | Read from the repository's `.env` (non-secret flag names only). This is the launcher's configuration, **not proven to be production's**. |
| **HYPOTHESIS** | Consistent with the evidence but not proven. The runtime evidence that would settle it is named. |
| **NOT AUDITED** | Not inspected deeply enough in this pass to make claims. |

---

## 1. Process topology

```
Browser SPA (aqua-frontend, Vite/React)
   │  POST /api/aqua/chat/stream  { message, conversationId, workspaceId?, mode? }
   ▼
index.js (Express, CommonJS)                      ── platform: auth, sessions, billing (MongoDB)
   ├─ engineLimiter / engineReadLimiter
   ├─ requireLogin                                ── session required (index.js:665-676)
   ├─ req.aquaUserId = session.userId
   ├─ attachAquaSettings (rememberSensitive)
   ├─ aquaEngine: usageGuard('chat_message')      ── debit on entry, refund net on status ≥ 400
   └─ aqua/router.js (ESM, dynamically imported)
        ├─ runWithWriteScope + responseGate       ── Phase 4A: response held until writes durable
        ├─ ensureOwnerLoaded (only if a partition store is authoritative)
        └─ /chat  → aqua/src/routes/chat.js
```

Boot side effect (SOURCE-CONFIRMED): `aqua/src/core/dataDir.js` resolves `DATA_DIR` (`AQUA_DATA_DIR` → `~/.aquiplex` → `./.aquiplex-data`), then `await hydrateFromMongo(DATA_DIR)` **before any store module loads**. Every JSON store's `loadFromDisk()` therefore reads what the Mongo mirror restored.

## 2. Persistence substrates (five, concurrently)

| Substrate | What lives there | Write path | Read path |
|---|---|---|---|
| **In-process `Map`s** | Conversations (`conversationStore.store`), Mind, PIC, evidence, vectors, ledger, ... | synchronous mutation | synchronous; **the authoritative read for chat history** |
| **JSON files in `DATA_DIR`** (20 stores: `.aqua-history.json`, `.aqua-memory.json`, `.aqua-mind.json`, `.aqua-pic.json`, `.aqua-evidence.json`, `.aqua-vectors.json`, `.aqua-ledger.json`, `.aqua-attachments.json`, ...) | Snapshot of each Map | `createDebouncedWriter` (500 ms debounce, whole-file atomic rewrite; 22 writers) | boot only (`loadFromDisk`) |
| **MongoDB `aqua_kv`** (mirror) | Whole-file copy of every JSON store | `mirrorWrite()` after each flush, fire-and-forget, re-queued on failure | boot hydration only |
| **MongoDB (platform)** | Users, sessions, billing/credits | platform services | platform services |
| **PostgreSQL** (`DATABASE_URL`) | Canonical World Model (claims/evidence), store partitions (`aqua_store_partitions`), job queue, pending charges | `core/db/pool.js` | Brain read model, partitions, workers |

`.env` (CONFIG-INDICATED) sets `DATABASE_URL=postgresql://…@localhost:5432/aqua`, matching the production log's `ECONNREFUSED localhost:5432`. When nothing listens there, every PostgreSQL-backed subsystem degrades (see STORAGE_AND_DURABILITY_AUDIT.md).

## 3. The chat turn: stage map

`prepareTurn()` (`aqua/src/routes/chat.js:430-975`) is shared by `POST /chat` and `POST /chat/stream`.

| # | Stage | Module | Uses conversation history? |
|---|---|---|---|
| 1 | Owner resolve | `memory/engine.js resolveOwner` | — |
| 1a | Sensitive policy | `memory/sensitivity.js` | no |
| 1b | Async starts: semantic fact scores, canonical semantic scores, file chunks, recall vector | `memory/engine.js`, `brain/index.js` | **no (raw message)** |
| 2 | Classify | `core/classifier.js classifyTask` | **no** |
| 2a | Observe (memory write) | `memory/engine.js memoryObserve` | no |
| 2b | Orchestrate (profile, budget, verify decision) | `orchestrator/toolOrchestrator.js` | **no** (uses the global learning ledger) |
| 2c | Internal Intelligence Engine (optional reasoning pass) | `intelligence/internalIntelligenceEngine.js` | **no** |
| 2d | CIE plan + directive | `cognition/index.js` | **no** |
| 3 | `memoryRetrieve` (legacy facts + Mind) | `memory/engine.js` | **no** |
| 5b | Project retrieval | `project/projectRetriever.js` | no |
| 5c | Attachments (this conversation) | `upload/attachmentStore.js` | conversation-scoped |
| 5c¹ | **History window** `getConversation` → `buildContextWindow` | `memory/conversationStore.js`, `core/tokenManager.js` | **yes. The only stage that reads history.** |
| 5c¹ | Information-needs / hybrid (flags off by default) | `brain/contextEngine/informationNeeds.js` | no (excludes window from its index) |
| 5c² | Knowledge: PIC floor, or **Context Engine V2 + E8 rounds + World Core** when `AQUA_CONTEXT_V2=on` | `cognition` → `pic`, `brain/contextEngine/*` | **no (raw message)**; `conversationFocus` only re-uses World-Model entity UUIDs |
| 5d | Web search (orchestrator-gated) | `search/searchAgent.js` | no |
| 5d² | Episodic recall (other conversations) | `memory/episodicRecall.js` | excludes the window |
| 6 | System prompt | `core/promptBuilder.js` | — |
| 7 | `optimizeContext([...window, user])` → `messages` | `core/contextOptimizer.js` | yes |
| 8 | Generate: `generateText` / `generateTextStream`, or graph runtime / artifact / edit branches | `providers/router.js`, `orchestrator/graphRuntime.js` | single-call path **yes**; graph runtime **no** |
| 8a² | CIE draft monitor (may escalate to verification) | `cognition/reasoningMonitor.js` | no |
| 8b | Verification / debate (may **replace** the answer) | `intelligence/verificationAgent.js`, `debateAgent.js` | **no** |
| 9 | Persist user + assistant (final, possibly revised) | `conversationStore.addMessage` or `commitTurnWithLearning` | — |
| 10 | Post-turn learning (Mind, World-Model ingest, Twin, Reflection) | `routes/turnPostProcess.js` | turn only |

**Central architectural fact (SOURCE-CONFIRMED):** of roughly fifteen stages that shape an answer, exactly one (the history window that feeds the drafter's `messages`) sees the previous turns. Every retrieval lane, every classifier, the planner, the reasoning pass, the graph runtime and both reviewers see only the current message. Several of those stages can inject instructions or rewrite the answer.

## 4. Prompt assembly order (drafter)

`buildSystemPrompt` (`core/promptBuilder.js:89-165`):

1. `prompts/system.txt`
2. `INSTRUCTION_HIERARCHY` (untrusted-content rules)
3. Identity block (compact, or full on self-questions)
4. `memoryBlock` (memoryRetrieve output)
5. Reasoning directive (Phase 4 + CIE + interview + revision voice + proactive)
6. IIE synthesis text
7. **`combinedContext` = attachments + project + knowledgeContext (Context Engine block) + recall**, fenced as UNTRUSTED CONTENT
8. Web search block (fenced)
9. Task module (`coding.txt`, `research.txt`, …)

The provider then receives `[system, ...window, {user: current}]`. All four adapters (`groq`, `gemini`, `openrouter`, `nvidia`) map `messages` 1:1 to `{role, content}` (SOURCE-CONFIRMED).

## 5. Feature flags that change the executed path

| Flag | Default in code | `.env` (CONFIG-INDICATED) | Effect |
|---|---|---|---|
| `AQUA_BRAIN` | on | — | Brain/World Model on |
| `AQUA_CONTEXT_V2` | **off** | **on** | Context Engine V2 + E8 query plan + World Core replace the PIC floor |
| `AQUA_RETRIEVAL_V3` | off | on | RRF fusion over lanes |
| `AQUA_E6` | off | on | Semantic understanding on the turn path |
| `AQUA_CIE` | on | — | Cognitive plan, directive, draft monitor |
| `AQUA_WORLD_CORE` | on | — | Appends the user's current world (Postgres) |
| `AQUA_CANONICAL_READ` | authoritative (if DB configured) | — | Degrades to legacy when the DB is unreachable |
| `AQUA_COST_AWARE_REVIEW` | on | — | Narrows low-confidence verification |
| `AQUA_STORE_PARTITIONS` | off | — | History/Mind/... on Postgres partitions |
| `AQUA_GRAPH` | on | — | Task-graph runtime for `agent_task` / numbered high-complexity asks |

Production evidence that Context V2 is on: the production warning `[BRAIN] world core unavailable` is emitted only inside `withWorldCore`, which is reached only from `assembleContextAsync` (`brain/index.js:1189, 1241`), which chat.js calls only when `Brain.contextV2Active()` (`chat.js:746`). So **production runs Context Engine V2** (SOURCE-CONFIRMED inference from the reported log line).

## 6. Subsystem status classification

| Subsystem | Status | Basis |
|---|---|---|
| Conversation history (JSON + Map) | **Implemented; single-instance only** | SOURCE-CONFIRMED |
| History partitions (Postgres) | Implemented, off by default | SOURCE-CONFIRMED |
| Drafter receives history | **Implemented and working** on the single-call path | SOURCE-CONFIRMED |
| Pronoun / follow-up resolution for retrieval | **Missing** (only World-Model entity carry-over) | SOURCE-CONFIRMED |
| Context Engine V2 / E8 | Implemented; **mis-scoped for general questions** | REPRODUCED |
| World Core | Implemented; **degraded** (DB unreachable) | Production log + source |
| Canonical read (authoritative) | Implemented; **degraded to legacy** | Production log + source |
| Verification / debate | Implemented; **history-blind** | SOURCE-CONFIRMED |
| Learning ledger → verification | Implemented; global across users | SOURCE-CONFIRMED |
| Mongo mirror | Implemented; production reported **unverified** | Production log + source |
| Mind, Reflection V2, E6, PIC internals, file extraction | Present; **NOT AUDITED in depth** in this pass | — |
