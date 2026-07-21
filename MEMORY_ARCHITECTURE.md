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

---

# Memory 5.1 — Editing + Reasoning (spec gap closure)

Full-spec survey (2026-07-21) vs the "cognitive memory architecture" brief:
12/15 requirements were already live (working/episodic/semantic/procedural/
project memory, timeline, graph + multi-hop recall, hybrid retrieval,
consolidation, confidence, performance posture, integration, tests). Two
were not: an explicit **editing surface** (correction/deletion/replacement/
merge/split/version history — internals existed, no API) and **reasoning
over the memory layer** (queryEngine covers evidence facts only). One
Phase-4 seam was orphaned: versionStore's `memory` revision kind had no
writer. 5.1 closes exactly these. Zero new deps, all additive, fail-open.

## New modules
| Module | Owns |
|---|---|
| `memory/memoryEditor.js` | `correctFact` (CORRECTION path, pins), `replaceFact` (OVERWRITE, damped conf), `mergeFacts` (survivor absorbs support; losers archived w/ `supersededBy`), `splitFact` (parts inherit provenance + `metadata.splitFrom`; source archived w/ `splitInto`), `pinFact`, `archiveFact`/`restoreFact`. Every op snapshots pre-edit state via `buildRevisionHistory` (new additive export from longTermMemory — ONE history implementation) — never a silent overwrite. Each op bridges a `memory`-kind revision to PIC versionStore (`memfact:<key>`), fire-forget, gated on `AQUA_PIC`. |
| `memory/memoryReasoner.js` | Deterministic, evidence-backed reasoning over facts+episodes+goals+working+graph+timeline: `findContradictions` (flips w/ prior values), `detectTrends` (momentum/churn/recurring work), `findGaps` (core identity, open questions, stale goals, unverified facts), `compareDecisions` (episode outcomes, chronological, contrast), `whatChanged` (merged change feed: timeline events + fact revisions + new facts), `reasonOverMemory` (question → mode → `{findings, evidence, confidence}`; empty memory = honest 0.3). Pure reads (`peekMind`), zero model calls. |

## API (routes/memory.js — literal paths, before legacy param routes)
```
POST /memory/fact                    { key, value, mode: correct|replace }
POST /memory/fact/:key/pin           { pinned }
POST /memory/fact/:key/archive       { restore, force }   pinned = archive-exempt unless force
POST /memory/merge                   { keys[], intoKey? } keys are STORED (canonical) keys
POST /memory/fact/:key/split         { parts:[{key,value,…}] }
GET  /memory/reason?q=&mode=         contradictions|trends|gaps|decisions|changes
GET  /memory/timeline?days=&limit=   "what changed" feed
```
All through the engine facade (new re-exports); POST /fact canonicalizes keys
(same `resolveCanonicalKey` rule chat extraction uses — `employer`→`workplace`),
response returns the canonical `key`. merge/split/pin/archive take stored keys
verbatim (the UI drives them from GET /memory).

## Invariants preserved
Archive ≠ delete everywhere (Phase-A + Phase-4 rule now uniform across manual
edits); pins survive merges; part-key collisions in split go through OVERWRITE
(history kept); every route fails 4xx-with-error, never 500s on editor `ok:false`;
`AQUA_PIC=off` silences the bridge, edits still land. Tests: `npm run
test:memory` — 135/135 (113 prior + 22 new: memoryEditor.test.js,
memoryReasoner.test.js); mind 51/51, pic 38/38, identity green.
