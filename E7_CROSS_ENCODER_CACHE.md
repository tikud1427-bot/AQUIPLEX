# E7 — Cross-Encoder Pair Cache

The local and hosted cross-encoder adapters now cache successful `(model, query, candidate-text)` scores.

## Contract

- bounded LRU cache; default capacity: 512 pairs;
- default TTL: 10 minutes;
- cache is adapter-local/in-process, so it never becomes a source of truth;
- failures and malformed scores are never cached;
- changing the model naturally invalidates keys;
- local batch scoring only runs model inference for cache misses and reconstructs the original candidate order;
- cache can be disabled with `AQUA_CROSS_ENCODER_CACHE_SIZE=0`.

## Configuration

```text
AQUA_CROSS_ENCODER_CACHE_SIZE=512
AQUA_CROSS_ENCODER_CACHE_TTL_MS=600000
```

## Why this belongs in E7

Cross-encoder reranking is deliberately bounded to the fused candidate pool. Repeated questions and adjacent turns can otherwise pay the same local/provider inference cost repeatedly. The cache reduces that repeated cost without changing retrieval correctness: a cache miss, cache eviction, expiry, model failure, or adapter failure always falls back to the normal inference/fail-safe path.

## Verification

Deterministic adapter tests cover cache hits and explicit cache clearing. The local smoke test additionally requires the project dependencies to be installed (`npm install`) before Transformers.js can load.
