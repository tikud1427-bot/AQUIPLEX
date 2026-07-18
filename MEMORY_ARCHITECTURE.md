# MEMORY_ARCHITECTURE.md — Memory 5.0 (Cognitive OS)

Principle: **extend the v4 facade, never bypass it.** Every new capability is a stage inside `memory/engine.js` pipelines. Zero new deps. Zero API breaks. Every stage fail-open.

## Target pipeline (additions in CAPS-bold)

```
memoryObserve(owner, turn)
  extract → resolve → storeFacts            (unchanged; history now CAPPED)
  mindObserve (beliefs/goals/working/episodes/graph)   (unchanged)
  CONTINUATION-DETECT → flag on trace                  (Phase F)
  fire-forget: indexOwnerFacts + INDEX-FILE-CHUNKS     (Phase D)

memoryRetrieve(owner, query)
  identity card (bypass, unchanged)
  ranked facts   — keyword + cosine + IMPORTANCE-AWARE (Phase A)
  cognitive block (unchanged)
  GRAPH RECALL   — query-seeded ≤2-hop paths           (Phase B)
  EPISODE RECALL — past arcs matching query/past-tense (Phase C)
  FILE RECALL    — top semantic chunks of uploads      (Phase D)
  file-summary block (unchanged)
  ONE budget (unchanged 800 tokens; new lanes ride the same cap)

memoryAfterTurn(owner)
  predictions rebuild (unchanged)
  reflection@8 → + FACT LIFECYCLE (importance recompute, archive/reactivate),
                 + DEDUPE MERGE, + INSIGHT BELIEFS, + HISTORY CAP   (A, E)

routes/memory.js
  + GET /memory/recall?q=   unified hybrid search JSON  (Phase G/F)
observability
  + memory counters: retrievals, hits, emptyRate, p50/p95 latency  (Phase F)
```

## New modules (all small, single-purpose, tested)
| Module | Owns |
|---|---|
| `memory/importanceEngine.js` | `computeImportance(fact, mind)` — recency, supportCount, retrievalCount, graph degree, pinned flags; `applyFactLifecycle(mind)` — recompute + archive/reactivate at reflection |
| `mind/graphRecall.js` | `recallGraphPaths(mind, query, {maxHops:2})` — seed by token↔label match, weighted BFS, path lines |
| `mind/episodeRecall.js` | `recallEpisodes(mind, query)` — token/recency/importance scored arcs + past-tense trigger |
| `embeddings/fileMemory.js` | `indexFileChunks(owner, name, content)` (fire-forget) + `fileChunkScores(owner, query)`; chunks stored WITH text in vectorStore record `meta` (additive field), ns `files:<ownerId>` |
| `memory/continuation.js` | `detectContinuation(msg)` → boosts working/episode/workspace lanes |

## Data model deltas (all additive, upgrade-on-read)
- `fact.retrievalCount`, `fact.lastRetrievedAt` (touched by retriever top-K)
- `fact.status: 'active'|'archived'` already exists — archive path now actually used; `getFacts(owner, {includeArchived})`
- `fact.pinned` (explicit "remember this" / correction ⇒ exempt from archive)
- vectorStore record `+meta?` (chunk text, fileKey, idx) — old records valid
- `mind.insights?` not needed — insights land as BEHAVIOR-dimension beliefs (reuse)

## Budget policy
Lanes fill in priority order: identity → facts → cognitive → graph(≤3 paths) → episodes(≤2) → file chunks(≤2×220 chars) → file summaries. `estimateTokens` gates each lane; overflow lanes drop whole (never truncate mid-line). Same total 800.

## Isolation & safety invariants
1. Namespaces: fact vectors `<ownerId>`, file chunks `files:<ownerId>` — cross-owner reads impossible by construction.
2. Every new stage wrapped in try/catch → neutral value + trace note (matches existing pattern).
3. Archive ≠ delete: archived facts excluded from prompt + default API, kept on disk, reactivated by re-mention (storeFact same key) or explicit recall query.
4. Reflection remains setImmediate-async; lifecycle work bounded O(facts).
