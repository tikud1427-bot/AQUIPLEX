# AQUA observability — metric catalog and integration points (E12)

Scrape: `GET /api/aqua/provider-health/metrics` (Prometheus text). **Open
(2026-10-05):** on the platform server every `/api/aqua/*` route is behind
`requireLogin`, so a Prometheus scraper without a session cookie gets 401 —
deciding how a scraper authenticates (token, private network) is pending.
Alerts:
`ops/prometheus/aqua-alerts.yml` (CI checks every alerted metric is emitted).

## Process-local vs. derived — read this first
The HTTP server and the cognition worker are separate processes. In-memory
counters (requests, providers, spans, reported errors, cost) describe **the
process that serves /metrics** — the server. Anything about learning is
**derived from Postgres** so it is the same number whichever process asks:
queue depth, retries, dead letters, re-explanation rate.

| Metric | Source | Meaning |
|---|---|---|
| `aqua_requests_total`, `aqua_request_{successes,failures}_total`, `aqua_request_latency_{avg,p95}_ms` | server memory | chat/API request outcomes and latency |
| `aqua_provider_{requests,failures}_total`, `aqua_provider_latency_avg_ms` `{provider}` | server memory | model-provider calls |
| `aqua_cost_{calls,input_tokens,output_tokens}_total`, `aqua_cost_purpose_tokens_total{purpose}` | every provider transport (`countedCall`) | tokens by purpose (`chat`, `extraction`, …) |
| `aqua_cost_unpriced_calls_total`, `aqua_cost_usd_total` | same | USD is **withheld** while any call is unpriced — never a false $0 |
| `aqua_jobs{state}` | Postgres | durable queue depth |
| `aqua_jobs_window{kind,state}`, `aqua_job_retries_window{kind,state}` | Postgres, 24h | throughput and retries per job kind |
| `aqua_dlq_level`, `aqua_dlq_oldest_dead_age_seconds` | Postgres + `dlqPolicy` | dead-letter alert level |
| `aqua_span_count`, `aqua_span_duration_ms_{sum,max}`, `aqua_span_errors_total` `{stage}` | `telemetry.js` | per-stage latency (`context.assemble`, `job.run` in the worker) |
| `aqua_reported_errors_total{where}` | `telemetry.reportError` | PII-scrubbed error reports by site |
| `aqua_eval_gate_{passed,regressions,age_seconds}` | `eval/out/gate-summary.json` | last full `eval:gate` outcome (absent = no data, never a fabricated pass) |
| `aqua_e6_*`, `aqua_memory_retrieval_*` | process memory | E6 / retrieval counters of the serving process |

Per-owner product metric (not a Prometheus series — cardinality): re-explanation
rate, `GET /api/aqua/brain/reexplanation?days=90` (derived from the World Model;
a lower bound).

## Where real infrastructure plugs in
| Need | Seam | Today |
|---|---|---|
| Distributed tracing (OpenTelemetry) | `setSpanExporter(fn)` in `aqua/src/core/telemetry.js`; OTLP/HTTP JSON exporter in `telemetryExport.js` | **env-activated** (below); bounded in-memory ring when unset |
| Error tracking | `setErrorSink(fn)`; webhook sink in `telemetryExport.js` — posts scrubbed `{ where, code, message, ownerHash, frames }` | **env-activated** (below); bounded in-memory ring when unset |
| Shared rate limits | `utils/rateLimitStore.js` — `redisBackend()` (atomic Lua per hit, RESP2 over net/tls, no dependency) | **env-activated** (below); in-memory per instance when unset |
| Worker-side metrics | each worker upserts its counters to `aqua_process_metrics` every 15s (`processMetrics.js`); /metrics emits `aqua_worker_*{process}` and `aqua_workers_alive` | done — any number of workers; a dead one ages out after 2 min |
| Server-side metrics | each server instance publishes the same snapshot (role `server`); /metrics emits `aqua_servers_alive` and `aqua_server_revision_voice_*{process,…}` so one scrape sees the fleet | done |
| Revision voice | `aqua_revision_voice_considered_total`, `_emitted_total`, `_suppressed_total{reason}` (said-in-this-conversation, user-correction, no-longer-current, missing-statement, newer-chosen, lost-race), `_skipped_total{reason}` (no-owner, flag-off, unsuitable-turn, no-candidates, error) | this process + every server via snapshots |
| E9 J3 consolidation | `aqua_j3_{scheduled,runs,groups,merged,raced,failures,evidenceLinked}_total` (+ `aqua_worker_j3_*{process}`); queue depth/retries/DLQ per kind `claim.consolidation.v1` via `aqua_jobs_window` | done |

### Activating them (no code change)
| Variable | Effect | Where read |
|---|---|---|
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (full URL) or `OTEL_EXPORTER_OTLP_ENDPOINT` (`/v1/traces` appended) | spans exported as OTLP/HTTP JSON, batched (64 / 5 s), bounded queue (2048, oldest dropped), 3 s timeout | server (`aqua/router.js`) and worker (`scripts/worker.mjs`); flushed on SIGTERM |
| `OTEL_EXPORTER_OTLP_HEADERS` | `k=v,k2=v2` (URL-encoded), e.g. a vendor API key | same |
| `OTEL_SERVICE_NAME` | `service.name`; default `aquiplex-server` / `aquiplex-worker` | same |
| `AQUA_ERROR_WEBHOOK_URL` (+ `AQUA_ERROR_WEBHOOK_TOKEN`) | each scrubbed error record POSTed as JSON (Bearer token optional), max 8 in flight | same |
| `AQUA_RATE_LIMIT_REDIS_URL` | `redis://[user:password@]host:port[/db]` or `rediss://…` — auth and API limiters share one window across instances; unreachable Redis degrades to per-instance counting with a warning | platform `index.js` via `utils/rateLimitStore.js` |

Boot logs say what is active: `[TELEMETRY] spans=otlp|local errors=webhook|local`
and `[WORKER] telemetry spans=… errors=…`. Verified against a local HTTP receiver
(`core/tests/telemetryExport.test.js`) and a real Redis 7
(`core/tests/rateLimitRedis.live.test.js`, needs `AQUA_TEST_REDIS_URL`). Not yet
verified against a specific vendor collector; OTLP/HTTP JSON is the vendor-neutral
protocol every OTel collector accepts.

PII rules (enforced in code, tested): span attributes pass `sanitizeSpanAttributes`
(allowlisted keys, identifier-shaped values); owners appear only as a 12-hex
hash; error messages are scrubbed of emails, URLs with queries, long digit runs,
quoted text and key-shaped tokens.
