# E7 PR-8 — Cross-Encoder Reranking Contract

This increment adds the cross-encoder reranking boundary without introducing a model/runtime dependency.

## Contract
`rerankWithCrossEncoder(candidates, fused, { query, scorePair, candidateLimit, outputLimit, blendWeight })`

- `scorePair(query, candidate)` is an injected synchronous model adapter.
- Only the fused top-N pool is reranked.
- RRF remains a bounded prior via `blendWeight`.
- Invalid/non-finite scores or adapter exceptions fail closed to the deterministic RRF order.
- With no adapter configured, production behavior is unchanged.

## Important
This is the PR-8 integration boundary, not a claim that a cross-encoder model is bundled. A concrete local/remote model adapter must be supplied separately before measuring PR-8 quality/latency gains.
