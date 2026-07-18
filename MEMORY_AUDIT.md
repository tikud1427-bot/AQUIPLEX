# MEMORY_AUDIT.md — AQUA Memory Stack, Full Audit

Date: 2026-07-17. Scope: every module touching memory, chats, retrieval, embeddings, identity, files, project intelligence, persistence, APIs. Baseline: **136/136 tests pass** (`src/memory`, `src/mind`, `src/embeddings`).

---

## 1. Current Architecture (as-built, v4 "unified")

```
routes/chat.js
   │  imports ONLY memory/engine.js (the facade)
   ▼
memory/engine.js
   ├─ resolveOwner()        ownerResolver.js   user:<id> | conv:<id> (+adoption)
   ├─ memoryObserve()       extract → conflict-resolve → store → mind observe
   │     memoryExtractor → sentenceParser → candidateExtractor →
   │     entityNormalizer → duplicateDetector → memoryResolver →
   │     longTermMemory.storeFacts (conflict resolver, history, confidence)
   │     └→ mind/index.mindObserve: beliefs, goals, working, episodes, graph
   │     └→ fire-forget indexOwnerFacts() (embeddings)
   ├─ memoryRetrieve()      identity-first bypass → ranked facts (keyword +
   │     semantic cosine blend, directed-intent gate) → cognitive block
   │     (mindRetriever) → file-summary block → ONE 800-token budget
   ├─ memoryAfterTurn()     turnCount++, predictions rebuild, reflection@8 turns
   ├─ rememberFile / rememberWorkspace   uploads → mind.files + graph node
   └─ getMemoryTrace()      per-request trace ring (Memory Inspector, 100 max)

PERSISTENCE (all: in-proc Map + debounced atomic JSON + mongoMirror durability)
   .aqua-mind.json       mindStore — facts, files, beliefs, goals, episodes,
                         graph, timeline, working, predictions, reflections
   .aqua-history.json    conversationStore (L1 buffer, 5000 msg hard cap)
   .aqua-projects.json   projectMemory (workspace index cache — rebuildable)
   .aqua-vectors.json    vectorStore (namespaced fact vectors, cap 500/ns)
   Mongo `aqua_kv`       mirror: hydrate@boot, mirror@write, drain@SIGTERM,
                         canary, 16MB chunking, writer heartbeat
```

## 2. Layer-by-layer vs "Memory 5.0" spec

| Spec layer | Status | Where | Verdict |
|---|---|---|---|
| L1 Conversation buffer | ✅ | conversationStore + buildContextWindow | solid; orphan/reuse bugs fixed v3 |
| L2 Working memory | ✅ | mind/workingMemory (focus/blockers/deadlines/discoveries/questions, 36h half-life) | solid |
| L3 Semantic memory (facts) | ✅ | longTermMemory v4: confidence, supportCount, contradiction penalty, revision history, provenance | strong; **history unbounded (bug)**, facts never decay |
| L4 Episodic | 🟡 | episodeTracker: themed arcs, outcomes, idle-close | exists; **not query-searchable** |
| L5 Project memory | 🟡 | projectMemory = index cache; workspace node in graph | **no decisions/blockers/debt records** |
| L6 Relationship graph | 🟡 | relationshipGraph: typed weighted nodes/edges, prune | populated; **retrieval never traverses it** (only 1-hop SELF neighborhood in cognitive block) |
| L7 Procedural | ✅ | belief dims COMMUNICATION/BEHAVIOR/DECISION + EWMA-style confidence | good coverage |
| L8 File memory | 🔴 | rememberFile: 280-char summary + refCount only | **content unrecoverable after the turn** — no chunk index, no entities |
| L9 Reflection | 🟡 | reflectionEngine@8 turns: belief decay/promote/archive, goal staling, episode close, graph prune, TTL | **no fact dedupe-merge, no insight generation, no fact importance recompute** |
| L10 Predictive | ✅ | predictionEngine heuristics (deadlines/blockers/momentum/goals/focus) | works; **no "continue" intent fast-path** |
| Importance engine | 🔴 | fact.importance static from extraction | never recomputed (recency/frequency/graph degree/retrieval usage ignored) |
| Memory decay (facts) | 🔴 | beliefs decay; facts immortal | no cold storage/archive for facts |
| Hybrid search | 🟡 | keyword multi-dim + cosine blend, directed-intent gate | facts only — **no graph/episode/timeline/file lanes, no unified recall API** |
| Self-learning | 🟡 | learningLedger (provider routing EWMA) | retrieval quality has no feedback loop |
| Observability | 🟡 | trace ring, logMemoryEvent, getMetrics | **no memory hit/miss/latency counters** |
| Security | ✅ | owner isolation everywhere, GDPR deleteMind/clearFacts, IDOR fixed earlier | no encryption-at-rest (host-level concern) |

## 3. Strengths
- **One facade, one owner model, one budget, one store.** v4 unification is real: no route reaches past engine.js; conv→user adoption preserves pre-login memory.
- **Conflict resolution is genuinely good**: contradiction-damped confidence, support reinforcement, corrections exempt, full revision history, per-request explainability (Inspector).
- **Identity ≠ recall**: canonical identity card bypasses ranking/budget — "what's my name" can never lose to noise.
- **Fail-open everywhere**: every stage degrades to neutral; chat cannot break on memory. Embeddings absent → byte-identical pre-Phase-2 behavior.
- **Durability**: atomic temp+rename, .bak recovery, Mongo mirror w/ canary + chunking + dual-writer alarm. Deploy-loss root cause fixed.
- **Zero new deps**; every store documents its single swap-seam.

## 4. Weaknesses (ranked)
1. **File content amnesia (L8).** Upload a PDF today, ask about its contents tomorrow → only a 280-char summary survives. Biggest gap vs ChatGPT/Claude-class memory.
2. **Graph is write-only.** Multi-hop knowledge (user→Aquiplex→AQUA→Node.js) is stored but never used to answer queries.
3. **Episodes are write-only.** "What did we decide about X last month" cannot be answered.
4. **Facts immortal + static importance.** No decay, no archive, no importance recompute → long-lived owners will accumulate noise that competes for the 800-token budget.
5. **fact.history unbounded** — CAPS.HISTORY_PER_ITEM=10 defined but never enforced in longTermMemory. Slow store bloat. (Confirmed bug.)
6. **No unified recall API** for frontend/agents (facts endpoint only).
7. **No memory metrics** (hit/miss/latency) despite observability infra existing.

## 5. Scalability & performance
- Current tier: in-proc Maps, debounced whole-file JSON, single writer. **Fine to ~10⁴ owners / ~10⁷ small records per instance; NOT a 100M-user design** — and honestly shouldn't be today. Every store already isolates its swap seam (mindStore, vectorStore, conversationStore, projectMemory each = one file to port to Postgres/pgvector). See DATABASE_MIGRATION_PLAN.md.
- Retrieval is O(facts) linear scan per turn — fine ≤ ~2k facts/owner; archive tier (Phase A) keeps the active set small.
- Write path already async (debounce + mirror fire-forget). Reflection already off-turn (setImmediate).
- Mongo mirror is whole-file last-writer-wins → **single-instance only** (heartbeat alarms on scale-out; correct current posture, documented).

## 6. Security risks
- Owner isolation solid; legacy conversation routes resolve true owner first. ✔
- vectorStore/file chunks (Phase D) must stay namespaced by ownerId — enforced by design below.
- Mirror stores plaintext JSON in Mongo — same trust domain as sessions/billing; acceptable, note for enterprise tier.

## 7. Future limitations
- Heuristic-only extraction (regex/schema) misses free-form facts; acceptable tradeoff (zero-LLM, deterministic, testable). LLM-assisted extraction can slot in behind memoryExtractor later without schema change.
- Embedding provider = Gemini only; provider seam exists (`__setEmbedderForTests` pattern generalizes).

## 8. Verdict
Foundation is **strong and unusually clean** — do not rebuild. Memory 5.0 = seven additive phases (A–G, see IMPLEMENTATION_PLAN.md): fact lifecycle + importance engine, graph recall, episodic recall, file content memory, reflection 2.0 (merge+insights+history cap fix), continuation fast-path, unified recall API + metrics. All extend the existing facade; zero API breaks; zero new deps.
