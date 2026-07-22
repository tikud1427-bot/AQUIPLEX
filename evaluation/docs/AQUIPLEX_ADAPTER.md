# AQUA Adapter — Engine Contract

Grounded in the frozen source (`aqua/src/routes/chat.js`, `index.js`).

## Request
`POST {base_url}/chat` · JSON `{ "message": string }` — one benchmark item
per request, **no** `conversationId`, so the engine creates a fresh
conversation per item (no cross-item history/memory/attachments; the
Phase-0 access-guard contract in chat.js supports sessionless callers).

## Success payload (fields the adapter consumes)
```
success:true, requestId, conversationId, answer,
provider, providerScore, taskType, confidence,
latencyMs, fallbackChain[], truncated, finishReason
```
`answer` becomes the scored text; the diagnostic fields are preserved
per-item in `records.jsonl` (adapter_meta) — so every score is traceable to
the provider that produced it and the engine's own confidence.

## Failure
`success:false` (+ HTTP 4xx/5xx) with `error` and any partial
`fallbackChain`. The adapter retries 408/429/5xx with exponential backoff
(config: `max_retries`, `retry_backoff_s`), then records the item as an
error — the run continues; the error rate is in every report.

## Deployment targets
1. **Standalone harness (default)** — `runners/aqua-standalone.mjs` mounts
   `aqua/router.js` on `127.0.0.1:8877` sessionless: no platform login, no
   credit metering (both live in `index.js`, which the harness does not
   load), isolated `AQUA_DATA_DIR`, Mongo mirror disabled. Zero platform
   modifications — the harness only imports the frozen code.
2. **Deployed platform** — set `base_url` to `https://<host>/api/aqua` and a
   logged-in session cookie in `headers.Cookie`. Note `usageGuard` meters
   credits per chat message there; a full MMLU run is 14k metered requests.

## Health
`GET {base_url}/provider-health` — used by the runner's pre-flight check.

## Verified
Contract exercised live against the frozen engine during framework
validation: harness boots (isolated data dir, search disabled without
keys), `/provider-health` green, `POST /chat` accepted, and with no
provider keys the engine walked its full fallback chain and returned the
documented `success:false` diagnostics — which the adapter surfaced as a
per-item error exactly as designed. With provider keys present the same
path returns `answer`.
