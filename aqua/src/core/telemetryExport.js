/**
 * AQUA — telemetry export adapters, activated by environment (E12, 2026-10-04).
 *
 * telemetry.js owns the seams (`setSpanExporter`, `setErrorSink`) and keeps a
 * bounded local ring by default. This module supplies the two real backends a
 * deployment can switch on without code, both dependency-free:
 *
 *   OTLP/HTTP (JSON) traces    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT  (full URL), or
 *                              OTEL_EXPORTER_OTLP_ENDPOINT         (+ '/v1/traces')
 *                              OTEL_EXPORTER_OTLP_HEADERS          k=v,k2=v2 (e.g. an API key)
 *                              OTEL_SERVICE_NAME                   default aquiplex-<role>
 *   error webhook              AQUA_ERROR_WEBHOOK_URL              POST of the already-scrubbed
 *                              AQUA_ERROR_WEBHOOK_TOKEN            record (Bearer, optional)
 *
 * Unset → nothing changes (local ring, as before). What leaves the process is
 * exactly what the local ring holds: span attributes that already passed the
 * allowlist sanitizer, error records already scrubbed with the owner hashed.
 *
 * Never fails the observed path (G-observability): exports are batched,
 * bounded (oldest dropped, counted), fire-and-forget with a timeout, and a
 * failing collector only increments a counter.
 */
import crypto from 'node:crypto';
import { setSpanExporter, setErrorSink } from './telemetry.js';

const stats = { spansExported: 0, spansDropped: 0, exportFailures: 0, errorsSent: 0, errorSendFailures: 0 };
export const getExportStats = () => ({ ...stats });

function parseHeaders(raw) {
  const out = {};
  for (const part of String(raw ?? '').split(',')) {
    const i = part.indexOf('=');
    if (i > 0) out[decodeURIComponent(part.slice(0, i).trim())] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function otlpValue(v) {
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: String(v) };
}

const hex = n => crypto.randomBytes(n).toString('hex');
const nanos = ms => (BigInt(Math.round(ms * 1000)) * 1000n).toString();

/** One telemetry.js span record → one OTLP span (JSON encoding of the proto). */
export function toOtlpSpan(span) {
  const end = Number(span.endedAt) || Date.now();
  const start = end - (Number(span.durationMs) || 0);
  return {
    traceId: hex(16),
    spanId: hex(8),
    name: span.name,
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: nanos(start),
    endTimeUnixNano: nanos(end),
    attributes: Object.entries(span.attributes ?? {}).map(([key, value]) => ({ key, value: otlpValue(value) })),
    status: { code: span.status === 'error' ? 2 : 1 },
  };
}

/**
 * @param {{ url: string, headers?: object, serviceName: string, fetchImpl?: Function,
 *           batchSize?: number, maxQueue?: number, flushMs?: number, timeoutMs?: number }} opts
 */
export function createOtlpSpanExporter({ url, headers = {}, serviceName, fetchImpl = globalThis.fetch,
  batchSize = 64, maxQueue = 2048, flushMs = 5000, timeoutMs = 3000 }) {
  const queue = [];
  let timer = null;
  let inflight = Promise.resolve();

  const body = spans => JSON.stringify({
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName } }] },
      scopeSpans: [{ scope: { name: 'aqua.telemetry' }, spans }],
    }],
  });

  async function send(batch) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: body(batch.map(toOtlpSpan)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`collector ${res.status}`);
      stats.spansExported += batch.length;
    } catch {
      stats.exportFailures++;
    }
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    while (queue.length) {
      const batch = queue.splice(0, batchSize);
      inflight = inflight.then(() => send(batch));
    }
    return inflight;
  }

  function exportSpan(span) {
    queue.push(span);
    if (queue.length > maxQueue) { queue.shift(); stats.spansDropped++; }
    if (queue.length >= batchSize) flush();
    else if (!timer) { timer = setTimeout(flush, flushMs); timer.unref?.(); }
  }
  return { exportSpan, flush, shutdown: flush };
}

/** Errors → a webhook (Slack/Discord-compatible receivers, a tracker's ingest proxy, …). */
export function createWebhookErrorSink({ url, token = null, fetchImpl = globalThis.fetch, timeoutMs = 3000, maxInflight = 8 }) {
  let inflight = 0;
  return function sink(rec) {
    if (inflight >= maxInflight) { stats.errorSendFailures++; return; }
    inflight++;
    Promise.resolve()
      .then(() => fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(rec),
        signal: AbortSignal.timeout(timeoutMs),
      }))
      .then(res => { if (!res.ok) throw new Error(`webhook ${res.status}`); stats.errorsSent++; })
      .catch(() => { stats.errorSendFailures++; })
      .finally(() => { inflight--; });
  };
}

/**
 * Wire whatever the environment asks for. Returns what is active and a
 * `shutdown()` that flushes pending spans (call it on SIGTERM).
 */
export function configureTelemetryFromEnv({ role = 'server', env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const active = { spans: 'local', errors: 'local' };
  let exporter = null;
  const tracesUrl = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    || (env.OTEL_EXPORTER_OTLP_ENDPOINT ? `${String(env.OTEL_EXPORTER_OTLP_ENDPOINT).replace(/\/+$/, '')}/v1/traces` : null);
  if (tracesUrl && typeof fetchImpl === 'function') {
    exporter = createOtlpSpanExporter({
      url: tracesUrl,
      headers: parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
      serviceName: env.OTEL_SERVICE_NAME || `aquiplex-${role}`,
      fetchImpl,
    });
    setSpanExporter(exporter.exportSpan);
    active.spans = 'otlp';
  }
  if (env.AQUA_ERROR_WEBHOOK_URL && typeof fetchImpl === 'function') {
    setErrorSink(createWebhookErrorSink({ url: env.AQUA_ERROR_WEBHOOK_URL, token: env.AQUA_ERROR_WEBHOOK_TOKEN || null, fetchImpl }));
    active.errors = 'webhook';
  }
  return { ...active, shutdown: async () => { await exporter?.shutdown(); } };
}
