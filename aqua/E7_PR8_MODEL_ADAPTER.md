# E7 PR-8 — Real Cross-Encoder Adapter

PR-8 now has a model-backed adapter in addition to the pure reranking boundary.

## Adapter

`src/brain/contextEngine/crossEncoder.js` exports:

- `createHuggingFaceCrossEncoder({ token, model, timeoutMs, fetchImpl })`
- default model: `Xenova/ms-marco-MiniLM-L-6-v2`

The adapter is opt-in and lazy: importing AQUA never performs network inference.

## Environment

```text
HF_TOKEN=<your Hugging Face access token>
AQUA_CROSS_ENCODER_MODEL=Xenova/ms-marco-MiniLM-L-6-v2
AQUA_CROSS_ENCODER_TIMEOUT_MS=2500
```

Do not commit `HF_TOKEN`.

## Runtime contract

The adapter exposes:

```js
await adapter.scorePair(query, candidate)
```

It sends the query and candidate statement as a text pair to the Hugging Face inference endpoint and returns one finite relevance score.

`rerankWithCrossEncoderAsync()`:

1. orders candidates by RRF rank;
2. limits the model pool (default 32);
3. scores only that pool;
4. blends CE score with the bounded RRF prior;
5. preserves the untouched tail;
6. fails closed to RRF ordering on timeout, HTTP errors, malformed scores, or adapter exceptions.

The synchronous PR-8 contract remains intact for injected synchronous adapters.

## Smoke test

Run:

```bash
HF_TOKEN=... node eval/cross-encoder-smoke.mjs
```

On PowerShell:

```powershell
$env:HF_TOKEN="..."
node eval/cross-encoder-smoke.mjs
```

The smoke test performs one real inference request. It is intentionally separate from the deterministic unit suite.

## Important

This PR does **not** enable the live model on every AQUA request. That is deliberate. Before promotion, benchmark:

- baseline V9 RRF metrics;
- CE-reranked metrics on the same 200 queries;
- p50/p95 latency;
- timeout/error rate;
- candidate-pool sensitivity.

Only then should the production turn path be switched on.
