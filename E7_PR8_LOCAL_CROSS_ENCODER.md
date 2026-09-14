# E7 PR-8 — Local Cross-Encoder Adapter

The hosted `hf-inference` route is not used for the default MS MARCO MiniLM reranker because the model is not deployed by an Inference Provider. AQUA instead uses the ONNX-compatible `Xenova/ms-marco-MiniLM-L-6-v2` model through Transformers.js.

## Runtime

- package: `@huggingface/transformers`
- model: `Xenova/ms-marco-MiniLM-L-6-v2`
- runtime: ONNX in-process Node.js
- default dtype: `q8`
- model download/cache: handled by Transformers.js on first use
- network is needed only to obtain the public model on first run; inference is local afterward

## Activation

PR-8 remains opt-in:

```powershell
$env:AQUA_CONTEXT_V2="on"
$env:AQUA_RETRIEVAL_V3="on"
$env:AQUA_CROSS_ENCODER="on"
```

Optional settings:

```powershell
$env:AQUA_CROSS_ENCODER_POOL="32"
$env:AQUA_CROSS_ENCODER_BLEND="0.20"
```

No cross-encoder model is loaded when `AQUA_CROSS_ENCODER` is not `on`.

## Safety

The async reranker is bounded to the fused candidate pool. Any model initialization, inference, shape, or score failure returns the deterministic pre-rerank RRF ordering.

The existing synchronous Context Engine API is unchanged. The chat seam selects the async PR-8 path only when the feature flag is enabled.

## Pair-score cache

Successful `(query, candidate-text)` scores are kept in a bounded in-process LRU cache (default 512 entries, 10-minute TTL). Configure with `AQUA_CROSS_ENCODER_CACHE_SIZE` and `AQUA_CROSS_ENCODER_CACHE_TTL_MS`. Failures are never cached.
