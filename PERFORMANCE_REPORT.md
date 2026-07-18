# PERFORMANCE_REPORT.md — Memory 5.0

Bench: `node src/memory/tests/bench.retrieve.js` (checked in, rerunnable).
Synthetic heavy owner: **302 facts, 60 graph nodes / 79 edges, 20 episodes**, populated working memory. Warmed process; wall-clock via `performance.now()`.

## Retrieval (the per-turn hot path — every lane active: identity, facts, cognitive, graph, episodes, file summaries)

| Path | avg | p50 | p95 |
|---|---|---|---|
| memoryRetrieve — mixed query classes (n=600) | 0.88 ms | 0.63 ms | 2.03 ms |
| recall query ("what do you know about me") | 0.74 | 0.51 | 2.44 |
| directed category query | 0.56 | 0.53 | 0.81 |
| **graph multi-hop query** (Phase B) | 0.88 | 0.76 | 1.34 |
| **episodic query** (Phase C) | 0.60 | 0.55 | 0.71 |
| **continuation fast-path** (Phase F) | 0.57 | 0.52 | 0.94 |
| near-miss (all gates drop) | 0.54 | 0.52 | 0.67 |

**Target <100 ms: beaten by ~50×** at p95 on a 300-fact owner. Headroom: retrieval is O(active facts) + O(edges within 2 hops of seeds); the Phase-A archive tier keeps the active set bounded for long-lived owners.

## Write & background paths

| Path | avg | p50 | p95 | Notes |
|---|---|---|---|---|
| memoryObserve (extract→resolve→store→mind) | 0.67 ms | 0.44 ms | 1.40 ms | inline, synchronous by design |
| reflect() — FULL consolidation (beliefs decay + fact lifecycle + dedupe merge + insights + graph prune) | 1.39 ms | 0.67 ms | 4.17 ms | runs setImmediate off-turn anyway; worst case measured synchronously |

Embedding lanes (fact vectors, file chunks) are **off the measured path by construction**: write-side fire-and-forget, read-side precomputed at chat's async seam overlapping classification — user-visible latency contribution ≈ 0 beyond the provider round-trip already amortized.

## Memory-block budget
One 800-token budget unchanged. New lanes (graph ≤3 paths, episodes ≤2, file chunks ≤2×220 chars) are drop-whole gated — worst-case block size is still ≤ budget; observed injected sizes logged per-request in the Inspector trace (`injectedTokens`).

## Live production metrics (Phase F)
`GET /provider-health` → `getMetrics().memoryRetrieval`: count, nonEmptyRate, avg/p50/p95 latency, per-lane fire counts — the bench numbers above are continuously verifiable in prod.

## Regression status
Full platform: **300/300 tests green** (memory 113 · mind 51 · embeddings 9 · identity 31 · routes 17 · search 58 · upload 21). Zero API breaks; new engine params optional; embeddings-off path byte-identical to pre-5.0 lanes absent.
