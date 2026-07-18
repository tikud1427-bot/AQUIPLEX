# IMPLEMENTATION_PLAN.md — Memory 5.0

Rule per phase: implement → targeted tests → run FULL memory/mind/embeddings suite → next. Any red = stop, fix. No placeholders.

| Phase | Scope | Files touched | New tests |
|---|---|---|---|
| **A** Fact lifecycle + Importance Engine | computeImportance (recency/frequency/retrieval-usage/graph-degree/pinned); retriever touches top-K (`retrievalCount`,`lastRetrievedAt`); reflection recomputes importance, archives stale-low-value non-identity non-pinned facts, reactivation on re-store; **fix: enforce HISTORY_PER_ITEM cap on write** | +`memory/importanceEngine.js`; edit `longTermMemory.js`, `memoryRetriever.js`, `reflectionEngine.js` | `memory/tests/importance.test.js` |
| **B** Graph recall | query-seeded weighted BFS ≤2 hops → "RELATED KNOWLEDGE" path lines; budget-gated; trace `graphPaths` | +`mind/graphRecall.js`; edit `engine.js` | `mind/tests/graphRecall.test.js` |
| **C** Episodic recall | scored past arcs (title/objectives/lessons/outcome tokens + recency + importance); past-tense trigger patterns; "PAST EPISODES" block | +`mind/episodeRecall.js`; edit `engine.js` | `mind/tests/episodeRecall.test.js` |
| **D** File content memory | chunker (≈700 chars, ≤30/file) → embed → vectorStore ns `files:<owner>` with `meta:{text,fileKey,idx}`; `fileChunkScores`; engine injects top-2 chunks on file intent/semantic hit; upload route passes `content` (additive param) | +`embeddings/fileMemory.js`; edit `vectorStore.js` (meta passthrough), `engine.js` (rememberFile `content` opt), `routes/upload.js` (3 call sites) | `embeddings/tests/fileMemory.test.js` |
| **E** Reflection 2.0 | duplicate-value fact merge into canonical key (resolveCanonicalKey); insight beliefs from repeated blockers/discoveries (≥3 occurrences → BEHAVIOR belief); history re-cap sweep | edit `reflectionEngine.js` (+helpers in importanceEngine) | `mind/tests/reflection2.test.js` |
| **F** Continuation + metrics | `detectContinuation()` → engine boosts working/episode/workspace lanes on "continue/resume/pick up"; observability memory counters (retrievals, nonEmptyRate, p50/p95 latency) surfaced in getMetrics | +`memory/continuation.js`; edit `engine.js`, `core/observability.js` | in `importance.test.js` + `recallApi.test.js` |
| **G** Unified recall API | `GET /memory/recall?q=` → {facts, episodes, graphPaths, files} owner-scoped JSON for frontend/agents | edit `routes/memory.js` | `routes/tests/recallApi.test.js` (route-level, supertest-free — direct handler or express boot) |

Post-G: PERFORMANCE_REPORT.md — micro-bench memoryRetrieve on synthetic 300-fact/50-node mind, p50/p95, before/after.

Backwards compat proof: full existing suite (136 tests) must stay green after every phase; no signature changes to engine.js exports; new params optional-with-defaults.
